// Trading-engine load model: simulates N traders each running the platform's polling mix
// (ticket price every 750ms, state every 4s, watchlist prices every 4s) for D seconds.
//
// Requires real session JWTs for TEST (demo) accounts — one per line in IPFX_LOADTEST_TOKENS_FILE.
// Never uses live-capital accounts, never places orders. Production is locked unless
// IPFX_ALLOW_PRODUCTION_LOAD_TEST=true (run only in an agreed quiet window).
//
//   IPFX_LOADTEST_TOKENS_FILE=tokens.txt IPFX_TRADERS=300 IPFX_DURATION_S=120 node scripts/engine-load-test.mjs
import fs from 'node:fs';
import process from 'node:process';

const ENGINE = process.env.IPFX_ENGINE_URL || 'https://agulweemteoeagscmppy.supabase.co/functions/v1/trading-engine';
if (ENGINE.includes('agulweemteoeagscmppy') && process.env.IPFX_ALLOW_PRODUCTION_LOAD_TEST !== 'true') {
  throw new Error('Production load testing is locked. Set IPFX_ALLOW_PRODUCTION_LOAD_TEST=true only in an approved window.');
}
const tokens = fs.readFileSync(process.env.IPFX_LOADTEST_TOKENS_FILE || 'loadtest-tokens.txt', 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
if (!tokens.length) throw new Error('No test tokens');
const traders = Math.min(1000, Number(process.env.IPFX_TRADERS) || 50);
const durationMs = Math.min(600, Number(process.env.IPFX_DURATION_S) || 60) * 1000;
const SYMBOLS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'US30', 'NAS100', 'BTCUSD'];
const stats = new Map();

async function call(kind, token, body) {
  const t0 = performance.now();
  let status = 'ERR';
  try {
    const r = await fetch(ENGINE, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    await r.arrayBuffer(); status = r.status;
  } catch (e) { status = e?.name || 'ERR'; }
  const s = stats.get(kind) || { n: 0, fail: 0, ms: [] };
  s.n++; if (status !== 200) s.fail++; s.ms.push(performance.now() - t0); stats.set(kind, s);
}

async function trader(i) {
  const token = tokens[i % tokens.length], sym = SYMBOLS[i % SYMBOLS.length];
  const end = Date.now() + durationMs;
  let nextState = Date.now() + Math.random() * 4000, nextWl = Date.now() + Math.random() * 4000;
  await new Promise(r => setTimeout(r, Math.random() * 750));
  while (Date.now() < end) {
    const jobs = [call('price', token, { action: 'price', symbol: sym, enforce_risk: true })];
    if (Date.now() >= nextState) { jobs.push(call('state', token, { action: 'state' })); nextState += 4000; }
    if (Date.now() >= nextWl) { jobs.push(call('prices', token, { action: 'prices', symbols: SYMBOLS })); nextWl += 4000; }
    await Promise.all(jobs);
    await new Promise(r => setTimeout(r, 750));
  }
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(0) : '-'; };
console.log(`${traders} traders x ${durationMs / 1000}s against ${ENGINE}`);
const t0 = Date.now();
await Promise.all(Array.from({ length: traders }, (_, i) => trader(i)));
const secs = (Date.now() - t0) / 1000;
let failed = false;
for (const [k, s] of stats) {
  const errRate = s.fail / s.n;
  console.log(`${k.padEnd(7)} n=${s.n} rps=${(s.n / secs).toFixed(1)} err=${(errRate * 100).toFixed(2)}% p50=${pct(s.ms, 50)}ms p95=${pct(s.ms, 95)}ms p99=${pct(s.ms, 99)}ms`);
  if (errRate > 0.01 || Number(pct(s.ms, 95)) > 1500) failed = true;
}
console.log(failed ? 'FAIL: error rate > 1% or p95 > 1500ms' : 'PASS');
process.exit(failed ? 1 : 0);
