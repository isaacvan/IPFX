-- Recover lows from real saved open/close windows; incomplete lifetime
-- coverage is explicit. New entry/exit audits also survive raw tick expiry.
begin;
with observations as (
 select t.id,t.open_price,t.opened_at,t.closed_at,s.contract_size,s.quote_currency,q.ts,
  (case when t.side='buy' then q.bid-t.open_price else t.open_price-q.ask end)*s.contract_size v,
  count(*) over(partition by t.id) samples
 from public.trades t join public.trading_accounts a on a.id=t.account_id
 join public.symbol_specs s on s.symbol=t.symbol and s.quote_currency='USD'
 join public.trade_quote_windows q on q.trade_id=t.id and q.ts between t.opened_at and t.closed_at
 left join public.ipfx_trade_lows l on l.trade_id=t.id
 where t.status='closed' and t.external_source is null and coalesce(a.venue,'ipfx')='ipfx'
  and (l.trade_id is null or (l.low_per_lot_usd is null and l.open_price=t.open_price))
  and t.open_price>0 and t.open_price<1e20 and s.contract_size>0 and s.contract_size<1e20
  and q.bid>0 and q.ask>=q.bid and q.ask<1e20 and t.side in('buy','sell')
), lows as(select distinct on(id) * from observations order by id,v,ts)
insert into public.ipfx_trade_lows(trade_id,contract_size,quote_currency,open_price,opened_at,scanned_until,
 low_per_lot_usd,low_at,observed_quotes,incomplete,complete)
select id,contract_size,quote_currency,open_price,opened_at,closed_at,v,ts,samples,true,true from lows
on conflict(trade_id) do update set low_per_lot_usd=excluded.low_per_lot_usd,low_at=excluded.low_at,
 observed_quotes=greatest(public.ipfx_trade_lows.observed_quotes,excluded.observed_quotes),incomplete=true,
 complete=true,scanned_until=excluded.scanned_until,updated_at=clock_timestamp()
 where public.ipfx_trade_lows.low_per_lot_usd is null;

create or replace function public.ipfx_trade_low_tick(p_limit int default 500) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='4s' as $$
declare r record; stop_at timestamptz; from_at timestamptz; n int:=0; stats record;
 now_at timestamptz:=clock_timestamp(); root_ok boolean;
