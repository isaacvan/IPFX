-- Schema parity: copy-pipeline objects that existed in production but had no definition in the repo
-- (generated read-only from the production catalog on 2026-10-03; structure only, no data, no secrets).
-- Idempotent: on production every statement is a no-op; on a fresh database it rebuilds the objects.

-- tables
-- trade_safety_flags (its original migration 20260909193000 is not in the repo)
create table if not exists public.trade_safety_flags (
  id uuid default gen_random_uuid() not null,
  trade_id uuid not null,
  account_id uuid not null,
  user_id uuid not null,
  reason text not null,
  evidence jsonb not null,
  status text default 'open'::text not null,
  created_at timestamp with time zone default now() not null
);
do $c$ begin alter table public.trade_safety_flags add constraint trade_safety_flags_trade_id_reason_key UNIQUE (trade_id, reason); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.trade_safety_flags add constraint trade_safety_flags_pkey PRIMARY KEY (id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.trade_safety_flags add constraint trade_safety_flags_account_id_fkey FOREIGN KEY (account_id) REFERENCES trading_accounts(id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.trade_safety_flags add constraint trade_safety_flags_trade_id_fkey FOREIGN KEY (trade_id) REFERENCES trades(id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.trade_safety_flags add constraint trade_safety_flags_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.trade_safety_flags add constraint trade_safety_flags_status_check CHECK ((status = ANY (ARRAY['open'::text, 'reviewed'::text, 'dismissed'::text]))); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
CREATE INDEX IF NOT EXISTS trade_safety_flags_user_idx ON public.trade_safety_flags USING btree (user_id);
CREATE INDEX IF NOT EXISTS trade_safety_flags_account_idx ON public.trade_safety_flags USING btree (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trade_safety_flags_status_time_idx ON public.trade_safety_flags USING btree (status, created_at DESC);
alter table public.trade_safety_flags enable row level security;

create table if not exists public.demo_mirror_outbox (
  id bigint generated always as identity not null,
  source_trade_id uuid not null,
  source_account_id uuid not null,
  user_id uuid not null,
  event text not null,
  status text default 'pending'::text not null,
  attempts integer default 0 not null,
  next_attempt_at timestamp with time zone default now() not null,
  leased_until timestamp with time zone,
  last_error text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.infinity_copy_policy_versions (
  id uuid default gen_random_uuid() not null,
  version integer not null,
  status text not null,
  thresholds jsonb not null,
  model_sha256 text,
  validation_reference text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.infinity_copy_states (
  trading_account_id uuid not null,
  decision_id uuid not null,
  recommended_tier text not null,
  approved_ceiling text default 'SHADOW'::text not null,
  effective_tier text not null,
  status text not null,
  risk_per_idea_gbp numeric(10,2) default 0 not null,
  max_concurrent_ideas integer default 0 not null,
  max_open_risk_gbp numeric(10,2) default 0 not null,
  tier_realised_pnl_gbp numeric(20,2) default 0 not null,
  approved_by uuid,
  approved_at timestamp with time zone,
  last_evidence_at timestamp with time zone not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.infinity_copy_tier_decisions (
  id uuid default gen_random_uuid() not null,
  trading_account_id uuid not null,
  assessment_id uuid not null,
  policy_id uuid not null,
  recommended_tier text not null,
  effective_tier text not null,
  risk_per_idea_gbp numeric(10,2) default 0 not null,
  max_concurrent_ideas integer default 0 not null,
  max_open_risk_gbp numeric(10,2) default 0 not null,
  reserve_coverage numeric(20,6),
  reasons jsonb default '[]'::jsonb not null,
  evidence_sha256 text not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.mirror_account_risk_snapshots (
  id bigint generated always as identity not null,
  target_id uuid not null,
  account_currency text not null,
  usd_per_account_currency numeric(20,8) not null,
  equity numeric(20,2) not null,
  daily_pnl numeric(20,2) not null,
  drawdown_from_copy_start numeric(20,2) not null,
  gross_open_risk numeric(20,2) not null,
  open_ideas integer not null,
  api_healthy boolean not null,
  evidence_sha256 text not null,
  observed_at timestamp with time zone not null,
  created_at timestamp with time zone default now() not null,
  provider_daily_loss_remaining_gbp numeric(20,2),
  provider_total_drawdown_remaining_gbp numeric(20,2)
);
create table if not exists public.tradelocker_demo_connections (
  id uuid default gen_random_uuid() not null,
  source_user_id uuid not null,
  source_account_id uuid not null,
  environment text default 'demo'::text not null,
  server text not null,
  tradelocker_account_id bigint not null,
  acc_num bigint not null,
  account_name text,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  access_expires_at timestamp with time zone,
  status text default 'connected'::text not null,
  last_health_at timestamp with time zone,
  last_error_code text,
  created_by uuid not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.tradelocker_instrument_map (
  id uuid default gen_random_uuid() not null,
  connection_id uuid not null,
  source_symbol text not null,
  broker_symbol text not null,
  tradable_instrument_id bigint not null,
  trade_route_id bigint not null,
  min_qty numeric(20,8) default 0.01 not null,
  lot_step numeric(20,8) default 0.01 not null,
  enabled boolean default true not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.trader_copy_consents (
  trading_account_id uuid not null,
  user_id uuid not null,
  consent_version text not null,
  consented_at timestamp with time zone not null,
  revoked_at timestamp with time zone,
  evidence_sha256 text not null,
  created_at timestamp with time zone default now() not null
);

-- constraints
do $c$ begin alter table public.demo_mirror_outbox add constraint demo_mirror_outbox_source_trade_id_event_key UNIQUE (source_trade_id, event); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.demo_mirror_outbox add constraint demo_mirror_outbox_pkey PRIMARY KEY (id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.demo_mirror_outbox add constraint demo_mirror_outbox_source_account_id_fkey FOREIGN KEY (source_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE; exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.demo_mirror_outbox add constraint demo_mirror_outbox_source_trade_id_fkey FOREIGN KEY (source_trade_id) REFERENCES trades(id) ON DELETE CASCADE; exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.demo_mirror_outbox add constraint demo_mirror_outbox_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE; exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.demo_mirror_outbox add constraint demo_mirror_outbox_attempts_check CHECK ((attempts >= 0)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.demo_mirror_outbox add constraint demo_mirror_outbox_event_check CHECK ((event = ANY (ARRAY['open'::text, 'close'::text]))); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.demo_mirror_outbox add constraint demo_mirror_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'acknowledged'::text, 'skipped'::text, 'needs_review'::text]))); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_policy_versions add constraint infinity_copy_policy_versions_version_key UNIQUE (version); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_policy_versions add constraint infinity_copy_policy_versions_pkey PRIMARY KEY (id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_policy_versions add constraint infinity_copy_policy_versions_check CHECK (((status <> 'VALIDATED'::text) OR ((model_sha256 IS NOT NULL) AND (validation_reference IS NOT NULL)))); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_policy_versions add constraint infinity_copy_policy_versions_model_sha256_check CHECK (((model_sha256 IS NULL) OR (model_sha256 ~ '^[a-f0-9]{64}$'::text))); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_policy_versions add constraint infinity_copy_policy_versions_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SHADOW'::text, 'VALIDATED'::text, 'RETIRED'::text]))); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_policy_versions add constraint infinity_copy_policy_versions_thresholds_check CHECK ((jsonb_typeof(thresholds) = 'object'::text)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_policy_versions add constraint infinity_copy_policy_versions_version_check CHECK ((version > 0)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_states add constraint infinity_copy_states_pkey PRIMARY KEY (trading_account_id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_states add constraint infinity_copy_states_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_states add constraint infinity_copy_states_decision_id_fkey FOREIGN KEY (decision_id) REFERENCES infinity_copy_tier_decisions(id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_states add constraint infinity_copy_states_trading_account_id_fkey FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE; exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_states add constraint infinity_copy_states_approved_ceiling_check CHECK ((approved_ceiling = ANY (ARRAY['SHADOW'::text, 'MICRO'::text, 'PARTIAL'::text, 'FULL'::text]))); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_states add constraint infinity_copy_states_status_check CHECK ((status = ANY (ARRAY['SHADOW'::text, 'ACTIVE'::text, 'QUARANTINE'::text, 'HALT'::text]))); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_tier_decisions add constraint infinity_copy_tier_decisions_assessment_id_key UNIQUE (assessment_id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_tier_decisions add constraint infinity_copy_tier_decisions_pkey PRIMARY KEY (id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_tier_decisions add constraint infinity_copy_tier_decisions_assessment_id_fkey FOREIGN KEY (assessment_id) REFERENCES trader_detector_assessments(id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_tier_decisions add constraint infinity_copy_tier_decisions_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES infinity_copy_policy_versions(id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_tier_decisions add constraint infinity_copy_tier_decisions_trading_account_id_fkey FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE; exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_tier_decisions add constraint infinity_copy_tier_decisions_effective_tier_check CHECK ((effective_tier = ANY (ARRAY['SHADOW'::text, 'MICRO'::text, 'PARTIAL'::text, 'FULL'::text, 'QUARANTINE'::text, 'HALT'::text]))); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_tier_decisions add constraint infinity_copy_tier_decisions_evidence_sha256_check CHECK ((evidence_sha256 ~ '^[a-f0-9]{64}$'::text)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_tier_decisions add constraint infinity_copy_tier_decisions_reasons_check CHECK ((jsonb_typeof(reasons) = 'array'::text)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.infinity_copy_tier_decisions add constraint infinity_copy_tier_decisions_recommended_tier_check CHECK ((recommended_tier = ANY (ARRAY['SHADOW'::text, 'MICRO'::text, 'PARTIAL'::text, 'FULL'::text, 'QUARANTINE'::text, 'HALT'::text]))); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.mirror_account_risk_snapshots add constraint mirror_account_risk_snapshots_pkey PRIMARY KEY (id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.mirror_account_risk_snapshots add constraint mirror_account_risk_snapshots_target_id_fkey FOREIGN KEY (target_id) REFERENCES mirror_targets(id) ON DELETE CASCADE; exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.mirror_account_risk_snapshots add constraint mirror_account_risk_snapshot_provider_daily_loss_remainin_check CHECK ((provider_daily_loss_remaining_gbp >= (0)::numeric)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.mirror_account_risk_snapshots add constraint mirror_account_risk_snapshot_provider_total_drawdown_rema_check CHECK ((provider_total_drawdown_remaining_gbp >= (0)::numeric)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.mirror_account_risk_snapshots add constraint mirror_account_risk_snapshots_account_currency_check CHECK ((account_currency ~ '^[A-Z]{3}$'::text)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.mirror_account_risk_snapshots add constraint mirror_account_risk_snapshots_evidence_sha256_check CHECK ((evidence_sha256 ~ '^[a-f0-9]{64}$'::text)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.mirror_account_risk_snapshots add constraint mirror_account_risk_snapshots_gross_open_risk_check CHECK ((gross_open_risk >= (0)::numeric)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.mirror_account_risk_snapshots add constraint mirror_account_risk_snapshots_open_ideas_check CHECK ((open_ideas >= 0)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.mirror_account_risk_snapshots add constraint mirror_account_risk_snapshots_usd_per_account_currency_check CHECK ((usd_per_account_currency > (0)::numeric)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_demo_connections add constraint tradelocker_demo_connections_source_account_id_key UNIQUE (source_account_id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_demo_connections add constraint tradelocker_demo_connections_source_user_id_tradelocker_acc_key UNIQUE (source_user_id, tradelocker_account_id, acc_num); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_demo_connections add constraint tradelocker_demo_connections_pkey PRIMARY KEY (id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_demo_connections add constraint tradelocker_demo_connections_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_demo_connections add constraint tradelocker_demo_connections_source_account_id_fkey FOREIGN KEY (source_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE; exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_demo_connections add constraint tradelocker_demo_connections_source_user_id_fkey FOREIGN KEY (source_user_id) REFERENCES auth.users(id) ON DELETE CASCADE; exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_demo_connections add constraint tradelocker_demo_connections_environment_check CHECK ((environment = 'demo'::text)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_demo_connections add constraint tradelocker_demo_connections_server_check CHECK (((length(server) >= 1) AND (length(server) <= 120))); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_demo_connections add constraint tradelocker_demo_connections_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'disabled'::text, 'error'::text]))); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_instrument_map add constraint tradelocker_instrument_map_connection_id_source_symbol_key UNIQUE (connection_id, source_symbol); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_instrument_map add constraint tradelocker_instrument_map_pkey PRIMARY KEY (id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_instrument_map add constraint tradelocker_instrument_map_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES tradelocker_demo_connections(id) ON DELETE CASCADE; exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_instrument_map add constraint tradelocker_instrument_map_lot_step_check CHECK ((lot_step > (0)::numeric)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.tradelocker_instrument_map add constraint tradelocker_instrument_map_min_qty_check CHECK ((min_qty > (0)::numeric)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.trader_copy_consents add constraint trader_copy_consents_pkey PRIMARY KEY (trading_account_id); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.trader_copy_consents add constraint trader_copy_consents_trading_account_id_fkey FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE; exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.trader_copy_consents add constraint trader_copy_consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE; exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.trader_copy_consents add constraint trader_copy_consents_check CHECK (((revoked_at IS NULL) OR (revoked_at >= consented_at))); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;
do $c$ begin alter table public.trader_copy_consents add constraint trader_copy_consents_evidence_sha256_check CHECK ((evidence_sha256 ~ '^[a-f0-9]{64}$'::text)); exception when duplicate_object or duplicate_table or invalid_table_definition then null; end $c$;

-- indexes
CREATE INDEX IF NOT EXISTS demo_mirror_outbox_due_idx ON public.demo_mirror_outbox USING btree (status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS infinity_copy_one_current_policy ON public.infinity_copy_policy_versions USING btree ((true)) WHERE (status = ANY (ARRAY['SHADOW'::text, 'VALIDATED'::text]));
CREATE INDEX IF NOT EXISTS mirror_risk_snapshot_target_time ON public.mirror_account_risk_snapshots USING btree (target_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS tradelocker_connections_user_idx ON public.tradelocker_demo_connections USING btree (source_user_id);
CREATE INDEX IF NOT EXISTS tradelocker_instrument_map_connection_idx ON public.tradelocker_instrument_map USING btree (connection_id);

-- row level security and policies
alter table public.demo_mirror_outbox enable row level security;
alter table public.infinity_copy_policy_versions enable row level security;
alter table public.infinity_copy_states enable row level security;
alter table public.infinity_copy_tier_decisions enable row level security;
alter table public.mirror_account_risk_snapshots enable row level security;
alter table public.tradelocker_demo_connections enable row level security;
alter table public.tradelocker_instrument_map enable row level security;
alter table public.trader_copy_consents enable row level security;
do $p$ begin create policy owner_read on public.infinity_copy_policy_versions as PERMISSIVE for SELECT to authenticated using (( SELECT fn_is_admin() AS fn_is_admin)); exception when duplicate_object then null; end $p$;
do $p$ begin create policy owner_read on public.infinity_copy_states as PERMISSIVE for SELECT to authenticated using (( SELECT fn_is_admin() AS fn_is_admin)); exception when duplicate_object then null; end $p$;
do $p$ begin create policy owner_read on public.infinity_copy_tier_decisions as PERMISSIVE for SELECT to authenticated using (( SELECT fn_is_admin() AS fn_is_admin)); exception when duplicate_object then null; end $p$;
do $p$ begin create policy owner_read on public.mirror_account_risk_snapshots as PERMISSIVE for SELECT to authenticated using (( SELECT fn_is_admin() AS fn_is_admin)); exception when duplicate_object then null; end $p$;
do $p$ begin create policy owner_read on public.trader_copy_consents as PERMISSIVE for SELECT to authenticated using (( SELECT fn_is_admin() AS fn_is_admin)); exception when duplicate_object then null; end $p$;

-- functions
CREATE OR REPLACE FUNCTION public.claim_demo_mirror_outbox(batch_size integer DEFAULT 30)
 RETURNS SETOF demo_mirror_outbox
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return query with due as (
    select q.id from public.demo_mirror_outbox q
    where (q.status = 'pending' and q.next_attempt_at <= clock_timestamp())
       or (q.status = 'processing' and q.leased_until < clock_timestamp())
    order by q.id for update skip locked limit least(greatest(batch_size,1),100)
  )
  update public.demo_mirror_outbox q set status='processing', attempts=q.attempts+1,
    leased_until=clock_timestamp()+interval '90 seconds', updated_at=clock_timestamp()
  from due where q.id=due.id returning q.*;
end; $function$;

CREATE OR REPLACE FUNCTION public.enqueue_demo_mirror_trade()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare selected_target uuid;
begin
  if tg_op = 'INSERT' and new.status = 'open' then
    select mt.id into selected_target from public.mirror_targets mt
      where mt.source_account_id = new.account_id and mt.user_id = new.user_id
        and mt.provider = 'tradelocker' and mt.environment = 'demo' and mt.enabled = true
      limit 1;
    if selected_target is not null then
      insert into public.demo_mirror_outbox(source_trade_id,source_account_id,user_id,event)
        values(new.id,new.account_id,new.user_id,'open') on conflict do nothing;
    end if;
  elsif tg_op = 'UPDATE' and old.status = 'open' and new.status = 'closed' then
    -- A disarmed trader's already-copied position must still get its close.
    if exists(select 1 from public.demo_mirror_outbox q where q.source_trade_id = new.id and q.event = 'open') then
      insert into public.demo_mirror_outbox(source_trade_id,source_account_id,user_id,event)
        values(new.id,new.account_id,new.user_id,'close') on conflict do nothing;
    end if;
  end if;
  return new;
end; $function$;

CREATE OR REPLACE FUNCTION public.fn_set_infinity_copy_ceiling(p_account_id uuid, p_ceiling text)
 RETURNS infinity_copy_states
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s public.infinity_copy_states; uid uuid:=auth.uid();
begin
  if not public.fn_is_admin() then raise exception 'OWNER_ONLY' using errcode='42501'; end if;
  if p_ceiling not in ('SHADOW','MICRO','PARTIAL','FULL') then raise exception 'INVALID_COPY_CEILING'; end if;
  update public.infinity_copy_states set approved_ceiling=p_ceiling,
    effective_tier=case when recommended_tier in ('HALT','QUARANTINE') then recommended_tier when public.infinity_copy_tier_rank(recommended_tier)<=public.infinity_copy_tier_rank(p_ceiling) then recommended_tier else p_ceiling end,
    status=case when recommended_tier in ('HALT','QUARANTINE') then recommended_tier when least(public.infinity_copy_tier_rank(recommended_tier),public.infinity_copy_tier_rank(p_ceiling))=0 then 'SHADOW' else 'ACTIVE' end,
    risk_per_idea_gbp=case when recommended_tier in ('HALT','QUARANTINE') then 0 when least(public.infinity_copy_tier_rank(recommended_tier),public.infinity_copy_tier_rank(p_ceiling))=1 then 25 when least(public.infinity_copy_tier_rank(recommended_tier),public.infinity_copy_tier_rank(p_ceiling)) in (2,3) then 50 else 0 end,
    max_concurrent_ideas=case least(public.infinity_copy_tier_rank(recommended_tier),public.infinity_copy_tier_rank(p_ceiling)) when 1 then 3 when 2 then 4 when 3 then 8 else 0 end,
    max_open_risk_gbp=case least(public.infinity_copy_tier_rank(recommended_tier),public.infinity_copy_tier_rank(p_ceiling)) when 1 then 75 when 2 then 200 when 3 then 400 else 0 end,
    approved_by=uid,approved_at=now(),updated_at=now()
  where trading_account_id=p_account_id returning * into s;
  if s.trading_account_id is null then raise exception 'COPY_STATE_NOT_FOUND'; end if;
  return s;
end $function$;

CREATE OR REPLACE FUNCTION public.refresh_infinity_copy_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a public.trading_accounts;
  p public.infinity_copy_policy_versions;
  prior public.infinity_copy_states;
  cp public.trader_detector_copyability_snapshots;
  pv public.infinity_copy_prospective_validations;
  consent_ok boolean:=false;
  provider_ok boolean:=false;
  reserve_coverage numeric:=0;
  recommended text:='SHADOW'; approved text:='SHADOW'; effective text:='SHADOW'; state_status text:='SHADOW';
  risk_gbp numeric:=0; max_concurrent integer:=0; max_open numeric:=0;
  reasons jsonb:='[]'::jsonb; d public.infinity_copy_tier_decisions; m jsonb:=new.metrics;
  stage3_account_id uuid; stage3_complete boolean:=false; stage_payout boolean:=false; public_risk_gates boolean:=false;
begin
  select * into a from public.trading_accounts where id=new.trading_account_id;
  if a.challenge_type<>'infinity' then return new; end if;
  select * into p from public.infinity_copy_policy_versions where status in ('SHADOW','VALIDATED') order by version desc limit 1;
  if p.id is null then return new; end if;
  select * into prior from public.infinity_copy_states where trading_account_id=a.id;
  approved:=coalesce(prior.approved_ceiling,'SHADOW');
  select exists(select 1 from public.trader_copy_consents c where c.trading_account_id=a.id and c.user_id=a.user_id and c.revoked_at is null) into consent_ok;
  if new.copy_review_id is not null then select * into cp from public.trader_detector_copyability_snapshots where id=new.copy_review_id; end if;
  provider_ok:=coalesce(cp.provider_authorised,false);
  select coverage into reserve_coverage from public.infinity_payout_reserve_status;
  stage3_account_id:=case when a.stage=3 then a.id when a.stage>3 then a.funded_from_account_id else null end;
  stage3_complete:=(a.stage>3) or (a.stage=3 and a.status='passed');
  select exists(select 1 from public.payouts py where py.account_id=stage3_account_id and py.user_id=a.user_id and py.programme_event='INFINITY_STAGE3_FIRST_PAYOUT' and py.status in ('requested','approved','paid')) into stage_payout;
  select * into pv from public.infinity_copy_prospective_validations v where v.trading_account_id=a.id and v.policy_id=p.id and v.status='PASS' order by v.validation_end_at desc limit 1;
  public_risk_gates:=new.gates @> '[{"key":"accounting_basis","status":"PASS"},{"key":"no_critical_risk","status":"PASS"},{"key":"concentration","status":"PASS"},{"key":"stability","status":"PASS"},{"key":"tail_risk","status":"PASS"}]'::jsonb;

  if a.status='breached' or new.state='RISK_NO_GO' then
    recommended:='HALT'; reasons:=reasons||'"RISK_OR_RULE_HARD_STOP"'::jsonb;
  elsif coalesce(prior.tier_realised_pnl_gbp,0)<=-600 or reserve_coverage<1 then
    recommended:='HALT'; reasons:=reasons||'"COPY_LOSS_OR_RESERVE_HARD_STOP"'::jsonb;
  elsif prior.effective_tier in ('MICRO','PARTIAL','FULL') and (
      new.data_quality<0.95 or coalesce(new.lower_90_bps,-1)<=0 or coalesce((m->>'recentMeanBps')::numeric,-1)<=0 or
      not public_risk_gates or coalesce(cp.copyability_lower80,0)<0.75 or coalesce(cp.downside_capture,999)>1.20 or
      coalesce(prior.tier_realised_pnl_gbp,0)<=case prior.effective_tier when 'MICRO' then -200 else -400 end
    ) then
    recommended:='QUARANTINE'; reasons:=reasons||'"EVIDENCE_OR_COPYABILITY_DETERIORATED"'::jsonb;
  elsif stage3_complete and stage_payout and new.state='LIVE_REVIEW_REQUIRED' and
      new.effective_sample_size>=45 and new.active_trading_days>=35 and
      coalesce(cp.matched_ideas,0)>=300 and coalesce(cp.copyability_lower90,0)>=0.80 and
      coalesce(cp.recent50_copyability_lower80,0)>=0.80 and coalesce(cp.downside_capture,999)<=1.05 and
      pv.id is not null and pv.prospective_blocks>=20 and pv.forecast_probability>=0.70 and
      consent_ok and provider_ok and reserve_coverage>=1.25 then
    recommended:='FULL'; reasons:=reasons||'"FULL_PROSPECTIVE_GATE_PASS"'::jsonb;
  elsif stage3_complete and new.state in ('PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED') and
      new.effective_sample_size>=45 and new.active_trading_days>=35 and coalesce((m->>'positiveStages')::integer,0)>=2 and
      coalesce(new.probability_edge_positive,0)>=0.80 and coalesce(new.lower_90_bps,-1)>0 and
      coalesce((m->>'maxDrawdownFraction')::numeric,1)<0.04 and public_risk_gates and
      coalesce(cp.matched_ideas,0)>=200 and coalesce(cp.copyability_lower80,0)>=0.80 and
      coalesce(cp.downside_capture,999)<=1.10 and consent_ok and provider_ok and reserve_coverage>=1.25 then
    recommended:='PARTIAL'; reasons:=reasons||'"PARTIAL_CONFIRMED_GATE_PASS"'::jsonb;
  elsif a.stage>=3 and new.state in ('HIGH_POTENTIAL','PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED') and
      new.effective_sample_size>=25 and new.active_trading_days>=25 and coalesce((m->>'positiveStages')::integer,0)>=2 and
      coalesce(new.probability_edge_positive,0)>=0.75 and coalesce(new.lower_90_bps,-1)>0 and public_risk_gates and
      coalesce(cp.matched_ideas,0)>=100 and coalesce(cp.copyability_lower80,0)>=0.75 and
      coalesce(cp.downside_capture,999)<=1.20 and consent_ok and provider_ok and reserve_coverage>=1.25 then
    recommended:='MICRO'; reasons:=reasons||'"STAGE2_HOLDOUT_MICRO_GATE_PASS"'::jsonb;
  else reasons:=reasons||'"SHADOW_UNTIL_DECISION_GRADE_GATES_PASS"'::jsonb;
  end if;

  if recommended in ('HALT','QUARANTINE') then effective:=recommended; state_status:=recommended;
  elsif public.infinity_copy_tier_rank(recommended)<=public.infinity_copy_tier_rank(approved) then effective:=recommended; state_status:=case when recommended='SHADOW' then 'SHADOW' else 'ACTIVE' end;
  else effective:=approved; state_status:=case when approved='SHADOW' then 'SHADOW' else 'ACTIVE' end; reasons:=reasons||'"APPROVAL_CEILING_APPLIED"'::jsonb; end if;
  risk_gbp:=case effective when 'MICRO' then 25 when 'PARTIAL' then 50 when 'FULL' then 50 else 0 end;
  max_concurrent:=case effective when 'MICRO' then 3 when 'PARTIAL' then 4 when 'FULL' then 8 else 0 end;
  max_open:=case effective when 'MICRO' then 75 when 'PARTIAL' then 200 when 'FULL' then 400 else 0 end;
  insert into public.infinity_copy_tier_decisions(trading_account_id,assessment_id,policy_id,recommended_tier,effective_tier,risk_per_idea_gbp,max_concurrent_ideas,max_open_risk_gbp,reserve_coverage,reasons,evidence_sha256)
  values(a.id,new.id,p.id,recommended,effective,risk_gbp,max_concurrent,max_open,reserve_coverage,reasons,new.evidence_sha256) returning * into d;
  insert into public.infinity_copy_states(trading_account_id,decision_id,recommended_tier,approved_ceiling,effective_tier,status,risk_per_idea_gbp,max_concurrent_ideas,max_open_risk_gbp,tier_realised_pnl_gbp,approved_by,approved_at,last_evidence_at,updated_at)
  values(a.id,d.id,recommended,approved,effective,state_status,risk_gbp,max_concurrent,max_open,coalesce(prior.tier_realised_pnl_gbp,0),prior.approved_by,prior.approved_at,new.as_of_at,now())
  on conflict(trading_account_id) do update set decision_id=excluded.decision_id,recommended_tier=excluded.recommended_tier,effective_tier=excluded.effective_tier,status=excluded.status,risk_per_idea_gbp=excluded.risk_per_idea_gbp,max_concurrent_ideas=excluded.max_concurrent_ideas,max_open_risk_gbp=excluded.max_open_risk_gbp,last_evidence_at=excluded.last_evidence_at,updated_at=excluded.updated_at;
  return new;
end $function$;


-- views
create or replace view public.infinity_payout_reserve_status as  WITH fx AS (
         SELECT COALESCE(max(treasury_fx_rates.gbp_per_unit), 0::numeric) AS gbp_per_unit,
            max(treasury_fx_rates.observed_at) AS observed_at
           FROM treasury_fx_rates
          WHERE treasury_fx_rates.currency = 'USD'::text
        ), cash AS (
         SELECT COALESCE(sum(payout_reserve_ledger.amount_gbp), 0::numeric) AS available_gbp
           FROM payout_reserve_ledger
        ), crystallised AS (
         SELECT COALESCE(sum(payouts.trader_share), 0::numeric) AS amount_usd,
            COALESCE(max(payouts.trader_share), 0::numeric) AS largest_usd
           FROM payouts
          WHERE payouts.status = ANY (ARRAY['requested'::text, 'approved'::text])
        ), potential AS (
         SELECT COALESCE(sum(a.starting_balance * a.profit_target_pct / 100::numeric * a.profit_split_pct / 100::numeric), 0::numeric) AS amount_usd,
            COALESCE(max(a.starting_balance * a.profit_target_pct / 100::numeric * a.profit_split_pct / 100::numeric), 0::numeric) AS largest_usd
           FROM trading_accounts a
          WHERE a.challenge_type = 'infinity'::text AND (a.stage = ANY (ARRAY[2, 3])) AND (a.status = ANY (ARRAY['active'::text, 'passed'::text]))
        ), totals AS (
         SELECT cash.available_gbp,
            fx.gbp_per_unit,
            fx.observed_at AS fx_observed_at,
            crystallised.amount_usd * fx.gbp_per_unit AS crystallised_gbp,
            potential.amount_usd * fx.gbp_per_unit AS potential_gbp,
            GREATEST(crystallised.largest_usd, potential.largest_usd) * fx.gbp_per_unit AS largest_liability_gbp
           FROM cash
             CROSS JOIN fx
             CROSS JOIN crystallised
             CROSS JOIN potential
        )
 SELECT available_gbp,
    crystallised_gbp,
    potential_gbp,
    largest_liability_gbp,
    fx_observed_at,
        CASE
            WHEN gbp_per_unit = 0::numeric OR fx_observed_at IS NULL THEN 999999999::numeric
            ELSE GREATEST(1.25 * (crystallised_gbp + potential_gbp), 1.50 * largest_liability_gbp)
        END::numeric(20,2) AS required_gbp,
        CASE
            WHEN gbp_per_unit = 0::numeric OR fx_observed_at IS NULL OR (now() - fx_observed_at) > '24:00:00'::interval THEN 0::numeric
            WHEN GREATEST(1.25 * (crystallised_gbp + potential_gbp), 1.50 * largest_liability_gbp) = 0::numeric THEN 999::numeric
            ELSE available_gbp / GREATEST(1.25 * (crystallised_gbp + potential_gbp), 1.50 * largest_liability_gbp)
        END::numeric(20,6) AS coverage
   FROM totals;

-- triggers
drop trigger if exists demo_mirror_trade_outbox on public.trades;
CREATE TRIGGER demo_mirror_trade_outbox AFTER INSERT OR UPDATE OF status ON public.trades FOR EACH ROW EXECUTE FUNCTION enqueue_demo_mirror_trade();
drop trigger if exists refresh_infinity_copy_state on public.trader_detector_assessments;
CREATE TRIGGER refresh_infinity_copy_state AFTER INSERT ON public.trader_detector_assessments FOR EACH ROW EXECUTE FUNCTION refresh_infinity_copy_state();
