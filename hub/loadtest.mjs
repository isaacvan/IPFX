// Load test for the IPFX hub: N simulated traders (each watching 1 chart symbol + 10 watchlist symbols) and a
// price feed of 30 symbols changing every 250ms (the pump's pace). Reports delivery delay and throughput.
// Needs LOADTEST_KEY set on the hub for the duration of the test only.
//   node hub/loadtest.mjs <ws url> <ingest url> <clients> <seconds>   (HUB_SECRET and LOADTEST_KEY in env)
import WebSocket from 'ws';

const [wsUrl, ingestUrl, nArg, secArg] = process.argv.slice(2);
const N = Number(nArg || 2000), SECONDS = Number(secArg || 60);
const SYMS = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'NSXUSD', 'DJI', 'BTCUSD', 'SPXUSD', 'GER40', 'ETHUSD', 'AUDUSD', 'USDCAD', 'GBPJPY', 'EURJPY',
  'XAGUSD', 'USDCHF', 'NZDUSD', 'EURGBP', 'UK100', 'US2000', 'JPN225', 'FRA40', 'EURCAD', 'AUDCAD', 'XPTUSD', 'XPDUSD', 'ADAUSD', 'CADJPY', 'AUDJPY', 'CHFJPY'];
const delays = []; let feedStart = Infinity, frames = 0, quotesRx = 0, open = 0, authed = 0, failed = 0;

function client(i) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const subs = [SYMS[i % SYMS.length], ...Array.from({ length: 10 }, (_, k) => SYMS[(i * 7 + k * 3) % SYMS.length])];
    ws.on('open', () => { open++; ws.send(JSON.stringify({ t: 'auth', token: process.env.LOADTEST_KEY })); });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'auth') { if (m.ok) { authed++; ws.send(JSON.stringify({ t: 'sub', s: subs })); } resolve(ws); return; }
      if (m.t === 'q') { frames++; const now = Date.now(); for (const q of m.q) { quotesRx++; if (q.rt && q.rt >= feedStart) delays.push(now - q.rt); } }
    });
    ws.on('error', () => { failed++; resolve(null); });
    ws.on('close', () => resolve(null));
  });
}

const t0 = Date.now();
const sockets = [];
for (let i = 0; i < N; i += 100) sockets.push(...await Promise.all(Array.from({ length: Math.min(100, N - i) }, (_, k) => client(i + k))));
console.log(`connected ${open}/${N}, authenticated ${authed}, failed ${failed}, in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
delays.length = 0; frames = 0; quotesRx = 0;

let price = 1, sent = 0, ingestErr = 0;
feedStart = Date.now();
const feed = setInterval(async () => {
  price += (Math.random() - 0.5) * 0.001;
  const now = Date.now();
  const q = SYMS.map((s, k) => { const m = price * (1 + k); return { s, b: m - 0.0001, a: m + 0.0001, m, sp: 0.0002, d: 5, rt: now, pt: now }; });
  try { const r = await fetch(ingestUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-secret': process.env.HUB_SECRET }, body: JSON.stringify({ q }) }); if (!r.ok) ingestErr++; sent++; }
  catch { ingestErr++; }
}, 250);

await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(feed);
await new Promise((r) => setTimeout(r, 1000));
delays.sort((a, b) => a - b);
const pct = (p) => delays.length ? delays[Math.min(delays.length - 1, Math.floor(delays.length * p))] : null;
console.log(JSON.stringify({ clients: authed, seconds: SECONDS, priceBatchesSent: sent, ingestErrors: ingestErr, framesPerSec: Math.round(frames / SECONDS),
  quotesPerSec: Math.round(quotesRx / SECONDS), delayMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: delays.at(-1) ?? null } }));
for (const ws of sockets) ws?.terminate();
process.exit(0);