begin
 if p_limit<1 or p_limit>500 then raise exception 'Batch must be 1..500'; end if;
 if not pg_try_advisory_xact_lock(hashtext('ipfx-trade-low-tick')) then return jsonb_build_object('busy',true); end if;
 for r in select l.*,t.symbol,t.side,t.status,t.closed_at,t.volume,t.open_price current_open_price,t.parent_trade_id
  from public.ipfx_trade_lows l join public.trades t on t.id=l.trade_id
  where not l.complete order by l.updated_at,l.trade_id limit p_limit for update of l skip locked
 loop
  -- Two-second settlement plus a thirty-second overlapping replay allows late
  -- tick inserts. A closed row is revisited until its exit is thirty seconds old.
  stop_at:=least(now_at-interval '2 seconds',coalesce(r.closed_at,now_at));
  if stop_at<r.opened_at then continue; end if;
  from_at:=greatest(r.opened_at,r.scanned_until-interval '30 seconds',now_at-interval '5 hours 55 minutes');
  root_ok:=r.open_price=r.current_open_price and r.contract_size>0 and r.contract_size<1e20 and r.open_price>0 and r.open_price<1e20
   and r.quote_currency in('USD','JPY','GBP','CAD','CHF');
  with marks as (
   select q.ts,q.bid,q.ask,q.mid from public.quote_ticks q
    where q.symbol=r.symbol and q.ts>=from_at and q.ts<=stop_at
   union all
   -- The last recorded quote at entry captures the opening spread even if
   -- prices do not change immediately. No synthetic zero mark is inserted.
   select r.opened_at,q.bid,q.ask,q.mid from lateral(
    select bid,ask,mid from public.quote_ticks where symbol=r.symbol
     and ts<=r.opened_at and ts>=r.opened_at-interval '30 seconds'
    order by ts desc limit 1)q where r.observed_quotes=0
   union all
   select q.ts,q.bid,q.ask,(q.bid+q.ask)/2 from public.trade_quote_windows q
    where q.trade_id=r.trade_id and q.ts>=r.opened_at and q.ts<=stop_at
   union all
   -- Durable server decision snapshots price the opening spread even when
   -- the feed remains unchanged. Exit snapshots stop at the actual exit.
   select case when d.kind='open' then r.opened_at else e.closed_at end,d.bid,d.ask,(d.bid+d.ask)/2
    from public.ipfx_sim_decision_quotes d join public.trades e on e.id=d.source_row_id
    where (d.trade_id=r.trade_id or d.source_row_id=r.trade_id
     or (d.kind='open' and d.trade_id=coalesce(r.parent_trade_id,r.trade_id)))
     and e.account_id=(select account_id from public.trades where id=r.trade_id)
     and e.symbol=r.symbol and e.side=r.side and e.open_price=r.open_price
     and (d.kind='open' or (e.closed_at>=r.opened_at and e.closed_at<=stop_at))
  ), valued as (
   select q.ts,case when root_ok and q.bid>0 and q.ask>=q.bid and q.ask<1e20
    and q.mid>0 and q.mid<1e20 then
    (case when r.side='buy' then q.bid-r.open_price else r.open_price-q.ask end)*r.contract_size*
    case when r.quote_currency='USD' then 1
     when r.quote_currency='GBP' then fx.mid
     when r.symbol=case r.quote_currency when 'JPY' then 'USDJPY' when 'CAD' then 'USDCAD' when 'CHF' then 'USDCHF' end then 1/q.mid
     else 1/fx.mid end end as v
   from marks q left join lateral(
    select f.mid from public.quote_ticks f
     where r.quote_currency<>'USD' and f.symbol=case r.quote_currency when 'JPY' then 'USDJPY'
      when 'GBP' then 'GBPUSD' when 'CAD' then 'USDCAD' when 'CHF' then 'USDCHF' end
      and f.ts<=q.ts and f.ts>=q.ts-interval '60 seconds' and f.mid>0 and f.mid<1e20
     order by f.ts desc limit 1)fx on true
  ) select (select v from valued where v is not null order by v,ts limit 1) as low,
   (select ts from valued where v is not null order by v,ts limit 1) as at,
   count(*) filter(where v is not null and ts>r.scanned_until) as samples,
   count(*) filter(where v is null) as missing into stats from valued;
  update public.ipfx_trade_lows set
   low_per_lot_usd=case when stats.low is not null and (low_per_lot_usd is null or stats.low<low_per_lot_usd) then stats.low else low_per_lot_usd end,
   low_at=case when stats.low is not null and (low_per_lot_usd is null or stats.low<low_per_lot_usd) then stats.at else low_at end,
   observed_quotes=observed_quotes+stats.samples,
   incomplete=incomplete or not coalesce(root_ok,false) or stats.missing>0 or r.scanned_until<now_at-interval '6 hours',
   scanned_until=greatest(scanned_until,stop_at),complete=r.status='closed' and r.closed_at<=now_at-interval '30 seconds',
   updated_at=now_at where trade_id=r.trade_id;
  n:=n+1;
 end loop;
 insert into public.ab_heartbeats(worker,ok,at,detail) values('trade-lows',true,now_at,jsonb_build_object('processed',n,
  'waiting',(select count(*) from public.ipfx_trade_lows where not complete)))
 on conflict(worker) do update set ok=excluded.ok,at=excluded.at,detail=excluded.detail;
 return jsonb_build_object('ok',true,'processed',n);
end $$;
create function public.ipfx_trade_low_wake_audit() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 update public.ipfx_trade_lows set complete=false where trade_id in(new.trade_id,new.source_row_id);
 return new;
end $$;
revoke all on function public.ipfx_trade_low_wake_audit() from public,anon,authenticated;
create trigger ipfx_trade_low_wake_audit after insert on public.ipfx_sim_decision_quotes
 for each row execute function public.ipfx_trade_low_wake_audit();
create function public.ipfx_trade_low_wake_windows() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Window capture can arrive after the normal exit settlement. Register
 -- missing old rows, then revisit each affected row once per insert batch.
 insert into public.ipfx_trade_lows(trade_id,contract_size,quote_currency,open_price,opened_at,scanned_until,incomplete)
 select distinct t.id,s.contract_size,s.quote_currency,t.open_price,t.opened_at,
  least(coalesce(t.closed_at,clock_timestamp()),greatest(t.opened_at-interval '1 microsecond',clock_timestamp()-interval '5 hours 55 minutes')),true
 from added_windows w join public.trades t on t.id=w.trade_id join public.trading_accounts a on a.id=t.account_id
 left join public.symbol_specs s on s.symbol=t.symbol
 where t.external_source is null and coalesce(a.venue,'ipfx')='ipfx' and t.open_price>0 and t.open_price<1e20
 on conflict do nothing;
 update public.ipfx_trade_lows set complete=false where trade_id in(select distinct trade_id from added_windows);
 return null;
end $$;
revoke all on function public.ipfx_trade_low_wake_windows() from public,anon,authenticated;
create trigger ipfx_trade_low_wake_windows after insert on public.trade_quote_windows
 referencing new table as added_windows for each statement execute function public.ipfx_trade_low_wake_windows();
commit;
