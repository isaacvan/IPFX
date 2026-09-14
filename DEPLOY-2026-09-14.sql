-- ============================================================================
--  IPFX Capital — consolidated deployment, 2026-09-14
--
--  Paste this WHOLE file into the Supabase SQL editor and click Run once.
--  It applies, in dependency order, the three migrations confirmed NOT yet
--  live in production (checked 2026-09-14):
--
--    1. Promo-code exposure fix  (validate_promo_code was missing -> the
--       promo_codes table was still readable by the public anon key)
--    2. Trader detector core      (all trader_detector_* tables were 404)
--    3. Trader detector hardening (v2 audit repairs + calibration gates)
--
--  Safe to run: section 1 is idempotent (drop-if-exists / create-or-replace);
--  sections 2 and 3 create fresh objects that do not exist yet, each wrapped
--  in its own transaction so a failure rolls back cleanly with nothing
--  half-applied. If a section reports "already exists", that section was
--  already deployed -- delete it and re-run the rest.
--
--  NOT included here (uncertain state, and unsafe to blindly re-run):
--    commerce provisioning / trade-safety v2 / qualification v2 / receipt
--    leases. Deploy those from their own migration files only if you know
--    they haven't run.
--
--  After this: redeploy the `admin-console` EDGE FUNCTION so the owner board
--  shows detector states (that is a function deploy, not SQL), and deploy the
--  `trader-detector` edge function + set TRADER_DETECTOR_CRON_SECRET to start
--  populating states. The detector stays SHADOW/uncalibrated until validated.
-- ============================================================================


-- ============================================================================
--  SECTION 1 / 3 — Promo-code exposure fix
-- ============================================================================
-- ============================================================
-- FIX: promo_codes fully readable by anonymous visitors (2026-09-08)
--
-- FOUND: `select * from promo_codes` with the public anon key (which is
-- embedded in the page source of every page) returned all 6 active promo
-- codes. Three of them had max_uses = NULL, i.e. unlimited free 100K
-- Challenges. Anyone who opened devtools, or simply curled the REST API
-- with the public key, could enumerate every code and redeem them.
-- Writes were already correctly blocked by RLS; this was read exposure.
--
-- SECOND ISSUE: the client validated a code with
--   .select(...).eq('code', code).eq('is_active', true)
-- which never compared use_count against max_uses. Exhaustion depended
-- entirely on the trg_promo_use_count trigger flipping is_active to
-- false. That is a single point of failure for a revenue control.
--
-- FIX: promo codes are no longer selectable from the client at all.
-- Validation goes through a SECURITY DEFINER function that takes one
-- code and returns only that code's display fields — never the list.
-- The function re-checks exhaustion itself rather than trusting
-- is_active alone, so the cap holds even if the trigger is missing.
--
-- Note `SET search_path = public` — omitting it on a SECURITY DEFINER
-- function is what broke signup earlier today (see
-- fix-signup-search-path.sql).
-- ============================================================

-- 1. Validation RPC: one code in, that code's details out (or nothing).
create or replace function public.validate_promo_code(p_code text)
returns table (code text, challenge_name text, challenge_type text)
language sql
stable
security definer
set search_path = public
as $$
  select pc.code, pc.challenge_name, pc.challenge_type
  from public.promo_codes pc
  where upper(pc.code) = upper(trim(p_code))
    and pc.is_active = true
    and (pc.max_uses is null or pc.use_count < pc.max_uses)
  limit 1;
$$;

revoke all on function public.validate_promo_code(text) from public;
grant execute on function public.validate_promo_code(text) to anon, authenticated;

-- 2. Remove the blanket read exposure. Drop every existing SELECT policy
--    on promo_codes, then deliberately add none back: the table is now
--    reachable only through validate_promo_code() (security definer) and
--    by service_role, which bypasses RLS.
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='promo_codes'
  loop
    execute format('drop policy if exists %I on public.promo_codes;', p.policyname);
  end loop;
end $$;

alter table public.promo_codes enable row level security;

-- 2b. Harden the redemption counter. increment_promo_use_count() is the
--     function that makes the max_uses cap actually bite, and it is
--     SECURITY DEFINER (so it keeps working once RLS locks the table).
--     But it was missing `SET search_path` and referenced `promo_codes`
--     unqualified -- the exact defect that broke signup earlier today.
--     A SECURITY DEFINER function inherits the CALLER's search_path, so
--     any caller whose search_path omits public would silently fail to
--     increment the counter, and single-use codes would stay redeemable.
--     Recreated here identically except for the qualification and the
--     search_path pin. The trigger itself is unchanged and does not need
--     to be redefined.
create or replace function public.increment_promo_use_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.promo_code is not null then
    update public.promo_codes
    set
      use_count = use_count + 1,
      is_active = case
        when max_uses is not null and (use_count + 1) >= max_uses then false
        else is_active
      end
    where code = NEW.promo_code;
  end if;
  return NEW;
end;
$$;

-- 3. Verify: this should return zero policies, and the RPC should still
--    resolve a known-good code.
select
  (select count(*) from pg_policies where schemaname='public' and tablename='promo_codes') as remaining_policies,
  (select count(*) from public.validate_promo_code('ADENIJI100K')) as rpc_resolves_known_code,
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('validate_promo_code','increment_promo_use_count')
      and p.proconfig::text like '%search_path=public%') as functions_with_search_path_pinned;


