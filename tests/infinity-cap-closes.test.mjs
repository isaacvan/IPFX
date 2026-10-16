// Infinity daily profit cap closes open positions for Terms 2.0 runs (owner decision 2026-10-12, new runs only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const engine = read('supabase/functions/trading-engine/index.ts');
const sql = read('supabase/migrations/20261012200000_infinity_cap_closes_positions.sql');
const terms = read('terms.html');

test('only runs whose application accepted Terms 2.0 or later close positions at the cap', () => {
  assert.match(sql, /create or replace function public\.fn_infinity_cap_closes_positions\(p_account uuid\) returns boolean/);
  assert.match(sql, /while root\.funded_from_account_id is not null and hops < 5 loop/);
  assert.match(sql, /r\.application_details->>'terms_version'/);
  assert.match(sql, /return coalesce\(accepted, ''\) >= '2026-10-12-2\.0';/);
  assert.match(sql, /coalesce\(a\.phase, ''\) = 'demo'/);
  assert.match(sql, /revoke all on function public\.fn_infinity_cap_closes_positions\(uuid\) from public, anon, authenticated;/);
});

test('the engine closes every open position and cancels pending orders when the cap is reached, without breaching', () => {
  assert.match(engine, /const closes = await db\.rpc\("fn_infinity_cap_closes_positions", \{ p_account: acct\.id \}\);\s+acct\.daily_profit_cap_closes = !closes\.error && closes\.data === true;/);
  const block = engine.slice(engine.indexOf('// Terms 2.0 runs: reaching the daily profit cap'), engine.indexOf('const expectedStatus = acct.status;'));
  assert.match(block, /acct\.status === "active" && acct\.daily_profit_cap_closes === true/);
  assert.match(block, /acct\.day_start_date === todayUtc/);
  assert.match(block, /\(acct\.daily_profit_cap_blocked \|\| gainNow >= capUsd\) && await claimOrderLock\(db, acct\.id\)/);
  assert.match(block, /closeTrade\(db, acct, t, t\.side === "buy" \? q\.bid : q\.ask, "daily_profit_cap", q\)/);
  assert.match(block, /status: "cancelled", reject_reason: "Daily profit cap reached"/);
  assert.match(block, /await releaseOrderLock\(db, acct\.id\);/);
  assert.doesNotMatch(block, /breached|fn_claim_account_breach/);
});

test('earlier runs keep the entry pause only, and the trader message matches their rule', () => {
  assert.match(engine, /if \(acct\.daily_profit_cap_closes\) \{\s+return `Daily profit cap reached \(\$\$\{cap\.toFixed\(2\)\}\)\. Your open positions are closed at the cap/);
  assert.match(engine, /their P&L can exceed the cap/);
});

test('Terms 2.0 states the new rule for each stage and is the version new applications accept', () => {
  assert.match(terms, /<span>Version 2\.[012]<\/span>/);
  assert.equal((terms.match(/For runs whose application accepted Terms version 2\.0 or later: when your net profit for the UTC day, including open positions, reaches the cap, all open positions are closed/g) || []).length, 3);
  assert.match(terms, /Reaching the cap is not a breach\./);
  assert.match(read('assets/js/checkout-flow.js'), /terms_version: '2026-10-1[26]-2\.[012]'/);
  assert.ok(read('legal/2026-10-12-v2.0/terms.html').includes('<span>Version 2.0</span>'));
});
