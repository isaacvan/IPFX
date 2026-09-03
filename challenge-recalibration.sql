-- ============================================================
-- IPFX Capital — challenge recalibration (Traditional 3-phase,
-- Infinity 4-stage rebalanced, Futures 2-phase)
--
-- WHY THIS EXISTS
-- Monte Carlo simulation (6 trader archetypes, elite through losing,
-- population-weighted, engine rules applied in engine order) of the
-- LIVE 2-phase Traditional rules found:
--   - Zero-edge ("coinflip") traders passed 34.0% of the time.
--   - Overall pass rate across the population: 38.3%.
--   - Because the challenge fee is refunded on first payout, a pass
--     rate anywhere near 50% makes the fee refund alone net the
--     business to zero or negative BEFORE any payout is even paid
--     (fee revenue = f*(1-2q), which goes negative as q -> 50%).
--   - Expected payout per challenge SOLD (population-weighted) was
--     10.4% of account size, meaning break-even fee on a $10K
--     challenge was ~$4,447 against a live price of $79.
--
-- THE FIX IS STRUCTURAL, NOT JUST A NUMBER
-- A single "reach +T% before -D%" test has a lucky-pass probability of
-- ~D/(T+D) NO MATTER what T and D are — tightening the ratio helps a
-- little but there is no single-phase setting that both keeps elite
-- traders and locks out luck, because a stricter ratio punishes the
-- elite trader by exactly the same geometry it punishes luck.
--
-- What actually works: MULTIPLE PHASES AT LOOSER PER-PHASE SETTINGS.
-- An elite trader's edge compounds favourably across repeated,
-- independent tests; a lucky run does not survive repetition. Grid
-- search (elite >= 45% subject to zero-edge <= 3%) found 2-phase
-- structures cap out at ~34% elite no matter how they're tuned, while
-- 3-phase and 4-phase structures clear both bars simultaneously with
-- LOOSER per-phase targets/drawdowns than the 2-phase attempt needed.
--
-- RESULT OF THE RECALIBRATION (same Monte Carlo, same population):
--                         old (2-phase)   new (3-phase)
--   zero-edge pass rate       34.0%            3.0%
--   overall pass rate         38.3%            5.6%
--   payout burden / sale      10.4%            1.5%   (% of account)
--   break-even fee, $10K     ~$4,447           ~$168
--
-- The lower fee floor is the point: this recalibration is what makes a
-- competitive, marketable fee ($79-$149) actually profitable instead
-- of a guaranteed structural loss regardless of price.
--
-- NOT INCLUDED: infra, CAC, payment processing, support, and a
-- variance/reserve margin above pure expectation (a small firm can
-- still be ruined by an early unlucky cluster of real winners even
-- though the long-run expectation is sound). See the accompanying
-- economics write-up for a fee recommendation that layers those in —
-- this file only fixes the STRUCTURAL hole, not the final price.
--
-- Safe to run repeatedly (idempotent upsert).
-- ============================================================

-- ---- Traditional: 2 phases -> 3 phases ----
-- Old: 8%/4% target, 10% static dd, 5% daily, no min trades.
-- New: 8%/5%/4%, 6% static dd, 3% daily, 1% risk cap, 15 min trades and
-- 5 min days PER PHASE. Fee schedule updated (see note above — these
-- are a starting point pending real cost inputs, not a final number).
insert into public.challenge_presets
 (id, challenge_type, stage, label, starting_balance, fee_usd, profit_target_pct, max_drawdown_pct,
  daily_loss_pct, drawdown_mode, min_trading_days, min_trades, max_risk_per_trade_pct,
  daily_profit_cap_pct, min_profitable_days_pct, max_attempts_per_month, require_stop_loss,
  profit_split_pct, next_preset_id)
values
 ('trad_10k_p1','traditional',1,'10K Challenge - Phase 1',  10000,129, 8,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,'trad_10k_p2'),
 ('trad_10k_p2','traditional',2,'10K Challenge - Phase 2',  10000,  0, 5,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,'trad_10k_p3'),
 ('trad_10k_p3','traditional',3,'10K Challenge - Phase 3',  10000,  0, 4,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,NULL),

 ('trad_25k_p1','traditional',1,'25K Challenge - Phase 1',  25000,199, 8,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,'trad_25k_p2'),
 ('trad_25k_p2','traditional',2,'25K Challenge - Phase 2',  25000,  0, 5,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,'trad_25k_p3'),
 ('trad_25k_p3','traditional',3,'25K Challenge - Phase 3',  25000,  0, 4,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,NULL),

 ('trad_50k_p1','traditional',1,'50K Challenge - Phase 1',  50000,299, 8,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,'trad_50k_p2'),
 ('trad_50k_p2','traditional',2,'50K Challenge - Phase 2',  50000,  0, 5,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,'trad_50k_p3'),
 ('trad_50k_p3','traditional',3,'50K Challenge - Phase 3',  50000,  0, 4,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,NULL),

 ('trad_100k_p1','traditional',1,'100K Challenge - Phase 1',100000,449,8,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,'trad_100k_p2'),
 ('trad_100k_p2','traditional',2,'100K Challenge - Phase 2',100000,  0,5,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,'trad_100k_p3'),
 ('trad_100k_p3','traditional',3,'100K Challenge - Phase 3',100000,  0,4,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,NULL),

 ('trad_200k_p1','traditional',1,'200K Challenge - Phase 1',200000,799,8,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,'trad_200k_p2'),
 ('trad_200k_p2','traditional',2,'200K Challenge - Phase 2',200000,  0,5,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,'trad_200k_p3'),
 ('trad_200k_p3','traditional',3,'200K Challenge - Phase 3',200000,  0,4,6,3,'static',5,15,1,NULL,NULL,NULL,true,85,NULL),

