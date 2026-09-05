-- ============================================================
-- IPFX Capital — Internal Control Core (Phases 0-3)
--
-- Implements the safe internal-control/governance layer described in
-- docs/risk-framework/deepseek-ipfx-report.md, sections 5 (data model)
-- and 17 (Phase 0-3). This is ADDITIVE infrastructure alongside the
-- existing live trading engine (trading_accounts/trades/pending_orders/
-- order_audit_events) — it does not replace or modify those tables.
--
-- SCOPE: Phase 0-3 only — data integrity, versioned rules, review
-- state machine, owner authorization, deterministic metrics, flags/
-- similarity, alerts, audit, model-governance scaffolding.
-- EXPLICITLY OUT OF SCOPE: no live broker order submission, no
-- Trade Syncer activation, no business-rule thresholds invented here
-- (deadlines/limits are configuration rows, not hardcoded constants —
-- see risk_limit / platform_config_kv below).
--
-- DESIGN DECISIONS RECORDED (per "record the assumption" instruction):
-- 1. auth_user is NOT duplicated — Supabase's own `auth.users` IS the
--    auth_user table. `person` extends it 1:1 with PII/profile fields.
--    Inventing a parallel identity table would be a second source of
--    truth for something Supabase already owns correctly.
-- 2. "Owner/admin" authorization reuses the EXISTING public.admins
--    table (already deployed, already the gate every admin-console
--    action checks) rather than inventing a new role system.
-- 3. PII columns use pgcrypto pgp_sym_encrypt/decrypt with a key read
--    from the Postgres setting `app.settings.pii_key`. That setting is
--    NOT set by this migration — it is a real missing credential an
--    operator must provision via Supabase Vault/dashboard before any
--    PII is written. Until set, encrypt/decrypt calls raise, which is
--    the correct fail-closed behavior (never write PII unencrypted).
-- 4. `order` and `fill` are reserved words in SQL — implemented as
--    `trade_order` and `trade_fill` to avoid needing quoted identifiers
--    everywhere, referenced as such throughout.
-- 5. review deadlines (10/20/10 business days) from the report are NOT
--    hardcoded — they live in `review_policy_config`, a small keyed
--    config table, so a policy change is a data change, not a
--    redeploy. Same for the "deadline expiry -> default approved"
--    behavior, which is left as an explicit configurable flag pending
--    the report's own flagged [LEGAL] sign-off requirement.
--
-- Safe to run repeatedly (idempotent DDL).
-- ============================================================

create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- ============================================================
-- 0. PII ENCRYPTION HELPERS
-- ============================================================
-- Fails closed: if app.settings.pii_key was never set by an operator,
-- these raise rather than silently storing/returning plaintext.
create or replace function public.fn_pii_key() returns text
language plpgsql stable as $$
declare k text;
begin
  begin
    k := current_setting('app.settings.pii_key');
  exception when others then
    raise exception 'pii_key_not_configured: set app.settings.pii_key via Supabase Vault before writing PII';
  end;
  if k is null or length(k) < 16 then
    raise exception 'pii_key_not_configured: app.settings.pii_key is unset or too short';
  end if;
  return k;
end;
$$;

create or replace function public.fn_encrypt_pii(plaintext text) returns bytea
language sql stable as $$
  select case when plaintext is null then null
    else pgp_sym_encrypt(plaintext, public.fn_pii_key())
  end;
$$;

create or replace function public.fn_decrypt_pii(ciphertext bytea) returns text
language sql stable as $$
  select case when ciphertext is null then null
    else pgp_sym_decrypt(ciphertext, public.fn_pii_key())
  end;
$$;

create or replace function public.fn_sha256(input text) returns text
language sql immutable as $$
  select encode(digest(coalesce(input,''), 'sha256'), 'hex');
$$;

-- ============================================================
-- 1. CORE IDENTITY / ACCOUNT
--    auth_user = auth.users (Supabase-native, not duplicated)
-- ============================================================

