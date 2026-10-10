// The free backtest form posts to a table that was never created (owner report 2026-10-10).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sql = read('supabase/migrations/20261010010000_backtest_submissions.sql');
const page = read('backtest.html');

test('the table the form posts to exists, accepts visitor inserts only and limits what can be stored', () => {
  assert.match(page, /rest\/v1\/backtest_submissions/);
  assert.match(sql, /create table if not exists public\.backtest_submissions/);
  for (const col of ['first_name', 'last_name', 'email', 'strategy_name', 'instruments', 'timeframe', 'language', 'description', 'status', 'submitted_at']) assert.ok(sql.includes(col), col);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on public\.backtest_submissions from public, anon, authenticated;\s+grant insert on public\.backtest_submissions to anon, authenticated;/);
  assert.match(sql, /for insert to anon, authenticated with check \(true\)/);
  assert.doesNotMatch(sql, /for select|grant select on public\.backtest_submissions to anon/);
  assert.match(sql, /char_length\(btrim\(description\)\) between 10 and 5000/);
  assert.match(sql, /new\.status := 'pending';\s+new\.submitted_at := now\(\);/);
  assert.match(sql, />= 3 then\s+raise exception 'BACKTEST_RATE_LIMITED'/);
  assert.match(sql, />= 200 then\s+raise exception 'BACKTEST_BUSY'/);
  assert.match(sql, /notify pgrst, 'reload schema'/);
});

test('the form gives a clear message for the daily limit and a contact address for other failures', () => {
  assert.match(page, /BACKTEST_RATE_LIMITED/);
  assert.match(page, /enquiries@ipfxcapital\.com/);
  assert.match(page, /status:'pending'/);
});

test('the strategy submission tool on IPFX Markets also has its table, with visitor inserts only and size limits', () => {
  const trading = read('trading.html');
  assert.match(trading, /rest\/v1\/strategy_submissions/);
  const s = read('supabase/migrations/20261010011000_strategy_submissions.sql');
  assert.match(s, /create table if not exists public\.strategy_submissions/);
  for (const col of ['account_name', 'login', 'strategy_name', 'language', 'max_risk_pct', 'code', 'status', 'submitted_at']) assert.ok(s.includes(col), col);
  assert.match(s, /enable row level security/);
  assert.match(s, /grant insert on public\.strategy_submissions to anon, authenticated;/);
  assert.doesNotMatch(s, /for select|grant select on public\.strategy_submissions to anon/);
  assert.match(s, /char_length\(btrim\(code\)\) between 1 and 100000/);
  assert.match(s, /new\.status := 'pending_review';/);
  assert.match(s, />= 10 then\s+raise exception 'STRATEGY_RATE_LIMITED'/);
});
