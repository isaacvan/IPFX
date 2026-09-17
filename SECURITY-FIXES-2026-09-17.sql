-- ============================================================
-- IPFX Capital — security fixes 1, 2 and 5 (2026-09-17)
-- Paste into the Supabase SQL editor and Run. Safe to run again.
--
-- 1. Traders must never write trading data directly. Every legitimate
--    write goes through edge functions using the service role (verified:
--    no page or app writes these tables with a user session). Old
--    database-setup.sql granted "Users can insert/update own trades";
--    this removes every client write policy AND revokes the underlying
--    table privileges, so writes stay blocked even if a policy returns.
--
-- 2. Promo claims move to a server-side function. Previously the only
--    check on challenge_claims inserts was user_id = auth.uid(): a
--    trader could insert a claim with no code, a used-up single-use
--    code, or unlimited claims. redeem_promo_code() validates the code
--    under a row lock, requires a verified email, allows one claim per
--    code per user, and takes the tier from the promo row itself.
--
-- 5. The offline drawdown sweep. The old job sent no Authorization header
--    and the gateway rejected every call, so drawdown was never enforced
--    while traders were offline. The engine now authenticates the sweep
--    itself (x-cron-secret), runs every 10 seconds instead of every
--    minute, and uses a lease so overlapping runs never double-process.
-- ============================================================

begin;

-- ---- 1. Lock client writes on engine-owned tables ----
do $$
declare t text; p record;
begin
  foreach t in array array[
    'trades','trading_accounts','equity_snapshots','pending_orders',
    'order_audit_events','payouts','live_quotes','feed_health_events',
    'security_events','commerce_orders','commerce_events','commerce_outbox',
    'referral_rewards','challenge_claims'
  ] loop
    if to_regclass('public.' || t) is not null then
      -- Write-only policies are removed. FOR ALL policies are left alone
      -- (they may also carry read access); the REVOKE below blocks their
      -- write side regardless, because RLS is evaluated only after the
      -- table privilege check.
      for p in select policyname from pg_policies
               where schemaname = 'public' and tablename = t
                 and cmd in ('INSERT','UPDATE','DELETE') loop
        execute format('drop policy if exists %I on public.%I', p.policyname, t);
      end loop;
      execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- ---- 2. Server-side promo redemption ----
create or replace function public.redeem_promo_code(p_code text, p_account_type text default 'traditional')
returns public.challenge_claims
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_type  text := lower(coalesce(nullif(trim(p_account_type), ''), 'traditional'));
  v_promo public.promo_codes%rowtype;
  v_claim public.challenge_claims%rowtype;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN' using errcode = '28000';
  end if;
  if v_type not in ('traditional', 'futures') then
    raise exception 'INVALID_ACCOUNT_TYPE' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users where id = v_uid and email_confirmed_at is not null) then
    raise exception 'EMAIL_NOT_VERIFIED' using errcode = '42501';
  end if;

  -- Serialise one user's redemptions, then lock the code row so two
  -- people can never both take the last use of a single-use code.
  perform pg_advisory_xact_lock(hashtextextended('redeem_promo:' || v_uid::text, 0));
  select * into v_promo from public.promo_codes
   where upper(code) = upper(trim(p_code))
   order by code limit 1
   for update;

  if not found
     or v_promo.is_active is not true
     or (v_promo.max_uses is not null and v_promo.use_count >= v_promo.max_uses) then
    raise exception 'PROMO_INVALID' using errcode = '22023';
  end if;

  if exists (select 1 from public.challenge_claims
              where user_id = v_uid and promo_code = v_promo.code) then
    raise exception 'PROMO_ALREADY_CLAIMED' using errcode = '23505';
  end if;

  -- use_count is incremented by the existing trg_promo_use_count trigger.
  insert into public.challenge_claims (user_id, promo_code, challenge_type, challenge_name, account_type)
  values (v_uid, v_promo.code, v_promo.challenge_type, v_promo.challenge_name, v_type)
  returning * into v_claim;

  return v_claim;
end;
$$;

