-- ============================================================
-- IPFX Capital — payout drawdown buffer
--
-- Previously, taking a payout was pure bookkeeping: a row in
-- public.payouts recording what's owed, with no effect on the
-- account's simulated balance. That meant "taking a payout" didn't
-- actually behave like withdrawing money from the account.
--
-- This makes a payout behave like a real withdrawal (balance goes
-- down by the amount paid out) while adding a buffer so that the
-- withdrawal itself is never misread as a trading loss and doesn't
-- push the account toward a drawdown breach it didn't actually earn.
-- See trading-engine/index.ts enforce() — ddFloor now subtracts
-- total_paid_out, and payout_create (admin-console) advances
-- day_start_equity by the same amount so the daily-loss floor isn't
-- affected either.
-- ============================================================

alter table public.trading_accounts
  add column if not exists total_paid_out numeric(14,2) not null default 0;

comment on column public.trading_accounts.total_paid_out is
  'Cumulative amount paid out to the trader from this account. Subtracted from the max-drawdown floor so withdrawing profit never counts as a loss toward breaching the account.';