-- ---- Infinity: same 4 stages, Stage 3 was the killer ----
-- Old Stage 3: 10% target vs a 2.5% trailing drawdown — a 4:1 ratio so
-- tight that even an elite trader (0.50R expectancy) failed it ~63% of
-- the time, which is exactly why almost nobody reached the "Stage 4 —
-- we earn nothing until you get here" point the business model needs.
-- New: all three evaluation stages run the SAME 7% target / 8% trailing
-- intraday drawdown / 4% daily / 1% risk-per-trade / 20 min trades —
-- uniform per-phase settings are what the grid search found actually
-- clears both the elite-retention and luck-rejection bars at once, for
-- the same reason the Traditional fix works. Stage 2 keeps a
-- profitable-day requirement but at 55%, not 60%, to avoid stacking two
-- independent hard-to-clear conditions on the same stage.
 ('infinity_s1','infinity',1,'Infinity Stage 1 - Evaluation',  1000,  0, 7,8,4,'trailing_intraday', 6,20,1,3,NULL,3,true, 0,'infinity_s2'),
 ('infinity_s2','infinity',2,'Infinity Stage 2 - Funded Sim',  5000,  0, 7,8,4,'trailing_intraday',10,20,1,NULL,55,NULL,true,85,'infinity_s3'),
 ('infinity_s3','infinity',3,'Infinity Stage 3 - Qualification',10000,0, 7,8,4,'trailing_intraday',10,20,1,NULL,NULL,NULL,true,85,'infinity_s4'),
 ('infinity_s4','infinity',4,'Infinity Stage 4 - Professional',25000, 0, 0,8,4,'trailing_eod',      0, 0,NULL,NULL,NULL,NULL,false,85,NULL),

-- ---- Futures: 1 phase -> 2 phases ----
-- Old: single phase, 6% target / 4% trailing-EOD dd / 2% daily, only a
-- 15-trade floor as a discriminator — a single-phase test with no risk
-- cap and a weak trade-count floor let a zero-edge trader through at a
-- rate close to the raw D/(T+D) geometry (~40%). Splitting into two
-- phases at the SAME per-phase ratio (the geometry that matters is the
-- ratio, not the absolute numbers) keeps the Futures-specific EOD
-- trailing mechanic your Futures page markets, while making luck run
-- the gauntlet twice.
 ('fut_25k_p1','futures',1,'25K Futures - Phase 1',  25000,129,6,4,2,'trailing_eod',6,30,NULL,NULL,NULL,NULL,false,85,'fut_25k_p2'),
 ('fut_25k_p2','futures',2,'25K Futures - Phase 2',  25000,  0,4,4,2,'trailing_eod',6,30,NULL,NULL,NULL,NULL,false,85,NULL),
 ('fut_50k_p1','futures',1,'50K Futures - Phase 1',  50000,179,6,4,2,'trailing_eod',6,30,NULL,NULL,NULL,NULL,false,85,'fut_50k_p2'),
 ('fut_50k_p2','futures',2,'50K Futures - Phase 2',  50000,  0,4,4,2,'trailing_eod',6,30,NULL,NULL,NULL,NULL,false,85,NULL),
 ('fut_100k_p1','futures',1,'100K Futures - Phase 1',100000,329,6,4,2,'trailing_eod',6,30,NULL,NULL,NULL,NULL,false,85,'fut_100k_p2'),
 ('fut_100k_p2','futures',2,'100K Futures - Phase 2',100000,  0,4,4,2,'trailing_eod',6,30,NULL,NULL,NULL,NULL,false,85,NULL),
 ('fut_150k_p1','futures',1,'150K Futures - Phase 1',150000,479,6,4,2,'trailing_eod',6,30,NULL,NULL,NULL,NULL,false,85,'fut_150k_p2'),
 ('fut_150k_p2','futures',2,'150K Futures - Phase 2',150000,  0,4,4,2,'trailing_eod',6,30,NULL,NULL,NULL,NULL,false,85,NULL)

on conflict (id) do update set
  challenge_type=excluded.challenge_type, stage=excluded.stage, label=excluded.label,
  starting_balance=excluded.starting_balance, fee_usd=excluded.fee_usd,
  profit_target_pct=excluded.profit_target_pct, max_drawdown_pct=excluded.max_drawdown_pct,
  daily_loss_pct=excluded.daily_loss_pct, drawdown_mode=excluded.drawdown_mode,
  min_trading_days=excluded.min_trading_days, min_trades=excluded.min_trades,
  max_risk_per_trade_pct=excluded.max_risk_per_trade_pct,
  daily_profit_cap_pct=excluded.daily_profit_cap_pct,
  min_profitable_days_pct=excluded.min_profitable_days_pct,
  max_attempts_per_month=excluded.max_attempts_per_month,
  require_stop_loss=excluded.require_stop_loss,
  profit_split_pct=excluded.profit_split_pct, next_preset_id=excluded.next_preset_id;

-- The old single-phase Futures presets are superseded by the _p1/_p2
-- pair above. Delete them only if no live account currently references
-- them (a live reference must finish its existing rules, not be
-- migrated mid-challenge).
delete from public.challenge_presets
where id in ('fut_25k','fut_50k','fut_100k','fut_150k')
  and not exists (select 1 from public.trading_accounts where preset_id = challenge_presets.id);

-- Verify:
--   select id,label,profit_target_pct,max_drawdown_pct,min_trades,next_preset_id
--   from public.challenge_presets order by challenge_type, stage;
