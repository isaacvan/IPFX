-- Owner decision 2026-10-24: "only keep alerts from the Brain, the anti-cheating thing". These scheduled jobs are Brain research that no
-- anti-cheating alert reads, and they were the largest background writers on the database (ipfx_trade_lows alone was about 16 rows a second).
-- They are PAUSED, not deleted: every job, table and function is kept as is, and the change is undone with the statement at the bottom.
--
-- KEPT running (anti-cheating chain): ipfx-brain-scan (alerts), ipfx-hedge-scan (opposite-side rings), ipfx-trade-similarity (herds / copied
-- trades), ipfx-trader-detector, ipfx-ab-classifier and ipfx-ab-ledger (they compute the NO_SL / FAST / SPEED / HERD / FLAG tags and the
-- ledger they use). Also kept: everything trading and housekeeping (price pump, sweeps, equity guard, venue sync, demo mirror, email outbox,
-- monthly restart, purges), plus ipfx-book-reconcile and ipfx-treasury, because the alert scanner raises a "worker has stopped" alert if they stop.
--
-- PAUSED: worst-price recorder (trade-lows), E8 monitor/simulator/backtest/trader-performance (7 jobs), paper-test tick, spread/cost sampling,
-- strategy lab. Alerts that need them (spread parity vs E8) simply go quiet: their data window is empty, they do not fire false alarms.
begin;
select cron.alter_job(job_id := j.jobid, active := false)
from cron.job j
where j.jobname in (
  'ipfx-trade-lows',
  'ipfx-validation-paper',
  'ipfx-e8-copy-backtest',
  'ipfx-e8-reference',
  'ipfx-e8-simulator',
  'ipfx-e8-trader-followup',
  'ipfx-e8-trader-perf',
  'ipfx-e8-trader-perf-nightly',
  'ipfx-e8-trader-perf-watchdog',
  'ipfx-cost-monitor',
  'ipfx-strategy-lab-daily'
);
commit;

-- UNDO (turns the same 11 jobs back on):
--   select cron.alter_job(job_id := jobid, active := true) from cron.job where jobname in ('ipfx-trade-lows','ipfx-validation-paper',
--     'ipfx-e8-copy-backtest','ipfx-e8-reference','ipfx-e8-simulator','ipfx-e8-trader-followup','ipfx-e8-trader-perf',
--     'ipfx-e8-trader-perf-nightly','ipfx-e8-trader-perf-watchdog','ipfx-cost-monitor','ipfx-strategy-lab-daily');
