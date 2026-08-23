-- ============================================================
-- IPFX Capital — prop-firm operational hardening
--
-- Closes gaps that any real, capital-backed prop firm needs before
-- taking on real liability, several of which your own Terms already
-- claim to have (jurisdiction restriction, IP/fingerprint fraud
-- detection) but that weren't actually implemented anywhere.
-- Safe to run repeatedly (idempotent DDL).
-- ============================================================

-- ---- 1. Jurisdiction restriction ----
-- Terms §5 excludes US, Canada (Ontario), and OFAC-sanctioned
-- countries — but the signup form's country dropdown offers "United
-- States" as a selectable option and nothing anywhere checked it.
-- This is a STARTER list only, not a substitute for real
-- sanctions-screening software (ComplyAdvantage, Sanctions.io, etc.)
-- — OFAC/EU/UK lists change; review with compliance counsel before
-- launch and before removing any entry.
create table if not exists public.restricted_countries (
  country_code text primary key,   -- ISO 3166-1 alpha-2
  country_name text not null,
  reason       text,
  added_at     timestamptz not null default now()
);
insert into public.restricted_countries (country_code, country_name, reason) values
  ('US', 'United States', 'Excluded under Terms §5 — CFTC/SEC jurisdiction risk'),
  ('CU', 'Cuba', 'OFAC-sanctioned'),
  ('IR', 'Iran', 'OFAC-sanctioned'),
  ('KP', 'North Korea', 'OFAC-sanctioned'),
  ('SY', 'Syria', 'OFAC-sanctioned')
on conflict (country_code) do nothing;

alter table public.user_profiles
  add column if not exists country_code text,
  add column if not exists restricted_jurisdiction boolean not null default false,
  add column if not exists age_confirmed boolean not null default false;

-- ---- 2. Consent versioning ----
-- Created before the trigger function below since that function
-- inserts into it — table must exist first.
create table if not exists public.consent_records (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  document     text not null check (document in ('terms','privacy')),
  version      text not null,
  accepted_at  timestamptz not null default now()
);
create index if not exists idx_consent_user on public.consent_records(user_id, document, accepted_at desc);
alter table public.consent_records enable row level security;
drop policy if exists "own consent read" on public.consent_records;
create policy "own consent read" on public.consent_records for select using (user_id = auth.uid());

-- Extends the existing signup trigger (from fix-signup-trigger.sql) —
-- same function name, additive only. Computes the restriction flag at
-- signup time; enforcement itself happens in trading-engine (rejecting
-- account provisioning), not by aborting the auth.users insert, since
-- failing inside a GoTrue-managed trigger has unpredictable failure
-- semantics that don't belong in a security-critical path.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    new_referral_code VARCHAR(10);
    referrer_id UUID;
    user_name TEXT;
    v_country_code TEXT;
    v_restricted BOOLEAN;
