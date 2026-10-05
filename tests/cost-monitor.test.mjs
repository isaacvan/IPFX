// Cost monitor: E8 funded account (read-only) vs TradeLocker demo copy accounts vs IPFX feed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the E8 monitor account can never trade: database check, admin refusal, read-only client', () => {
  const sql = read('supabase/migrations/20261005150000_cost_monitor.sql');
  assert.match(sql, /check \(role <> 'monitor' or execution_enabled = false\)/);
  const admin = read('supabase/functions/ladder-admin/index.ts');
  assert.match(admin, /The E8 monitor account is read-only and can never receive copies/);
  const client = read('supabase/functions/_shared/tradelocker-read.ts');
  assert.doesNotMatch(client, /\/orders"|\/orders`|method: "DELETE"|placeMarketOrder|closePosition/);
  assert.match(client, /throw new Error\("READ_ONLY_CLIENT"\)/);
  const mon = read('supabase/functions/cost-monitor/index.ts');
  assert.match(mon, /from "\.\.\/_shared\/tradelocker-read\.ts"/);
  assert.doesNotMatch(mon, /from "\.\.\/_shared\/tradelocker\.ts"/, 'the monitor never imports the order-placing client');
});

test('A-book copies go only to prop (ladder) accounts, never demo copy or monitor accounts', () => {
  assert.match(read('supabase/functions/book-executor/index.ts'), /\.eq\("role", "ladder"\)\.eq\("execution_enabled", true\)/);
});

test('monitor runs every minute with its own secret, samples E8 + demo + IPFX at the same moment', () => {
  const sql = read('supabase/migrations/20261005150000_cost_monitor.sql');
  assert.match(sql, /cron\.schedule\('ipfx-cost-monitor', '\* \* \* \* \*', 'select public\.kick_cost_monitor\(\)'\)/);
  assert.doesNotMatch(sql, /vault\.create_secret/, 'secret set outside migrations (public repo)');
  const mon = read('supabase/functions/cost-monitor/index.ts');
  assert.match(mon, /constantTimeEqual\(req\.headers\.get\("x-cost-secret"\) \?\? "", secret\)/);
  assert.match(mon, /ipfx_spread: ix \? Number\(ix\.ask\) - Number\(ix\.bid\) : null/);
});

test('Treasury page offers the three roles; Brain shows the cost comparison', () => {
  const html = read('team-treasury.html');
  assert.match(html, /<option value="monitor">E8 funded account: cost monitor \(read-only, never trades\)<\/option>/);
  assert.match(read('assets/js/team-brain.js'), /function renderCosts\(\)/);
});

test('spread parity: Brain alerts when IPFX spread leaves 80%-125% of E8 and shows the ratio', () => {
  const sql = read('supabase/migrations/20261005160000_spread_parity.sql');
  assert.match(sql, /'cost:spread:' \|\| s\.symbol/);
  assert.match(sql, /s\.ipfx \/ s\.e8 > 1\.25 or s\.ipfx \/ s\.e8 < 0\.8/);
  assert.match(sql, /'ipfx_vs_e8'/);
  assert.match(read('assets/js/team-brain.js'), /IPFX vs E8/);
});