-- ============================================================================
--  SECTION 2 / 3 — Trader detector: core tables, policies, immutable
--  assessments, alert outbox, states  (wrapped in a transaction here)
-- ============================================================================
begin;
-- IPFX Capital challenge-specific trader detector persistence and alert outbox.
--
-- Safe-by-default invariants:
--   * policies start SHADOW_UNCALIBRATED;
--   * uncalibrated policies cannot record a profitability confirmation;
--   * no row in this subsystem can enable live trading;
--   * detector states cannot approve/deny contractual payouts;
--   * assessments are immutable and alerts are idempotent.

-- Decision-grade cost and regime provenance. Existing rows remain null and
-- therefore cannot be mistaken for complete evidence.
alter table public.trades
  add column if not exists commission numeric(20,6),
  add column if not exists financing numeric(20,6),
  add column if not exists execution_shortfall numeric(20,6),
  add column if not exists decision_price numeric(20,8),
  add column if not exists market_regime text,
  add column if not exists execution_latency_ms numeric(20,4),
  add column if not exists detector_data_version integer;

comment on column public.trades.commission is
  'Explicit execution cost; null means unknown, not zero.';
comment on column public.trades.execution_shortfall is
  'Adverse execution versus decision_price; null blocks confirmation-grade data quality.';
comment on column public.trades.market_regime is
  'Point-in-time, versioned market-regime label; null blocks confirmation-grade regime coverage.';

create table public.trader_detector_policy_versions (
  id uuid primary key default gen_random_uuid(),
  challenge_type text not null check(challenge_type in ('infinity','traditional','futures','pac')),
  version integer not null check(version > 0),
  status text not null check(status in ('DRAFT','SHADOW_UNCALIBRATED','VALIDATED','RETIRED')),
  thresholds jsonb not null check(jsonb_typeof(thresholds) = 'object'),
  challenge_rule_source text not null,
  training_cutoff_at timestamptz,
  validation_reference text,
  model_sha256 text check(model_sha256 is null or model_sha256 ~ '^[0-9a-fA-F]{64}$'),
  live_enabled boolean not null default false check(live_enabled = false),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique(challenge_type, version),
  check(status <> 'VALIDATED' or (
    validation_reference is not null and model_sha256 is not null and training_cutoff_at is not null
  ))
);

create unique index trader_detector_one_current_policy
  on public.trader_detector_policy_versions(challenge_type)
  where status in ('SHADOW_UNCALIBRATED','VALIDATED');

create or replace function public.trader_detector_policy_version_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'TRADER_DETECTOR_POLICY_VERSIONS_ARE_IMMUTABLE';
  end if;
  if new.challenge_type is distinct from old.challenge_type
    or new.version is distinct from old.version
    or new.thresholds is distinct from old.thresholds
    or new.challenge_rule_source is distinct from old.challenge_rule_source
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or new.live_enabled is distinct from old.live_enabled then
    raise exception 'TRADER_DETECTOR_POLICY_CONTENT_IS_IMMUTABLE';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'DRAFT' and new.status in ('SHADOW_UNCALIBRATED','RETIRED')) or
    (old.status = 'SHADOW_UNCALIBRATED' and new.status in ('VALIDATED','RETIRED')) or
    (old.status = 'VALIDATED' and new.status = 'RETIRED')
  ) then
    raise exception 'INVALID_TRADER_DETECTOR_POLICY_STATUS_TRANSITION';
  end if;
  if old.status = 'RETIRED' then
    raise exception 'RETIRED_TRADER_DETECTOR_POLICY_IS_IMMUTABLE';
  end if;
  if old.status = 'VALIDATED' and (
    new.training_cutoff_at is distinct from old.training_cutoff_at or
    new.validation_reference is distinct from old.validation_reference or
    new.model_sha256 is distinct from old.model_sha256
  ) then
    raise exception 'VALIDATED_TRADER_DETECTOR_EVIDENCE_IS_IMMUTABLE';
  end if;
  return new;
end $$;

create trigger trader_detector_policy_version_guard
before update or delete on public.trader_detector_policy_versions
for each row execute function public.trader_detector_policy_version_guard();

create table public.trader_detector_pac_validations (
  id uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_accounts(id),
  strategy_disclosed boolean not null default false,
  track_record_verified boolean not null default false,
  out_of_sample_replicated boolean not null default false,
  stress_test_passed boolean not null default false,
  evidence jsonb not null default '{}' check(jsonb_typeof(evidence) = 'object'),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(trading_account_id)
);

