// All-in cost comparison, E8 vs IPFX: spread + commission per lot, medians, one summary alert (owner request 2026-10-08).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sql = read('supabase/migrations/20261008220000_all_in_cost_comparison.sql');
const brain = read('assets/js/team-brain.js');

test('the Brain shows all-in cost per lot, says the E8 commission is an estimate, and hides the empty demo column', () => {
  const fn = brain.slice(brain.indexOf('function renderCosts()'), brain.indexOf('function renderShadow()'));
  assert.match(fn, /const allin = new Map\(\(c\.allin \|\| \[\]\)\.map/);
  assert.match(fn, /E8 all-in \/ lot/);
  assert.match(fn, /IPFX all-in \/ lot/);
  assert.match(fn, /ratio > 1\.25 \|\| ratio < 0\.8/);
  assert.match(fn, /<b>E8 commission is an estimate<\/b>/);
  assert.match(fn, /const hasDemo = \(c\.spreads \|\| \[\]\)\.some/);
});

test('one summary alert replaces the per-instrument spread alerts and keeps every other alert block', () => {
  assert.match(sql, /select 'cost:parity', 'warning', 'system'/);
  assert.doesNotMatch(sql, /'cost:spread:'/);
  assert.match(sql, /from public\.cost_allin\(1\) where samples >= 10 and ratio > 0/);
  for (const keep of ["'ring:'", 'security:kyc_views', "'ident:'", "'system:hub'", 'Books: daily stop', "'system:classifier'"]) assert.ok(sql.includes(keep), keep + ' is preserved');
  assert.match(sql, /'allin', coalesce\(\(select jsonb_agg\(to_jsonb\(a\) order by a\.symbol\) from public\.cost_allin\(p_days \* 24\) a\), '\[\]'::jsonb\),/);
});

test('real PostgreSQL: all-in uses the median, converts the quote currency, applies per-symbol commission, ignores demo and unmatched samples', { skip: !process.env.DEMO_TEST_DEPS }, async () => {
  const { PGlite } = await import(pathToFileURL(process.env.DEMO_TEST_DEPS + '/node_modules/@electric-sql/pglite/dist/index.js').href);
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table cost_samples(id bigint generated always as identity primary key, account_id bigint, role text, symbol text, bid numeric, ask numeric, spread numeric, ipfx_spread numeric, sampled_at timestamptz default now());
      create table cost_fills(role text, commission numeric, qty numeric, created_at timestamptz default now());
      create table ladder_accounts(id bigint primary key, label text, role text, api_env text);
      create table live_quotes(symbol text primary key, bid numeric, ask numeric);
      create table symbol_specs(symbol text primary key, commission_per_lot_usd numeric);
      insert into live_quotes values ('EURUSD',1.1,1.1002),('USDJPY',149.99,150.01),('GBPUSD',1.3,1.3002);
      insert into symbol_specs values ('GBPUSD', 2);`);
    await db.exec(sql);
    const add = async (role, symbol, spread, ipfx, n = 1) => { for (let i = 0; i < n; i++) await db.query('insert into cost_samples(account_id,role,symbol,bid,ask,spread,ipfx_spread) values (1,$1,$2,1,1,$3,$4)', [role, symbol, spread, ipfx]); };
    await add('monitor', 'EURUSD', 0.00001, 0.00011, 11);
    await add('monitor', 'EURUSD', 0.001, 0.001, 1);                 // one wild spike: the median ignores it
    await add('monitor', 'USDJPY', 0.002, 0.01, 12);                 // JPY quote: converted at 150
    await add('monitor', 'GBPUSD', 0.00003, 0.00013, 12);            // IPFX commission overridden to $2 in symbol_specs
    await add('shadow', 'EURUSD', 0.5, 0.5, 20);                     // demo accounts are not the E8 reference
    await add('monitor', 'NZDUSD', 0.00002, null, 12);               // no IPFX quote at the same moment: left out
    const rows = Object.fromEntries((await db.query('select * from cost_allin(24)')).rows.map((r) => [r.symbol, r]));
    assert.deepEqual(Object.keys(rows).sort(), ['EURUSD', 'GBPUSD', 'USDJPY']);
    // EURUSD: E8 = 0.00001 x 100000 + 5.50 = 6.50 ; IPFX = 0.00011 x 100000 + 6 = 17.00 ; ratio 2.615
    assert.equal(Number(rows.EURUSD.e8_usd), 6.5);
    assert.equal(Number(rows.EURUSD.ipfx_usd), 17);
    assert.equal(Number(rows.EURUSD.ratio), 2.615);
    assert.equal(Number(rows.EURUSD.samples), 12);
    // USDJPY: E8 = 0.002 x 100000 / 150 + 5.50 = 6.83 ; IPFX = 0.01 x 100000 / 150 + 6 = 12.67
    assert.equal(Number(rows.USDJPY.e8_usd), 6.83);
    assert.equal(Number(rows.USDJPY.ipfx_usd), 12.67);
    // GBPUSD: IPFX commission comes from symbol_specs ($2), not the $6 default
    assert.equal(Number(rows.GBPUSD.ipfx_commission), 2);
    assert.equal(Number(rows.GBPUSD.ipfx_usd), 15);
    // cost_summary now carries the all-in rows and still has the old spread rows
    const sum = (await db.query('select cost_summary(7) j')).rows[0].j;
    assert.equal(sum.allin.length, 3);
    assert.ok(Array.isArray(sum.spreads) && sum.spreads.length >= 3);
    // the owner can correct the E8 commission and every number follows
    await db.exec(`update cost_symbol_model set e8_commission_per_lot = 3 where symbol = 'EURUSD'`);
    assert.equal(Number((await db.query(`select e8_usd from cost_allin(24) where symbol='EURUSD'`)).rows[0].e8_usd), 4);
  } finally { await db.close(); }
});

test('the cost model covers exactly the 24 instruments the E8 monitor samples', () => {
  const rows = [...sql.matchAll(/\('([A-Z0-9]+)', (\d+), '([A-Z]{3})', ([\d.]+), (\d+),/g)].map((m) => m[1]);
  assert.equal(rows.length, 24);
  assert.equal(new Set(rows).size, 24);
  const monitorFast = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD'];
  const migration = read('supabase/migrations/20261008210000_e8_all_instruments.sql');
  const slow = migration.match(/set slow_symbols = array\[([^\]]*)\]/)[1].match(/'(\w+)'/g).map((x) => x.replace(/'/g, ''));
  assert.deepEqual([...rows].sort(), [...monitorFast, ...slow].sort());
});
