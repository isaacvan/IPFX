// Owner decision 2026-10-24: keep only the Brain's anti-cheating alerts. Research jobs are paused, anti-cheat / trading / housekeeping jobs are not.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
const sql = fs.readFileSync(new URL('../supabase/migrations/20261024130000_pause_non_anticheat_brain_jobs.sql', import.meta.url), 'utf8');
const body = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const paused = [...body.matchAll(/'(ipfx-[a-z0-9-]+)'/g)].map((m) => m[1]);

test('exactly the research jobs are paused', () => {
  assert.deepEqual(paused.sort(), ['ipfx-cost-monitor', 'ipfx-e8-copy-backtest', 'ipfx-e8-reference', 'ipfx-e8-simulator', 'ipfx-e8-trader-followup', 'ipfx-e8-trader-perf',
    'ipfx-e8-trader-perf-nightly', 'ipfx-e8-trader-perf-watchdog', 'ipfx-strategy-lab-daily', 'ipfx-trade-lows', 'ipfx-validation-paper']);
  assert.match(body, /cron\.alter_job\(job_id := j\.jobid, active := false\)/);
});

test('nothing in the anti-cheating chain, trading path or housekeeping is paused, and nothing is deleted', () => {
  const keep = ['ipfx-brain-scan', 'ipfx-hedge-scan', 'ipfx-trade-similarity', 'ipfx-trader-detector', 'ipfx-ab-classifier', 'ipfx-ab-ledger', 'ipfx-book-reconcile', 'ipfx-treasury',
    'ipfx-quote-pump', 'ipfx-drawdown-sweep', 'ipfx-equity-guard', 'ipfx-venue-sync', 'ipfx-failed-pending-cleanup', 'ipfx-demo-mirror-outbox', 'ipfx-email-outbox', 'ipfx-infinity-monthly-restart'];
  for (const k of keep) assert.ok(!paused.includes(k), k);
  assert.doesNotMatch(body, /\b(unschedule|drop|delete|truncate)\b/i);
  assert.match(sql, /UNDO[\s\S]*active := true/);
});

test('the alert scanner only raises "stopped" alerts for jobs that stay on, so pausing causes no false alarms', () => {
  const scanner = fs.readFileSync(new URL('../supabase/migrations/20261008160000_kyc_document_view_alert.sql', import.meta.url), 'utf8');
  const watched = [...scanner.matchAll(/\('(ipfx-[a-z-]+)', '/g)].map((m) => m[1]);
  assert.deepEqual(watched.sort(), ['ipfx-ab-ledger', 'ipfx-book-reconcile', 'ipfx-drawdown-sweep']);
  for (const w of watched) assert.ok(!paused.includes(w), w);
});
