-- ============================================================
-- IPFX Capital — Bot API token rollout (one-time backfill + ongoing issuance)
--
-- Scope: gives every existing real trader a token that authenticates
-- their OWN bot to their OWN simulated IPFX account via trading-engine.
-- It does NOT grant access to any other account, any broker, or any
-- other platform. Cross-firm trade replication is explicitly out of
-- scope — see docs/risk-framework/deepseek-ipfx-report.md Phase 4-6.
--
-- Design:
--   - api_token (already deployed, owner-only under RLS) stores only
--     token_hash_sha256 — never the plaintext. That invariant is kept.
--   - api_token_pending_reveal (new, this file) holds the plaintext
--     exactly until the trader's own dashboard shows it once and they
--     confirm they've saved it (client deletes the row on confirm).
--     RLS restricts each row to its own person — never cross-visible.
-- ============================================================

-- 1. Backfill a person row for every existing real auth user that
--    doesn't have one yet (internal-control-core.sql shipped the table
--    but nothing had populated it for the 90 users who signed up before
--    this schema existed).
insert into public.person (auth_user_id)
select u.id
from auth.users u
left join public.person p on p.auth_user_id = u.id
where p.id is null;

-- 1b. Backfill a trading_account (internal-control governance row) for
--     every person who has at least one live trading_accounts row but no
--     governance row yet — otherwise the owner dashboard's Traders list
--     (which reads trading_account, not person, per report §10.2) stays
--     empty and there is no link into a trader's profile page at all.
--     Picks each trader's most recent live account kind='simulated'
--     since this platform is entirely simulated challenge trading.
insert into public.trading_account (person_id, live_trading_account_id, account_kind)
select distinct on (p.id)
  p.id, ta.id, 'simulated'
from public.person p
join public.trading_accounts ta on ta.user_id = p.auth_user_id
left join public.trading_account gov on gov.person_id = p.id
where gov.id is null
order by p.id, ta.created_at desc;

-- 2. One-time plaintext reveal table.
create table if not exists public.api_token_pending_reveal (
  id             uuid primary key default gen_random_uuid(),
  api_token_id   uuid not null references public.api_token(id) on delete cascade,
  person_id      uuid not null references public.person(id) on delete cascade,
  plaintext      text not null,
  key_fingerprint text not null,
  scope_text     text[] not null default '{}',
  created_at     timestamptz not null default now()
);
create index if not exists idx_reveal_person on public.api_token_pending_reveal(person_id);

alter table public.api_token_pending_reveal enable row level security;

drop policy if exists own_row_select on public.api_token_pending_reveal;
create policy own_row_select on public.api_token_pending_reveal for select
  using (public.fn_is_admin() or person_id = public.fn_own_person_id());

drop policy if exists own_row_delete on public.api_token_pending_reveal;
create policy own_row_delete on public.api_token_pending_reveal for delete
  using (public.fn_is_admin() or person_id = public.fn_own_person_id());
-- Deliberately no insert/update policy: only server-side (this migration,
-- or a future service-role-backed "rotate key" function) ever writes a
-- plaintext value here — never directly from a client.

-- 3. Issue one bot API token for every person who doesn't already have
--    one. Scoped to "trade:own_account" only — bot can place/close/modify
--    orders on that trader's own simulated account, nothing else.
with new_tokens as materialized (
  select
    p.id as person_id,
    'ipfx_bot_' || encode(gen_random_bytes(24), 'hex') as plaintext
  from public.person p
  where not exists (select 1 from public.api_token t where t.person_id = p.id)
),
inserted_tokens as (
  insert into public.api_token (person_id, scope_text, token_hash_sha256, key_fingerprint)
  select
    nt.person_id,
    array['trade:own_account'],
    public.fn_sha256(nt.plaintext),
    right(nt.plaintext, 6)
  from new_tokens nt
  returning id, person_id, key_fingerprint
)
insert into public.api_token_pending_reveal (api_token_id, person_id, plaintext, key_fingerprint, scope_text)
select it.id, it.person_id, nt.plaintext, it.key_fingerprint, array['trade:own_account']
from inserted_tokens it
join new_tokens nt on nt.person_id = it.person_id;

-- Verification: counts only, never the plaintext itself.
select
  (select count(*) from public.person) as total_persons,
  (select count(*) from public.trading_account) as total_governance_accounts,
  (select count(*) from public.api_token) as total_tokens,
  (select count(*) from public.api_token_pending_reveal) as pending_reveals;
