-- ============================================================
-- IPFX Capital — activate qualification-v2 for the Infinity Challenge
--
-- 20260909200000_qualification_versions.sql built the whole mechanism
-- (challenge_qualification_versions, account_qualification_contracts,
-- qualification_progress_v2()) and trading-engine's passGate() already
-- calls qualification_progress_v2() on every pass check. But nothing
-- ever INSERTS an account_qualification_contracts row, and the seeded
-- versions are all status='draft' -- so today this entire system is a
-- correctly-designed no-op: qualification_progress_v2() returns
-- {applies:false, eligible:true} for every account and passGate() adds
-- nothing. This activates it for the Infinity Challenge specifically,
-- which is what was asked for: "especially the Infinity Challenge...
-- make it so you can't just pass it within a day or two."
--
-- What "activating" means concretely, from the seeded infinity-v2-s1/2/3
-- rows already in challenge_qualification_versions:
--   Stage 1: 21 calendar days elapsed minimum, 10 meaningful trading
--             days, 20 distinct exposure sessions, no more than 40% of
--             total profit from a single day (consistency rule).
--   Stage 2: 28 days / 15 days / 30 sessions / 30% concentration cap.
--   Stage 3: 42 days / 20 days / 40 sessions / 25% concentration cap.
-- These run ALONGSIDE the existing min_trading_days/min_trades/
-- min_profitable_days_pct columns on trading_accounts (already deployed,
-- already enforced) -- not instead of them. Both gates must clear.
--
-- THIS IS A REAL PRODUCT DECISION, not just a technical wiring task: it
-- adds a multi-week minimum elapsed-time gate to Infinity Stage
-- completion that does not exist today. Review the numbers above before
-- relying on this being deployed -- they are the previously-designed
-- defaults, not something this migration chose independently.
--
-- Safe to run repeatedly (idempotent). Publishing the versions and
-- adding the accept function do nothing by themselves -- see the
-- companion code change in trading-engine (provisionNextStage) and
-- commerce_provision_account() (20260909210000) that actually calls
-- accept_qualification_v2() when a new Infinity account is provisioned.
-- Existing Infinity accounts provisioned before this runs are
-- unaffected unless backfilled explicitly (see the commented backfill
-- at the bottom -- deliberately not run automatically, since applying a
-- new minimum-days gate retroactively to someone already mid-challenge
-- is a fairness call the business should make explicitly).
-- ============================================================

begin;

update public.challenge_qualification_versions
   set status = 'published'
 where id in ('infinity-v2-s1','infinity-v2-s2','infinity-v2-s3')
   and status = 'draft';

-- ---- accept_qualification_v2(account_id): idempotent opt-in ----
-- Called once, right after an account is provisioned. No-op if a
-- published version does not exist for that challenge_type/stage (so
-- Traditional/Futures/PAC accounts, which have no seeded v2 rows yet,
-- are completely unaffected), and no-op if a contract already exists
-- for that account (accept_qualification_v2 can be safely called more
-- than once).
create or replace function public.accept_qualification_v2(p_account_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  acct   record;
  ver    record;
begin
  select id, challenge_type, stage into acct from public.trading_accounts where id = p_account_id;
  if not found then
    return 'ACCOUNT_NOT_FOUND';
  end if;

  if exists (select 1 from public.account_qualification_contracts where account_id = p_account_id) then
    return 'ALREADY_ACCEPTED';
  end if;

  select * into ver from public.challenge_qualification_versions
    where challenge_type = acct.challenge_type and stage = acct.stage and status = 'published'
    order by created_at desc limit 1;
  if not found then
    return 'NO_PUBLISHED_VERSION';
  end if;

  insert into public.account_qualification_contracts
    (account_id, version_id, accepted_at, rules_snapshot, acceptance_reference)
  values
    (p_account_id, ver.id, now(),
     jsonb_build_object(
       'min_elapsed_days', ver.min_elapsed_days,
       'min_trading_days', ver.min_trading_days,
       'min_sessions', ver.min_sessions,
       'max_best_day_share', ver.max_best_day_share,
       'min_daily_net_fraction', ver.min_daily_net_fraction,
       'session_flat_gap_minutes', ver.session_flat_gap_minutes
     ),
     'auto-accepted at provisioning, account_qualification_versions ' || ver.id);

  return 'ACCEPTED:' || ver.id;
end;
$$;

revoke all on function public.accept_qualification_v2(uuid) from public,anon,authenticated;
grant execute on function public.accept_qualification_v2(uuid) to service_role;

commit;

-- ---- OPTIONAL backfill for accounts already provisioned before this
-- migration -- NOT run automatically. Uncomment and run deliberately
-- once you've decided whether existing mid-challenge Infinity traders
-- should be held to this from today, or grandfathered on the old rules.
-- select public.accept_qualification_v2(id) from public.trading_accounts
--   where challenge_type='infinity' and stage between 1 and 3 and status='active';

-- Verify after deploying:
--   select id,status from public.challenge_qualification_versions order by id;
--   select public.accept_qualification_v2('<some evaluation account id>');
--   select public.qualification_progress_v2('<same account id>');