revoke all on function public.redeem_promo_code(text, text) from public, anon;
grant execute on function public.redeem_promo_code(text, text) to authenticated;

-- One claim per code per user at the database level too. Skipped (with a
-- notice) if historic duplicates already exist, so this file never fails.
do $$
begin
  create unique index if not exists challenge_claims_user_code_uniq
    on public.challenge_claims (user_id, promo_code) where promo_code is not null;
exception when unique_violation then
  raise notice 'challenge_claims has duplicate (user_id, promo_code) rows — unique index skipped; review them with the query at the bottom of this file';
end $$;

commit;

-- ---- 5a. Sweep lease ----
begin;
create table if not exists public.engine_sweep_lease (
  id boolean primary key default true check (id),
  locked_until timestamptz not null default 'epoch'
);
insert into public.engine_sweep_lease (id) values (true) on conflict (id) do nothing;
alter table public.engine_sweep_lease enable row level security;
revoke all on public.engine_sweep_lease from anon, authenticated;

create or replace function public.claim_engine_sweep(p_seconds int default 55)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.engine_sweep_lease
     set locked_until = now() + make_interval(secs => greatest(5, least(coalesce(p_seconds, 55), 120)))
   where id and locked_until < now();
  return found;
end $$;

create or replace function public.release_engine_sweep()
returns void language sql security definer set search_path = public as $$
  update public.engine_sweep_lease set locked_until = now() where id;
$$;

revoke all on function public.claim_engine_sweep(int) from public, anon, authenticated;
revoke all on function public.release_engine_sweep() from public, anon, authenticated;
grant execute on function public.claim_engine_sweep(int) to service_role;
grant execute on function public.release_engine_sweep() to service_role;
commit;

-- ---- 5b. Reschedule the sweep every 10 seconds with the engine's secret ----
do $$
declare cmd text := $cmd$
  select net.http_post(
    url := 'https://agulweemteoeagscmppy.supabase.co/functions/v1/trading-engine',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body := jsonb_build_object('action', 'sweep'),
    timeout_milliseconds := 30000
  );
$cmd$;
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'ipfx-drawdown-sweep';
  begin
    perform cron.schedule('ipfx-drawdown-sweep', '10 seconds', cmd);
  exception when others then
    raise notice 'sub-minute schedules unavailable (%); scheduling every minute instead', sqlerrm;
    perform cron.schedule('ipfx-drawdown-sweep', '* * * * *', cmd);
  end;
end $$;

-- ---- Verification (single result row) ----
-- Expect: client_write_policies_left = 0, client_can_insert_trades = false,
-- client_can_update_accounts = false, client_can_insert_claims = false,
-- redeem_fn_present = 1, sweep_lease_present = 1, sweep_schedule = '10 seconds'.
-- The last four columns are REPORTS, not errors — see notes below.
select
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('trades','trading_accounts','challenge_claims')
      and cmd in ('INSERT','UPDATE','DELETE'))                                   as client_write_policies_left,
  has_table_privilege('authenticated', 'public.trades', 'INSERT')                 as client_can_insert_trades,
  has_table_privilege('authenticated', 'public.trading_accounts', 'UPDATE')       as client_can_update_accounts,
  has_table_privilege('authenticated', 'public.challenge_claims', 'INSERT')       as client_can_insert_claims,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'redeem_promo_code')               as redeem_fn_present,
  (select count(*) from public.challenge_claims where promo_code is null)         as claims_without_code,
  (select count(*) from public.trading_accounts where preset_id is null)          as accounts_without_preset,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_engine_sweep')              as sweep_lease_present,
  (select schedule from cron.job where jobname = 'ipfx-drawdown-sweep')           as sweep_schedule;

-- NOTES ON THE REPORT COLUMNS
-- claims_without_code > 0: claims inserted without any promo code — the
--   old hole. Review with:
--     select * from public.challenge_claims where promo_code is null order by created_at;
-- accounts_without_preset > 0: accounts created by the old free
--   auto-provisioning in the trading engine (no payment, no claim). Review with:
--     select id, user_id, label, starting_balance, status, phase, created_at
--     from public.trading_accounts where preset_id is null order by created_at;
