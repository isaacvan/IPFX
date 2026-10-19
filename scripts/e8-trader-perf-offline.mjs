// Run the production inference SQL on a masked frozen export, never on a broker.
// Usage: DEMO_TEST_DEPS=... node scripts/e8-trader-perf-offline.mjs INPUT.json OUTPUT.json
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const [input, output] = process.argv.slice(2);
if (!input || !output || !process.env.DEMO_TEST_DEPS) throw Error('Provide masked input, private output and DEMO_TEST_DEPS.');
const { PGlite } = await import(pathToFileURL(`${process.env.DEMO_TEST_DEPS}/node_modules/@electric-sql/pglite/dist/index.js`).href);
const db = new PGlite(), data = JSON.parse(fs.readFileSync(input, 'utf8'));
try {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261019090000_e8_trader_statistics.sql', import.meta.url), 'utf8'));
  const grouped = new Map();
  for (const t of data.trades) { if (!grouped.has(t.trader_id)) grouped.set(t.trader_id, []); grouped.get(t.trader_id).push(t); }
  const infer = async (trades, population) => (await db.query('select public.ab_e8_trader_infer($1,$2,$3,$4) r',
    [JSON.stringify(trades), JSON.stringify(population), '{}', data.cutoff])).rows[0].r;
  const preliminary = [];
  for (const [id, trades] of grouped) preliminary.push({ trader_id: id, ...await infer(trades, []) });
  const population = { asof: data.cutoff, rows: preliminary.map(r => ({ trader_id: r.trader_id,
    mean: r.raw?.gross_mean, variance: r.raw?.se_gross == null ? null : r.raw.se_gross ** 2,
    trades: r.trades, active_days: r.active_days })) };
  const rows = [];
  for (const [id, trades] of grouped) rows.push({ ...await infer(trades, population), trader_id: id, trader: trades[0].trader });
  const adjusted = (await db.query('select public.ab_e8_trader_adjust($1,$2) r', [JSON.stringify(rows), '{}'])).rows[0].r;
  const priced = data.trades.filter(t => t.reason == null), actualA = priced.reduce((s, t) => s + t.a_net, 0), actualB = priced.reduce((s, t) => s + t.b_net, 0);
  assert.ok(Math.abs(actualA - data.control.a_net) < .005);
  assert.ok(Math.abs(actualB - data.control.b_net) < .005);
  const cashA = adjusted.reduce((s, r) => s + Number(r.a_net || 0), 0), cashB = adjusted.reduce((s, r) => s + Number(r.b_net || 0), 0);
  assert.ok(Math.abs(cashA - actualA) < .005, `Trader A totals ${cashA} differ from control ${actualA}`);
  assert.ok(Math.abs(cashB - actualB) < .005, `Trader B totals ${cashB} differ from control ${actualB}`);
  const classes = {};
  for (const r of adjusted) classes[r.evidence_class] = (classes[r.evidence_class] || 0) + 1;
  const result = { available: true, version: '20261019a', frozen: true, computed_at: new Date().toISOString(), source_computed_at: data.cutoff,
    from: data.trades.map(t => t.opened_at).sort()[0], to: data.cutoff,
    provenance: { archive_sha256: data.archive_sha256, mode: 'masked frozen SQL inference; not production cache' },
    summary: { total: adjusted.length, enough_data: adjusted.filter(r => r.trades >= 100).length,
      copy_candidates: classes.COPY_CANDIDATE || 0, reverse_candidates: classes.REVERSE_CANDIDATE || 0, class_counts: classes, fdr_target: .05 },
    coverage: { source_trades: data.trades.length, priced: priced.length, not_priced: data.trades.length - priced.length },
    calibration: { available: false, reason: 'This offline inference fixture contains no actual fills; live cache calibration is separate.' },
    walk_forward: { available: false, reason: 'No captured-live classification existed before this frozen window.' },
    config: { min_trades: 30, reportable_trades: 100, actionable_trades: 200, min_days: 10, q_max: .05 },
    traders: adjusted, total: adjusted.length, control: { a_net: cashA, b_net: cashB },
    details: Object.fromEntries(adjusted.map(r => [r.trader_id, { available: true, row: r, ...r, trades: grouped.get(r.trader_id) }])) };
  fs.writeFileSync(output, JSON.stringify(result));
  console.log(JSON.stringify({ source_cutoff: data.cutoff, classes, priced: priced.length, a_net: cashA, b_net: cashB, output }));
} catch (e) {
  console.error(JSON.stringify({ error: e.message, code: e.code, where: e.where, position: e.position }));
  process.exitCode = 1;
} finally { await db.close(); }
