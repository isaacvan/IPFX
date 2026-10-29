// The Brain and the A/B and demo-copy automation work on Infinity challenge trades only (owner request 2026-10-08).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sql = read('supabase/migrations/20261008230000_brain_infinity_only.sql');
const engine = read('supabase/functions/trading-engine/index.ts');

test('the ledger builder only takes closed trades from Infinity accounts that are not demo accounts', () => {
  const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.ab_build_ledger'), sql.indexOf('-- 2. Hedge-ring'));
  assert.match(fn, /where a\.challenge_type = 'infinity' and a\.status <> 'demo' and coalesce\(a\.phase, ''\) <> 'demo'\s+and t\.status = 'closed'/i);
  assert.equal((fn.match(/challenge_type = 'infinity'/g) || []).length, 1);
});

test('the hedge-ring scan is Infinity only', () => {
  assert.match(sql, /and ta\.challenge_type = 'infinity' and ta\.status <> 'demo' and coalesce\(ta\.phase, ''\) <> 'demo'/);
});

test('rows leaving the Brain are archived before they are deleted, and owner-set states are kept', () => {
  assert.ok(sql.indexOf("insert into public.ab_scope_archive (kind, payload)\nselect 'ledger'") < sql.indexOf('delete from public.ab_trade_ledger'));
  assert.ok(sql.indexOf("select 'profile'") < sql.indexOf('delete from public.ab_trader_profiles'));
  assert.ok(sql.indexOf("select 'metrics'") < sql.indexOf('delete from public.ab_trader_metrics'));
  assert.match(sql, /p\.manual_book_state is null and not exists/);
  assert.match(sql, /revoke all on public\.ab_scope_archive from public, anon, authenticated/);
});

test('ordinary and scoped routing stay Infinity-only, with selected gold scope before normal classification', () => {
  assert.match(engine, /const inBrainScope = \(acct: [^)]*\) =>\s+acct\.challenge_type === "infinity" && acct\.phase !== "demo" && acct\.status !== "demo";/);
  assert.match(engine, /function shadowLater\(db: Db, acct: [^)]*\}, body: Record<string, unknown>\) \{\s+if \(!inBrainScope\(acct\)\) return;/);
  assert.equal((engine.match(/shadowLater\(db, (acct|A)( as Acct)?, \{/g) || []).length, 4);
  assert.doesNotMatch(engine, /shadowLater\(db, \{/);
  assert.ok(engine.includes('await scopedCopyTestRoute(db,acct,symbol) ?? (inBrainScope(acct) ? await abRoute(db, acct.user_id) : null)'));
  assert.ok(engine.includes('await scopedCopyTestRoute(db,A,symbol) ?? (inBrainScope(A) ? await abRoute(db, user.id) : null)'));
  assert.ok(engine.includes("if(!inBrainScope(acct)||acct.status!=='active'||symbol!=='XAUUSD')return null"));
  assert.match(engine,/db.rpc\('copy_test_route',\{p_user:acct.user_id,p_source:acct.id,p_symbol:symbol\}\)/);
  assert.equal((engine.match(/await abRoute\(/g) || []).length, 3);
  assert.match(engine,/inBrainScope\(acct\)\?await abRoute\(db,acct.user_id\):null/);
});
