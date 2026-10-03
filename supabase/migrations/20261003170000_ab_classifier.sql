-- A/B-book Day 2: classification engine storage. The ab-classifier Edge Function (cron, every 5 min) decides;
-- the database records every move in an append-only audit log and changes state only if it is unchanged
-- since the decision was made (optimistic), so two runs can never apply conflicting moves.
create table if not exists public.ab_policy_versions (
  version int primary key,
  status text not null check (status in ('ACTIVE', 'RETIRED', 'DRAFT')),
  thresholds jsonb not null,
  note text,
  created_at timestamptz not null default now()
);
create unique index if not exists ab_policy_one_active on public.ab_policy_versions ((status)) where status = 'ACTIVE';
insert into public.ab_policy_versions (version, status, thresholds, note) values (1, 'ACTIVE',
  '{"minDays":20,"minTrades":40,"minEdgeR":0.02,"zLower":1.645,"eValuePromote":10,"eValueLive":10,"maxBestTradeShare":0.3,
    "minMedianHoldSeconds":60,"maxShareUnder60s":0.5,"dwellDays":5,"coolOffDays":10,"liveFlipMinTrades":10,"abFailTrades":80,
    "ewmaAlpha":0.1,"abDemoteEwma":-0.05,"stage2AutoPct":2.75,"stage2AutoTarget":"AB_DEMO"}',
  'Initial conservative policy (2026-10-03). Thresholds are versioned; a change is a new row, never an edit.')
on conflict (version) do nothing;

create table if not exists public.ab_lifecycle_events (
  id bigint generated always as identity primary key,
  person_id uuid not null,
  from_state text not null,
  to_state text not null,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  policy_version int not null references public.ab_policy_versions(version),
  actor text not null default 'ab-classifier',
  created_at timestamptz not null default now()
);
create index if not exists ab_lifecycle_events_person on public.ab_lifecycle_events (person_id, created_at desc);

create or replace function public.ab_lifecycle_immutable() returns trigger language plpgsql as $$
begin raise exception 'ab_lifecycle_events is append-only'; end $$;
drop trigger if exists ab_lifecycle_events_immutable on public.ab_lifecycle_events;
create trigger ab_lifecycle_events_immutable before update or delete on public.ab_lifecycle_events
  for each row execute function public.ab_lifecycle_immutable();
create or replace function public.ab_policy_thresholds_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or new.thresholds is distinct from old.thresholds or new.version <> old.version then
    raise exception 'policy thresholds are immutable: add a new version instead';
  end if;
  return new;
end $$;
drop trigger if exists ab_policy_versions_immutable on public.ab_policy_versions;
create trigger ab_policy_versions_immutable before update or delete on public.ab_policy_versions
  for each row execute function public.ab_policy_thresholds_immutable();

alter table public.ab_policy_versions enable row level security;
alter table public.ab_lifecycle_events enable row level security;
revoke all on public.ab_policy_versions, public.ab_lifecycle_events from public, anon, authenticated;
grant select, insert on public.ab_lifecycle_events to service_role;
grant select, insert, update on public.ab_policy_versions to service_role;

alter table public.ab_trader_profiles add column if not exists last_ab_exit_at timestamptz;
alter table public.ab_trader_profiles add column if not exists policy_version int;

-- Applies one move only if the person is still in p_from. SUSPENDED is left only through
-- ab_release_suspension (a human decision), never by the classifier.
create or replace function public.ab_apply_transition(p_person uuid, p_from text, p_to text, p_reason text,
  p_evidence jsonb, p_policy_version int, p_actor text default 'ab-classifier')
returns boolean language plpgsql security definer set search_path to '' as $$
declare n int;
begin
  if p_from = 'SUSPENDED' and p_actor = 'ab-classifier' then return false; end if;
  update public.ab_trader_profiles
     set book_state = p_to, state_since = now(), state_reason = left(p_reason, 300), policy_version = p_policy_version,
         last_ab_exit_at = case when p_from in ('AB_DEMO', 'AB_LIVE') and p_to in ('BB_DEMO', 'BB_LIVE') then now() else last_ab_exit_at end,
         updated_at = now()
   where person_id = p_person and book_state = p_from;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  insert into public.ab_lifecycle_events (person_id, from_state, to_state, reason, evidence, policy_version, actor)
  values (p_person, p_from, p_to, left(p_reason, 300), coalesce(p_evidence, '{}'::jsonb), p_policy_version, p_actor);
  return true;
end $$;
revoke all on function public.ab_apply_transition(uuid, text, text, text, jsonb, int, text) from public, anon, authenticated;
grant execute on function public.ab_apply_transition(uuid, text, text, text, jsonb, int, text) to service_role;

-- A person releases a SUSPENDED trader back to B-book demo (human decision, audited).
create or replace function public.ab_release_suspension(p_person uuid, p_by text, p_reason text)
returns boolean language sql security definer set search_path to '' as $$
  select public.ab_apply_transition(p_person, 'SUSPENDED', 'BB_DEMO', 'released by ' || p_by || ': ' || p_reason, '{}'::jsonb,
    (select version from public.ab_policy_versions where status = 'ACTIVE'), 'human:' || p_by)
$$;
revoke all on function public.ab_release_suspension(uuid, text, text) from public, anon, authenticated;
grant execute on function public.ab_release_suspension(uuid, text, text) to service_role;

-- Inputs the classifier needs that are not in the ledger: integrity signals and Infinity Stage 2 progress.
create or replace view public.ab_person_signals with (security_invoker = true) as
select public.ab_person_of(a.user_id) as person_id,
  bool_or(coalesce(a.investigation_hold, false)) as investigation_hold,
  bool_or(exists (select 1 from public.trade_safety_flags f where f.account_id = a.id and f.status = 'open'
                  and f.reason in ('data_tampering', 'cross_account_hedge', 'stale_feed_exploit'))) as critical_flag,
  max(case when a.challenge_type = 'infinity' and a.stage = 2 and a.status = 'active' and a.starting_balance > 0
           then (a.balance - a.starting_balance) / a.starting_balance * 100 end) as stage2_profit_pct
from public.trading_accounts a
group by 1;
revoke all on public.ab_person_signals from public, anon, authenticated;
grant select on public.ab_person_signals to service_role;

-- Scheduler: calls the classifier with a dedicated secret (Vault: ipfx_ab_classifier_secret), 2 minutes after
-- each ledger build. The secret value is set outside migrations.
create or replace function public.kick_ab_classifier() returns void language plpgsql security definer set search_path to '' as $$
declare secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'ipfx_ab_classifier_secret' limit 1;
  if secret is null then raise warning 'ab-classifier not scheduled: Vault secret missing'; return; end if;
  perform net.http_post(
    url := 'https://agulweemteoeagscmppy.supabase.co/functions/v1/ab-classifier',
    headers := jsonb_build_object('x-classifier-secret', secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 30000);
end $$;
revoke all on function public.kick_ab_classifier() from public, anon, authenticated;
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'ipfx-ab-classifier';
  perform cron.schedule('ipfx-ab-classifier', '2-59/5 * * * *', 'select public.kick_ab_classifier()');
end $$;
