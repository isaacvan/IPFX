-- Freeze Infinity on the first usable persisted portfolio quote that touches
-- either floor. The failed account stays failed; cleanup/restarts are separate.
begin;
create function public.fn_infinity_quote_equity(p_account uuid) returns numeric
language sql stable security definer set search_path='' as $$
 with marks as(
  select a.balance,t.id,
   case when t.id is null then 0
    when s.contract_size>0 and s.contract_size<1e20 and t.volume>0 and t.volume<1e20
     and t.open_price>0 and t.open_price<1e20 and q.bid>0 and q.ask>=q.bid and q.ask<1e20
     and q.received_at between clock_timestamp()-interval '30 seconds' and clock_timestamp()+interval '2 seconds'
    then (case when t.side='buy' then q.bid-t.open_price when t.side='sell' then t.open_price-q.ask end)*t.volume*s.contract_size*
     case when s.quote_currency='USD' then 1
      when fx.bid>0 and fx.ask>=fx.bid and fx.ask<1e20 and fx.mid between fx.bid and fx.ask
       and fx.received_at between clock_timestamp()-interval '30 seconds' and clock_timestamp()+interval '2 seconds'
      then case when s.quote_currency='GBP' then fx.mid else 1/fx.mid end end end value
  from public.trading_accounts a left join public.trades t on t.account_id=a.id and t.status='open'
  left join public.symbol_specs s on s.symbol=t.symbol
  left join public.live_quotes q on q.symbol=t.symbol
  left join public.live_quotes fx on fx.symbol=case s.quote_currency when 'JPY' then 'USDJPY'
   when 'GBP' then 'GBPUSD' when 'CAD' then 'USDCAD' when 'CHF' then 'USDCHF' end
  where a.id=p_account
 ) select case when balance>-1e20 and balance<1e20 and count(*) filter(where value is null)=0
  then round(balance+coalesce(sum(value),0),2) end from marks group by balance;
$$;

