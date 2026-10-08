begin;
create or replace function public.fn_enforce_infinity_from_quotes(p_account uuid) returns jsonb
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
 if why is not null then
  begin
   claimed:=public.fn_claim_account_breach(a.id,why,eq,case when why='max_drawdown' then dd_floor else daily_floor end);
  exception when others then
   -- A bookkeeping/deadlock error must not erase an observed crossing.
   -- Freeze first without taking a pending-order lock; cleanup retries later.
   update public.trading_accounts set status='breached',breach_reason=why,breached_at=clock_timestamp(),
    breach_equity=eq,breach_floor=case when why='max_drawdown' then dd_floor else daily_floor end,
    access_revoked_at=clock_timestamp(),access_revoked_reason='challenge_rule_breach:'||why,
    mirror_enabled=false,updated_at=clock_timestamp() where id=a.id and status='active';
   claimed:=found;
   begin
    insert into public.account_breach_events(account_id,user_id,challenge_type,stage,reason,trigger_equity,breach_floor)
    values(a.id,a.user_id,a.challenge_type,a.stage,why,eq,case when why='max_drawdown' then dd_floor else daily_floor end)
    on conflict(account_id) do nothing;
   exception when others then null;end;
   insert into public.ab_heartbeats(worker,ok,at,detail) values('infinity-freeze-fallback',false,clock_timestamp(),
    jsonb_build_object('error_code',sqlstate,'account_frozen',claimed,'cleanup_pending',true))
   on conflict(worker) do update set ok=false,at=excluded.at,detail=excluded.detail;
  end;
 end if;
 return jsonb_build_object('checked',true,'claimed',claimed,'equity',eq,'dd_floor',dd_floor,'daily_floor',daily_floor,
  'status',case when why is not null then 'breached' else a.status end,'balance',a.balance,'breach_reason',why,
  'day_start_equity',day_start,'day_start_date',today,'trailing_peak',peak,
  'trailing_peak_date',case when a.drawdown_mode='trailing_eod' then today else a.trailing_peak_date end,
  'breached_at',(select breached_at from public.trading_accounts where id=a.id),
  'breach_equity',(select breach_equity from public.trading_accounts where id=a.id),
  'breach_floor',(select breach_floor from public.trading_accounts where id=a.id),
  'access_revoked_at',(select access_revoked_at from public.trading_accounts where id=a.id));
end $$;
create function public.fn_cleanup_failed_pending() returns int language plpgsql security definer set search_path='' as $$
declare n int;
begin
 update public.pending_orders p set status='cancelled',resolved_at=clock_timestamp()
 where p.status='pending' and exists(select 1 from public.trading_accounts a where a.id=p.account_id and a.status='breached');
 get diagnostics n=row_count;return n;
end $$;
revoke all on function public.fn_cleanup_failed_pending() from public,anon,authenticated;
grant execute on function public.fn_cleanup_failed_pending() to service_role;
select cron.schedule('ipfx-failed-pending-cleanup','10 seconds',$job$set statement_timeout='2s';select public.fn_cleanup_failed_pending();$job$);
commit;
