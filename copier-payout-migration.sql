-- ============================================================
-- IPFX Capital — Copier + Payout Tracking schema
-- Safe to run repeatedly (idempotent).
-- Nothing here executes trades or moves money; it is data +
-- config only. The live copier stays OFF until a mirror_target
-- is created with enabled=true AND a METAAPI_TOKEN secret is set.
-- ============================================================

-- ---- 1. Payout config on the trading account ----
alter table public.trading_accounts
  add column if not exists profit_split_pct numeric(5,2) not null default 80,  -- trader's share
  add column if not exists mirror_enabled   boolean      not null default false; -- copy to live?

-- ---- 2. Where a trader's fills get mirrored (one live account per trader) ----
--    metaapi_account_id + region identify the destination MT5 account in MetaApi.
--    enabled=false means "configured but paused". Credentials (the MetaApi
--    token) live in Supabase secrets, NEVER in this table.
create table if not exists public.mirror_targets (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  label              text not null default 'Prop MT5',
  metaapi_account_id text not null,
  region             text not null default 'new-york',
  volume_multiplier  numeric(8,2) not null default 1.0,  -- scale lot size to the live account
  enabled            boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists idx_mirror_targets_user_active
  on public.mirror_targets(user_id) where (enabled = true);
create index if not exists idx_mirror_targets_user on public.mirror_targets(user_id);

-- ---- 3. Audit log of every mirrored order (also maps our trade -> broker ticket) ----
create table if not exists public.mirror_orders (
  id               bigint generated always as identity primary key,
  source_trade_id  uuid not null,           -- public.trades.id
  target_id        uuid references public.mirror_targets(id) on delete set null,
  user_id          uuid not null,
  event            text not null check (event in ('open','close')),
  symbol           text not null,
  side             text,
  volume           numeric(10,2),
  broker_position_id text,                    -- MT5 position id returned by MetaApi
  status           text not null default 'sent' check (status in ('sent','filled','error','skipped')),
  latency_ms       integer,
  error            text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_mirror_orders_trade on public.mirror_orders(source_trade_id);
create index if not exists idx_mirror_orders_user  on public.mirror_orders(user_id, created_at desc);

-- ---- 4. Payouts: what the firm owes each trader ----
--    A payout run captures realized profit on an account over a period and
--    the trader's share. status: pending -> approved -> paid.
create table if not exists public.payouts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  account_id    uuid references public.trading_accounts(id) on delete set null,
  period_start  timestamptz,
  period_end    timestamptz not null default now(),
  gross_profit  numeric(14,2) not null default 0,   -- realized profit in the period
  split_pct     numeric(5,2)  not null default 80,
  trader_share  numeric(14,2) not null default 0,   -- gross_profit * split_pct/100 (if > 0)
  status        text not null default 'pending' check (status in ('pending','approved','paid','void')),
  note          text,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);
create index if not exists idx_payouts_user on public.payouts(user_id, created_at desc);

-- ---- 5. RLS: traders can read their own mirror config, orders, and payouts ----
alter table public.mirror_targets enable row level security;
alter table public.mirror_orders  enable row level security;
alter table public.payouts        enable row level security;

drop policy if exists "own mirror targets read" on public.mirror_targets;
create policy "own mirror targets read" on public.mirror_targets
  for select using (user_id = auth.uid());

drop policy if exists "own mirror orders read" on public.mirror_orders;
create policy "own mirror orders read" on public.mirror_orders
  for select using (user_id = auth.uid());

drop policy if exists "own payouts read" on public.payouts;
create policy "own payouts read" on public.payouts
  for select using (user_id = auth.uid());
-- No client write policies: only the server (service role) writes these.

-- ---- 6. Live owed-amount summary (realized profit not yet paid out) ----
--    For each account: realized profit since the last payout period_end,
--    and the trader's share of any positive amount.
create or replace view public.trader_payout_summary as
with last_payout as (
  select account_id, max(period_end) as last_end
  from public.payouts
  where status <> 'void'
  group by account_id
),
realized as (
  select
    t.account_id,
    a.user_id,
    a.profit_split_pct,
    a.status as account_status,
    coalesce(sum(t.pnl), 0) as realized_since
  from public.trades t
  join public.trading_accounts a on a.id = t.account_id
  left join last_payout lp on lp.account_id = t.account_id
  where t.status = 'closed'
    and (lp.last_end is null or t.closed_at > lp.last_end)
  group by t.account_id, a.user_id, a.profit_split_pct, a.status
)
select
  account_id,
  user_id,
  account_status,
  profit_split_pct,
  round(realized_since, 2) as realized_profit_unpaid,
  round(greatest(realized_since, 0) * profit_split_pct / 100, 2) as trader_share_owed
from realized;

comment on view public.trader_payout_summary is
  'Per-account realized profit since last payout and the trader''s share owed.';
