-- ============================================================
-- IPFX Capital — Server-Side Trading Engine v1
-- Tables + Row Level Security
--
-- Design: the browser can SELECT its own rows but can NEVER
-- insert/update/delete. All writes go through the
-- `trading-engine` Edge Function using the service role key.
-- This is what makes trade records trustworthy.
-- ============================================================

create extension if not exists pgcrypto;

-- 1. Trading accounts (one active account per user)
create table if not exists public.trading_accounts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  label              text not null default 'Challenge 100K',
  starting_balance   numeric(14,2) not null default 100000,
  balance            numeric(14,2) not null default 100000,   -- realized only
  profit_target_pct  numeric(5,2) not null default 8,
  max_drawdown_pct   numeric(5,2) not null default 10,
  daily_loss_pct     numeric(5,2) not null default 5,
  day_start_equity   numeric(14,2) not null default 100000,
  day_start_date     date not null default current_date,
  status             text not null default 'active'
                     check (status in ('active','passed','breached')),
  breach_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- one ACTIVE account per user (passed/breached accounts are kept as history)
create unique index if not exists idx_trading_accounts_one_active
  on public.trading_accounts(user_id) where (status = 'active');
create index if not exists idx_trading_accounts_user
  on public.trading_accounts(user_id);

-- 2. Trades (one row per position: open -> closed)
create table if not exists public.trades (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.trading_accounts(id) on delete cascade,
  user_id     uuid not null,
  symbol      text not null,
  side        text not null check (side in ('buy','sell')),
  volume      numeric(10,2) not null check (volume >= 0.01 and volume <= 100),
  open_price  numeric(18,6) not null,
  close_price numeric(18,6),
  sl          numeric(18,6),
  tp          numeric(18,6),
  status      text not null default 'open' check (status in ('open','closed')),
  close_reason text,             -- manual | sl | tp | breach
  pnl         numeric(14,2),     -- realized USD, set on close
  opened_at   timestamptz not null default now(),
  closed_at   timestamptz
);

create index if not exists idx_trades_account_status on public.trades(account_id, status);
create index if not exists idx_trades_user_opened on public.trades(user_id, opened_at desc);

-- 3. Equity snapshots (audit trail for the equity curve)
create table if not exists public.equity_snapshots (
  id         bigint generated always as identity primary key,
  account_id uuid not null references public.trading_accounts(id) on delete cascade,
  user_id    uuid not null,
  balance    numeric(14,2) not null,
  equity     numeric(14,2) not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_equity_snapshots_account
  on public.equity_snapshots(account_id, created_at desc);

-- 4. Row Level Security: read-own-rows only, NO client writes
alter table public.trading_accounts enable row level security;
alter table public.trades           enable row level security;
alter table public.equity_snapshots enable row level security;

drop policy if exists "own accounts read"  on public.trading_accounts;
create policy "own accounts read" on public.trading_accounts
  for select using (user_id = auth.uid());

drop policy if exists "own trades read" on public.trades;
create policy "own trades read" on public.trades
  for select using (user_id = auth.uid());

drop policy if exists "own snapshots read" on public.equity_snapshots;
create policy "own snapshots read" on public.equity_snapshots
  for select using (user_id = auth.uid());

-- No insert/update/delete policies exist on purpose:
-- with RLS enabled and no write policy, anon/authenticated clients
-- cannot write. The Edge Function uses the service role which
-- bypasses RLS.
