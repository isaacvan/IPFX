// One-time free Stage 1 restart for earlier-rules runs with a day above the daily cap (owner request 2026-10-12).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sql = read('supabase/migrations/20261012220000_infinity_fresh_restart_offer.sql');
const engine = read('supabase/functions/trading-engine/index.ts');
const page = read('trading.html');

test('the offer is per person: best day, what the best-day rule needs, how much more, and days left', () => {
  assert.match(sql, /if coalesce\(accepted, ''\) >= '2026-10-12-2\.1' then return jsonb_build_object\('eligible', false, 'reason', 'already_on_new_rules'\)/);
  assert.match(sql, /if best is null or best <= cap then return jsonb_build_object\('eligible', false, 'reason', 'no_day_above_cap'\)/);
  assert.match(sql, /need := round\(best \/ share, 2\);/);
  assert.match(sql, /remaining := greatest\(0, round\(need - pos, 2\)\);/);
  assert.match(sql, /'min_more_profitable_days', case when cap > 0 then ceil\(remaining \/ cap\)::int else null end/);
  assert.match(sql, /'days_left_in_month', days_left/);
  assert.match(sql, /used := exists \(select 1 from public\.infinity_restart_offers o where o\.user_id = a\.user_id\);/);
});

test('the restart is owner-only, once, flat-only, archives the old run and starts a Terms 2.1 run', () => {
  assert.match(sql, /if not found or a\.user_id is distinct from p_user then raise exception 'RESTART_NOT_AVAILABLE'/);
  assert.match(sql, /raise exception 'CLOSE_POSITIONS_FIRST'/);
  assert.match(sql, /insert into public\.infinity_retired_accounts \(account_id, reset_id, user_id, snapshot\)/);
  assert.match(sql, /access_revoked_reason = 'infinity_fresh_restart_offer'/);
  assert.match(sql, /'source', 'fresh_restart_offer', 'terms_version', terms_v/);
  assert.match(sql, /insert into public\.platform_legal_acceptances/);
  assert.match(sql, /insert into public\.infinity_restart_offers \(user_id, old_account_id, new_account_id, snapshot\)/);
  assert.doesNotMatch(sql, /delete from public\.(trades|trading_accounts)/);
  assert.match(engine, /if \(body\.action === "infinity_fresh_restart"\) \{/);
  assert.match(engine, /if \(body\.confirm !== true\) return err\("Please confirm the one-time restart\.", 400\);/);
  assert.match(engine, /db\.rpc\("fn_infinity_take_fresh_restart", \{ p_account: accountId, p_user: user\.id \}\)/);
  assert.match(engine, /\(isInfinityRun && Number\(acct\.stage\) === 1 && !isDemoAccount\(acct\)\)\n\s*\? db\.rpc\("fn_infinity_restart_offer"/);
  assert.match(engine, /fresh_restart: freshRestart,/);
});

test('IPFX Markets explains it simply, shows both choices, and says it is the only free restart', () => {
  assert.match(page, /function renderFreshRestart\(o, a, money\)/);
  assert.match(page, /No single day can be more than <b>\$\{pct\}%<\/b> of all the profit you make on your winning days/);
  assert.match(page, /You need <b>\$\{money\(more\)\} more<\/b> from winning days/);
  assert.match(page, /a balance of at least <b>\$\{money\(o\.target_balance_usd\)\}<\/b> with <b>no trade open<\/b>/);
  assert.match(page, /<b>This is your only free restart\.<\/b> If you restart and the new run fails, you will have to wait until the 1st of next month to start again\./);
  assert.match(page, /engineCall\(\{action:'infinity_fresh_restart',account_id:accountId,confirm:true\}\)/);
  assert.match(page, /renderFreshRestart\(engineState\.fresh_restart, a, money\);/);
});
