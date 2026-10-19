import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const skip = !process.env.DEMO_TEST_DEPS;
let db;
before(async () => {
  if (skip) return;
  const { PGlite } = await import(pathToFileURL(`${process.env.DEMO_TEST_DEPS}/node_modules/@electric-sql/pglite/dist/index.js`).href);
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  // Advance only the database clock in the isolated lab; production uses its
  // real clock and cannot backdate registration or prospective observations.
  await db.exec(`create table test_clock(at timestamptz); insert into test_clock values('2026-10-19T12:00Z');
    create function public.test_clock() returns timestamptz language sql as 'select at from public.test_clock';`);
  try {
    await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261019090000_e8_trader_statistics.sql', import.meta.url), 'utf8').replaceAll('clock_timestamp()', 'public.test_clock()'));
  } catch (e) { throw new Error(`${e.message}; position=${e.position}; context=${e.where}`); }
});
after(async () => { await db?.close(); });

const start = Date.parse('2026-01-01T00:00:00Z');
const asof = '2026-10-18T23:59:59Z';
function fixture(n = 300, edge = 0, noise = 1) {
  // Every day has symmetric noise; a day component prevents fake IID precision.
  return Array.from({ length: n }, (_, i) => {
    const day = Math.floor(i / 6), gross = edge + noise * ((i % 6 - 2.5) / 2 + (day % 2 ? .2 : -.2));
    const opened = start + day * 86400000 + (i % 3) * 8 * 3600000;
    return { trade_id: `t${i}`, trader_id: 'person', symbol: 'EURUSD', side: 'buy',
      opened_at: new Date(opened).toISOString(), closed_at: new Date(opened + 120000).toISOString(),
      available_at: new Date(opened + 240000).toISOString(), lots: .06, gross,
      spread: .02, commission: .02, slippage: .01, a_net: gross - .05, b_net: -gross - .05,
      hold_s: 120, spread_multiple: gross / .02, r_multiple: gross,
      volatility_regime: ['low', 'medium', 'high'][i % 3] };
  });
}
async function infer(trades, config = {}, population = [], cutoff = asof) {
  return (await db.query('select public.ab_e8_trader_infer($1::jsonb,$2::jsonb,$3::jsonb,$4::timestamptz) r',
    [JSON.stringify(trades), JSON.stringify(population), JSON.stringify(config), cutoff])).rows[0].r;
}
async function adjust(rows, config = {}) {
  return (await db.query('select public.ab_e8_trader_adjust($1::jsonb,$2::jsonb) r', [JSON.stringify(rows), JSON.stringify(config)])).rows[0].r;
}

test('empty input, tiers and completed UTC days are honest', { skip }, async () => {
  const empty = await infer([]);
  assert.equal(empty.trades, 0); assert.equal(empty.p_copy, null);
  assert.equal(empty.evidence_class, 'INSUFFICIENT_DATA');
  for (const [n, tier] of [[29, 'insufficient'], [30, 'provisional'], [99, 'provisional'], [100, 'reportable'], [200, 'potential']]) {
    const r = await infer(fixture(n, .3)); assert.equal(r.tier, tier);
    assert.notEqual(r.evidence_class, 'COPY_CANDIDATE');
  }
});

test('planted +/-0.1R and +/-0.3R recover direction without historical actionability', { skip }, async () => {
  for (const edge of [.1, -.1, .3, -.3]) {
    const r = await infer(fixture(600, edge));
    assert.ok(Math.abs(r.raw.gross_mean - edge) < 1e-9);
    assert.ok((edge > 0 ? r.p_copy : r.p_reverse) > .95);
    assert.ok((edge > 0 ? r.pvalue_copy : r.pvalue_reverse) < .05);
    assert.equal(r.details.anytime.valid, false);
    assert.ok(!['COPY_CANDIDATE', 'REVERSE_CANDIDATE'].includes(r.evidence_class));
    assert.ok(Math.abs(r.a_net + r.b_net + 2 * r.trades * .05) < 1e-8);
    assert.ok(r.a_interval[0] < r.a_net && r.a_interval[1] > r.a_net);
  }
});

test('a visible size change resets inference while all priced cash remains visible', { skip }, async () => {
  const trades=fixture(100,.2).map(t=>({...t,source_volume:.1}));trades.at(-1).source_volume=1;
  const lastAt=Math.max(...trades.map(t=>Date.parse(t.opened_at)))+3600000;
  for(const [key,delta] of [['opened_at',0],['closed_at',120000],['available_at',240000]]) trades.at(-1)[key]=new Date(lastAt+delta).toISOString();
  const reset=await infer(trades);
  assert.equal(reset.trades,100);assert.equal(reset.inference_trades,1);
  assert.ok(reset.flags.includes('BEHAVIOR_WINDOW_RESET'));
  assert.equal(Date.parse(reset.details.behavior.reset_at),Date.parse(trades.at(-1).opened_at));
  assert.ok(Math.abs(reset.a_net-trades.reduce((s,t)=>s+t.a_net,0))<1e-8);
});

