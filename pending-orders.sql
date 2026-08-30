-- ============================================================
-- IPFX Capital — pending orders (limit / stop)
--
-- IPFX Markets was market-orders-only. Every competing platform
-- (TradingView, TradeLocker, MT4/5, cTrader) has had limit and stop
-- orders for decades; without them a trader cannot set up a trade and
-- walk away, which is most of how retail traders actually operate.
--
-- Fill semantics (checked server-side against the live bid/ask, never
-- from a browser-supplied price):
--   buy  limit -> fills when ask <= trigger   (price falls INTO the bid)
--   sell limit -> fills when bid >= trigger   (price rises INTO the offer)
--   buy  stop  -> fills when ask >= trigger   (breakout upward)
--   sell stop  -> fills when bid <= trigger   (breakdown)
--
-- A pending order is NOT a bypass of the challenge rules: at fill time
-- the engine re-runs the same gates a market order goes through (margin,
-- per-trade risk cap, mandatory stop-loss, daily profit cap). If a gate
-- fails the order is rejected with a reason rather than silently filled.
--
-- Safe to run repeatedly (idempotent DDL).
-- ============================================================

create table if not exists public.pending_orders (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references public.trading_accounts(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  symbol           text not null,
  side             text not null check (side in ('buy','sell')),
  order_type       text not null check (order_type in ('limit','stop')),
  volume           numeric(10,2) not null check (volume > 0),
  trigger_price    numeric(18,6) not null check (trigger_price > 0),
  sl               numeric(18,6),
  tp               numeric(18,6),
  status           text not null default 'pending'
                     check (status in ('pending','filled','cancelled','rejected','expired')),
  filled_trade_id  uuid,
  fill_price       numeric(18,6),
  reject_reason    text,
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);

create index if not exists idx_pending_account_status
  on public.pending_orders(account_id, status);
create index if not exists idx_pending_open
  on public.pending_orders(symbol) where status = 'pending';

alter table public.pending_orders enable row level security;
drop policy if exists "own pending read" on public.pending_orders;
create policy "own pending read" on public.pending_orders
  for select using (user_id = auth.uid());
-- No client write policy: only the engine (service role) writes these,
-- same rule as trades.

comment on table public.pending_orders is
  'Limit and stop orders awaiting a trigger. Filled server-side by the engine against live bid/ask, and re-checked against the account challenge rules at fill time so a pending order cannot bypass the per-trade risk cap.';

-- Verify:
--   select id,symbol,side,order_type,trigger_price,status from public.pending_orders order by created_at desc limit 20;
