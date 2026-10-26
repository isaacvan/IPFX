// Owner decision 2026-10-26: keep the total-risk rule, but flag traders who stack 3+ open positions on one symbol and direction.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
const sql = fs.readFileSync(new URL('../supabase/migrations/20261026120000_brain_stacking_alert.sql', import.meta.url), 'utf8');
test('the alerts scan gains one stacking block and stays a service-role-only function', () => {
  assert.match(sql, /'stack:' \|\| s\.account_id/);
  assert.match(sql, /having count\(\*\) >= 3/);
  assert.match(sql, /status = 'open' and coalesce\(a\.phase, ''\) <> 'demo'/);
  assert.match(sql, /revoke all on function public\.ab_alerts_scan\(\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.ab_alerts_scan\(\) to service_role;/);
  assert.doesNotMatch(sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'), /\b(drop|truncate)\s+table|delete from public\.(trades|trading_accounts)/i);
});