test('null is equivalence only with a sufficiently narrow interval, never mere non-significance', { skip }, async () => {
  const noisy = await infer(fixture(120, 0, 20));
  assert.notEqual(noisy.evidence_class, 'COST_BLED');
  assert.ok(noisy.pvalue_copy > .05 && noisy.pvalue_reverse > .05);
  const precise = await infer(fixture(600, 0, .01), {}, [], '2026-04-12');
  assert.equal(precise.evidence_class, 'COST_BLED');
  assert.equal(precise.raw.equivalence, true);
});

test('variable costs propagate covariance into net intervals and invariants are checked per trade', { skip }, async () => {
  const trades = fixture(300, .2).map(t => ({ ...t, spread: t.gross + 3,
    a_net: -3.03, b_net: -2 * t.gross - 3.03 }));
  const r = await infer(trades);
  assert.ok(r.raw.se_a < r.raw.se_b / 100);
  const bad = fixture(); bad[0].a_net += 1; bad[1].a_net -= 1;
  await assert.rejects(infer(bad), /invariant/i);
  const negative = fixture(); negative[0].commission = -.02;
  await assert.rejects(infer(negative), /cost/i);
});

test('mutation audit excludes future outcomes, unpublished results, embargo and incomplete day', { skip }, async () => {
  const trades = fixture(300, .2), cutoff = '2026-01-20T12:00:00Z';
  const first = await infer(trades, {}, [], cutoff);
  const changed = trades.map(t => Date.parse(t.closed_at) >= Date.parse('2026-01-20') ?
    { ...t, gross: 9999, a_net: 9998.95, b_net: -9999.05 } : t);
  const mutated = await infer(changed, {}, [], cutoff);
  for (const key of ['raw', 'posterior', 'evidence_class', 'tier', 'stability', 'a_interval', 'b_interval']) assert.deepEqual(mutated[key], first[key]);
  assert.notEqual(mutated.a_net, first.a_net, 'published current-day cash changes, completed-day inference does not');
  const late = { ...trades[0], trade_id: 'late', available_at: '2026-02-01' };
  assert.deepEqual(await infer([...trades, late], {}, [], cutoff), first);
  const close = trades[0];
  assert.equal((await infer([close], {}, [], '2026-01-01T00:04:29Z')).trades, 0);
  // Even published outcomes on the current day cannot enter a completed-day cluster.
  const current = await infer([close], {}, [], '2026-01-01T23:59:59Z');
  assert.equal(current.trades, 1); assert.equal(current.inference_trades, 0);
  assert.equal(current.a_net, close.a_net); assert.equal(current.a_interval, null);
});

test('population prior uses equal people, sampling variances, leave-one-out and cutoff guard', { skip }, async () => {
  const people = Array.from({ length: 8 }, (_, i) => ({ trader_id: `p${i}`, mean: i % 2 ? .1 : -.1, variance: .001, trades: 200, active_days: 30 }));
  const trades = fixture(30, 1);
  const r = await infer(trades, {}, { asof, rows: people });
  assert.equal(r.posterior.model, 'empirical_bayes_normal_normal_approximation');
  assert.ok(r.posterior.mean < r.raw.gross_mean);
  assert.ok(r.posterior.variance > 0 && r.posterior.prior_mean_variance > 0);
  const ignored = await infer(trades, {}, { asof: '2026-10-19', rows: people });
  assert.equal(ignored.posterior.prior_people, 0);
  assert.deepEqual(await infer(trades, {}, { asof: '2026-10-19', rows: people.map(x => ({ ...x, mean: 1e8 })) }), ignored);
  assert.equal((await infer(trades, {}, people)).posterior.prior_people, 0);
});

test('positive day serial dependence widens uncertainty and tail lottery is flagged', { skip }, async () => {
  const independent = fixture(600, .2);
  const dependent = independent.map((t, i) => {
    const gross = .2 + (Math.floor(i / 60) % 2 ? .2 : -.2);
    return { ...t, gross, a_net: gross - .05, b_net: -gross - .05 };
  });
  const r = await infer(dependent);
  assert.ok(r.raw.se_gross >= r.raw.se_cluster_gross);
  assert.ok(r.raw.se_gross > r.raw.se_cluster_gross * 1.2);
  const tail = fixture(300, 0, .01); tail[0] = { ...tail[0], gross: -1000, a_net: -1000.05, b_net: 999.95 };
  const risk = await infer(tail, {}, [], '2026-02-21');
  assert.equal(risk.evidence_class, 'TAIL_RISK');
  assert.ok(risk.flags.includes('TOP_THREE_CONCENTRATION'));
});

