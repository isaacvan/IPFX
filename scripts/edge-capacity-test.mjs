// Stepped production capacity test for the parts of the trading stack that need no trader login:
//   * trading-engine request path up to and including Supabase Auth token verification
//     (every trader request pays this), using the PUBLIC anon key as the bearer
//   * chart-candles (public, reads the candle tables) at a realistic chart-load rate
// It ramps 50 -> 100 -> 200 -> 300 simulated traders and ABORTS at the first sign of strain
// (p95 > 1500ms, any 5xx/429, or >1% transport errors) so live traders are not affected.
//
// Each simulated trader sends what the platform sends: ~1.33 price polls/s + 0.25 state/s + 0.25 prices/s
// to the engine, and one chart-candle load every 30s.
//
//   IPFX_ALLOW_PRODUCTION_LOAD_TEST=true node scripts/edge-capacity-test.mjs
import fs from 'node:fs';
import process from 'node:process';

if (process.env.IPFX_ALLOW_PRODUCTION_LOAD_TEST !== 'true') {
  throw new Error('Production load testing is locked. Set IPFX_ALLOW_PRODUCTION_LOAD_TEST=true only in an approved window.');
}
const src = fs.readFileSync(new URL('../trading.html', import.meta.url), 'utf8');
const BASE = (src.match(/SUPABASE_URL\s*=\s*'([^']+)'/) || [])[1];
const ANON = (src.match(/SUPABASE_KEY\s*=\s*'([^']+)'/) || [])[1];
if (!BASE || !ANON) throw new Error('public Supabase URL / anon key not found');
const ENGINE = `${BASE}/functions/v1/trading-engine`;
const CANDLES = `${BASE}/functions/v1/chart-candles`;
const STEPS = (process.env.IPFX_STEPS || '50,100,200,300').split(',').map(Number);
const STEP_MS = Math.min(60, Number(process.env.IPFX_STEP_S) || 20) * 1000;
const SYMBOLS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'US30', 'NAS100', 'BTCUSD'];

async function hit(url, init) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    await r.arrayBuffer();
    return { status: r.status, ms: performance.now() - t0 };
  } catch (e) { return { status: e?.name || 'ERR', ms: performance.now() - t0 }; }
}
const engine = (body) => hit(ENGINE, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}` }, body: JSON.stringify(body) });

async function trader(i, until, out) {
  const sym = SYMBOLS[i % SYMBOLS.length];
  let nextState = Date.now() + Math.random() * 4000, nextWl = Date.now() + Math.random() * 4000, nextCandles = Date.now() + Math.random() * 30000;
  await new Promise(r => setTimeout(r, Math.random() * 750));
  while (Date.now() < until) {
    const jobs = [engine({ action: 'price', symbol: sym, enforce_risk: true }).then(r => out.engine.push(r))];
    if (Date.now() >= nextState) { jobs.push(engine({ action: 'state' }).then(r => out.engine.push(r))); nextState += 4000; }
    if (Date.now() >= nextWl) { jobs.push(engine({ action: 'prices', symbols: SYMBOLS }).then(r => out.engine.push(r))); nextWl += 4000; }
    if (Date.now() >= nextCandles) { jobs.push(hit(`${CANDLES}?symbol=${sym}&tf=1`).then(r => out.candles.push(r))); nextCandles += 30000; }
    await Promise.all(jobs);
    await new Promise(r => setTimeout(r, 750));
  }
}

const pct = (a, p) => { const s = a.map(x => x.ms).sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]) : 0; };
function summarise(name, rows, secs, expectOk) {
  const bad5xx = rows.filter(r => typeof r.status === 'number' && r.status >= 500).length;
  const limited = rows.filter(r => r.status === 429).length;
  const transport = rows.filter(r => typeof r.status !== 'number').length;
  const unexpected = rows.filter(r => typeof r.status === 'number' && !expectOk.includes(r.status)).length;
  const line = { name, n: rows.length, rps: +(rows.length / secs).toFixed(1), p50: pct(rows, 50), p95: pct(rows, 95), p99: pct(rows, 99), http5xx: bad5xx, rate_limited_429: limited, transport_errors: transport, unexpected_status: unexpected };
  // chart-candles is rate limited per IP (60/min) and this test runs from ONE IP, so its 429s are the limiter
  // working, not strain. A 429 from the engine path would be real strain.
  const strained = line.p95 > 1500 || bad5xx > 0 || transport / Math.max(1, rows.length) > 0.01 || (name.startsWith('engine') && limited > 0);
  return { line, strained };
}

console.log(`Stepped capacity test: ${STEPS.join(' -> ')} traders, ${STEP_MS / 1000}s per step`);
const results = [];
for (const n of STEPS) {
  const out = { engine: [], candles: [] };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: n }, (_, i) => trader(i, t0 + STEP_MS, out)));
  const secs = (Date.now() - t0) / 1000;
  const e = summarise('engine (auth path)', out.engine, secs, [401]);
  const c = summarise('chart-candles', out.candles, secs, [200, 429]);
  results.push({ traders: n, engine: e.line, candles: c.line });
  console.log(`\n${n} traders`); console.table([e.line, c.line]);
  if (e.strained || c.strained) { console.log(`STOPPED at ${n} traders: strain detected`); break; }
  await new Promise(r => setTimeout(r, 5000)); // let the platform settle between steps
}
fs.writeFileSync(new URL('../loadtest-results.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
