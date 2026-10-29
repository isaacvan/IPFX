// New-to-live size probation for A-book live, and automatic fresh Stage 1 on the 1st (owner decisions 2026-10-13).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('A-book live starts small: 25% for the first 10 live copies, 50% until 20 with a positive average, then full', async () => {
  const src = read('supabase/functions/_shared/ab-allocator.ts');
  const m = src.match(/export function liveProbation[\s\S]*?\n\}/)[0];
  const mod = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(m)));
  assert.equal(mod.liveProbation(0, 0), 0.25);
  assert.equal(mod.liveProbation(9, 0.5), 0.25);
  assert.equal(mod.liveProbation(10, 0.5), 0.5);
  assert.equal(mod.liveProbation(19, 0.5), 0.5);
  assert.equal(mod.liveProbation(25, -0.1), 0.5);
  assert.equal(mod.liveProbation(25, 0), 0.5);
  assert.equal(mod.liveProbation(20, 0.05), 1);
  assert.match(src, /const riskUsd = Math\.round\(Math\.min\(ceil, Math\.max\(floor, base \* weight\)\) \* probation \* 100\) \/ 100;/);
  assert.match(src, /const probation = book === "a" \? Math\.min\(1, Math\.max\(0, sizing\.probation \?\? 1\)\) : 1;/);
  const exec = read('supabase/functions/book-executor/index.ts');
  assert.match(exec, /let wanted = traderRisk \* sizing\.multiplier \* probation/);
});

test('a failed run gets an automatic fresh Stage 1 on the 1st, once, only when the lockout is over and identity is verified', () => {
  const sql = read('supabase/migrations/20261013100000_infinity_monthly_auto_restart.sql');
  assert.match(sql, /if c\.status is distinct from 'breached' or c\.breached_at is null or c\.breached_at >= month_start then continue; end if;/);
  assert.match(sql, /order by a\.user_id, a\.created_at desc/);
  assert.match(sql, /fn_infinity_breach_lockout\(c\.user_id\)->>'locked'/);
  assert.match(sql, /k\.status = 'verified'/);
  assert.match(sql, /t\.book_state = 'SUSPENDED'/);
  assert.match(sql, /unique \(user_id, month\)/);
  assert.match(sql, /'source', 'monthly_auto_restart', 'terms_version', terms_v/);
  assert.match(sql, /'infinity_monthly_restart', who, 'Your new Infinity Stage 1 is ready', 'queued'/);
  assert.match(sql, /cron\.schedule\('ipfx-infinity-monthly-restart', '5 0,6,12 1 \* \*'/);
  assert.doesNotMatch(sql, /delete from public\.(trades|trading_accounts)/);
  const outbox = read('supabase/functions/email-outbox/index.ts');
  assert.match(outbox, /const TEMPLATES = \["infinity_v2_launch", "infinity_monthly_restart_v2", "infinity_approved_v2", "infinity_approved", "infinity_monthly_restart", "infinity_breach_notice", "infinity_account_reinstated"\];/);
  assert.match(outbox, /const NEEDS_ACTIVE = \["infinity_approved_v2", "infinity_monthly_restart_v2", "infinity_approved", "infinity_monthly_restart", "infinity_account_reinstated"\];/);
});

test('breached traders are told when they can restart: email, engine message and a centred pop-up', () => {
  const engine = read('supabase/functions/trading-engine/index.ts');
  assert.match(engine, /A fresh \$1,000 Stage 1 starts automatically on \$\{infinityRestartDateText\(\)\}/);
  assert.match(engine, /next_step: acct\.challenge_type === "infinity" \? INFINITY_BREACH_NEXT_STEP\(\)/);
  const page = read('trading.html');
  assert.match(page, /'Your Infinity account has failed'/);
  assert.match(page, /'A fresh \$1,000 Stage 1 starts automatically on '\+date\+'\. You do not need to apply again/);
  assert.match(page, /id="infBreachAttemptClose" onclick="closeInfinityTradeWarning\(\)">Close<\/button>/);
  const sql = read('supabase/migrations/20261013110000_infinity_breach_restart_notice.sql');
  assert.match(sql, /'infinity_breach_notice', 'account'/);
  assert.match(sql, /a\.breached_at >= '2026-10-01' and a\.breached_at < '2026-11-01'/);
  assert.match(sql, /not exists \(select 1 from public\.email_events e where e\.user_id = a\.user_id and e\.template_key = 'infinity_breach_notice'\)/);
});