test('BY adjusts the entire two-direction family, preserves order and is monotone', { skip }, async () => {
  const input = [
    { trader_id: 'a', pvalue_copy: .001, pvalue_reverse: .9 },
    { trader_id: 'b', pvalue_copy: .02, pvalue_reverse: .01 },
    { trader_id: 'missing', pvalue_copy: null, pvalue_reverse: null }];
  const rows = await adjust(input), h6 = 1 + 1/2 + 1/3 + 1/4 + 1/5 + 1/6;
  assert.deepEqual(rows.map(x => x.trader_id), input.map(x => x.trader_id));
  assert.ok(Math.abs(rows[0].q_copy - .001 * 6 * h6) < 1e-12);
  assert.ok(Math.abs(rows[1].q_reverse - .01 * 6 * h6 / 2) < 1e-12);
  assert.equal(rows[2].q_copy, 1);
  assert.equal(rows[0].details.fdr.hypotheses, 6);
  assert.deepEqual((await adjust(rows)).map(r=>r.reasons),rows.map(r=>r.reasons),'repeated scheduled adjustment cannot grow cached reason text');
  assert.deepEqual(await adjust([]), []);
  await assert.rejects(adjust([{ pvalue_copy: -1 }]), /p.value/i);
});

test('BY never promotes fabricated historical or posterior-only candidates', { skip }, async () => {
  const r = await infer(fixture(600, .3));
  const [row] = await adjust([{ ...r, evidence_class: 'COPY_CANDIDATE', pvalue_copy: 1e-12 }]);
  assert.notEqual(row.evidence_class, 'COPY_CANDIDATE');
});

test('helpers deny anon/authenticated and validate numerical configuration', { skip }, async () => {
  const r = await db.query("select has_function_privilege('anon','public.ab_e8_trader_infer(jsonb,jsonb,jsonb,timestamptz)','execute') a, has_function_privilege('authenticated','public.ab_e8_trader_adjust(jsonb,jsonb)','execute') b");
  assert.deepEqual(r.rows[0], { a: false, b: false });
  await assert.rejects(infer(fixture(), { variance_floor: 0 }), /configuration/i);
});

test('numerical CDFs match distribution reference points', { skip }, async () => {
  const r = (await db.query(`select public.ab_e8_trader_normal_cdf(0) n0,
    public.ab_e8_trader_normal_cdf(1.959963984540054) n975,
    public.ab_e8_trader_normal_cdf(-1.959963984540054) n025,
    public.ab_e8_trader_t_cdf(1,1) cauchy,
    public.ab_e8_trader_t_cdf(2.262157162798205,9) t975`)).rows[0];
  for (const [name, ref] of [['n0', .5], ['n975', .975], ['n025', .025], ['cauchy', .75], ['t975', .975]]) {
    assert.ok(Math.abs(r[name] - ref) < 1e-7, `${name}=${r[name]}`);
  }
});

test('tail moments have finite sample correction and withhold tiny-sample claims', { skip }, async()=>{
 const r=await infer(fixture(300,.2));
 assert.ok(Math.abs(r.details.tail.skewness)<1e-8);
 assert.ok(Number.isFinite(r.details.tail.excess_kurtosis));
 assert.ok(r.details.tail.negative_gross_size_cv>0);
 assert.equal((await infer(fixture(29,.2))).details.tail.skewness,null);
});

async function setClock(at) { await db.query('update public.test_clock set at=$1 where true', [new Date(at).toISOString()]); }
async function register(person, config = {}, bound = 3) {
  const result = (await db.query('select public.ab_e8_trader_start($1,$2,$3,$4::jsonb,$5) r',
    [person, config.cell_id ?? 'base', bound, JSON.stringify(config), 'TEST ONLY: independent ex ante raw daily net risk bound enforced upstream.'])).rows[0].r;
  await db.query('select public.ab_e8_trader_activate($1,$2,$3)', [result.id,
    'TEST ONLY: synthetic generator bounded on BOTH tails before observations.',
    'TEST ONLY: exhaustive ordered daily fixture; every nonoverlapping day sealed.']);
  return result;
}
async function append(id, day, a, b, complete = true) {
  return (await db.query('select public.ab_e8_trader_append($1,$2,$3,$4,$5) r', [id, day, a, b, complete])).rows[0].r;
}