create table public.trader_detector_copyability_snapshots (
  id uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_accounts(id),
  as_of_at timestamptz not null,
  shadow_ideas integer not null check(shadow_ideas >= 0),
  fill_rate numeric(12,10) check(fill_rate between 0 and 1),
  reject_rate numeric(12,10) check(reject_rate between 0 and 1),
  median_slippage_bps numeric(18,8),
  p95_latency_ms numeric(18,4),
  source_net_pnl numeric(20,6),
  destination_net_pnl numeric(20,6),
  portfolio_correlation numeric(12,10) check(portfolio_correlation between -1 and 1),
  provider_authorised boolean not null default false,
  reserve_capacity_available boolean not null default false,
  provenance jsonb not null default '{}' check(jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  unique(trading_account_id, as_of_at)
);
create index trader_detector_copyability_account_idx
  on public.trader_detector_copyability_snapshots(trading_account_id, as_of_at desc);

create table public.trader_detector_assessments (
  id uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_accounts(id),
  user_id uuid not null references auth.users(id),
  policy_id uuid not null references public.trader_detector_policy_versions(id),
  as_of_at timestamptz not null,
  source_cutoff_at timestamptz not null,
  state text not null check(state in (
    'INSUFFICIENT_EVIDENCE','OBSERVE','HIGH_POTENTIAL',
    'PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED','RISK_NO_GO'
  )),
  probability_status text not null check(probability_status in (
    'INSUFFICIENT_EVIDENCE','DESCRIPTIVE_UNCALIBRATED','CALIBRATED'
  )),
  probability_edge_positive numeric(12,10) check(probability_edge_positive between 0 and 1),
  posterior_mean_bps numeric(20,8),
  posterior_sd_bps numeric(20,8) check(posterior_sd_bps is null or posterior_sd_bps >= 0),
  lower_90_bps numeric(20,8),
  independent_idea_count integer not null check(independent_idea_count >= 0),
  effective_sample_size numeric(20,8) not null check(effective_sample_size >= 0),
  active_trading_days integer not null check(active_trading_days >= 0),
  data_quality numeric(12,10) not null check(data_quality between 0 and 1),
  copyability_score numeric(12,10) check(copyability_score between 0 and 1),
  metrics jsonb not null check(jsonb_typeof(metrics) = 'object'),
  gates jsonb not null check(jsonb_typeof(gates) = 'array'),
  reasons jsonb not null check(jsonb_typeof(reasons) = 'array'),
  evidence_sha256 text not null check(evidence_sha256 ~ '^[0-9a-fA-F]{64}$'),
  live_enabled boolean not null default false check(live_enabled = false),
  created_at timestamptz not null default now(),
  check(source_cutoff_at <= as_of_at),
  unique(trading_account_id, policy_id, evidence_sha256)
);
create index trader_detector_assessment_account_idx
  on public.trader_detector_assessments(trading_account_id, as_of_at desc);
create index trader_detector_assessment_state_idx
  on public.trader_detector_assessments(state, as_of_at desc);

create table public.trader_detector_states (
  trading_account_id uuid primary key references public.trading_accounts(id),
  assessment_id uuid not null references public.trader_detector_assessments(id),
  state text not null check(state in (
    'INSUFFICIENT_EVIDENCE','OBSERVE','HIGH_POTENTIAL',
    'PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED','RISK_NO_GO'
  )),
  state_since timestamptz not null default now(),
  previous_state text,
  updated_at timestamptz not null default now()
);

create table public.trader_detector_alerts (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.trader_detector_assessments(id),
  trading_account_id uuid not null references public.trading_accounts(id),
  alert_type text not null check(alert_type in (
    'HIGH_POTENTIAL','PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED','RISK_DETERIORATION'
  )),
  severity text not null check(severity in ('medium','high','critical')),
  title text not null,
  body text not null,
  payload jsonb not null default '{}' check(jsonb_typeof(payload) = 'object'),
  dedup_key text not null unique,
  status text not null default 'pending' check(status in ('pending','processing','sent','failed','dead_letter')),
  attempts integer not null default 0 check(attempts >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_message_id text,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index trader_detector_alert_pending_idx
  on public.trader_detector_alerts(created_at)
  where status in ('pending','failed');

create table public.trader_detector_run_log (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check(status in ('RUNNING','COMPLETE','PARTIAL','FAILED')),
  accounts_seen integer not null default 0,
  assessments_written integer not null default 0,
  alerts_queued integer not null default 0,
  errors jsonb not null default '[]' check(jsonb_typeof(errors) = 'array'),
  worker_version text not null
);

create or replace function public.trader_detector_assessment_guard()
returns trigger language plpgsql set search_path = '' as $$
declare policy_status text;
begin
  select status into policy_status
  from public.trader_detector_policy_versions where id = new.policy_id;

  if new.state in ('PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED') then
    if policy_status <> 'VALIDATED' or new.probability_status <> 'CALIBRATED' then
      raise exception 'CALIBRATED_VALIDATED_POLICY_REQUIRED';
    end if;
  end if;
  if new.state = 'LIVE_REVIEW_REQUIRED' and not (
    coalesce((new.gates @> '[{"key":"copyability","status":"PASS"}]'::jsonb), false) and
    coalesce((new.gates @> '[{"key":"portfolio_correlation","status":"PASS"}]'::jsonb), false) and
    coalesce((new.gates @> '[{"key":"provider_authorisation","status":"PASS"}]'::jsonb), false) and
    coalesce((new.gates @> '[{"key":"reserve_capacity","status":"PASS"}]'::jsonb), false)
  ) then
    raise exception 'LIVE_REVIEW_GATES_REQUIRED';
  end if;
  return new;
end $$;

create trigger trader_detector_assessment_guard
before insert or update on public.trader_detector_assessments
for each row execute function public.trader_detector_assessment_guard();

create or replace function public.trader_detector_reject_assessment_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'TRADER_DETECTOR_ASSESSMENTS_ARE_IMMUTABLE';
end $$;

create trigger trader_detector_assessment_immutable
before update or delete on public.trader_detector_assessments
for each row execute function public.trader_detector_reject_assessment_mutation();

create or replace function public.trader_detector_claim_alert(p_max_attempts integer default 5)
returns public.trader_detector_alerts
language plpgsql security definer set search_path = '' as $$
declare job public.trader_detector_alerts;
begin
  update public.trader_detector_alerts
  set status = case when attempts >= p_max_attempts then 'dead_letter' else 'failed' end,
      last_error = coalesce(last_error, 'LEASE_EXPIRED'), lease_token = null, lease_expires_at = null
  where status = 'processing' and lease_expires_at < now();

  select * into job from public.trader_detector_alerts
  where status in ('pending','failed') and attempts < p_max_attempts
  order by case severity when 'critical' then 1 when 'high' then 2 else 3 end, created_at
  for update skip locked limit 1;
  if job.id is null then return null; end if;

  update public.trader_detector_alerts
  set status = 'processing', attempts = attempts + 1,
      lease_token = gen_random_uuid(), lease_expires_at = now() + interval '2 minutes'
  where id = job.id returning * into job;
  return job;
end $$;

-- The policies below are intentionally shadow-only hypotheses. They configure
-- when an owner gets an early review alert; they are not contractual rules.
insert into public.trader_detector_policy_versions
  (challenge_type,version,status,thresholds,challenge_rule_source)
values
('infinity',1,'SHADOW_UNCALIBRATED',
 '{"minPotentialEss":12,"minPotentialDays":5,"minPotentialProbability":0.78,"minConfirmedEss":40,"minConfirmedDays":20,"minConfirmedProbability":0.90,"minConfirmedEdgeBps":1,"minConfirmedStage":3,"minPositiveStages":2,"minRegimes":2,"maxSymbolHhi":0.65,"maxBestIdeaShare":0.35,"maxDrawdownFraction":0.08,"maxTailLossMultiple":4,"maxPortfolioCorrelation":0.35,"minCopyIdeas":30,"minCopyability":0.70,"priorMeanBps":0,"priorStdBps":8}',
 'immutable trading_account preset/rule snapshot; website is display-only'),
('traditional',1,'SHADOW_UNCALIBRATED',
 '{"minPotentialEss":12,"minPotentialDays":5,"minPotentialProbability":0.78,"minConfirmedEss":30,"minConfirmedDays":12,"minConfirmedProbability":0.90,"minConfirmedEdgeBps":1,"minConfirmedStage":3,"minPositiveStages":2,"minRegimes":2,"maxSymbolHhi":0.65,"maxBestIdeaShare":0.35,"maxDrawdownFraction":0.06,"maxTailLossMultiple":4,"maxPortfolioCorrelation":0.35,"minCopyIdeas":30,"minCopyability":0.72,"priorMeanBps":0,"priorStdBps":8}',
 'immutable trading_account preset/rule snapshot; website currently contains conflicting legacy values'),
('futures',1,'SHADOW_UNCALIBRATED',
 '{"minPotentialEss":15,"minPotentialDays":4,"minPotentialProbability":0.80,"minConfirmedEss":35,"minConfirmedDays":10,"minConfirmedProbability":0.92,"minConfirmedEdgeBps":1,"minConfirmedStage":2,"minPositiveStages":2,"minRegimes":2,"maxSymbolHhi":0.75,"maxBestIdeaShare":0.30,"maxDrawdownFraction":0.04,"maxTailLossMultiple":3.5,"maxPortfolioCorrelation":0.30,"minCopyIdeas":35,"minCopyability":0.78,"priorMeanBps":0,"priorStdBps":8}',
 'immutable trading_account preset/rule snapshot; EOD trailing drawdown requires futures-specific handling'),
('pac',1,'SHADOW_UNCALIBRATED',
 '{"minPotentialEss":30,"minPotentialDays":15,"minPotentialProbability":0.82,"minConfirmedEss":60,"minConfirmedDays":30,"minConfirmedProbability":0.95,"minConfirmedEdgeBps":1.5,"minConfirmedStage":1,"minPositiveStages":1,"minRegimes":3,"maxSymbolHhi":0.60,"maxBestIdeaShare":0.25,"maxDrawdownFraction":0.08,"maxTailLossMultiple":3,"maxPortfolioCorrelation":0.30,"minCopyIdeas":40,"minCopyability":0.80,"priorMeanBps":0,"priorStdBps":8}',
 'individually agreed PAC contract plus verified track record and holdout evidence')
on conflict(challenge_type,version) do nothing;

do $$ declare table_name text; begin
  foreach table_name in array array[
    'trader_detector_policy_versions','trader_detector_pac_validations',
    'trader_detector_copyability_snapshots','trader_detector_assessments',
    'trader_detector_states','trader_detector_alerts','trader_detector_run_log'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.fn_is_admin()))',
      table_name || '_owner_read', table_name);
  end loop;
end $$;

revoke all on function public.trader_detector_claim_alert(integer) from public, anon, authenticated;
grant execute on function public.trader_detector_claim_alert(integer) to service_role;

comment on table public.trader_detector_assessments is
  'Immutable review recommendations. Never determines contractual payout eligibility and never enables live trading.';
comment on table public.trader_detector_alerts is
  'Idempotent owner-alert outbox for high-potential, confirmed, live-review, and deterioration transitions.';
comment on table public.trader_detector_policy_versions is
  'Threshold content is immutable. Validation metadata/status may advance only for the exact frozen version.';

commit;


-- ============================================================================
--  SECTION 3 / 3 — Trader detector: hardening (scan leases, calibration,
--  forecasts, risk reviews, commit/record functions)  -- already transactional
-- ============================================================================
-- Transactional detector persistence and independently bound decision evidence.
begin;

create table public.trader_detector_scan_control (
  singleton boolean primary key default true check(singleton),
  after_account_id uuid,
  lease_token uuid,
  lease_expires_at timestamptz
);
insert into public.trader_detector_scan_control(singleton) values(true);
alter table public.trader_detector_scan_control enable row level security;
alter table public.trader_detector_scan_control force row level security;
revoke all on public.trader_detector_scan_control from public,anon,authenticated,service_role;
create function public.trader_detector_claim_scan() returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.trader_detector_scan_control;
begin
  select * into s from public.trader_detector_scan_control where singleton for update;
  if s.lease_expires_at>clock_timestamp() then return null; end if;
  update public.trader_detector_scan_control set lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '10 minutes'
    where singleton returning * into s;
  return jsonb_build_object('lease_token',s.lease_token,'after_account_id',s.after_account_id);
end $$;
create function public.trader_detector_finish_scan(p_lease_token uuid,p_after_account_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  update public.trader_detector_scan_control set after_account_id=p_after_account_id,lease_token=null,lease_expires_at=null
    where singleton and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
  if not found then raise exception 'SCAN_LEASE_LOST'; end if;
end $$;
revoke all on function public.trader_detector_claim_scan() from public,anon,authenticated;
revoke all on function public.trader_detector_finish_scan(uuid,uuid) from public,anon,authenticated;
grant execute on function public.trader_detector_claim_scan() to service_role;
grant execute on function public.trader_detector_finish_scan(uuid,uuid) to service_role;

alter table public.trader_detector_states
  add column data_status text not null default 'OK' check(data_status in ('OK','ERROR')),
  add column last_error text,
  add column last_checked_at timestamptz not null default now();

alter table public.trades
  add column if not exists pnl_basis text check(pnl_basis in ('NET_AFTER_COSTS','GROSS_BEFORE_COSTS')),
  add column if not exists detector_stage integer check(detector_stage > 0);

-- A policy status alone is not evidence of predictive calibration.
create table public.trader_detector_calibrations (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.trader_detector_policy_versions(id),
  model_sha256 text not null check(model_sha256 ~ '^[0-9a-f]{64}$'),
  outcome_definition text not null check(length(outcome_definition) >= 20),
  horizon_days integer not null check(horizon_days > 0),
  training_cutoff_at timestamptz not null,
  validation_start_at timestamptz not null,
  validation_end_at timestamptz not null,
  sample_count integer not null check(sample_count > 0),
  metrics jsonb not null check(jsonb_typeof(metrics) = 'object'),
  evidence_sha256 text not null check(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  validation_reference text not null check(length(validation_reference) > 0),
  trader_holdout_verified boolean not null,
  prospective_verified boolean not null,
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null,
  expires_at timestamptz not null,
  check(training_cutoff_at < validation_start_at and validation_start_at < validation_end_at),
  check(validation_end_at <= approved_at and approved_at < expires_at),
  check(trader_holdout_verified and prospective_verified),
  created_at timestamptz not null default now()
);

create table public.trader_detector_forecasts (
  id uuid primary key default gen_random_uuid(),
  calibration_id uuid not null references public.trader_detector_calibrations(id),
  trading_account_id uuid not null references public.trading_accounts(id),
  policy_id uuid not null references public.trader_detector_policy_versions(id),
  input_sha256 text not null check(input_sha256 ~ '^[0-9a-f]{64}$'),
  source_cutoff_at timestamptz not null,
  predicted_at timestamptz not null,
  expires_at timestamptz not null,
  probability numeric(12,10) not null check(probability between 0 and 1),
  created_at timestamptz not null default now(),
  check(source_cutoff_at <= predicted_at and predicted_at < expires_at)
);

-- Risk evidence must reconcile open positions and transfers, not just closed PnL.
create table public.trader_detector_risk_reviews (
  id uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_accounts(id),
  policy_id uuid not null references public.trader_detector_policy_versions(id),
  input_sha256 text not null check(input_sha256 ~ '^[0-9a-f]{64}$'),
  source_cutoff_at timestamptz not null,
  as_of_at timestamptz not null,
  expires_at timestamptz not null,
  reconciled boolean not null,
  complete_history boolean not null,
  open_positions_marked boolean not null,
  cash_flows_reconciled boolean not null,
  rule_breach boolean not null,
  equity numeric(20,6) not null,
  daily_floor numeric(20,6) not null check(daily_floor>=0),
  total_floor numeric(20,6) not null check(total_floor>=0),
  stressed_open_loss numeric(20,6) not null check(stressed_open_loss>=0),
  rule_snapshot_id uuid not null references public.a_book_rule_snapshots(id),
  evidence_reference text not null check(length(evidence_reference) > 0),
  audit_sha256 text not null check(audit_sha256 ~ '^[0-9a-f]{64}$'),
  verified_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check(source_cutoff_at <= as_of_at and as_of_at < expires_at)
);

alter table public.trader_detector_assessments
  add column input_sha256 text check(input_sha256 ~ '^[0-9a-f]{64}$'),
  add column forecast_id uuid references public.trader_detector_forecasts(id),
  add column risk_review_id uuid references public.trader_detector_risk_reviews(id),
  add column copy_review_id uuid references public.trader_detector_copyability_snapshots(id),
  add column calibrated_future_probability numeric(12,10) check(calibrated_future_probability between 0 and 1);

create or replace function public.trader_detector_assessment_guard()
returns trigger language plpgsql set search_path = '' as $$
declare p public.trader_detector_policy_versions; a public.trading_accounts;
  f public.trader_detector_forecasts; c public.trader_detector_calibrations;
  r public.trader_detector_risk_reviews; cp public.trader_detector_copyability_snapshots; g text;
begin
  select * into p from public.trader_detector_policy_versions where id=new.policy_id;
  select * into a from public.trading_accounts where id=new.trading_account_id;
  if a.user_id is distinct from new.user_id or a.challenge_type is distinct from p.challenge_type then
    raise exception 'DETECTOR_ACCOUNT_POLICY_IDENTITY_MISMATCH';
  end if;
  if new.probability_status='CALIBRATED' then
    raise exception 'DESCRIPTIVE_POSTERIOR_IS_NOT_CALIBRATED_FORECAST';
  end if;
  if new.as_of_at > clock_timestamp()+interval '1 minute' then raise exception 'FUTURE_ASSESSMENT'; end if;
  if new.forecast_id is not null then
    select * into f from public.trader_detector_forecasts where id=new.forecast_id;
    select * into c from public.trader_detector_calibrations where id=f.calibration_id;
    if f.trading_account_id is distinct from new.trading_account_id or f.policy_id is distinct from new.policy_id
      or c.policy_id is distinct from new.policy_id or c.model_sha256 is distinct from lower(p.model_sha256)
      or f.input_sha256 is distinct from new.input_sha256 or f.source_cutoff_at is distinct from new.source_cutoff_at
      or f.predicted_at > new.as_of_at or f.expires_at <= new.as_of_at
      or c.approved_at > f.predicted_at or c.expires_at <= new.as_of_at
      or c.training_cutoff_at is distinct from p.training_cutoff_at then
      raise exception 'FORECAST_EVIDENCE_BINDING_INVALID';
    end if;
    new.calibrated_future_probability:=f.probability;
  elsif new.calibrated_future_probability is not null then raise exception 'FORECAST_REQUIRED';
  end if;
  if new.state in ('PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED') then
    if p.status <> 'VALIDATED' or new.forecast_id is null or new.risk_review_id is null
      or new.input_sha256 is null or f.probability < (p.thresholds->>'minConfirmedProbability')::numeric then
      raise exception 'VALIDATED_FORECAST_AND_RISK_EVIDENCE_REQUIRED';
    end if;
    select * into r from public.trader_detector_risk_reviews where id=new.risk_review_id;
    if r.trading_account_id is distinct from new.trading_account_id or r.policy_id is distinct from new.policy_id or r.input_sha256 is distinct from new.input_sha256
      or r.source_cutoff_at is distinct from new.source_cutoff_at or r.as_of_at > new.as_of_at
      or not r.reconciled or not r.complete_history or not r.open_positions_marked or not r.cash_flows_reconciled
      or r.rule_breach or r.equity-r.stressed_open_loss<=greatest(r.daily_floor,r.total_floor)
      or r.expires_at <= new.as_of_at or not exists(select 1 from public.a_book_rule_snapshots s
        where s.id=r.rule_snapshot_id and s.trading_account_id=new.trading_account_id and s.effective_at<=new.source_cutoff_at) then
      raise exception 'RISK_EVIDENCE_BINDING_INVALID';
    end if;
    if a.status='breached' then raise exception 'BREACHED_ACCOUNT_CANNOT_CONFIRM'; end if;
    foreach g in array array['accounting_basis','mark_to_market_risk','rule_snapshot','trade_stage_provenance','no_critical_risk',
      'validation_evidence','data_quality','confirmed_effective_evidence','confirmed_days','challenge_stage',
      'positive_stages','regime_coverage','concentration','stability','tail_risk','pac_validation','calibration'] loop
      if not(new.gates @> jsonb_build_array(jsonb_build_object('key',g,'status','PASS'))) then
        raise exception 'CONFIRMATION_GATE_REQUIRED:%',g;
      end if;
    end loop;
  end if;
  if new.state='LIVE_REVIEW_REQUIRED' then
    select * into cp from public.trader_detector_copyability_snapshots where id=new.copy_review_id;
    if cp.id is null or cp.trading_account_id is distinct from new.trading_account_id or
      cp.provenance->>'policy_id' is distinct from new.policy_id::text or
      cp.provenance->>'input_sha256' is distinct from new.input_sha256 or
      cp.as_of_at>new.as_of_at or cp.as_of_at<new.as_of_at-interval '5 minutes' or
      coalesce((cp.provenance->>'expires_at')::timestamptz,new.as_of_at)<=new.as_of_at or
      not coalesce((cp.provenance->>'matched_ideas_complete')::boolean,false) or
      not coalesce((cp.provenance->>'risk_normalised')::boolean,false) or
      coalesce((cp.provenance->>'net_edge_lower90_bps')::numeric,0)<=0 or
      nullif(cp.provenance->>'provider_permission_reference','') is null or
      nullif(cp.provenance->>'reserve_review_reference','') is null or
      nullif(cp.provenance->>'verified_by','') is null or
      not coalesce((cp.provenance->>'audit_sha256')~'^[a-f0-9]{64}$',false) or
      not cp.provider_authorised or not cp.reserve_capacity_available or
      cp.shadow_ideas<(p.thresholds->>'minCopyIdeas')::integer then
      raise exception 'MATCHED_COPY_EVIDENCE_REQUIRED';
    end if;
    foreach g in array array['copyability','portfolio_correlation','provider_authorisation','reserve_capacity'] loop
      if not(new.gates @> jsonb_build_array(jsonb_build_object('key',g,'status','PASS'))) then
        raise exception 'LIVE_REVIEW_GATE_REQUIRED:%',g;
      end if;
    end loop;
  end if;
  return new;
end $$;

-- One transaction owns assessment, current state, and transition alert. Lock the
-- account row because there may be no state row yet. CAS prevents stale workers.
create function public.trader_detector_commit_assessment(p_assessment jsonb,p_expected_assessment_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare n public.trader_detector_assessments; prior public.trader_detector_states;
  existing public.trader_detector_assessments; event_type text; event_severity text; event_count integer:=0;
begin
  n:=jsonb_populate_record(null::public.trader_detector_assessments,p_assessment);
  perform 1 from public.trading_accounts where id=n.trading_account_id for update;
  if not found then raise exception 'DETECTOR_ACCOUNT_NOT_FOUND'; end if;
  select * into prior from public.trader_detector_states where trading_account_id=n.trading_account_id;
  select * into existing from public.trader_detector_assessments where trading_account_id=n.trading_account_id
    and policy_id=n.policy_id and evidence_sha256=n.evidence_sha256;
  if existing.id is not null then
    if existing.id=prior.assessment_id and n.as_of_at>=prior.last_checked_at then
      update public.trader_detector_states set data_status='OK',last_error=null,last_checked_at=n.as_of_at
        where trading_account_id=n.trading_account_id;
    end if;
    return jsonb_build_object('inserted',false,'assessment_id',existing.id,'alerts_queued',0);
  end if;
  if prior.assessment_id is distinct from p_expected_assessment_id then raise exception 'STALE_DETECTOR_STATE'; end if;
  if prior.last_checked_at>n.as_of_at then raise exception 'STALE_DETECTOR_CHECK'; end if;
  if prior.assessment_id is not null and exists(select 1 from public.trader_detector_assessments old
    where old.id=prior.assessment_id and (old.as_of_at>n.as_of_at or old.source_cutoff_at>n.source_cutoff_at)) then
    raise exception 'STALE_DETECTOR_EVIDENCE';
  end if;
  if not exists(select 1 from public.trader_detector_policy_versions where id=n.policy_id
    and status in ('SHADOW_UNCALIBRATED','VALIDATED')) then raise exception 'DETECTOR_POLICY_NOT_CURRENT'; end if;
  n.id:=gen_random_uuid(); n.created_at:=now(); n.live_enabled:=false;
  insert into public.trader_detector_assessments select n.* returning * into n;
  insert into public.trader_detector_states(trading_account_id,assessment_id,state,state_since,previous_state,updated_at)
  values(n.trading_account_id,n.id,n.state,case when prior.state=n.state then prior.state_since else now() end,prior.state,now())
  on conflict(trading_account_id) do update set assessment_id=excluded.assessment_id,state=excluded.state,
    state_since=excluded.state_since,previous_state=excluded.previous_state,updated_at=excluded.updated_at;
  update public.trader_detector_states set data_status='OK',last_error=null,last_checked_at=n.as_of_at
    where trading_account_id=n.trading_account_id;
  if n.state is distinct from prior.state then
    if (prior.state='LIVE_REVIEW_REQUIRED' and n.state<>'LIVE_REVIEW_REQUIRED') or
       (prior.state='PROFITABILITY_CONFIRMED' and n.state in ('HIGH_POTENTIAL','OBSERVE','INSUFFICIENT_EVIDENCE','RISK_NO_GO')) then
      event_type:='RISK_DETERIORATION'; event_severity:='high';
    elsif n.state in ('HIGH_POTENTIAL','PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED') then
      event_type:=n.state;
      event_severity:=case n.state when 'HIGH_POTENTIAL' then 'medium' when 'PROFITABILITY_CONFIRMED' then 'high' else 'critical' end;
    elsif n.state='RISK_NO_GO' or prior.state in ('HIGH_POTENTIAL','PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED') then
      event_type:='RISK_DETERIORATION'; event_severity:=case when n.state='RISK_NO_GO' then 'critical' else 'high' end;
    end if;
  end if;
  if event_type is not null then
    insert into public.trader_detector_alerts(assessment_id,trading_account_id,alert_type,severity,title,body,payload,dedup_key)
    values(n.id,n.trading_account_id,event_type,event_severity,replace(event_type,'_',' '),
      'Review the immutable assessment and evidence before acting. Live trading remains disabled.',
      jsonb_build_object('previous_state',prior.state,'state',n.state,'probability_status',n.probability_status),
      n.id::text||':'||event_type);
    event_count:=1;
  end if;
  return jsonb_build_object('inserted',true,'assessment_id',n.id,'alerts_queued',event_count);
end $$;
revoke all on function public.trader_detector_commit_assessment(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.trader_detector_commit_assessment(jsonb,uuid) to service_role;

create function public.trader_detector_record_failure(p_account_id uuid,p_as_of_at timestamptz,p_error text)
returns void language plpgsql security definer set search_path='' as $$
declare s public.trader_detector_states;
begin
  if p_as_of_at>clock_timestamp()+interval '1 minute' or p_error is null then raise exception 'INVALID_FAILURE_EVENT'; end if;
  perform 1 from public.trading_accounts where id=p_account_id for update;
  if not found then raise exception 'DETECTOR_ACCOUNT_NOT_FOUND'; end if;
  select * into s from public.trader_detector_states where trading_account_id=p_account_id;
  if s.assessment_id is null or s.last_checked_at>p_as_of_at then return; end if;
  update public.trader_detector_states set data_status='ERROR',last_error=left(p_error,500),last_checked_at=p_as_of_at
    where trading_account_id=p_account_id;
  if s.data_status<>'ERROR' and s.state in ('HIGH_POTENTIAL','PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED') then
    insert into public.trader_detector_alerts(assessment_id,trading_account_id,alert_type,severity,title,body,dedup_key)
      values(s.assessment_id,p_account_id,'RISK_DETERIORATION','critical','Trader assessment unavailable',
      'Evidence scan failed. The previous assessment is no longer current. Inspect worker health.',
      s.assessment_id::text||':scan-failure:'||p_as_of_at::text);
  end if;
end $$;
revoke all on function public.trader_detector_record_failure(uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.trader_detector_record_failure(uuid,timestamptz,text) to service_role;

create index detector_forecast_lookup on public.trader_detector_forecasts(trading_account_id,policy_id,input_sha256,predicted_at desc);
create index detector_risk_lookup on public.trader_detector_risk_reviews(trading_account_id,policy_id,input_sha256,as_of_at desc);
create index detector_state_health on public.trader_detector_states(data_status,last_checked_at,state);
create trigger detector_copy_immutable before update or delete on public.trader_detector_copyability_snapshots
for each row execute function public.trader_detector_reject_assessment_mutation();

create function public.trader_detector_recover_abandoned_runs(p_timeout_minutes integer default 15)
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  if p_timeout_minutes < 5 then raise exception 'INVALID_RUN_TIMEOUT'; end if;
  update public.trader_detector_run_log set status='FAILED',finished_at=now(),
    errors=errors||jsonb_build_array(jsonb_build_object('error','WORKER_TIMEOUT'))
    where status='RUNNING' and started_at<now()-make_interval(mins=>p_timeout_minutes);
  get diagnostics n=row_count; return n;
end $$;
revoke all on function public.trader_detector_recover_abandoned_runs(integer) from public,anon,authenticated;
grant execute on function public.trader_detector_recover_abandoned_runs(integer) to service_role;

do $$ declare t text; begin
  foreach t in array array['trader_detector_calibrations','trader_detector_forecasts','trader_detector_risk_reviews'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('alter table public.%I force row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy owner_read on public.%I for select to authenticated using ((select public.fn_is_admin()))',t);
    execute format('create trigger immutable before update or delete on public.%I for each row execute function public.trader_detector_reject_assessment_mutation()',t);
  end loop;
end $$;
grant select on public.trader_detector_policy_versions,public.trader_detector_pac_validations,
  public.trader_detector_copyability_snapshots,public.trader_detector_assessments,
  public.trader_detector_states,public.trader_detector_alerts,public.trader_detector_run_log to authenticated;
-- No service writer can bypass state/assessment agreement with a direct write.
revoke insert,update,delete on public.trader_detector_states,public.trader_detector_assessments from service_role;

-- Changed inference units require new immutable policies. A validated production
-- policy requires explicit migration review and is never silently replaced.
with retiring as (
  update public.trader_detector_policy_versions set status='RETIRED'
  where version=1 and status='SHADOW_UNCALIBRATED' returning *
)
insert into public.trader_detector_policy_versions(challenge_type,version,status,thresholds,challenge_rule_source)
select challenge_type,2,'SHADOW_UNCALIBRATED',thresholds||
  '{"inferenceUnit":"UTC_TRADING_DAY","minStageDays":5,"minRegimeDays":5}'::jsonb,
  challenge_rule_source from retiring;
commit;


-- ============================================================================
--  VERIFICATION — should return one row confirming all three are live.
-- ============================================================================
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='validate_promo_code')                as promo_fn_present,
  (select count(*) from pg_policies where schemaname='public' and tablename='promo_codes') as promo_codes_policies_remaining,
  (select count(*) from information_schema.tables
     where table_schema='public' and table_name like 'trader_detector_%')         as detector_tables,
  (select count(*) from public.trader_detector_policy_versions)                   as detector_policy_versions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='trader_detector_commit_assessment')  as detector_commit_fn_present;
-- Expect: promo_fn_present=1, promo_codes_policies_remaining=0, detector_tables=11,
--         detector_policy_versions>=8, detector_commit_fn_present=1.
