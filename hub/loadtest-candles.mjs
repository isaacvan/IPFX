// Chart-candle load for the IPFX hub, to run next to hub/loadtest.mjs (which holds the WebSocket traders).
// Seeds the tick store with a day of one-second moves, then requests candles at a steady rate and reports latency.
//   node hub/loadtest-candles.mjs <base url> <ingest url> <requests per second> <seconds>   (HUB_SECRET in env)
const [base, ingestUrl, rpsArg, secArg] = process.argv.slice(2);
const RPS = Number(rpsArg || 50), SECONDS = Number(secArg || 20);
const SYMS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'NSXUSD', 'USDJPY'];
let price = 1;
for (let i = 0; i < 120; i++) {   // two minutes of price moves so second candles have data
  price += (Math.random() - 0.5) * 0.001; const now = Date.now() - (120 - i) * 1000;
  await fetch(ingestUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-secret': process.env.HUB_SECRET },
    body: JSON.stringify({ q: SYMS.map((s, k) => ({ s, b: price * (1 + k) - 0.0001, a: price * (1 + k) + 0.0001, rt: now, pt: now, d: 5 })) }) });
}
const lat = []; let bad = 0, limited = 0, sent = 0;
const tfs = ['1S', '15S', '30S'];
const timer = setInterval(() => {
  for (let k = 0; k < RPS / 10; k++) {
    const t = Date.now(); sent++;
    fetch(`${base}/candles?symbol=${SYMS[sent % SYMS.length]}&tf=${tfs[sent % tfs.length]}`).then(async (r) => {
      if (r.status === 429) limited++; else if (!r.ok) bad++; else { const j = await r.json(); if (!j.ok) bad++; }
      lat.push(Date.now() - t);
    }).catch(() => { bad++; });
  }
}, 100);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(timer); await new Promise((r) => setTimeout(r, 1000));
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
console.log(JSON.stringify({ requests: sent, answered: lat.length, rateLimited429: limited, errors: bad, latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: lat.at(-1) } }));
process.exit(0);
