-- Restore mandatory qualification attachment for new accounts; historical contracts stay unchanged.
-- Restores existing published rules; no numeric thresholds, old contracts or policy versions changed.
create or replace function public.accept_qualification_v2(p_account_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare acct record; ver record;
begin
 select id,challenge_type,stage into acct from public.trading_accounts where id=p_account_id for update;
 if not found then return 'ACCOUNT_NOT_FOUND';end if;
 if exists(select 1 from public.account_qualification_contracts where account_id=p_account_id)then return 'ALREADY_ACCEPTED';end if;
 select * into ver from public.challenge_qualification_versions
 where challenge_type=acct.challenge_type and stage=acct.stage and status='published' order by created_at desc,id desc limit 1;
 if not found then return 'NO_PUBLISHED_VERSION';end if;
 insert into public.account_qualification_contracts(account_id,version_id,accepted_at,rules_snapshot,acceptance_reference)
 values(p_account_id,ver.id,now(),jsonb_build_object('min_elapsed_days',ver.min_elapsed_days,
 'min_trading_days',ver.min_trading_days,'min_sessions',ver.min_sessions,'max_best_day_share',ver.max_best_day_share,
 'min_daily_net_fraction',ver.min_daily_net_fraction,'session_flat_gap_minutes',ver.session_flat_gap_minutes),
 'auto-accepted at provisioning, account_qualification_versions '||ver.id);
 return 'ACCEPTED:'||ver.id;
end $$;
revoke all on function public.accept_qualification_v2(uuid)from public,anon,authenticated;
grant execute on function public.accept_qualification_v2(uuid)to service_role;

create or replace function public.fn_attach_infinity_qualification()
returns trigger language plpgsql security definer set search_path='' as $$
declare result text;
begin
 if new.challenge_type='infinity'and new.stage between 1 and 3 and new.phase='evaluation'and new.status='active' then
  result:=public.accept_qualification_v2(new.id);
  if result<>'ALREADY_ACCEPTED'and result not like 'ACCEPTED:%'then
   raise exception 'QUALIFICATION_CONTRACT_UNAVAILABLE:%',result;
  end if;
 end if;
 return new;
end $$;
revoke all on function public.fn_attach_infinity_qualification()from public,anon,authenticated;
create trigger infinity_qualification_at_insert after insert on public.trading_accounts
for each row execute function public.fn_attach_infinity_qualification();

-- Stage transition and next-account insertion are one transaction.
-- Copies existing presets and qualification gates; does not modify classifier or broker enablement.
create function public.fn_advance_infinity_stage(p_account uuid,p_expected_user uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts; n public.challenge_presets; child public.trading_accounts;
 progress record; qualification jsonb; risk jsonb; quick numeric; target numeric; children integer;
begin
 select * into a from public.trading_accounts where id=p_account for update;
 if not found or a.user_id is distinct from p_expected_user then raise exception 'ACCOUNT_NOT_FOUND_OR_OWNER_MISMATCH';end if;
 select count(*)into children from public.trading_accounts where funded_from_account_id=a.id;
 if children>1 then raise exception 'AMBIGUOUS_DESCENDANTS';end if;
 if children=1 then
  select * into child from public.trading_accounts where funded_from_account_id=a.id;
  if a.status<>'passed'or child.user_id is distinct from a.user_id then raise exception 'LINEAGE_REVIEW_REQUIRED';end if;
  return jsonb_build_object('ok',true,'already_created',true,'next_account',child.id,'next_stage',child.stage);
 end if;
 if a.challenge_type<>'infinity'or a.stage not between 1 and 3 or a.phase<>'evaluation'
  or a.status<>'active'or a.access_revoked_at is not null then
  return jsonb_build_object('ok',false,'reason','PARENT_NOT_ELIGIBLE');
 end if;
 risk:=public.fn_enforce_infinity_from_quotes(a.id);
 -- Do not raise after an authoritative freeze: a raised error would roll that freeze back.
 select * into a from public.trading_accounts where id=p_account;
 if a.status<>'active'or a.access_revoked_at is not null then return jsonb_build_object('ok',false,'reason','ACCOUNT_FROZEN');end if;
 if risk is null or coalesce((risk->>'checked')::boolean,false)=false then
  return jsonb_build_object('ok',false,'reason','RISK_CHECK_UNAVAILABLE');
 end if;
 if exists(select 1 from public.trades where account_id=a.id and status='open')then return jsonb_build_object('ok',false,'reason','OPEN_POSITIONS');end if;
 target:=round(a.starting_balance*(1+a.profit_target_pct/100),2);
 if a.profit_target_pct<=0 or a.balance<target then return jsonb_build_object('ok',false,'reason','TARGET_INCOMPLETE');end if;
 select * into progress from public.account_progress where account_id=a.id;
 if not found then return jsonb_build_object('ok',false,'reason','PROGRESS_UNAVAILABLE');end if;
 if progress.trading_days<coalesce(a.min_trading_days,0)or progress.trades_closed<coalesce(a.min_trades,0)
  or(a.min_profitable_days_pct is not null and coalesce(progress.profitable_days_pct,0)<a.min_profitable_days_pct)then
  return jsonb_build_object('ok',false,'reason','BASE_QUALIFICATION_INCOMPLETE');
 end if;
 qualification:=public.qualification_progress_v2(a.id);
 if qualification is null or not coalesce((qualification->>'applies')::boolean,false)
  or not coalesce((qualification->>'eligible')::boolean,false)then
  return jsonb_build_object('ok',false,'reason','EXTENDED_QUALIFICATION_INCOMPLETE');
 end if;
 if a.created_at>=timestamptz '2026-10-01 00:00:00+00'then
  select coalesce(sum(pnl),0)into quick from public.trades where account_id=a.id and status='closed'and pnl>0
   and closed_at-opened_at<interval '60 seconds';
  if quick>0 and round(a.balance-quick,2)<target then return jsonb_build_object('ok',false,'reason','SHORT_HOLD_PROFIT');end if;
 end if;
 select next.*into n from public.challenge_presets cur join public.challenge_presets next on next.id=cur.next_preset_id where cur.id=a.preset_id;
 if not found or n.challenge_type<>'infinity'or n.stage<>a.stage+1 then raise exception 'NEXT_PRESET_UNAVAILABLE';end if;
 update public.trading_accounts set status='passed',updated_at=now()where id=a.id and status='active';
 if not found then raise exception 'PARENT_STATUS_CHANGED';end if;
 update public.pending_orders set status='cancelled' where account_id=a.id and status='pending';
 insert into public.trading_accounts(user_id,label,preset_id,challenge_type,stage,phase,status,starting_balance,balance,
 day_start_equity,day_start_date,profit_target_pct,max_drawdown_pct,daily_loss_pct,drawdown_mode,trailing_peak,
 min_trading_days,min_trades,max_risk_per_trade_pct,daily_profit_cap_pct,min_profitable_days_pct,require_stop_loss,
 profit_split_pct,challenge_fee_usd,funded_from_account_id,total_paid_out)
 values(a.user_id,n.label,n.id,n.challenge_type,n.stage,'evaluation','active',n.starting_balance,n.starting_balance,
 n.starting_balance,(now()at time zone'UTC')::date,n.profit_target_pct,n.max_drawdown_pct,n.daily_loss_pct,n.drawdown_mode,n.starting_balance,
 coalesce(n.min_trading_days,0),coalesce(n.min_trades,0),n.max_risk_per_trade_pct,n.daily_profit_cap_pct,n.min_profitable_days_pct,n.require_stop_loss,
 coalesce(n.profit_split_pct,85),a.challenge_fee_usd,a.id,0)returning *into child;
 -- AFTER INSERT contract trigger is part of the same transaction; any failure rolls everything back.
 return jsonb_build_object('ok',true,'already_created',false,'next_account',child.id,'next_stage',child.stage,
  'phase',child.phase,'review_required',child.stage=4,'execution_enablement_changed',false);
end $$;
revoke all on function public.fn_advance_infinity_stage(uuid,uuid)from public,anon,authenticated;
grant execute on function public.fn_advance_infinity_stage(uuid,uuid)to service_role;

-- Ready events cannot be starved by earlier missing reference prices.
CREATE OR REPLACE FUNCTION public.e8_sim_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare e record; q public.e8_reference_quotes; n int:=0; waiting int; t timestamptz:=clock_timestamp(); reason text;
begin
 -- One worker; bounded batch, no network or broker access.
 if not pg_try_advisory_xact_lock(hashtext('e8-sim-tick')) then return jsonb_build_object('busy',true); end if;
 for e in select v.*,p.reference_account_id,p.symbol,p.min_delay_ms,p.max_wait_ms,p.scale_usd
  from public.e8_sim_events v join public.e8_sim_positions p using(trade_id)
  where v.kind in('open','partial','close') and not exists(select 1 from public.e8_sim_prices x where x.event_id=v.id)
  and (p.reference_account_id is null or p.scale_usd is null
   or t>v.event_at+make_interval(secs=>(p.min_delay_ms+p.max_wait_ms)/1000.0)
   or exists(select 1 from public.e8_reference_quotes ready
    where ready.account_id=p.reference_account_id and ready.symbol=p.symbol
     and ready.requested_at>=v.event_at+make_interval(secs=>p.min_delay_ms/1000.0)
     and ready.received_at<=v.event_at+make_interval(secs=>(p.min_delay_ms+p.max_wait_ms)/1000.0)
     and ready.received_at<=t))
  order by v.id limit 1000 loop
  reason:=null;
  if e.reference_account_id is null then reason:='NO_ENABLED_REFERENCE_FOR_SYMBOL';
  elsif e.scale_usd is null then reason:='USD_SCALE_UNVERIFIED'; end if;
  if reason is not null then
   insert into public.e8_sim_prices(event_id,status,reason) values(e.id,'UNAVAILABLE',reason); n:=n+1; continue;
  end if;
  select * into q from public.e8_reference_quotes where account_id=e.reference_account_id and symbol=e.symbol
   and requested_at>=e.event_at+make_interval(secs=>e.min_delay_ms/1000.0)
   and received_at<=e.event_at+make_interval(secs=>(e.min_delay_ms+e.max_wait_ms)/1000.0)
   and received_at<=t order by received_at,id limit 1;
  if found then
   insert into public.e8_sim_prices(event_id,quote_id,status,bid,ask,requested_at,received_at,sampling_wait_ms)
   values(e.id,q.id,'PRICED',q.bid,q.ask,q.requested_at,q.received_at,extract(epoch from q.received_at-e.event_at)*1000);
   n:=n+1;
  elsif t>e.event_at+make_interval(secs=>(e.min_delay_ms+e.max_wait_ms)/1000.0) then
   insert into public.e8_sim_prices(event_id,status,reason) values(e.id,'UNAVAILABLE','REFERENCE_QUOTE_MISSING_WITHIN_WINDOW'); n:=n+1;
  end if;
 end loop;
 select count(*) into waiting from public.e8_sim_events pending where kind in('open','partial','close')
  and not exists(select 1 from public.e8_sim_prices x where x.event_id=pending.id);
 insert into public.ab_heartbeats(worker,ok,at,detail) values('e8-simulator',waiting<1000,t,jsonb_build_object('processed',n,'waiting',waiting,'basis','E8_QUOTE_ESTIMATE','fees','UNVERIFIED'))
 on conflict(worker) do update set ok=excluded.ok,at=excluded.at,detail=excluded.detail;
 return jsonb_build_object('processed',n,'waiting',waiting);
end $function$
;
revoke all on function public.e8_sim_tick()from public,anon,authenticated;
grant execute on function public.e8_sim_tick()to service_role;

-- Contacts for only the explicitly requested page; private, service-only and bounded.
create or replace function public.fn_application_contacts(p_users uuid[]) returns table(user_id uuid,email text)
language sql stable security definer set search_path='' as $$
 select u.id,u.email::text from auth.users u where u.id=any(p_users) and cardinality(p_users)<=100
$$;
revoke all on function public.fn_application_contacts(uuid[]) from public,anon,authenticated;
grant execute on function public.fn_application_contacts(uuid[]) to service_role;
-- Child stages are the same Infinity attempt, so warnings reset only on a fresh Stage1.
create or replace function public.fn_carry_infinity_strikes() returns trigger language plpgsql security definer set search_path='' as $$
declare p public.trading_accounts;
begin
 if new.challenge_type='infinity' and new.stage>1 and new.funded_from_account_id is not null then
  select * into p from public.trading_accounts where id=new.funded_from_account_id for update;
  if not found or p.user_id<>new.user_id or p.challenge_type<>'infinity' or p.stage<>new.stage-1 then raise exception 'INVALID_INFINITY_LINEAGE';end if;
  new.sl_strikes:=p.sl_strikes;
 end if;
 return new;
end $$;
revoke all on function public.fn_carry_infinity_strikes() from public,anon,authenticated;
create trigger infinity_carry_strikes before insert on public.trading_accounts for each row execute function public.fn_carry_infinity_strikes();
-- Record the warning in the same transaction as the canonical source close.
create or replace function public.fn_sl_warning_on_close() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts;n integer;
begin
 if new.status='closed' and new.close_reason='no_stop_loss' then
  select * into a from public.trading_accounts where id=new.account_id for update;
  if a.challenge_type='infinity' and a.phase<>'demo' and a.status in('active','breached') and not exists(select 1 from public.infinity_retired_accounts r where r.account_id=a.id) then
   n:=public.fn_record_sl_strike(a.id,new.id,coalesce(new.stripped_profit,0));
   if n>=3 and a.status='active' then perform public.fn_claim_account_breach(a.id,'stop_loss_rule',a.balance,a.balance);end if;
  end if;
 end if;
 return new;
end $$;
revoke all on function public.fn_sl_warning_on_close() from public,anon,authenticated;
create trigger sl_warning_on_close after insert or update of status,close_reason on public.trades for each row execute function public.fn_sl_warning_on_close();
alter table public.treasury_snapshots add column if not exists complete boolean not null default false;
grant update on public.treasury_snapshots to service_role;
create or replace function public.treasury_status() returns text language sql stable security definer set search_path='' as $$
 select coalesce((select case when complete and as_of>now()-interval '2 hours' then status else 'unknown' end from public.treasury_snapshots order by as_of desc,id desc limit 1),'unknown')
$$;
revoke all on function public.treasury_status() from public,anon,authenticated;
grant execute on function public.treasury_status() to service_role;
