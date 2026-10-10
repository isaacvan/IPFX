-- The treasury forecaster needs each account's opening time to know which Stage 2 target a run gets
-- (rule set B: 7% for runs whose Stage 1 opened from 2026-10-11, 6% before). Column appended; nothing else changes.
create or replace view public.treasury_open_accounts as
 SELECT id,
    ab_person_of(user_id) AS person_id,
    stage,
    starting_balance,
    balance,
    trailing_peak,
    profit_target_pct,
    max_drawdown_pct,
    max_risk_per_trade_pct,
    created_at
   FROM trading_accounts a
  WHERE challenge_type = 'infinity'::text AND status = 'active'::text AND access_revoked_at IS NULL;
