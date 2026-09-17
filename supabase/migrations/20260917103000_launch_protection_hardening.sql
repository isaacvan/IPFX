-- IPFX launch-protection hardening
-- Rate limits, least-privilege grants, safer views, RLS performance,
-- high-value query indexes, and a server-enforced upload ceiling.

begin;

-- DB-backed fixed-window rate limiting works across Edge Function instances.
create table if not exists public.api_rate_limits (
  scope text not null,
  subject_hash text not null,
  window_start timestamptz not null,
  request_count integer not null default 1 check (request_count > 0),
  primary key (scope, subject_hash, window_start),
  check (scope ~ '^[a-z0-9:_-]{1,80}$'),
  check (subject_hash ~ '^[0-9a-f]{64}$')
);
alter table public.api_rate_limits enable row level security;
revoke all on table public.api_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.api_rate_limits to service_role;
create index if not exists api_rate_limits_expiry_idx on public.api_rate_limits (window_start);

create or replace function public.enforce_api_rate_limit(
  p_scope text,
  p_subject_hash text,
  p_max_requests integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  if p_scope !~ '^[a-z0-9:_-]{1,80}$'
     or p_subject_hash !~ '^[0-9a-f]{64}$'
     or p_max_requests not between 1 and 10000
     or p_window_seconds not between 1 and 86400 then
    raise exception 'INVALID_RATE_LIMIT_INPUT';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into public.api_rate_limits(scope, subject_hash, window_start, request_count)
  values (p_scope, p_subject_hash, v_window_start, 1)
  on conflict (scope, subject_hash, window_start)
  do update set request_count = public.api_rate_limits.request_count + 1
  returning request_count into v_count;

  return v_count <= p_max_requests;
end;
$$;
revoke all on function public.enforce_api_rate_limit(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.enforce_api_rate_limit(text,text,integer,integer) to service_role;

create or replace function public.cleanup_api_rate_limits()
returns bigint
language sql
security definer
set search_path = ''
as $$
  with removed as (
    delete from public.api_rate_limits
    where window_start < now() - interval '2 days'
    returning 1
  )
  select count(*) from removed;
$$;
revoke all on function public.cleanup_api_rate_limits() from public, anon, authenticated;
grant execute on function public.cleanup_api_rate_limits() to service_role;

-- Keep limiter storage bounded when pg_cron is available. The migration is
-- idempotent: replace the named job rather than stacking duplicate schedules.
do $$
declare v_job bigint;
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    select jobid into v_job from cron.job where jobname = 'ipfx-rate-limit-cleanup' limit 1;
    if v_job is not null then perform cron.unschedule(v_job); end if;
    perform cron.schedule(
      'ipfx-rate-limit-cleanup',
      '17 * * * *',
      'select public.cleanup_api_rate_limits();'
    );
  end if;
end;
$$;

-- Views consumed only by the service-role admin Edge Function must not bypass
-- their underlying RLS for browser roles and must not be directly exposed.
alter view if exists public.account_progress set (security_invoker = true);
alter view if exists public.shared_ip_accounts set (security_invoker = true);
alter view if exists public.trader_payout_summary set (security_invoker = true);
revoke all on table public.account_progress from public, anon, authenticated;
revoke all on table public.shared_ip_accounts from public, anon, authenticated;
revoke all on table public.trader_payout_summary from public, anon, authenticated;
grant select on table public.account_progress, public.shared_ip_accounts, public.trader_payout_summary to service_role;

-- Financial and audit mutation functions are internal server operations.
-- PostgreSQL grants function execution to PUBLIC by default, so revoke it
-- explicitly and retain only the service role used by authenticated functions.
revoke all on function public.fn_adjust_balance(uuid,numeric) from public, anon, authenticated;
revoke all on function public.fn_append_audit_event(uuid,text,text,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.fn_approve_payout(uuid,uuid) from public, anon, authenticated;
revoke all on function public.fn_mark_paid(uuid,uuid) from public, anon, authenticated;
revoke all on function public.fn_maybe_award_referral(uuid) from public, anon, authenticated;
revoke all on function public.fn_request_payout(uuid,uuid,boolean,text,uuid) from public, anon, authenticated;
revoke all on function public.fn_void_payout(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.fn_adjust_balance(uuid,numeric) to service_role;
grant execute on function public.fn_append_audit_event(uuid,text,text,uuid,text,text,text) to service_role;
grant execute on function public.fn_approve_payout(uuid,uuid) to service_role;
grant execute on function public.fn_mark_paid(uuid,uuid) to service_role;
grant execute on function public.fn_maybe_award_referral(uuid) to service_role;
grant execute on function public.fn_request_payout(uuid,uuid,boolean,text,uuid) to service_role;
grant execute on function public.fn_void_payout(uuid,uuid,text) to service_role;

-- Trigger and audit helpers use fully-qualified objects (or no relations), so
-- an empty search path removes object-shadowing risk without changing behavior.
alter function public.fn_pii_key() set search_path = '';
alter function public.fn_audit_immutable() set search_path = '';
alter function public.fn_verify_audit_chain() set search_path = '';
alter function public.fn_block_terms_mutation() set search_path = '';
alter function public.fn_block_rule_policy_mutation() set search_path = '';
alter function public.fn_block_capital_reason_on_eligibility() set search_path = '';
alter function public.fn_block_live_without_permission() set search_path = '';
alter function public.fn_block_live_dest_order() set search_path = '';
alter function public.fn_touch_updated_at() set search_path = '';

-- These identity helpers are intentionally used by authenticated RLS policies.
-- Anonymous callers do not need direct execution.
revoke all on function public.fn_is_admin() from public, anon;
revoke all on function public.fn_own_person_id() from public, anon;
grant execute on function public.fn_is_admin(), public.fn_own_person_id() to authenticated, service_role;

-- Cache auth.uid() once per statement instead of evaluating it for every row.
alter policy "own audit read" on public.order_audit_events to authenticated
  using (user_id = (select auth.uid()));
alter policy "own layout read" on public.user_chart_layouts to authenticated
  using (user_id = (select auth.uid()));
alter policy "own pending read" on public.pending_orders to authenticated
  using (user_id = (select auth.uid()));
alter policy "own kyc read" on public.trader_kyc to authenticated
  using (user_id = (select auth.uid()));
alter policy "own payout methods select" on public.payout_methods to authenticated
  using (user_id = (select auth.uid()));
alter policy "own payout methods insert" on public.payout_methods to authenticated
  with check (user_id = (select auth.uid()));
alter policy "own payout methods delete" on public.payout_methods to authenticated
  using (user_id = (select auth.uid()));
alter policy "own referral rewards" on public.referral_rewards to authenticated
  using (referrer_user_id = (select auth.uid()));
alter policy "own consent read" on public.consent_records to authenticated
  using (user_id = (select auth.uid()));

-- Indexes match the highest-volume trading, payout, review, and audit queries.
create index if not exists trades_account_opened_idx
  on public.trades (account_id, opened_at desc);
create index if not exists trades_closed_account_time_idx
  on public.trades (account_id, closed_at desc)
  where status = 'closed' and closed_at is not null;
create index if not exists pending_orders_open_account_idx
  on public.pending_orders (account_id, created_at)
  where status = 'pending';
create index if not exists trade_safety_flags_status_time_idx
  on public.trade_safety_flags (status, created_at desc);
create index if not exists admin_audit_log_time_idx
  on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_log_target_time_idx
  on public.admin_audit_log (target_user_id, created_at desc)
  where target_user_id is not null;
create index if not exists payout_methods_user_time_idx
  on public.payout_methods (user_id, created_at desc);
create index if not exists consent_records_user_time_idx
  on public.consent_records (user_id, accepted_at desc);

-- Preview installers are uploaded in <=40 MiB chunks. Enforce a small margin
-- server-side so a leaked signed URL cannot be used for a very large object.
update storage.buckets
set file_size_limit = 52428800
where id = 'desktop-releases'
  and (file_size_limit is null or file_size_limit > 52428800);

commit;
