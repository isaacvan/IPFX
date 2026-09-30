-- Infinity Challenge payout rule: trades must be held for at least 1 minute to be payout-eligible.
-- Profit from WINNING trades held under 60s is excluded from every Infinity payout calculation; losses
-- always count (so the rule can never raise a payout). Applies to trades opened from the Infinity public
-- launch (2026-09-30 23:00 UTC), so nothing earned before the rule existed changes.
-- Also restores the double-payout guards (one open request per account; approval re-checks the period)
-- that were dropped when 20260930211500_infinity_manual_liability_admission redefined these functions.

create or replace function public.fn_infinity_quick_trade_profit(p_account_id uuid, p_since timestamptz default null)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(t.pnl), 0)
    from public.trades t
   where t.account_id = p_account_id
     and t.status = 'closed'
     and t.pnl > 0
     and t.opened_at >= timestamptz '2026-09-30 23:00:00+00'
     and t.closed_at - t.opened_at < interval '60 seconds'
     and (p_since is null or t.closed_at > p_since);
$$;
revoke all on function public.fn_infinity_quick_trade_profit(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.fn_infinity_quick_trade_profit(uuid, timestamptz) to service_role;

CREATE OR REPLACE FUNCTION public.fn_request_payout(p_account_id uuid, p_requested_by uuid, p_is_admin boolean, p_idempotency_key text, p_payout_method_id uuid DEFAULT NULL::uuid)
 RETURNS payouts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_acct            public.trading_accounts%rowtype;
  v_kyc_status      text;
  v_last_period_end timestamptz;
  v_period_end      timestamptz;
  v_net             numeric(14,2);
  v_amount          numeric(14,2);
  v_best_win        numeric(14,2);
  v_gross_win       numeric(14,2);
  v_days_since      numeric;
  v_status          text;
  v_best_day        numeric(14,2);
  v_period_days     int;
  v_row             public.payouts;
  v_min_days        constant int     := 7;
  v_min_withdrawal  constant numeric := 500;
begin
  if p_idempotency_key is not null then
    select * into v_row from public.payouts where idempotency_key = p_idempotency_key;
    if found then
      if v_row.account_id is distinct from p_account_id or v_row.created_by is distinct from p_requested_by then
        raise exception 'idempotency_key_conflict' using errcode='23505';
      end if;
      return v_row;
    end if;
  end if;

  select * into v_acct from public.trading_accounts where id = p_account_id for update;
  if not found then raise exception 'account_not_found'; end if;
  if v_acct.phase <> 'funded' then raise exception 'not_funded'; end if;
  if v_acct.status <> 'active' then raise exception 'account_not_in_good_standing:%', v_acct.status; end if;
  if v_acct.investigation_hold then raise exception 'investigation_hold'; end if;

  select status into v_kyc_status from public.trader_kyc where user_id = v_acct.user_id;
  if v_kyc_status is distinct from 'verified' then raise exception 'kyc_not_verified'; end if;

  -- One open request per account: a second request while the first is still
  -- pending would cover the same period and could be approved twice.
  if exists (select 1 from public.payouts where account_id = p_account_id and status = 'requested') then
    raise exception 'payout_pending';
  end if;

  select max(period_end) into v_last_period_end
    from public.payouts where account_id = p_account_id and status in ('approved','paid');

  v_days_since := extract(epoch from (now() - coalesce(v_last_period_end, v_acct.funded_at, v_acct.created_at))) / 86400;
  if v_days_since < v_min_days then
    raise exception 'too_soon:% days since last payout, minimum % days', round(v_days_since,1), v_min_days;
  end if;

  -- period_end is the real timestamp of the last trade actually included,
  -- not now() â€” a trade closing after this SELECT stays out of this
  -- period and is correctly picked up by the next request instead of
  -- silently vanishing.
  select coalesce(sum(t.pnl),0), max(t.closed_at)
    into v_net, v_period_end
    from public.trades t
    where t.account_id = p_account_id and t.status = 'closed'
      and (v_last_period_end is null or t.closed_at > v_last_period_end);

  -- Infinity Challenge: profit from winning trades held under 60 seconds is not payout-eligible.
  if v_acct.challenge_type = 'infinity' then
    v_net := v_net - public.fn_infinity_quick_trade_profit(p_account_id, v_last_period_end);
  end if;

  v_amount := round(greatest(v_net,0) * v_acct.profit_split_pct/100, 2);
  if v_amount <= 0 or v_period_end is null then raise exception 'nothing_owed'; end if;
  if v_amount < v_min_withdrawal then raise exception 'below_minimum:minimum $%', v_min_withdrawal; end if;

  select coalesce(max(t.pnl),0), coalesce(sum(t.pnl) filter (where t.pnl > 0),0)
    into v_best_win, v_gross_win
    from public.trades t
    where t.account_id = p_account_id and t.status = 'closed' and t.pnl > 0
      and (v_last_period_end is null or t.closed_at > v_last_period_end);
  if v_gross_win > 0 and (v_best_win / v_gross_win) * 100 > 25 then
    raise exception 'consistency_check_failed:single trade is more than 25%% of this period''s profit';
  end if;

  -- Terms 10.2 / 7.5, accounts opened from 1 Oct 2026: splitting one lucky
  -- day into many small trades no longer passes the single-trade check.
  if v_acct.created_at >= timestamptz '2026-10-01 00:00:00+00' then
    select coalesce(max(x.day_pnl), 0), count(*)
      into v_best_day, v_period_days
      from (select sum(t.pnl) as day_pnl
              from public.trades t
             where t.account_id = p_account_id and t.status = 'closed'
               and (v_last_period_end is null or t.closed_at > v_last_period_end)
             group by (t.closed_at at time zone 'UTC')::date) x;
    if v_period_days < 4 then
      raise exception 'min_trading_days:% trading days since last payout, minimum 4', v_period_days;
    end if;
    if v_net > 0 and (v_best_day / v_net) * 100 > 40 then
      raise exception 'consistency_check_failed:best day is more than 40%% of this period''s profit';
    end if;
  end if;

  -- Every request enters a manual owner-review queue. This function never
  -- approves a payout or sends money, including admin-initiated requests.
  v_status := 'requested';

  insert into public.payouts (
    user_id, account_id, period_start, period_end, gross_profit, split_pct, trader_share,
    status, currency, idempotency_key, created_by, payout_method_id, approved_by, approved_at
  ) values (
    v_acct.user_id, p_account_id, v_last_period_end, v_period_end,
    round(greatest(v_net,0), 2), v_acct.profit_split_pct, v_amount,
    v_status, 'USD', p_idempotency_key, p_requested_by, p_payout_method_id,
    case when v_status = 'approved' then p_requested_by end,
    case when v_status = 'approved' then now() end
  ) returning * into v_row;

  if v_status = 'approved' then
    update public.trading_accounts set
      balance = round(balance - v_amount, 2),
      total_paid_out = round(total_paid_out + v_amount, 2),
      day_start_equity = round(day_start_equity - v_amount, 2),
      updated_at = now()
    where id = p_account_id;
  end if;

  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_approve_payout(p_payout_id uuid, p_admin_id uuid)
 RETURNS payouts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_payout public.payouts%rowtype; v_acct public.trading_accounts%rowtype; v_kyc text; v_infinity_event boolean;
begin
  select * into v_payout from public.payouts where id=p_payout_id for update;
  if not found then raise exception 'payout_not_found'; end if;
  if v_payout.status<>'requested' then raise exception 'not_requested:%',v_payout.status; end if;
  select * into v_acct from public.trading_accounts where id=v_payout.account_id for update;
  v_infinity_event:=v_payout.programme_event in ('INFINITY_STAGE3_FIRST_PAYOUT','INFINITY_STAGE3_COMPLETION_PAYOUT');
  if (not v_infinity_event and v_acct.status<>'active') or (v_infinity_event and v_acct.status not in ('active','passed','breached')) then raise exception 'account_not_in_good_standing:%',v_acct.status; end if;
  if v_acct.investigation_hold then raise exception 'investigation_hold'; end if;
  select status into v_kyc from public.trader_kyc where user_id=v_acct.user_id;
  if v_kyc is distinct from 'verified' then raise exception 'kyc_not_verified'; end if;
  if not v_infinity_event and v_payout.trader_share>v_acct.balance then raise exception 'insufficient_balance'; end if;
  -- Re-check under the row locks: never approve a period another approved/paid payout already covers.
  if not v_infinity_event and exists (select 1 from public.payouts p
      where p.account_id=v_payout.account_id and p.id<>v_payout.id and p.status in ('approved','paid')
        and coalesce(p.programme_event,'') not in ('INFINITY_STAGE3_FIRST_PAYOUT','INFINITY_STAGE3_COMPLETION_PAYOUT')
        and p.period_end>=v_payout.period_end) then
    raise exception 'period_already_paid';
  end if;
  update public.payouts set status='approved',approved_by=p_admin_id,approved_at=now() where id=p_payout_id returning * into v_payout;
  if v_infinity_event then
    update public.trading_accounts set total_paid_out=round(total_paid_out+v_payout.trader_share,2),updated_at=now() where id=v_acct.id;
  else
    update public.trading_accounts set balance=round(balance-v_payout.trader_share,2),total_paid_out=round(total_paid_out+v_payout.trader_share,2),day_start_equity=round(day_start_equity-v_payout.trader_share,2),updated_at=now() where id=v_acct.id;
  end if;
  return v_payout;
end $function$;

CREATE OR REPLACE FUNCTION public.fn_request_infinity_stage3_payout(p_account_id uuid, p_requested_by uuid, p_idempotency_key text, p_payout_method_id uuid)
 RETURNS payouts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s3 public.trading_accounts; s2 public.trading_accounts; q jsonb;
  kyc text; s2_profit numeric:=0; s3_profit numeric:=0; gross numeric:=0; share numeric:=0;
  r public.payouts; period_start timestamptz; period_end timestamptz; first_exists boolean:=false;
  service_call boolean:=coalesce(current_setting('request.jwt.claim.role',true),'')='service_role';
begin
  if not service_call and auth.uid() is distinct from p_requested_by and not public.fn_is_admin() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_idempotency_key is null or length(p_idempotency_key)<8 then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  select * into r from public.payouts where idempotency_key=p_idempotency_key;
  if found then
    if r.user_id is distinct from p_requested_by or r.account_id is distinct from p_account_id then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode='23505';
    end if;
    return r;
  end if;
  select * into s3 from public.trading_accounts where id=p_account_id for update;
  if not found or s3.user_id<>p_requested_by or s3.challenge_type<>'infinity' or s3.stage<>3 then raise exception 'INVALID_INFINITY_STAGE3_ACCOUNT'; end if;
  if s3.status not in ('active','passed') or s3.investigation_hold or s3.access_revoked_at is not null then raise exception 'ACCOUNT_NOT_IN_GOOD_STANDING'; end if;
  if s3.status<>'passed' or s3.balance < s3.starting_balance*1.06 then raise exception 'STAGE3_COMPLETION_REQUIRED'; end if;
  select status into kyc from public.trader_kyc where user_id=s3.user_id;
  if kyc is distinct from 'verified' then raise exception 'KYC_NOT_VERIFIED'; end if;
  if not exists(select 1 from public.payout_methods pm where pm.id=p_payout_method_id and pm.user_id=s3.user_id) then raise exception 'INVALID_PAYOUT_METHOD'; end if;
  select public.qualification_progress_v2(s3.id) into q;
  if q is null or (coalesce((q->>'applies')::boolean,false) and not coalesce((q->>'eligible')::boolean,false)) then raise exception 'PUBLISHED_OBSERVATION_RULES_INCOMPLETE'; end if;
  select * into s2 from public.trading_accounts where id=s3.funded_from_account_id and user_id=s3.user_id and challenge_type='infinity' and stage=2;
  if not found or s2.status<>'passed' then raise exception 'STAGE2_LINEAGE_NOT_CONFIRMED'; end if;
  if exists(select 1 from public.payouts where account_id=s3.id and programme_event='INFINITY_STAGE3_COMPLETION_PAYOUT' and status<>'void') then raise exception 'STAGE3_COMPLETION_PAYOUT_ALREADY_REQUESTED'; end if;
  select exists(select 1 from public.payouts where account_id=s3.id and programme_event='INFINITY_STAGE3_FIRST_PAYOUT' and status<>'void') into first_exists;
  select coalesce(sum(pnl),0) into s2_profit from public.trades where account_id=s2.id and status='closed';
  s2_profit := s2_profit - public.fn_infinity_quick_trade_profit(s2.id);
  select coalesce(sum(pnl),0),max(closed_at) into s3_profit,period_end from public.trades where account_id=s3.id and status='closed';
  s3_profit := s3_profit - public.fn_infinity_quick_trade_profit(s3.id);
  gross:=round(greatest(s3_profit,0) + case when first_exists then 0 else greatest(s2_profit,0) end,2);
  share:=round(gross*0.85,2);
  if share<500 then raise exception 'BELOW_MINIMUM:MINIMUM $500'; end if;
  period_start:=case when first_exists then s3.created_at else s2.created_at end;
  -- Recording a valid request creates a real manual liability. It does not
  -- transfer funds, auto-approve, or depend on a potentially stale cash ledger.
  insert into public.payouts(user_id,account_id,period_start,period_end,gross_profit,split_pct,trader_share,status,currency,idempotency_key,created_by,payout_method_id,programme_event,note)
  values(s3.user_id,s3.id,period_start,coalesce(period_end,now()),gross,85,share,'requested','USD',p_idempotency_key,p_requested_by,p_payout_method_id,'INFINITY_STAGE3_COMPLETION_PAYOUT',
    case when first_exists then 'Stage 3 share after completion; prior Stage 2 release excluded' else 'Combined held Stage 2 and Stage 3 shares after Stage 3 completion' end) returning * into r;
  return r;
end $function$;

CREATE OR REPLACE FUNCTION public.fn_infinity_payout_preview(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s3 public.trading_accounts; s2 public.trading_accounts;
  s2_profit numeric:=0; s3_profit numeric:=0;
  first_exists boolean:=false; completion_exists boolean:=false;
  held_share numeric:=0; available_share numeric:=0; excluded numeric:=0;
  service_call boolean:=coalesce(current_setting('request.jwt.claim.role',true),'')='service_role';
begin
  if not service_call and auth.uid() is distinct from p_user_id and not public.fn_is_admin() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into s3 from public.trading_accounts
    where user_id=p_user_id and challenge_type='infinity' and stage=3
    order by created_at desc limit 1;
  if found then
    if s3.status not in ('active','passed') or s3.access_revoked_at is not null then
      return jsonb_build_object('has_infinity',false,'stage3_status',s3.status);
    end if;
    select * into s2 from public.trading_accounts
      where id=s3.funded_from_account_id and user_id=p_user_id and challenge_type='infinity' and stage=2 and status='passed';
  else
    select * into s2 from public.trading_accounts
      where user_id=p_user_id and challenge_type='infinity' and stage=2
      order by created_at desc limit 1;
  end if;
  if s2.id is null or s2.status<>'passed' then return jsonb_build_object('has_infinity',false); end if;
  if s3.id is not null then
    select exists(select 1 from public.payouts where account_id=s3.id and programme_event='INFINITY_STAGE3_FIRST_PAYOUT' and status<>'void') into first_exists;
    select exists(select 1 from public.payouts where account_id=s3.id and programme_event='INFINITY_STAGE3_COMPLETION_PAYOUT' and status<>'void') into completion_exists;
  end if;
  select coalesce(sum(pnl),0) into s2_profit from public.trades where account_id=s2.id and status='closed';
  excluded := public.fn_infinity_quick_trade_profit(s2.id);
  s2_profit := s2_profit - excluded;
  held_share:=case when first_exists then 0 else round(greatest(s2_profit,0)*0.85,2) end;
  if s3.id is not null and s3.status='passed' and s3.balance>=s3.starting_balance*1.06 and not completion_exists then
    select coalesce(sum(pnl),0) into s3_profit from public.trades where account_id=s3.id and status='closed';
    s3_profit := s3_profit - public.fn_infinity_quick_trade_profit(s3.id);
    available_share:=round((greatest(s3_profit,0)+case when first_exists then 0 else greatest(s2_profit,0) end)*0.85,2);
  end if;
  return jsonb_build_object(
    'has_infinity',true,'stage3_status',coalesce(s3.status,'not_started'),
    'stage2_held',held_share,'available_now',available_share,
    'completion_requested',completion_exists,'minimum_withdrawal',500,
    'excluded_under_1_minute',round(excluded + case when s3.id is null then 0 else public.fn_infinity_quick_trade_profit(s3.id) end,2),
    'min_hold_seconds',60
  );
end $function$;
