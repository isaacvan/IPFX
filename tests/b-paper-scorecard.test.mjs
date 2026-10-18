import fs from 'node:fs'; import vm from 'node:vm'; import test from 'node:test'; import assert from 'node:assert/strict';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const js = read('assets/js/team-brain.js');
const sql = read('supabase/migrations/20261018100000_b_paper_scorecard.sql');
const exec = read('supabase/functions/book-executor/index.ts');
const monitor = read('supabase/functions/brain-monitor/index.ts');

function render(b_paper) {
  const a = js.indexOf('  function renderBPaper()'), b = js.indexOf('  function render() {', a);
  let html = '';
  const ctx = { data: { b_paper }, $() { return { set innerHTML(v) { html = v; } }; },
    fin: (v) => v != null && v !== '' && Number.isFinite(Number(v)), esc: (v) => String(v ?? '').replaceAll('<', '&lt;'), Number, String, Math };
  vm.createContext(ctx); vm.runInContext(js.slice(a, b) + '\nrenderBPaper()', ctx);
  return html;
}
const rules = { risk_per_trade_usd: 25, min_trades: 300, min_traders: 30, day_limit_usd: 625, drawdown_limit_usd: 3000, selection: 'reverse <b>', basis: 'replay' };

test('a failing paper test says keep it off E8 and shows the limit breach', () => {
  const html = render({ verdict: 'FAIL', why: 'At $25 a trade it would have broken an E8 limit', trades: 586, traders: 68, pnl_usd: -2283.54,
    mean_r: -0.156, low95_r: -0.203, high95_r: -0.109, worst_day_usd: -686.34, max_drawdown_usd: 2283.54, rules, from: '2026-10-01', to: '2026-10-18' });
  assert.match(html, /Failed: keep it off E8/);
  assert.match(html, /−\$2,284/);
  assert.match(html, /−\$686 \/ −\$2,284/);
  assert.match(html, /class="neg">−\$686/);
  assert.match(html, /<b>not<\/b> sent to E8/);
  assert.match(html, /reverse &lt;b>/);
});

test('only a PASS verdict reads as allowed; missing data is not a pass', () => {
  assert.match(render({ verdict: 'PASS', why: 'ok', rules, pnl_usd: 500, mean_r: 0.2, low95_r: 0.05, high95_r: 0.35, worst_day_usd: -200, max_drawdown_usd: 400 }), /Passed: can go to E8 at small size/);
  const thin = render({ verdict: 'NOT_ENOUGH_DATA', why: '12 of 300', rules, trades: 12, traders: 3 });
  assert.match(thin, /Not enough trades yet/); assert.doesNotMatch(thin, /Passed/);
  assert.match(render(null), /unavailable/);
});

test('the pass rule is fixed in the database and the function changes nothing', () => {
  for (const s of ['risk constant numeric := 25', 'room constant numeric := 2.5', 'min_trades constant int := 300', 'min_people constant int := 30',
    'day_limit constant numeric := 625', 'dd_limit constant numeric := 3000', "'live_on_e8', false", 'lo > 0', 'p.closed_at <= l.opened_at'])
    assert.ok(sql.includes(s), s);
  assert.doesNotMatch(sql.replace(/insert into _bp/g, ''), /\binsert into\b|\bupdate public\.|\bdelete from\b/i);
  assert.match(sql, /grant execute on function public\.ab_b_paper_scorecard\(date, date\) to service_role/);
  assert.match(monitor, /b_paper: bPaper\?\.data \?\? null/);
});

test('reverse (B-book) legs never go to E8 ladder accounts and only to a demo destination', () => {
  assert.match(exec, /if \(book === "a"\) \{\s*const groups/);
  assert.match(exec, /\.eq\("environment", "demo"\)/);
  assert.match(exec, /\(d\.api_env \?\? "demo"\) !== "demo"\) return null/);
});
