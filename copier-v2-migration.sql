-- ============================================================
-- IPFX Capital — Copier v2: target types + trader performance
-- Idempotent. Run after copier-payout-migration.sql.
-- ============================================================

-- ---- 1. Label each mirror destination: your own broker vs a prop firm ----
--    'own_broker' = zero ToS risk (you own the account/capital).
--    'prop_firm'  = check the firm's terms; most ban external copiers.
alter table public.mirror_targets
  add column if not exists target_type text not null default 'own_broker'
    check (target_type in ('own_broker','prop_firm')),
  add column if not exists firm_name text;

-- ---- 2. Per-account performance stats (from closed trades) ----
--    The "is this a good trader?" signal for the verification console.
create or replace view public.trader_stats as
select
  account_id,
  count(*)                                              as trades,
  count(*) filter (where pnl > 0)                       as wins,
  count(*) filter (where pnl < 0)                       as losses,
  round(100.0 * count(*) filter (where pnl > 0) / nullif(count(*), 0), 1) as win_rate,
  round(coalesce(sum(pnl) filter (where pnl > 0), 0), 2)                  as gross_win,
  round(coalesce(abs(sum(pnl) filter (where pnl < 0)), 0), 2)             as gross_loss,
  round(
    coalesce(sum(pnl) filter (where pnl > 0), 0)
    / nullif(abs(sum(pnl) filter (where pnl < 0)), 0), 2)                 as profit_factor,
  round(coalesce(avg(pnl), 0), 2)                       as avg_trade,
  round(coalesce(max(pnl), 0), 2)                       as best_trade,
  round(coalesce(min(pnl), 0), 2)                       as worst_trade
from public.trades
where status = 'closed'
group by account_id;

comment on view public.trader_stats is
  'Per-account closed-trade performance: count, win rate, profit factor, extremes.';
