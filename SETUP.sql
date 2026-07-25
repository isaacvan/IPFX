-- ============================================================
-- IPFX Capital — ONE-PASTE SETUP (copier + payouts + admin + verification)
-- Safe to run repeatedly. Run this whole file once in the Supabase SQL editor.
-- The trading engine tables (trading_accounts / trades / equity_snapshots)
-- are assumed already created. This file adds everything on top.
-- Nothing here executes trades or moves money — config + views only.
-- ============================================================

-- ---------- payout config on accounts (trader share = 85%) ----------
alter table public.trading_accounts
  add column if not exists profit_split_pct numeric(5,2) not null default 85,
  add column if not exists mirror_enabled   boolean      not null default false;
alter table public.trading_accounts alter column profit_split_pct set default 85;
update public.trading_accounts set profit_split_pct = 85 where profit_split_pct = 80;

-- ---------- mirror targets (own broker vs prop firm) ----------
create table if not exists public.mirror_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null default 'Prop MT5',
  metaapi_account_id text not null,
  region text not null default 'new-york',
  volume_multiplier numeric(8,2) not null default 1.0,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.mirror_targets
  add column if not exists target_type text not null default 'own_broker'
    check (target_type in ('own_broker','prop_firm')),
  add column if not exists firm_name text;
create unique index if not exists idx_mirror_targets_user_active
  on public.mirror_targets(user_id) where (enabled = true);
create index if not exists idx_mirror_targets_user on public.mirror_targets(user_id);

-- ---------- mirror order log ----------
create table if not exists public.mirror_orders (
  id bigint generated always as identity primary key,
  source_trade_id uuid not null,
  target_id uuid references public.mirror_targets(id) on delete set null,
  user_id uuid not null,
  event text not null check (event in ('open','close')),
  symbol text not null,
  side text,
  volume numeric(10,2),
  broker_position_id text,
  status text not null default 'sent' check (status in ('sent','filled','error','skipped')),
  latency_ms integer,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists idx_mirror_orders_trade on public.mirror_orders(source_trade_id);
create index if not exists idx_mirror_orders_user on public.mirror_orders(user_id, created_at desc);

-- ---------- payouts ----------
create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid references public.trading_accounts(id) on delete set null,
  period_start timestamptz,
  period_end timestamptz not null default now(),
  gross_profit numeric(14,2) not null default 0,
  split_pct numeric(5,2) not null default 85,
  trader_share numeric(14,2) not null default 0,
  status text not null default 'pending' check (status in ('pending','approved','paid','void')),
  note text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists idx_payouts_user on public.payouts(user_id, created_at desc);

-- ---------- admins (fail-closed) ----------
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------- RLS: read-own-rows; server (service role) does all writes ----------
alter table public.mirror_targets enable row level security;
alter table public.mirror_orders  enable row level security;
alter table public.payouts        enable row level security;
alter table public.admins         enable row level security;

drop policy if exists "own mirror targets read" on public.mirror_targets;
create policy "own mirror targets read" on public.mirror_targets for select using (user_id = auth.uid());
drop policy if exists "own mirror orders read" on public.mirror_orders;
create policy "own mirror orders read" on public.mirror_orders for select using (user_id = auth.uid());
drop policy if exists "own payouts read" on public.payouts;
create policy "own payouts read" on public.payouts for select using (user_id = auth.uid());
drop policy if exists "admins read self" on public.admins;
create policy "admins read self" on public.admins for select using (user_id = auth.uid());

-- ---------- payout summary (owed = 85% of unpaid realized profit) ----------
create or replace view public.trader_payout_summary as
with last_payout as (
  select account_id, max(period_end) as last_end
  from public.payouts where status <> 'void' group by account_id
),
realized as (
  select t.account_id, a.user_id, a.profit_split_pct, a.status as account_status,
         coalesce(sum(t.pnl), 0) as realized_since
  from public.trades t
  join public.trading_accounts a on a.id = t.account_id
  left join last_payout lp on lp.account_id = t.account_id
  where t.status = 'closed' and (lp.last_end is null or t.closed_at > lp.last_end)
  group by t.account_id, a.user_id, a.profit_split_pct, a.status
)
select account_id, user_id, account_status, profit_split_pct,
  round(realized_since, 2) as realized_profit_unpaid,
  round(greatest(realized_since, 0) * profit_split_pct / 100, 2) as trader_share_owed
from realized;

-- ---------- performance stats (the "good trader?" signal) ----------
create or replace view public.trader_stats as
select account_id,
  count(*) as trades,
  count(*) filter (where pnl > 0) as wins,
  count(*) filter (where pnl < 0) as losses,
  round(100.0 * count(*) filter (where pnl > 0) / nullif(count(*),0), 1) as win_rate,
  round(coalesce(sum(pnl) filter (where pnl > 0),0),2) as gross_win,
  round(coalesce(abs(sum(pnl) filter (where pnl < 0)),0),2) as gross_loss,
  round(coalesce(sum(pnl) filter (where pnl > 0),0) / nullif(abs(sum(pnl) filter (where pnl < 0)),0),2) as profit_factor,
  round(coalesce(avg(pnl),0),2) as avg_trade,
  round(coalesce(max(pnl),0),2) as best_trade,
  round(coalesce(min(pnl),0),2) as worst_trade
from public.trades where status = 'closed' group by account_id;

-- ---------- risk: max equity drawdown from the snapshot curve ----------
create or replace view public.trader_risk as
with eq as (
  select account_id, equity, created_at,
    max(equity) over (partition by account_id order by created_at
      rows between unbounded preceding and current row) as running_peak
  from public.equity_snapshots
)
select account_id,
  round(coalesce(max((running_peak - equity) / nullif(running_peak,0)) * 100, 0), 2) as max_drawdown_pct
from eq group by account_id;

-- ============================================================
-- ACTIVATE ADMIN: replace with your ipfxcapital.com login email, run once.
-- ============================================================
--   insert into public.admins(user_id)
--   select id from auth.users where email = 'YOUR_LOGIN_EMAIL'
--   on conflict do nothing;