test('prospective path can pass; starts, observations and bound failures are immutable', { skip }, async () => {
  await setClock('2026-10-19T12:00Z');
  const config = { cell_id: 'base', regime_asof: '2026-10-19T00:00Z' };
  const process = await register('person', config);
  assert.equal(process.first_day, '2026-10-20');
  await assert.rejects(register('person', config, 4), /unique/i, 'no reset after seeing outcomes');
  await assert.rejects(append(process.id, '2026-10-19', 0, 0), /next complete/);
  await assert.rejects(append(process.id, '2026-10-20', 0, 0), /next complete/);
  const shift = Date.parse('2026-10-20') - start;
  const trades = fixture(600, .3, .1).map(t => Object.fromEntries(Object.entries(t).map(([k, v]) =>
    [k, ['opened_at', 'closed_at', 'available_at'].includes(k) ? new Date(Date.parse(v) + shift).toISOString() : v])));
  let latest;
  for (let day = 0; day < 100; day++) {
    const dayStart = Date.parse('2026-10-20') + day * 86400000;
    await setClock(dayStart + 86400000 + 151000);
    const rows = trades.slice(day * 6, day * 6 + 6);
    if (!day) await assert.rejects(append(process.id, new Date(dayStart).toISOString(), 0, 0, false), /complete/);
    latest = await append(process.id, new Date(dayStart).toISOString(), rows.reduce((s, t) => s + t.a_net, 0), rows.reduce((s, t) => s + t.b_net, 0));
  }
  assert.equal(latest.valid, true); assert.ok(latest.p_copy < .001); assert.equal(latest.p_reverse, 1);
  const cutoff = new Date(Date.parse('2026-10-20') + 100 * 86400000 + 151000).toISOString();
  const inferConfig = { ...config, anytime_process_id: process.id };
  const r = await infer(trades, inferConfig, [], cutoff);
  assert.equal(r.details.anytime.valid, true);
  assert.equal(r.pvalue_copy, r.details.anytime.p_copy, 'BY uses prospective marginal p, not historical t');
  assert.equal(r.details.candidate_gates.copy, true);
  assert.equal((await adjust([r]))[0].evidence_class, 'COPY_CANDIDATE');
  assert.equal((await infer(trades, { ...inferConfig, variance_floor: .1 }, [], cutoff)).details.anytime.valid, false, 'changing frozen config cannot reuse evidence');
  const breachDay = Date.parse('2026-10-20') + 100 * 86400000;
  await setClock(breachDay + 86400000 + 151000);
  const breach = await append(process.id, new Date(breachDay).toISOString(), 4, -4);
  assert.equal(breach.valid, false); assert.equal(breach.p_copy, null); assert.equal(breach.a_net, 4, 'no clipping');
  await assert.rejects(append(process.id, new Date(breachDay).toISOString(), 0, 0), /next complete/);
  await setClock(breachDay + 2 * 86400000 + 151000);
  assert.equal((await append(process.id, new Date(breachDay + 86400000).toISOString(), 0, 0)).valid, false);
  assert.deepEqual(await infer(trades, inferConfig, [], cutoff), r, 'later bound breach cannot alter a captured past decision');
});

test('bounded symmetric null has mean e-value <=1 and null/negative paths do not pass', { skip }, async () => {
  let meanE = 0;
  const lambdas = [.015625, .03125, .0625, .125, .25, .5, 1];
  // Exhaust the 16 equiprobable bounded Rademacher paths, testing the SQL's
  // stored sufficient statistics against the preregistered Hoeffding mixture.
  for (let path = 0; path < 16; path++) {
    await setClock('2026-10-19T12:00Z');
    const p = await register(`null-${path}`, {}, 1);
    let sum = 0, last;
    for (let j = 0; j < 4; j++) {
      const value = path & (1 << j) ? 1 : -1;
      sum += value;
      const at = Date.parse('2026-10-20') + j * 86400000;
      await setClock(at + 86400000 + 151000);
      last = await append(p.id, new Date(at).toISOString(), value, -value);
    }
    const e = lambdas.reduce((s, l) => s + Math.exp(l * sum - 4 * l * l / 2), 0) / lambdas.length;
    assert.ok(last.max_log_e_a >= Math.max(0, Math.log(e)) - 1e-12);
    assert.ok(last.p_copy > .05 && last.p_reverse > .05);
    meanE += e / 16;
  }
  assert.ok(meanE <= 1);
  const tableRights = (await db.query("select has_table_privilege('service_role','public.ab_e8_trader_process_days','UPDATE') u, has_table_privilege('anon','public.ab_e8_trader_processes','SELECT') s")).rows[0];
  assert.deepEqual(tableRights, { u: false, s: false });
});
