// Team Traders page: intra-trade drawdown check, and the owner-only "Move to next stage" override.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
const fn = fs.readFileSync(new URL('../supabase/functions/admin-console/index.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../assets/js/ws-traders.js', import.meta.url), 'utf8');
const sql = fs.readFileSync(new URL('../supabase/migrations/20261028120000_owner_advance_infinity_stage.sql', import.meta.url), 'utf8');
test('advance_stage is owner-only, needs MFA, writes the audit row first and calls the service-role function', () => {
  assert.match(fn, /"gap_resolve", "advance_stage"\]\);/);
  assert.match(fn, /"close_account", "set_mirror", "advance_stage"\]\);/);
  const a = fn.slice(fn.indexOf('if (action === "advance_stage")'), fn.indexOf('if (action === "set_investigation_hold")'));
  assert.ok(a.indexOf('logAdminStrict("advance_stage"') > 0 && a.indexOf('logAdminStrict') < a.indexOf('fn_owner_advance_infinity_stage'));
  assert.match(sql, /revoke all on function public\.fn_owner_advance_infinity_stage\(uuid, uuid\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.fn_owner_advance_infinity_stage\(uuid, uuid\) to service_role;/);
});
test('the override still refuses open trades, frozen accounts and non-eligible accounts, but skips the progression boxes', () => {
  for (const k of ["'OPEN_POSITIONS'", "'ACCOUNT_FROZEN'", "'PARENT_NOT_ELIGIBLE'", "'NEXT_PRESET_UNAVAILABLE'"]) assert.ok(sql.includes(k), k);
  assert.doesNotMatch(sql, /qualification_progress_v2|TARGET_INCOMPLETE|account_progress/);
});
test('the drawdown check reports yes/no, the margin and coverage, and reads only recorded lows', () => {
  const body = fn.slice(fn.indexOf('function drawdownCheck('), fn.indexOf('// The same boxes the trader sees'));
  for (const k of ['hit: worstDaily.margin <= 0', 'hit: worstOverall.margin <= 0', 'trades_not_checked', 'closest_margin', 'floating_loss_in_that_trade']) assert.ok(body.includes(k), k);
  assert.match(fn, /drawdown_check: drawdownCheck\(a, ts, lowsByTrade\)/);
  assert.match(fn, /from\("ipfx_trade_lows"\)\.select/);
});
test('the trader panel shows the drawdown rows and the Move to next stage button only for active Stage 1-3 accounts', () => {
  assert.match(ui, /function drawdownSection\(/);
  assert.match(ui, /Move to next stage/);
  assert.match(ui, /\/Stage \[123\]\$\/\.test/);
  assert.match(ui, /advance: \(\) => advance\(b\)/);
});