BEGIN
    new_referral_code := generate_referral_code(NEW.id);

    user_name := COALESCE(
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name',
        split_part(NEW.email, '@', 1)
    );

    v_country_code := upper(NEW.raw_user_meta_data->>'country_code');
    v_restricted := v_country_code IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.restricted_countries WHERE country_code = v_country_code
    );

    IF NEW.raw_user_meta_data->>'referral_code' IS NOT NULL THEN
        SELECT user_id INTO referrer_id
        FROM public.user_profiles
        WHERE referral_code = NEW.raw_user_meta_data->>'referral_code';

        IF referrer_id IS NOT NULL THEN
            UPDATE public.user_profiles
            SET referral_count = referral_count + 1
            WHERE user_id = referrer_id;
        END IF;
    END IF;

    INSERT INTO public.user_profiles (
        user_id, full_name, referral_code, referred_by_code,
        country_code, restricted_jurisdiction, age_confirmed
    )
    VALUES (
        NEW.id, user_name, new_referral_code, NEW.raw_user_meta_data->>'referral_code',
        v_country_code, coalesce(v_restricted, false),
        (NEW.raw_user_meta_data->>'age_confirmed')::boolean IS TRUE
    );

    -- Consent audit trail — which document version this trader agreed
    -- to and when. version numbers come from the client at signup time
    -- (start-challenge.html); if absent, recorded as 'unknown' rather
    -- than silently skipped, so a gap is visible instead of invisible.
    INSERT INTO public.consent_records (user_id, document, version)
    VALUES
      (NEW.id, 'terms', coalesce(NEW.raw_user_meta_data->>'terms_version', 'unknown')),
      (NEW.id, 'privacy', coalesce(NEW.raw_user_meta_data->>'privacy_version', 'unknown'));

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- ---- 3. Admin audit log ----
-- Every state-changing admin-console action writes here: who, what,
-- on whom, when, and the before/after detail. Not client-readable —
-- surfaced only through admin-console's own admin-gated action.
create table if not exists public.admin_audit_log (
  id                 bigint generated always as identity primary key,
  actor_id           uuid not null references auth.users(id),
  action             text not null,
  target_user_id     uuid references auth.users(id),
  target_account_id  uuid references public.trading_accounts(id),
  detail             jsonb,
  created_at         timestamptz not null default now()
);
create index if not exists idx_admin_audit_actor on public.admin_audit_log(actor_id, created_at desc);
create index if not exists idx_admin_audit_target on public.admin_audit_log(target_user_id, created_at desc);
alter table public.admin_audit_log enable row level security;
-- No client policies at all — service-role writes/reads only.

-- ---- 4. Platform kill switch ----
-- Singleton row (id is always `true`) an admin can flip to halt new
-- order placement platform-wide — a stale/broken price feed, a
-- security incident, or a rule bug are all reasons to want this
-- without redeploying code. Closing/flattening existing positions
-- stays allowed during a halt so traders can protect themselves.
create table if not exists public.platform_config (
  id             boolean primary key default true check (id),
  trading_halted boolean not null default false,
  halted_reason  text,
  halted_by      uuid references auth.users(id),
  halted_at      timestamptz,
  updated_at     timestamptz not null default now()
);
insert into public.platform_config (id) values (true) on conflict (id) do nothing;

-- ---- 5. Security events (abuse/rate-limit support) ----
-- Lightweight, app-level rate limiting for financially-sensitive
-- actions — separate from the business-rule gates (7-day payout
-- cadence etc.) in payout-system-v2.sql, this is about spam/abuse
-- (hammering an endpoint), not eligibility.
create table if not exists public.security_events (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id),
  event_type  text not null,
  ip_address  text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_security_events_user_type_time on public.security_events(user_id, event_type, created_at desc);
create index if not exists idx_security_events_ip_time on public.security_events(ip_address, created_at desc);

-- ---- 6. IP logging on order events (multi-accounting detection) ----
-- Terms §? already claims "IP address logging, and device
-- fingerprinting to identify copy trading" as an existing capability —
-- it wasn't implemented anywhere. This adds the IP side, captured
-- server-side from the request itself (never trusted from the client).
alter table public.order_audit_events
  add column if not exists client_ip text;

-- Admin-facing view: accounts that share an IP address on their order
-- activity, i.e. candidates for the multi-accounting check your Terms
-- already promises. Informational only — never auto-actioned.
create or replace view public.shared_ip_accounts as
select
  oae.client_ip,
  count(distinct oae.user_id) as distinct_users,
  array_agg(distinct oae.user_id) as user_ids,
  min(oae.server_ts) as first_seen,
  max(oae.server_ts) as last_seen
from public.order_audit_events oae
where oae.client_ip is not null
group by oae.client_ip
having count(distinct oae.user_id) > 1;

comment on view public.shared_ip_accounts is
  'IP addresses used by more than one trader — review candidates for the multi-accounting/copy-trading detection promised in Terms. Shared IPs happen innocently (same household, office, VPN) so this is a lead to investigate, never grounds to act on alone.';

-- Verify after running:
--   select * from public.restricted_countries;
--   select * from public.platform_config;
--   select column_name from information_schema.columns where table_name='user_profiles' and column_name in ('country_code','restricted_jurisdiction','age_confirmed');
--   select column_name from information_schema.columns where table_name='order_audit_events' and column_name='client_ip';
