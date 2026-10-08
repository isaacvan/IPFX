-- Observed floating P&L, before fees; never a claim about unseen broker ticks.
-- The asynchronous worker reads existing IPFX ticks and does not delay orders.
begin;
create table public.ipfx_trade_lows (
 trade_id uuid primary key references public.trades(id) on delete cascade,
 contract_size numeric, quote_currency text, open_price numeric not null,
 opened_at timestamptz not null, scanned_until timestamptz not null,
 low_per_lot_usd numeric, low_at timestamptz, observed_quotes bigint not null default 0,
 incomplete boolean not null default false, complete boolean not null default false,
 updated_at timestamptz not null default clock_timestamp()
);
create index ipfx_trade_lows_unfinished on public.ipfx_trade_lows(updated_at,trade_id) where not complete;
alter table public.ipfx_trade_lows enable row level security;
revoke all on public.ipfx_trade_lows from public,anon,authenticated;
grant select,insert,update,delete on public.ipfx_trade_lows to service_role;

create function public.ipfx_trade_low_register() returns trigger
language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts; s public.symbol_specs; p public.ipfx_trade_lows;
 start_at timestamptz; inherited boolean:=false;
begin
 if new.external_source is not null or new.status not in('open','closed') or new.side not in('buy','sell') then return new; end if;
 select * into a from public.trading_accounts where id=new.account_id;
 if not found or coalesce(a.venue,'ipfx')<>'ipfx' then return new; end if;
 select * into s from public.symbol_specs where symbol=new.symbol;
 start_at:=greatest(new.opened_at-interval '1 microsecond',clock_timestamp()-interval '5 hours 55 minutes');
 if new.parent_trade_id is not null then
  select * into p from public.ipfx_trade_lows where trade_id=new.parent_trade_id;
  inherited:=found and p.open_price=new.open_price and p.opened_at=new.opened_at
    and p.scanned_until<=new.closed_at;
 end if;
 insert into public.ipfx_trade_lows(trade_id,contract_size,quote_currency,open_price,opened_at,scanned_until,
  low_per_lot_usd,low_at,observed_quotes,incomplete)
 values(new.id,case when inherited then p.contract_size else s.contract_size end,
  case when inherited then p.quote_currency else s.quote_currency end,new.open_price,new.opened_at,
  case when inherited then p.scanned_until else start_at end,
  case when inherited then p.low_per_lot_usd end,case when inherited then p.low_at end,
  case when inherited then p.observed_quotes else 0 end,
  case when inherited then p.incomplete else start_at>new.opened_at end)
 on conflict do nothing;
 return new;
end $$;
create trigger ipfx_trade_low_register after insert on public.trades for each row execute function public.ipfx_trade_low_register();

-- Existing open/recently closed trades can use retained ticks, with incomplete
-- coverage explicitly flagged. Older closed trades remain unavailable.
insert into public.ipfx_trade_lows(trade_id,contract_size,quote_currency,open_price,opened_at,scanned_until,incomplete)
select t.id,s.contract_size,s.quote_currency,t.open_price,t.opened_at,
 greatest(t.opened_at-interval '1 microsecond',clock_timestamp()-interval '5 hours 55 minutes'),
 t.opened_at<clock_timestamp()-interval '5 hours 55 minutes'
from public.trades t join public.trading_accounts a on a.id=t.account_id
left join public.symbol_specs s on s.symbol=t.symbol
where t.external_source is null and coalesce(a.venue,'ipfx')='ipfx' and t.side in('buy','sell')
 and (t.status='open' or t.closed_at>clock_timestamp()-interval '5 hours 55 minutes');

create function public.ipfx_trade_low_tick(p_limit int default 500) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='4s' as $$
declare r record; stop_at timestamptz; from_at timestamptz; n int:=0; stats record;
 now_at timestamptz:=clock_timestamp(); root_ok boolean;
begin
 if p_limit<1 or p_limit>500 then raise exception 'Batch must be 1..500'; end if;
 if not pg_try_advisory_xact_lock(hashtext('ipfx-trade-low-tick')) then return jsonb_build_object('busy',true); end if;
 for r in select l.*,t.symbol,t.side,t.status,t.closed_at,t.volume,t.open_price current_open_price
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
revoke all on function public.ipfx_trade_low_register(),public.ipfx_trade_low_tick(int) from public,anon,authenticated;
grant execute on function public.ipfx_trade_low_tick(int) to service_role;
select cron.schedule('ipfx-trade-lows','10 seconds',$job$select public.ipfx_trade_low_tick();$job$);

create or replace function public.ab_brain_live_activity(p_person uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('as_of',clock_timestamp(),
 'source_trades',coalesce((select jsonb_agg(x) from(select t.id,t.parent_trade_id,t.account_id,t.symbol,t.side,t.volume,
  t.status,t.open_price,t.close_price,t.sl,t.tp,t.pnl,t.commission,t.financing,t.opened_at,t.closed_at,t.close_reason,
  case when coalesce(t.closed_at,clock_timestamp())>=t.opened_at
   then extract(epoch from(coalesce(t.closed_at,clock_timestamp())-t.opened_at)) end hold_seconds,
  case when l.open_price=t.open_price then round(l.low_per_lot_usd*t.volume,2) end lowest_pnl_usd,
  l.low_at lowest_pnl_at,l.scanned_until low_observed_until,
  not coalesce(l.complete,false) and l.scanned_until<least(coalesce(t.closed_at,clock_timestamp()),clock_timestamp())-interval '60 seconds' low_processing_delayed,
  case when l.trade_id is null then 'UNAVAILABLE_HISTORY'
   when l.open_price<>t.open_price then 'UNAVAILABLE_ENTRY_CHANGED'
   when l.low_per_lot_usd is null and l.complete then 'UNAVAILABLE_QUOTES'
   when l.low_per_lot_usd is null then 'WAITING_QUOTES'
   when l.incomplete then 'INCOMPLETE_HISTORY' else 'OBSERVED_QUOTES' end lowest_pnl_status,
  'IPFX_FLOATING_GROSS_FOR_ROW_LOTS'::text lowest_pnl_basis
  from public.trades t join public.trading_accounts a on a.id=t.account_id
  left join public.ipfx_trade_lows l on l.trade_id=t.id
  where public.ab_person_of(a.user_id)=p_person and coalesce(a.venue,'ipfx')='ipfx' and t.external_source is null
  order by (t.status='open') desc,coalesce(t.closed_at,t.opened_at) desc limit 100)x),'[]'::jsonb),
 'simulations',coalesce((select jsonb_agg(x) from(select r.trade_id,r.symbol,r.trader_side,r.selected_book,r.status,
  r.original_lots,r.exited_lots,r.selected_gross_usd,r.net_usd,r.net_status,r.opened_at,r.last_exit_at,
  d.status decision_status,d.selected_gross_usd decision_gross_usd
  from public.e8_sim_trade_results r left join public.ipfx_sim_decision_results d using(trade_id)
  where r.person_id=p_person order by r.opened_at desc limit 50)x),'[]'::jsonb),
 'pending',coalesce((select jsonb_agg(x) from(select * from public.ipfx_sim_pending_state where person_id=p_person
  order by captured_at desc limit 50)x),'[]'::jsonb));
$$;
revoke all on function public.ab_brain_live_activity(uuid) from public,anon,authenticated;
grant execute on function public.ab_brain_live_activity(uuid) to service_role;
commit;