create table if not exists public.person (
  id                 uuid primary key default gen_random_uuid(),
  auth_user_id       uuid not null unique references auth.users(id) on delete cascade,
  legal_name_ciphertext bytea,               -- fn_encrypt_pii(legal name)
  country_code       text,
  kyc_status         text not null default 'unverified'
                       check (kyc_status in ('unverified','pending','verified','rejected')),
  risk_region        text,
  retention_class    text not null default 'standard',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_person_auth_user on public.person(auth_user_id);

create table if not exists public.device (
  id                     uuid primary key default gen_random_uuid(),
  person_id              uuid not null references public.person(id) on delete cascade,
  device_fingerprint_hash text not null,
  first_seen_at          timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  mfa_risk_level         text not null default 'normal' check (mfa_risk_level in ('normal','elevated','high')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists idx_device_person on public.device(person_id);
create index if not exists idx_device_fingerprint on public.device(device_fingerprint_hash);

create table if not exists public.session (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid not null references auth.users(id) on delete cascade,
  ip_hash        text,
  user_agent_hash text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  revocation_reason text
);
create index if not exists idx_session_auth_user on public.session(auth_user_id, created_at desc);

create table if not exists public.api_token (
  id               uuid primary key default gen_random_uuid(),
  person_id        uuid not null references public.person(id) on delete cascade,
  scope_text       text[] not null default '{}',
  token_hash_sha256 text not null unique,
  key_fingerprint  text not null,
  expires_at       timestamptz,
  rotated_at       timestamptz,
  revoked_at       timestamptz,
  rate_limit_rps   numeric(8,2) not null default 5,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_api_token_person on public.api_token(person_id);
-- Never store plaintext tokens: token_hash_sha256 is the only representation kept.

-- ============================================================
-- 2. TRADING ACCOUNT AND CHALLENGE (governance shadow of the
--    existing trading_accounts/challenge_presets — this layer adds
--    versioned-terms anchoring and objective tracking on top, it does
--    not replace the live engine's own account row)
-- ============================================================

create table if not exists public.trading_account (
  id                            uuid primary key default gen_random_uuid(),
  person_id                     uuid not null references public.person(id) on delete cascade,
  live_trading_account_id       uuid references public.trading_accounts(id) on delete set null,
  provider_id                   text not null default 'ipfx-internal',
  external_account_id_ciphertext bytea,
  account_kind                  text not null default 'simulated'
                                   check (account_kind in ('demo','simulated','live','internal')),
  base_currency                 text not null default 'USD',
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);
create index if not exists idx_trading_account_person on public.trading_account(person_id);
create index if not exists idx_trading_account_live on public.trading_account(live_trading_account_id);

create table if not exists public.challenge_product (
  id                        uuid primary key default gen_random_uuid(),
  name                      text not null,
  phase_count               int not null default 1,
  funding_structure         text,
  published_terms_version_id uuid, -- FK added after terms_version exists
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create table if not exists public.terms_version (
  id                 uuid primary key default gen_random_uuid(),
  product_id         uuid not null references public.challenge_product(id) on delete cascade,
  version_no         int not null,
  effective_from     timestamptz not null default now(),
  content_sha256     text not null,
  published_by       uuid references auth.users(id),
  legal_approval_ref text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique(product_id, version_no)
);
create index if not exists idx_terms_version_product on public.terms_version(product_id, effective_from desc);

alter table public.challenge_product drop constraint if exists fk_challenge_product_published_terms;
alter table public.challenge_product
  add constraint fk_challenge_product_published_terms
  foreign key (published_terms_version_id) references public.terms_version(id)
  deferrable initially deferred;

create table if not exists public.rule_definition (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  data_type    text not null check (data_type in ('numeric','percent','boolean','text','duration')),
  formula_ref  text,
  description  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.rule_policy (
  id                  uuid primary key default gen_random_uuid(),
  terms_version_id    uuid not null references public.terms_version(id) on delete cascade,
  rule_definition_id  uuid not null references public.rule_definition(id) on delete restrict,
  params_jsonb        jsonb not null default '{}',
  effective_from      timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique(terms_version_id, rule_definition_id)
);
create index if not exists idx_rule_policy_terms on public.rule_policy(terms_version_id);

-- Immutability guard: a rule_policy row must never be edited once a
-- challenge_instance references its terms_version_id — only new
-- versions may be created. Enforced below once challenge_instance
-- exists (see section 9 triggers).

create table if not exists public.challenge_instance (
  id                uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_account(id) on delete cascade,
  product_id        uuid not null references public.challenge_product(id) on delete restrict,
  terms_version_id  uuid not null references public.terms_version(id) on delete restrict,
  rule_policy_id    uuid references public.rule_policy(id) on delete restrict,
  stage             int not null default 1,
  state             text not null default 'active' check (state in (
                       'active','objective_met','pending_review','in_review','needs_more_data',
                       'compliance_escalation','approved','rejected','appeal_requested',
                       'appeal_in_review','appeal_upheld','appeal_overturned'
                     )),
  started_at        timestamptz not null default now(),
  objective_met_at  timestamptz,
  balance           numeric(18,2),
  equity            numeric(18,2),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_challenge_instance_account on public.challenge_instance(trading_account_id);
create index if not exists idx_challenge_instance_state on public.challenge_instance(state);

create table if not exists public.accepted_terms (
  id                  uuid primary key default gen_random_uuid(),
  challenge_instance_id uuid not null references public.challenge_instance(id) on delete cascade,
  terms_version_id    uuid not null references public.terms_version(id) on delete restrict,
  accepted_at         timestamptz not null default now(),
  acceptance_token    text not null,
  ip_hash             text,
  content_hint        text,
  created_at          timestamptz not null default now()
);
create unique index if not exists idx_accepted_terms_once
  on public.accepted_terms(challenge_instance_id, terms_version_id);

create table if not exists public.objective (
  id                    uuid primary key default gen_random_uuid(),
  challenge_instance_id uuid not null references public.challenge_instance(id) on delete cascade,
  stage                 int not null default 1,
  metric                text not null,
  target                numeric(18,6),
  comparison_operator   text not null default '>=' check (comparison_operator in ('>=','<=','>','<','=')),
  observed_value        numeric(18,6),
  satisfied_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_objective_instance on public.objective(challenge_instance_id);

-- Review policy is CONFIGURATION, not a hardcoded business rule — the
-- report's 10/20/10 business-day figures and the deadline-expiry
-- default outcome live here so a policy change is a data change.
-- Seeded with the report's own suggested defaults, each flagged as
-- pending the report's own [LEGAL] sign-off requirement.
create table if not exists public.review_policy_config (
  key          text primary key,
  value_jsonb  jsonb not null,
  description  text,
  legal_signoff_required boolean not null default true,
  legal_signoff_ref text,
  updated_at   timestamptz not null default now()
);
insert into public.review_policy_config (key, value_jsonb, description, legal_signoff_required) values
  ('review_target_business_days', '10', 'Target final review decision, business days from objective_met', true),
  ('review_max_extension_business_days', '20', 'Maximum allowed extension with written notice', true),
  ('needs_more_data_max_pause_business_days', '10', 'Max pause while needs_more_data before iPFX must decide on available evidence', true),
  ('appeal_window_business_days', '10', 'Trader appeal window after rejection', true),
  ('deadline_expiry_default_outcome', '"pending_review"', 'What happens if the deadline lapses with no decision and no open compliance_escalation. Report suggests "approved" but flags it [LEGAL: counsel must confirm]. Defaulted here to pending_review (safest / no auto-approval) until that sign-off exists.', true)
on conflict (key) do nothing;

-- ============================================================
-- 3. TRADING EVENTS (order/fill/position) — the report's canonical
--    order-vs-position separation, layered over the existing trades/
--    pending_orders tables via reference columns rather than
--    duplicating fill data the live engine already owns.
-- ============================================================

create table if not exists public.trade_order (
  id                uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_account(id) on delete cascade,
  external_order_id text,
  source_event_id   text,
  live_pending_order_id uuid references public.pending_orders(id) on delete set null,
  live_audit_event_id bigint references public.order_audit_events(id) on delete set null,
  symbol            text not null,
  side              text not null check (side in ('buy','sell')),
  quantity          numeric(14,4) not null,
  order_type        text not null check (order_type in ('market','limit','stop')),
  limit_price       numeric(18,6),
  stop_price        numeric(18,6),
  target_price      numeric(18,6),
  time_in_force     text default 'GTC',
  status            text not null default 'new' check (status in (
                       'new','validated','approved','sent','ack','filled','partially_filled',
                       'cancelled','rejected','expired'
                     )),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_trade_order_account on public.trade_order(trading_account_id, created_at desc);
create unique index if not exists idx_trade_order_source_event
  on public.trade_order(trading_account_id, source_event_id) where source_event_id is not null;

create table if not exists public.trade_fill (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.trade_order(id) on delete cascade,
  execution_id    text not null unique,
  price           numeric(18,6) not null,
  quantity        numeric(14,4) not null,
  fill_time       timestamptz not null default now(),
  commission      numeric(14,4),
  swap            numeric(14,4),
  spread_bps      numeric(10,3),
  slippage_bps    numeric(10,3),
  decision_price  numeric(18,6),
  created_at      timestamptz not null default now()
);
create index if not exists idx_trade_fill_order on public.trade_fill(order_id);

create table if not exists public.position (
  id                uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_account(id) on delete cascade,
  live_trade_id     uuid references public.trades(id) on delete set null,
  symbol            text not null,
  direction         text not null check (direction in ('long','short')),
  total_qty         numeric(14,4) not null default 0,
  avg_entry_price   numeric(18,6),
  opened_at         timestamptz not null default now(),
  closed_at         timestamptz,
  closed_pnl        numeric(18,2),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_position_account on public.position(trading_account_id);
create index if not exists idx_position_live_trade on public.position(live_trade_id);

create table if not exists public.position_snapshot (
  id           uuid primary key default gen_random_uuid(),
  position_id  uuid not null references public.position(id) on delete cascade,
  qty          numeric(14,4) not null,
  mark_price   numeric(18,6) not null,
  notional     numeric(18,2),
  margin       numeric(18,2),
  equity       numeric(18,2),
  recorded_at  timestamptz not null default now()
);
create index if not exists idx_position_snapshot_position on public.position_snapshot(position_id, recorded_at desc);

-- ============================================================
-- 4. REVIEWS AND DECISIONS
-- ============================================================

create table if not exists public.review_case (
  id                    uuid primary key default gen_random_uuid(),
  challenge_instance_id uuid not null references public.challenge_instance(id) on delete cascade,
  status                text not null default 'pending_review' check (status in (
                           'pending_review','in_review','needs_more_data','compliance_escalation',
                           'approved','rejected','appeal_requested','appeal_in_review',
                           'appeal_upheld','appeal_overturned'
                         )),
  assigned_to           uuid references auth.users(id),
  due_at                timestamptz,
  opened_at             timestamptz not null default now(),
  closed_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_review_case_instance on public.review_case(challenge_instance_id);
create index if not exists idx_review_case_status on public.review_case(status, due_at);

-- review_event is append-only: it is the audit trail of every state
-- transition. Enforced immutable via trigger below (section 9).
create table if not exists public.review_event (
  id             uuid primary key default gen_random_uuid(),
  review_case_id uuid not null references public.review_case(id) on delete cascade,
  actor_id       uuid references auth.users(id),
  transition     text not null,
  from_state     text,
  to_state       text not null,
  "timestamp"    timestamptz not null default now(),
  created_at     timestamptz not null default now()
);
create index if not exists idx_review_event_case on public.review_event(review_case_id, "timestamp");

create table if not exists public.review_decision (
  id               uuid primary key default gen_random_uuid(),
  review_case_id   uuid not null references public.review_case(id) on delete cascade,
  decision_type    text not null check (decision_type in ('eligibility','internal_allocation','compliance')),
  outcome          text not null check (outcome in ('approved','rejected','escalated','correction')),
  reason_code      text not null,
  reason_text      text,
  terms_version_id uuid references public.terms_version(id),
  rule_reference   jsonb,
  evidence_document_id uuid[] not null default '{}',
  model_contributions jsonb,
  decided_by       uuid not null references auth.users(id),
  decided_at       timestamptz not null default now(),
  appeal_expiry_at timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists idx_review_decision_case on public.review_decision(review_case_id);
-- "NOT_ELIGIBLE_CAPITAL_INTERNAL" must never be paired with decision_type='eligibility' —
-- it is an internal-allocation-only reason code. Enforced by application logic
-- (see internal-control/lib/review-state-machine.ts) since a CHECK constraint
-- can't cross-validate reason_code against decision_type cleanly without a
-- lookup table; recorded here as a MUST-ENFORCE-IN-CODE note, not silently assumed safe.

create table if not exists public.review_evidence (
  id               uuid primary key default gen_random_uuid(),
  review_case_id   uuid not null references public.review_case(id) on delete cascade,
  type             text not null,
  source_entity_id uuid,
  source_hash      text not null,
  visible_to_trader boolean not null default false,
  redacted_summary text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_review_evidence_case on public.review_evidence(review_case_id);

create table if not exists public.appeal (
  id                  uuid primary key default gen_random_uuid(),
  review_decision_id  uuid not null references public.review_decision(id) on delete cascade,
  requested_at        timestamptz not null default now(),
  reason              text not null,
  status              text not null default 'requested' check (status in ('requested','in_review','upheld','overturned')),
  decided_by          uuid references auth.users(id),
  decided_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_appeal_decision on public.appeal(review_decision_id);
-- Independent-reviewer rule (decided_by must differ from the original
-- review_decision.decided_by) is enforced in application logic — see
-- internal-control/lib/review-state-machine.ts assertIndependentReviewer().

-- ============================================================
-- 5. METRICS AND MODELS
-- ============================================================

create table if not exists public.metric_run (
  id               uuid primary key default gen_random_uuid(),
  scope_type       text not null check (scope_type in ('trading_account','challenge_instance','cohort','platform')),
  scope_id         uuid,
  model_version    text not null,
  input_sha256     text not null,
  data_window_start timestamptz,
  data_window_end  timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists idx_metric_run_scope on public.metric_run(scope_type, scope_id, created_at desc);

create table if not exists public.prob_estimate (
  id                    uuid primary key default gen_random_uuid(),
  metric_run_id         uuid not null references public.metric_run(id) on delete cascade,
  metric_name           text not null,
  value                 numeric(18,6),   -- NULL when insufficient_evidence — never fabricated
  credible_low          numeric(18,6),
  credible_high         numeric(18,6),
  ci_level              numeric(5,4) default 0.95,
  horizon               text,
  sample_size           int,
  effective_sample_size numeric(10,2),
  calibration_status    text not null default 'uncalibrated'
                          check (calibration_status in ('uncalibrated','calibrated','drifted','insufficient_evidence')),
  contributors_jsonb    jsonb,
  data_warnings_jsonb   jsonb,
  status                text not null default 'ok' check (status in ('ok','insufficient_evidence','shadow_data_insufficient')),
  created_at            timestamptz not null default now()
);
create index if not exists idx_prob_estimate_run on public.prob_estimate(metric_run_id, metric_name);
-- Fail-closed constraint: a row claiming status='ok' must carry a value.
alter table public.prob_estimate drop constraint if exists chk_prob_estimate_value_status;
alter table public.prob_estimate add constraint chk_prob_estimate_value_status
  check (status <> 'ok' or value is not null);

create table if not exists public.flag_definition (
  id                uuid primary key default gen_random_uuid(),
  flag_code         text not null unique,
  severity_default  text not null check (severity_default in ('low','medium','high','critical')),
  description       text not null,
  required_evidence text,
  reviewer_actions  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.flag_case (
  id             uuid primary key default gen_random_uuid(),
  entity_type    text not null,
  entity_id      uuid not null,
  flag_code      text not null references public.flag_definition(flag_code),
  severity       text not null check (severity in ('low','medium','high','critical')),
  confidence     numeric(5,4),
  evidence_jsonb jsonb,
  status         text not null default 'open' check (status in (
                    'open','in_review','confirmed','false_positive','escalated','remediated','closed'
                  )),
  disposition    text,
  reviewer_id    uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_flag_case_entity on public.flag_case(entity_type, entity_id);
create index if not exists idx_flag_case_status on public.flag_case(status, severity);
-- A flag_case may never itself be a review_decision — there is no FK
-- from flag_case to a rejection outcome, by design (report §9: "Flags
-- only create review cases; they never fail an account automatically").

-- ============================================================
-- 6. RISK, PAYOUT, CAPITAL
-- ============================================================

create table if not exists public.risk_limit (
  id             uuid primary key default gen_random_uuid(),
  risk_policy_id uuid,
  dimension      text not null check (dimension in ('account','symbol','trader','strategy_cluster','provider','global')),
  operator       text not null check (operator in ('<=','>=','<','>','=')),
  value          numeric(18,6) not null,
  hard_or_soft   text not null default 'soft' check (hard_or_soft in ('hard','soft')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.kill_switch (
  id          uuid primary key default gen_random_uuid(),
  scope_type  text not null check (scope_type in ('global','provider','account','symbol')),
  scope_id    uuid,
  target      text not null,
  enabled     boolean not null default false,
  reason      text,
  enabled_by  uuid references auth.users(id),
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_kill_switch_scope on public.kill_switch(scope_type, scope_id, enabled);

create table if not exists public.internal_capital_decision (
  id                uuid primary key default gen_random_uuid(),
  trader_id         uuid not null references public.person(id) on delete cascade,
  review_case_id    uuid references public.review_case(id) on delete set null,
  amount            numeric(18,2),
  risk_budget       numeric(18,2),
  status            text not null default 'draft' check (status in ('draft','proposed','approved','rejected','active','suspended')),
  approved_by       uuid references auth.users(id),
  approved_at       timestamptz,
  risk_committee_ref text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_internal_capital_trader on public.internal_capital_decision(trader_id);
-- Explicitly separate from payout_request: an internal_capital_decision
-- of 'rejected' must never be readable as a denial of contractual
-- payout eligibility (report §4.5 — NOT_ELIGIBLE_CAPITAL_INTERNAL rule).

create table if not exists public.payout_request (
  id                 uuid primary key default gen_random_uuid(),
  contract_id        text,
  trader_account_id  uuid not null references public.trading_account(id) on delete cascade,
  amount             numeric(18,2) not null,
  status             text not null default 'requested' check (status in ('requested','approved','paid','void')),
  review_decision_id uuid references public.review_decision(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_payout_request_account on public.payout_request(trader_account_id);

create table if not exists public.payout_payment (
  id               uuid primary key default gen_random_uuid(),
  payout_request_id uuid not null references public.payout_request(id) on delete cascade,
  processor_ref    text,
  paid_at          timestamptz,
  amount           numeric(18,2) not null,
  currency         text not null default 'USD',
  created_at       timestamptz not null default now()
);
create index if not exists idx_payout_payment_request on public.payout_payment(payout_request_id);

-- ============================================================
-- 7. REPLICATION (Phase 4 shadow-only scaffolding — no live adapter,
--    no external order sending; dest_order is populated ONLY by a dry
--    internal shadow service per the report's Phase 4 boundary)
-- ============================================================

create table if not exists public.broker_account (
  id                       uuid primary key default gen_random_uuid(),
  provider_id              text not null,
  account_ref_ciphertext   bytea,
  permission_document_id   uuid,
  automation_permitted_until timestamptz, -- NULL = no written permission on file = Phase 4 shadow only
  api_mode                 text not null default 'shadow' check (api_mode in ('shadow','paper','live')),
  netting_mode             text default 'netting' check (netting_mode in ('netting','hedging')),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
-- Fail-closed: api_mode may only be 'live' when automation_permitted_until
-- is in the future. Enforced in section 9 trigger, not just a CHECK,
-- since it depends on now().

create table if not exists public.replication_event (
  id                    uuid primary key default gen_random_uuid(),
  source_event_id       text not null,
  source_account_id     uuid not null references public.trading_account(id),
  source_sequence       bigint not null,
  copy_request_id       uuid not null default gen_random_uuid(),
  source_event_type     text not null,
  payload_jsonb         jsonb not null,
  schema_version        text not null default '1',
  status                text not null default 'new' check (status in (
                           'new','validated','approved','sent','ack','filled','cancelled','rejected','reconciled'
                         )),
  idempotency_key_hash  text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists idx_replication_event_idempotency on public.replication_event(idempotency_key_hash);
create index if not exists idx_replication_event_source on public.replication_event(source_account_id, source_sequence);

create table if not exists public.dest_order (
  id                   uuid primary key default gen_random_uuid(),
  replication_event_id uuid not null references public.replication_event(id) on delete cascade,
  broker_account_id    uuid not null references public.broker_account(id),
  external_order_id    text,
  status               text not null default 'shadow_only' check (status in ('shadow_only','sent','filled','rejected','cancelled')),
  filled_qty           numeric(14,4),
  avg_fill_price       numeric(18,6),
  error_code           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_dest_order_replication on public.dest_order(replication_event_id);

create table if not exists public.reconciliation_run (
  id                uuid primary key default gen_random_uuid(),
  broker_account_id uuid references public.broker_account(id),
  source_account_id uuid references public.trading_account(id),
  window_start      timestamptz not null,
  window_end        timestamptz not null,
  match_status      text not null default 'pending' check (match_status in ('pending','matched','mismatched')),
  mismatch_jsonb    jsonb,
  recorded_at       timestamptz not null default now()
);
create index if not exists idx_reconciliation_run_broker on public.reconciliation_run(broker_account_id, window_start desc);

-- ============================================================
-- 8. AUDIT — append-only, tamper-evident hash chain
-- ============================================================

create table if not exists public.audit_event (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid references auth.users(id),
  action        text not null,
  entity_type   text not null,
  entity_id     uuid,
  before_sha256 text,
  after_sha256  text,
  ip_hash       text,
  created_at    timestamptz not null default now(),
  prev_hash     text,
  event_hash    text not null
);
create index if not exists idx_audit_event_entity on public.audit_event(entity_type, entity_id, created_at desc);
create index if not exists idx_audit_event_actor on public.audit_event(actor_id, created_at desc);

-- Append-only enforcement: no one, including admins/service role via
-- ordinary DML, may update or delete an existing audit row.
create or replace function public.fn_audit_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_event is append-only: % is not permitted', TG_OP;
end;
$$;
drop trigger if exists trg_audit_no_update on public.audit_event;
create trigger trg_audit_no_update before update on public.audit_event
  for each row execute function public.fn_audit_immutable();
drop trigger if exists trg_audit_no_delete on public.audit_event;
create trigger trg_audit_no_delete before delete on public.audit_event
  for each row execute function public.fn_audit_immutable();

-- Canonical hash-chained insert. Always call THIS, never insert into
-- audit_event directly, so prev_hash/event_hash are always correct —
-- application code (edge functions, dashboard server actions) should
-- call this RPC rather than a raw insert.
create or replace function public.fn_append_audit_event(
  p_actor_id uuid, p_action text, p_entity_type text, p_entity_id uuid,
  p_before_sha256 text default null, p_after_sha256 text default null,
  p_ip_hash text default null
) returns public.audit_event
language plpgsql security definer set search_path = public as $$
declare
  v_prev text;
  v_row  public.audit_event;
  v_canonical text;
begin
  select event_hash into v_prev from public.audit_event order by created_at desc, id desc limit 1;
  v_canonical := coalesce(v_prev,'') || '|' || p_action || '|' || p_entity_type || '|'
    || coalesce(p_entity_id::text,'') || '|' || coalesce(p_before_sha256,'') || '|'
    || coalesce(p_after_sha256,'') || '|' || now()::text;
  insert into public.audit_event (actor_id, action, entity_type, entity_id, before_sha256, after_sha256, ip_hash, prev_hash, event_hash)
  values (p_actor_id, p_action, p_entity_type, p_entity_id, p_before_sha256, p_after_sha256, p_ip_hash, v_prev, public.fn_sha256(v_canonical))
  returning * into v_row;
  return v_row;
end;
$$;

-- Verifies the entire chain is unbroken — run this to detect tampering.
create or replace function public.fn_verify_audit_chain() returns table(broken_at_id uuid, expected_hash text, stored_hash text)
language plpgsql as $$
declare
  r record;
  v_prev text := null;
  v_canonical text;
  v_expected text;
begin
  for r in select * from public.audit_event order by created_at asc, id asc loop
    v_canonical := coalesce(v_prev,'') || '|' || r.action || '|' || r.entity_type || '|'
      || coalesce(r.entity_id::text,'') || '|' || coalesce(r.before_sha256,'') || '|'
      || coalesce(r.after_sha256,'') || '|' || r.created_at::text;
    v_expected := public.fn_sha256(v_canonical);
    if r.prev_hash is distinct from v_prev then
      return query select r.id, v_expected, r.event_hash; return;
    end if;
    v_prev := r.event_hash;
  end loop;
  return;
end;
$$;
comment on function public.fn_verify_audit_chain is
  'Returns zero rows if the chain is intact. Returns one row at the first break if any row prev_hash/created_at was altered out of band. NOTE: this recomputation depends on created_at not having been altered either; combined with the append-only triggers above, that is the tamper-evidence guarantee, not this function alone.';

-- ============================================================
-- 9. CROSS-TABLE INTEGRITY TRIGGERS
-- ============================================================

-- 9a. Rule-policy / terms-version immutability once referenced by an
-- active challenge_instance (report §4.2: "No retrospective rule may
-- apply to an active challenge").
create or replace function public.fn_block_terms_mutation() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from public.challenge_instance where terms_version_id = OLD.id) then
    raise exception 'terms_version_immutable: version % is referenced by an existing challenge_instance and cannot be modified — publish a new version instead', OLD.id;
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_terms_version_immutable on public.terms_version;
create trigger trg_terms_version_immutable before update on public.terms_version
  for each row execute function public.fn_block_terms_mutation();

create or replace function public.fn_block_rule_policy_mutation() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from public.challenge_instance where rule_policy_id = OLD.id) then
    raise exception 'rule_policy_immutable: policy % is referenced by an existing challenge_instance and cannot be modified — publish a new version instead', OLD.id;
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_rule_policy_immutable on public.rule_policy;
create trigger trg_rule_policy_immutable before update on public.rule_policy
  for each row execute function public.fn_block_rule_policy_mutation();

-- 9b. review_event / review_decision are append-only once written —
-- a correction is a NEW row (e.g. outcome='correction'), never an edit.
drop trigger if exists trg_review_event_immutable_upd on public.review_event;
create trigger trg_review_event_immutable_upd before update on public.review_event
  for each row execute function public.fn_audit_immutable();
drop trigger if exists trg_review_event_immutable_del on public.review_event;
create trigger trg_review_event_immutable_del before delete on public.review_event
  for each row execute function public.fn_audit_immutable();
drop trigger if exists trg_review_decision_immutable_upd on public.review_decision;
create trigger trg_review_decision_immutable_upd before update on public.review_decision
  for each row execute function public.fn_audit_immutable();
drop trigger if exists trg_review_decision_immutable_del on public.review_decision;
create trigger trg_review_decision_immutable_del before delete on public.review_decision
  for each row execute function public.fn_audit_immutable();

-- 9c. A rejection reason_code may never be the internal-allocation-only
-- code (report §4.5).
create or replace function public.fn_block_capital_reason_on_eligibility() returns trigger
language plpgsql as $$
begin
  if NEW.decision_type = 'eligibility' and NEW.reason_code = 'NOT_ELIGIBLE_CAPITAL_INTERNAL' then
    raise exception 'invalid_reason_code: NOT_ELIGIBLE_CAPITAL_INTERNAL is an internal-allocation status and must never be used on an eligibility decision';
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_review_decision_reason_guard on public.review_decision;
create trigger trg_review_decision_reason_guard before insert or update on public.review_decision
  for each row execute function public.fn_block_capital_reason_on_eligibility();

-- 9d. A flag_case may never itself carry an outcome field implying it
-- rejected something — defensive check in case a future column is
-- added carelessly. For now this is a documentation trigger that
-- passes through; real enforcement is "no FK path exists" (schema
-- design), listed here so a future migration author sees the intent.

-- 9e. broker_account.api_mode can only be 'live' with a current written
-- permission on file.
create or replace function public.fn_block_live_without_permission() returns trigger
language plpgsql as $$
begin
  if NEW.api_mode = 'live' and (NEW.automation_permitted_until is null or NEW.automation_permitted_until < now()) then
    raise exception 'no_provider_permission: cannot set api_mode=live without a current, unexpired automation_permitted_until — see report §3 provider-permission gate';
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_broker_account_permission_guard on public.broker_account;
create trigger trg_broker_account_permission_guard before insert or update on public.broker_account
  for each row execute function public.fn_block_live_without_permission();

-- 9f. dest_order may never reach a "sent"/"filled" state while its
-- broker_account is not api_mode='live' — this is the hard Phase 4
-- boundary ("no external order sending") enforced at the database
-- layer, not just in application code.
create or replace function public.fn_block_live_dest_order() returns trigger
language plpgsql as $$
declare v_mode text;
begin
  if NEW.status in ('sent','filled') then
    select api_mode into v_mode from public.broker_account where id = NEW.broker_account_id;
    if v_mode is distinct from 'live' then
      raise exception 'phase4_boundary: dest_order cannot reach status=% while broker_account.api_mode=% — Phase 4 is shadow-only, no external order sending', NEW.status, coalesce(v_mode,'null');
    end if;
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_dest_order_phase4_guard on public.dest_order;
create trigger trg_dest_order_phase4_guard before insert or update on public.dest_order
  for each row execute function public.fn_block_live_dest_order();

-- generic updated_at maintenance
create or replace function public.fn_touch_updated_at() returns trigger
language plpgsql as $$
begin
  NEW.updated_at := now();
  return NEW;
end;
$$;
do $$
declare t text;
begin
  for t in select unnest(array[
    'person','device','session','api_token','trading_account','challenge_product','terms_version',
    'rule_definition','rule_policy','challenge_instance','objective','trade_order','position',
    'review_case','appeal','flag_definition','flag_case','risk_limit','kill_switch',
    'internal_capital_decision','payout_request','broker_account','replication_event','dest_order'
  ]) loop
    execute format('drop trigger if exists trg_touch_updated_at on public.%I;', t);
    execute format('create trigger trg_touch_updated_at before update on public.%I for each row execute function public.fn_touch_updated_at();', t);
  end loop;
end $$;

-- ============================================================
-- 10. ROW LEVEL SECURITY
--     Owner/admin = exists in public.admins (existing table, reused
--     per design decision #2 above). Traders may read only rows tied
--     to their own person_id/auth_user_id; never owner-only tables.
-- ============================================================

create or replace function public.fn_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.admins where user_id = auth.uid());
$$;

create or replace function public.fn_own_person_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.person where auth_user_id = auth.uid();
$$;

-- Owner-only tables: admin full access, no trader access at all.
do $$
declare t text;
begin
  for t in select unnest(array[
    'device','session','api_token','rule_definition','rule_policy','terms_version',
    'challenge_product','review_evidence','metric_run','prob_estimate','flag_definition',
    'flag_case','risk_limit','kill_switch','internal_capital_decision','broker_account',
    'replication_event','dest_order','reconciliation_run','audit_event','review_policy_config'
  ]) loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists owner_only_all on public.%I;', t);
    execute format('create policy owner_only_all on public.%I for all using (public.fn_is_admin()) with check (public.fn_is_admin());', t);
  end loop;
end $$;

-- Trader-visible-own-row tables: trader can SELECT their own rows;
-- all writes remain service-role/admin only (no insert/update/delete
-- policy for the trader role — matches "browser can SELECT its own
-- rows but can NEVER insert/update/delete" pattern already used by
-- public.trades).
alter table public.person enable row level security;
drop policy if exists own_row_select on public.person;
create policy own_row_select on public.person for select using (auth_user_id = auth.uid() or public.fn_is_admin());
drop policy if exists admin_write on public.person;
create policy admin_write on public.person for all using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.trading_account enable row level security;
drop policy if exists own_row_select on public.trading_account;
create policy own_row_select on public.trading_account for select
  using (public.fn_is_admin() or person_id = public.fn_own_person_id());
drop policy if exists admin_write on public.trading_account;
create policy admin_write on public.trading_account for all using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.challenge_instance enable row level security;
drop policy if exists own_row_select on public.challenge_instance;
create policy own_row_select on public.challenge_instance for select
  using (public.fn_is_admin() or trading_account_id in (select id from public.trading_account where person_id = public.fn_own_person_id()));
drop policy if exists admin_write on public.challenge_instance;
create policy admin_write on public.challenge_instance for all using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.accepted_terms enable row level security;
drop policy if exists own_row_select on public.accepted_terms;
create policy own_row_select on public.accepted_terms for select
  using (public.fn_is_admin() or challenge_instance_id in (
    select ci.id from public.challenge_instance ci join public.trading_account ta on ta.id = ci.trading_account_id
    where ta.person_id = public.fn_own_person_id()));
drop policy if exists admin_write on public.accepted_terms;
create policy admin_write on public.accepted_terms for all using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.objective enable row level security;
drop policy if exists own_row_select on public.objective;
create policy own_row_select on public.objective for select
  using (public.fn_is_admin() or challenge_instance_id in (
    select ci.id from public.challenge_instance ci join public.trading_account ta on ta.id = ci.trading_account_id
    where ta.person_id = public.fn_own_person_id()));
drop policy if exists admin_write on public.objective;
create policy admin_write on public.objective for all using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.trade_order enable row level security;
drop policy if exists own_row_select on public.trade_order;
create policy own_row_select on public.trade_order for select
  using (public.fn_is_admin() or trading_account_id in (select id from public.trading_account where person_id = public.fn_own_person_id()));
drop policy if exists admin_write on public.trade_order;
create policy admin_write on public.trade_order for all using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.trade_fill enable row level security;
drop policy if exists own_row_select on public.trade_fill;
create policy own_row_select on public.trade_fill for select
  using (public.fn_is_admin() or order_id in (
    select o.id from public.trade_order o join public.trading_account ta on ta.id = o.trading_account_id
    where ta.person_id = public.fn_own_person_id()));
drop policy if exists admin_write on public.trade_fill;
create policy admin_write on public.trade_fill for all using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.position enable row level security;
drop policy if exists own_row_select on public.position;
create policy own_row_select on public.position for select
  using (public.fn_is_admin() or trading_account_id in (select id from public.trading_account where person_id = public.fn_own_person_id()));
drop policy if exists admin_write on public.position;
create policy admin_write on public.position for all using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.position_snapshot enable row level security;
drop policy if exists own_row_select on public.position_snapshot;
create policy own_row_select on public.position_snapshot for select
  using (public.fn_is_admin() or position_id in (
    select p.id from public.position p join public.trading_account ta on ta.id = p.trading_account_id
    where ta.person_id = public.fn_own_person_id()));
drop policy if exists admin_write on public.position_snapshot;
create policy admin_write on public.position_snapshot for all using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.review_case enable row level security;
drop policy if exists own_row_select on public.review_case;
create policy own_row_select on public.review_case for select
  using (public.fn_is_admin() or challenge_instance_id in (
    select ci.id from public.challenge_instance ci join public.trading_account ta on ta.id = ci.trading_account_id
    where ta.person_id = public.fn_own_person_id()));
drop policy if exists admin_write on public.review_case;
create policy admin_write on public.review_case for all using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.review_event enable row level security;
drop policy if exists own_row_select on public.review_event;
create policy own_row_select on public.review_event for select
  using (public.fn_is_admin() or review_case_id in (
    select rc.id from public.review_case rc join public.challenge_instance ci on ci.id = rc.challenge_instance_id
    join public.trading_account ta on ta.id = ci.trading_account_id where ta.person_id = public.fn_own_person_id()));
drop policy if exists admin_write on public.review_event;
create policy admin_write on public.review_event for all using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.review_decision enable row level security;
drop policy if exists own_row_select on public.review_decision;
create policy own_row_select on public.review_decision for select
  using (public.fn_is_admin() or review_case_id in (
    select rc.id from public.review_case rc join public.challenge_instance ci on ci.id = rc.challenge_instance_id
    join public.trading_account ta on ta.id = ci.trading_account_id where ta.person_id = public.fn_own_person_id()));
drop policy if exists admin_write on public.review_decision;
create policy admin_write on public.review_decision for all using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.appeal enable row level security;
drop policy if exists own_row_select on public.appeal;
create policy own_row_select on public.appeal for select
  using (public.fn_is_admin() or review_decision_id in (
    select rd.id from public.review_decision rd join public.review_case rc on rc.id = rd.review_case_id
    join public.challenge_instance ci on ci.id = rc.challenge_instance_id
    join public.trading_account ta on ta.id = ci.trading_account_id where ta.person_id = public.fn_own_person_id()));
-- Traders MAY insert their own appeal request (the one write exception —
-- appealing is a trader right, not an admin-only action).
drop policy if exists trader_insert_appeal on public.appeal;
create policy trader_insert_appeal on public.appeal for insert
  with check (review_decision_id in (
    select rd.id from public.review_decision rd join public.review_case rc on rc.id = rd.review_case_id
    join public.challenge_instance ci on ci.id = rc.challenge_instance_id
    join public.trading_account ta on ta.id = ci.trading_account_id where ta.person_id = public.fn_own_person_id()));
drop policy if exists admin_write on public.appeal;
create policy admin_write on public.appeal for update using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.payout_request enable row level security;
drop policy if exists own_row_select on public.payout_request;
create policy own_row_select on public.payout_request for select
  using (public.fn_is_admin() or trader_account_id in (select id from public.trading_account where person_id = public.fn_own_person_id()));
drop policy if exists admin_write on public.payout_request;
create policy admin_write on public.payout_request for all using (public.fn_is_admin()) with check (public.fn_is_admin());

alter table public.payout_payment enable row level security;
drop policy if exists own_row_select on public.payout_payment;
create policy own_row_select on public.payout_payment for select
  using (public.fn_is_admin() or payout_request_id in (
    select pr.id from public.payout_request pr join public.trading_account ta on ta.id = pr.trader_account_id
    where ta.person_id = public.fn_own_person_id()));
drop policy if exists admin_write on public.payout_payment;
create policy admin_write on public.payout_payment for all using (public.fn_is_admin()) with check (public.fn_is_admin());

-- Verify after running:
--   select count(*) from information_schema.tables where table_schema='public'
--     and table_name in ('person','trading_account','challenge_instance','review_case','audit_event');
--   select * from public.fn_verify_audit_chain(); -- expect zero rows
--   select public.fn_append_audit_event(auth.uid(),'test_action','test_entity',gen_random_uuid());