create function public.fn_enforce_infinity_from_quotes(p_account uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts; eq numeric; peak numeric; day_start numeric; dd_floor numeric; daily_floor numeric;
 today date:=(clock_timestamp() at time zone 'UTC')::date; why text; claimed boolean:=false;
begin
 select * into a from public.trading_accounts where id=p_account for update;
 if not found then return jsonb_build_object('checked',false,'reason','ACCOUNT_NOT_FOUND'); end if;
 if a.challenge_type<>'infinity' or coalesce(a.venue,'ipfx')<>'ipfx' or a.phase='demo' then
  return jsonb_build_object('checked',false,'reason','NOT_IPFX_INFINITY'); end if;
 if a.status<>'active' or a.access_revoked_at is not null then
  return jsonb_build_object('checked',false,'reason','NOT_ACTIVE','status',a.status,'balance',a.balance,
   'breach_reason',a.breach_reason,'day_start_equity',a.day_start_equity,'day_start_date',a.day_start_date,
   'trailing_peak',a.trailing_peak,'trailing_peak_date',a.trailing_peak_date,'access_revoked_at',a.access_revoked_at); end if;
 eq:=public.fn_infinity_quote_equity(a.id);
 if eq is null then return jsonb_build_object('checked',false,'reason','MARK_UNAVAILABLE'); end if;
 if a.starting_balance is null or a.max_drawdown_pct is null or a.daily_loss_pct is null
  or not(coalesce(a.drawdown_mode,'static') in('static','trailing_intraday','trailing_eod'))
  or not(a.starting_balance>0 and a.starting_balance<1e20 and a.max_drawdown_pct>0 and a.max_drawdown_pct<=100
   and a.daily_loss_pct>0 and a.daily_loss_pct<=100) then
  return jsonb_build_object('checked',false,'reason','RULES_UNAVAILABLE'); end if;
 peak:=greatest(coalesce(a.trailing_peak,a.starting_balance),a.starting_balance);day_start:=a.day_start_equity;
 if a.day_start_date is distinct from today then
  day_start:=case when a.created_at>='2026-10-01T00:00:00Z' then greatest(a.balance,eq) else eq end;
  if a.drawdown_mode='trailing_eod' then peak:=greatest(peak,eq);end if;
 end if;
 if a.drawdown_mode='trailing_intraday' then peak:=greatest(peak,eq); end if;
 if day_start is null or day_start<=-1e20 or day_start>=1e20 or peak<=-1e20 or peak>=1e20
  or coalesce(a.total_paid_out,0)<0 or coalesce(a.total_paid_out,0)>=1e20 then
  return jsonb_build_object('checked',false,'reason','RULES_UNAVAILABLE'); end if;
 dd_floor:=round(case when coalesce(a.drawdown_mode,'static')='static'
  then a.starting_balance*(1-a.max_drawdown_pct/100)-coalesce(a.total_paid_out,0)
  else peak-a.starting_balance*a.max_drawdown_pct/100-coalesce(a.total_paid_out,0) end,2);
 daily_floor:=round(day_start-a.starting_balance*a.daily_loss_pct/100,2);
 if eq<=dd_floor then why:='max_drawdown';elsif eq<=daily_floor then why:='daily_loss';end if;
 if a.day_start_date is distinct from today or a.trailing_peak is distinct from peak then
  update public.trading_accounts set day_start_equity=day_start,day_start_date=today,trailing_peak=peak,
   trailing_peak_date=case when a.drawdown_mode='trailing_eod' then today else trailing_peak_date end
  where id=a.id;
 end if;
 if why is not null then claimed:=public.fn_claim_account_breach(a.id,why,eq,
  case when why='max_drawdown' then dd_floor else daily_floor end); end if;
 return jsonb_build_object('checked',true,'claimed',claimed,'equity',eq,'dd_floor',dd_floor,'daily_floor',daily_floor,
  'status',case when why is not null then 'breached' else a.status end,'balance',a.balance,'breach_reason',why,
  'day_start_equity',day_start,'day_start_date',today,'trailing_peak',peak,
  'trailing_peak_date',case when a.drawdown_mode='trailing_eod' then today else a.trailing_peak_date end,
  'breached_at',(select breached_at from public.trading_accounts where id=a.id),
  'breach_equity',(select breach_equity from public.trading_accounts where id=a.id),
  'breach_floor',(select breach_floor from public.trading_accounts where id=a.id),
  'access_revoked_at',(select access_revoked_at from public.trading_accounts where id=a.id));
end $$;

create function public.fn_infinity_on_persisted_quotes() returns trigger
language plpgsql security definer set search_path='' as $$
declare who uuid; result jsonb; checked int:=0; unavailable int:=0; errors int:=0;
begin
 if not exists(select 1 from changed_quotes) then return null;end if;
 for who in select distinct a.id from public.trading_accounts a join public.trades t on t.account_id=a.id and t.status='open'
  where a.challenge_type='infinity' and a.status='active' and a.access_revoked_at is null and coalesce(a.venue,'ipfx')='ipfx'
   and exists(select 1 from changed_quotes c where c.symbol=t.symbol
    or c.symbol=case (select quote_currency from public.symbol_specs where symbol=t.symbol)
     when 'JPY' then 'USDJPY' when 'GBP' then 'GBPUSD' when 'CAD' then 'USDCAD' when 'CHF' then 'USDCHF' end)
  order by a.id
 loop
  begin
   result:=public.fn_enforce_infinity_from_quotes(who);
   if coalesce((result->>'checked')::boolean,false) then checked:=checked+1;
   elsif result->>'reason' in('MARK_UNAVAILABLE','RULES_UNAVAILABLE') then unavailable:=unavailable+1;end if;
  exception when others then errors:=errors+1;
  end;
 end loop;
 insert into public.ab_heartbeats(worker,ok,at,detail) values('infinity-quote-risk',errors=0 and unavailable=0,clock_timestamp(),
  jsonb_build_object('checked',checked,'unavailable',unavailable,'errors',errors))
 on conflict(worker) do update set ok=excluded.ok,at=excluded.at,detail=excluded.detail;
 return null;
end $$;
create trigger infinity_quote_risk_insert after insert on public.live_quotes
 referencing new table as changed_quotes for each statement execute function public.fn_infinity_on_persisted_quotes();
create trigger infinity_quote_risk_update after update on public.live_quotes
 referencing new table as changed_quotes for each statement execute function public.fn_infinity_on_persisted_quotes();

create function public.fn_infinity_after_source_change() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='trading_accounts' then
  if new.challenge_type='infinity' and new.status='active' then perform public.fn_enforce_infinity_from_quotes(new.id);end if;
 elsif new.status='open' and exists(select 1 from public.trading_accounts where id=new.account_id
  and challenge_type='infinity' and status='active' and coalesce(venue,'ipfx')='ipfx')
 then perform public.fn_enforce_infinity_from_quotes(new.account_id);end if;
 return new;
end $$;
create trigger infinity_balance_risk after update of balance on public.trading_accounts
 for each row when(old.balance is distinct from new.balance) execute function public.fn_infinity_after_source_change();
create trigger infinity_new_position_risk after insert on public.trades
 for each row when(new.status='open') execute function public.fn_infinity_after_source_change();

-- Locking the same account row serializes new orders against a breach claim.
create or replace function public.fn_require_active_trade_account() returns trigger
language plpgsql set search_path='' as $$
declare a public.trading_accounts;
begin
 select * into a from public.trading_accounts where id=new.account_id and user_id=new.user_id for share;
 if not found or a.access_revoked_at is not null or not((a.status='active' and a.phase in('evaluation','funded'))
  or (a.status='demo' and a.phase='demo' and a.challenge_type='demo')) then raise exception 'TRADING_ACCOUNT_FROZEN';end if;
 return new;
end $$;
drop trigger if exists trg_require_active_trade_account on public.trades;
create trigger trg_require_active_trade_account before insert on public.trades
 for each row execute function public.fn_require_active_trade_account();
drop trigger if exists trg_require_active_pending_account on public.pending_orders;
create trigger trg_require_active_pending_account before insert on public.pending_orders
 for each row execute function public.fn_require_active_trade_account();
create function public.fn_keep_breached_account_frozen() returns trigger language plpgsql set search_path='' as $$
begin
 if old.status='breached' and old.phase<>'demo' and(new.status<>'breached'
  or new.breach_reason is distinct from old.breach_reason or new.breached_at is distinct from old.breached_at
  or new.breach_equity is distinct from old.breach_equity or new.breach_floor is distinct from old.breach_floor
  or (old.access_revoked_at is not null and new.access_revoked_at is null)
  or new.stage is distinct from old.stage or new.phase is distinct from old.phase) then
  raise exception 'BREACHED_ACCOUNT_IS_FROZEN';end if;
 return new;
end $$;
create trigger trg_keep_breached_account_frozen before update on public.trading_accounts
 for each row execute function public.fn_keep_breached_account_frozen();
-- Updates cannot re-arm a failed account's resting order or increase its risk.
create trigger trg_active_trade_update before update of volume,open_price,sl,tp,trail_distance on public.trades
 for each row when(new.status='open') execute function public.fn_require_active_trade_account();
create trigger trg_active_pending_update before update on public.pending_orders
 for each row when(new.status='pending') execute function public.fn_require_active_trade_account();
create function public.fn_no_closed_trade_reopen() returns trigger language plpgsql set search_path='' as $$
begin if old.status='closed' and new.status='open' then raise exception 'CLOSED_TRADE_CANNOT_REOPEN';end if;return new;end $$;
create trigger trg_no_closed_trade_reopen before update of status on public.trades
 for each row execute function public.fn_no_closed_trade_reopen();

revoke all on function public.fn_infinity_quote_equity(uuid),public.fn_enforce_infinity_from_quotes(uuid),
 public.fn_infinity_on_persisted_quotes(),public.fn_infinity_after_source_change(),public.fn_require_active_trade_account(),
 public.fn_keep_breached_account_frozen(),public.fn_no_closed_trade_reopen() from public,anon,authenticated;
grant execute on function public.fn_infinity_quote_equity(uuid),public.fn_enforce_infinity_from_quotes(uuid) to service_role;
commit;
