// Shadow copy: every trader's trade at minimum size on TradeLocker demo accounts, scaled to funded size in the Brain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const exec = read('supabase/functions/book-executor/index.ts');
const engine = read('supabase/functions/trading-engine/index.ts');
const sql = read('supabase/migrations/20261005170000_shadow_copy.sql');
const fn = (src, name) => { const i = src.indexOf(`async function ${name}(`); assert.ok(i >= 0, name + ' exists'); const j = src.indexOf('\nasync function ', i + 10); return src.slice(i, j < 0 ? undefined : j); };

test('shadow copies are isolated: own tables, no risk reservations, no A/B ledger rows', () => {
  for (const name of ['shadowOpen', 'shadowClose', 'shadowReconcile']) {
    const body = fn(exec, name);
    assert.doesNotMatch(body, /book_orders|ab_reserve_risk|ab_release_risk/, name + ' never touches the A/B ledger or risk');
    assert.match(body, /shadow_orders/);
  }
  assert.doesNotMatch(sql, /alter table public\.book_orders/, 'book_orders and its book check are unchanged');
});

test('shadow orders go out at the broker minimum size with no stop, only to role shadow accounts', () => {
  const open = fn(exec, 'shadowOpen');
  assert.match(open, /const qty = Number\(inst\.min_qty \?\? inst\.lot_step \?\? 0\.01\)/);
  assert.match(open, /sl: null, tp: null/);
  assert.match(exec, /\.eq\("role", "shadow"\)\.maybeSingle\(\)/);
  assert.match(exec, /\.eq\("role", "ladder"\)\.eq\("execution_enabled", true\)/, 'A-book destinations still only ladder accounts');
});

test('assignment is permanent and capped at 200 traders per demo account; monitor accounts are never used', () => {
  assert.match(sql, /p_cap int default 200/);
  assert.match(sql, /l\.role = 'shadow' and l\.execution_enabled/);
  assert.match(sql, /person_id uuid primary key/);
  assert.doesNotMatch(sql, /role = 'monitor' and l\.execution_enabled/);
});

test('copy is idempotent and a lost order is found by strategy id; orphans are closed', () => {
  assert.match(fn(exec, 'shadowOpen'), /idempotency_key: `\$\{book\}:\$\{tradeId\}:open`/);
  assert.match(fn(exec, 'shadowClose'), /idempotency_key: `\$\{book\}:\$\{tradeId\}:close`/);
  assert.match(sql, /idempotency_key text not null unique/);
  const rec = fn(exec, 'shadowReconcile');
  assert.match(rec, /ordersByStrategy/);
  assert.match(rec, /t\?\.status === "closed"/);
  assert.match(exec, /fixed\.push\(\.\.\.await shadowReconcile\(db\)/);
});

test('a trader closing before the demo order fills still gets the demo position closed', () => {
  assert.match(fn(exec, 'shadowOpen'), /now\?\.status === "closed"\) await shadowClose/);
});

test('engine dispatches after the trader fill (pending fill and market open) and on close, only while demo accounts are enabled', () => {
  assert.equal((engine.match(/shadowLater\(db, (?:acct|A), \{ event: "shadow_open"/g) || []).length, 2);
  assert.equal((engine.match(/shadowLater\(db, acct, \{ event: "shadow_close"/g) || []).length, 1);
  assert.match(engine, /\.eq\("role", "shadow"\)\.eq\("execution_enabled", true\)\.not\("access_token_ciphertext", "is", null\)/);
  assert.match(engine, /\(await shadowOn\(db\)\.catch\(\(\) => false\)\) \? await callBook\(body\) : null/);
  assert.match(exec, /body\.event === "shadow_open"/);
});

test('funded-size maths: scale by trader size, subtract E8 extra spread and commission, compare with IPFX', () => {
  assert.match(sql, /p\.volume \* p_funded \/ p\.size_usd/);
  assert.match(sql, /greatest\(0, coalesce\(\(x->>'e8'\)::numeric, 0\) - coalesce\(\(x->>'demo'\)::numeric, 0\)\)/);
  assert.match(sql, /greatest\(0, cm\.e8 - cm\.demo\)/);
  assert.match(sql, /'gap'/);
  assert.match(read('supabase/functions/brain-monitor/index.ts'), /shadow_funded_summary/);
  assert.match(read('assets/js/team-brain.js'), /function renderShadow\(\)/);
});
