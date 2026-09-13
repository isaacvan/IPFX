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
