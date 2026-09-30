-- Repair: production has the current fn_claim_account_breach (from 20260919183000) but never received
-- the columns and table it writes to (from 20260918092933). Every breach claim therefore raised
-- "column does not exist" and rolled back, so breached accounts stayed active and were not flattened.
-- Additive only; mirrors the original definitions exactly.
begin;

alter table public.trading_accounts
  add column if not exists breached_at timestamptz,
  add column if not exists breach_equity numeric,
  add column if not exists breach_floor numeric;

create table if not exists public.account_breach_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.trading_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_type text not null,
  stage integer not null,
  reason text not null check (reason in ('max_drawdown','daily_loss')),
  trigger_equity numeric not null,
  breach_floor numeric not null,
  triggered_at timestamptz not null default clock_timestamp(),
  unique (account_id)
);
alter table public.account_breach_events enable row level security;
revoke all on table public.account_breach_events from public, anon;
grant select on table public.account_breach_events to authenticated;
grant select, insert on table public.account_breach_events to service_role;
drop policy if exists "own breach read" on public.account_breach_events;
create policy "own breach read" on public.account_breach_events
  for select to authenticated using (user_id = (select auth.uid()));

commit;
