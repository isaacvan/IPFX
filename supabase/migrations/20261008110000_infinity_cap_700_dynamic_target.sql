-- Infinity Stage 3 payout cap is $700 (the earlier cap is replaced) and the completion check follows the account's own profit target
-- (6% / 8% today) instead of a fixed 6%. Also updates three chatbot answers that still said 5% / no cap (owner 2026-10-08).
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
  if s3.status<>'passed' or s3.balance < s3.starting_balance*(1+s3.profit_target_pct/100) then raise exception 'STAGE3_COMPLETION_REQUIRED'; end if;
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
  share:=least(round(gross*0.85,2),700);
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
  held_share:=case when first_exists then 0 else least(round(greatest(s2_profit,0)*0.85,2),700) end;
  if s3.id is not null and s3.status='passed' and s3.balance>=s3.starting_balance*(1+s3.profit_target_pct/100) and not completion_exists then
    select coalesce(sum(pnl),0) into s3_profit from public.trades where account_id=s3.id and status='closed';
    s3_profit := s3_profit - public.fn_infinity_quick_trade_profit(s3.id);
    available_share:=least(round((greatest(s3_profit,0)+case when first_exists then 0 else greatest(s2_profit,0) end)*0.85,2),700);
  end if;
  return jsonb_build_object(
    'has_infinity',true,'stage3_status',coalesce(s3.status,'not_started'),
    'stage2_held',held_share,'available_now',available_share,
    'completion_requested',completion_exists,'minimum_withdrawal',500,'max_payout',700,
    'excluded_under_1_minute',round(excluded + case when s3.id is null then 0 else public.fn_infinity_quick_trade_profit(s3.id) end,2),
    'min_hold_seconds',60
  );
end $function$;


update public.support_kb set answer = replace(answer, 'reaching **5% closed profit**', 'reaching **{{p:infinity_s3.target_pct}} closed profit**') where id = 'infinity-payouts';
update public.support_kb set answer = replace(answer, '- Full profit target {{p:infinity_s3.target_pct}} ({{p:infinity_s3.target_amt}})', '- Full profit target {{p:infinity_s3.target_pct}} ({{p:infinity_s3.target_amt}})' || chr(10) || '- Stage 3 payout is 85% of eligible Stage 2 and Stage 3 profit, up to a maximum of $700') where id = 'infinity-stage3' and answer not like '%maximum of $700%';
update public.support_kb set answer = replace(answer, 'subject to the $500 minimum and published checks.', 'subject to the $500 minimum, the $700 maximum Stage 3 payout (85% of eligible profit) and published checks.') where id = 'payout-how' and answer not like '%$700 maximum%';
