// Big Build step 1: chart candles and the 6-hour tick history live on the hub; Supabase keeps only the ticks the database still reads.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import vm from 'node:vm';
import { TickStore, createCandles, rateLimiter, CODES, TF, SEC_TF, VOLUME_PROXY, cleanSymbol } from '../hub/candles.mjs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const edge = read('supabase/functions/chart-candles/index.ts'), volume = read('supabase/functions/chart-candles/volume-merge.ts');
const server = read('hub/server.mjs'), engine = read('supabase/functions/trading-engine/index.ts'), chart = read('assets/js/ipfx-chart.js');

// The Edge Function's second-timeframe construction, copied from chart-candles, as the reference.
function edgeBars(rows, seconds) {
  const bars = [];
  for (const t of rows) {
    const time = Math.floor(Date.parse(t.ts) / 1000 / seconds) * seconds, px = Number(t.mid), last = bars[bars.length - 1];
    if (last && last.t === time) { last.h = Math.max(last.h, px); last.l = Math.min(last.l, px); last.c = px; }
    else bars.push({ t: time, o: last ? last.c : px, h: Math.max(px, last ? last.c : px), l: Math.min(px, last ? last.c : px), c: px, v: 0 });
  }
  return bars.slice(-2000);
}

test('second candles from the hub are identical to the Edge Function built from the same ticks', () => {
  const now = Date.UTC(2026, 9, 24, 12), store = new TickStore();
  const rows = []; let px = 1.1;
  for (let i = 0; i < 5000; i++) { const t = now - 3 * 3600_000 + i * 2100 + (i % 7) * 13; px += Math.sin(i) * 0.0001; store.add('EURUSD', t, px); rows.push({ ts: new Date(t).toISOString(), mid: px }); }
  for (const [tf, sec] of Object.entries(SEC_TF)) {
    const since = now - sec.windowSec * 1000;
    assert.deepEqual(store.bars('EURUSD', sec.seconds, sec.windowSec, now), edgeBars(rows.filter((r) => Date.parse(r.ts) >= since), sec.seconds), tf);
  }
});

test('the tick store keeps 6 hours, ignores out-of-order or bad ticks, and survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticks-')), file = path.join(dir, 'ticks.json'), now = Date.now();
  const a = new TickStore({ path: file });
  a.add('XAUUSD', now - 7 * 3600_000, 4100); a.add('XAUUSD', now - 1000, 4170); a.add('XAUUSD', now - 2000, 4169); a.add('XAUUSD', now, NaN); a.add('XAUUSD', now, 4171);
  a.prune(now);
  assert.equal(a.size(), 2, 'old, out-of-order and bad ticks are dropped');
  a.save();
  const b = new TickStore({ path: file });
  assert.equal(b.load(now), 2);
  assert.deepEqual(b.bars('XAUUSD', 1, 60, now).map((x) => x.c), [4170, 4171]);
  assert.equal(new TickStore({ path: path.join(dir, 'missing.json') }).load(), 0, 'no file: start empty');
});

test('minute to weekly history: same instruments, timeframes and volume sources as the Edge Function', () => {
  for (const [sym, [code, proxy]] of Object.entries(CODES)) assert.ok(edge.includes(`${sym}: ["${code}", ${proxy}]`) || edge.includes(`${sym}:  ["${code}", ${proxy}]`), sym);
  assert.equal(Object.keys(CODES).length, (edge.match(/\["[^"]+", (true|false)\]/g) || []).length);
  for (const [tf, x] of Object.entries(TF)) assert.ok(edge.includes(`interval: "${x.interval}", range: "${x.range}", group: ${x.group}, seconds: ${x.seconds}, cache: ${x.cache}`), tf);
  for (const [tf, x] of Object.entries(SEC_TF)) assert.ok(edge.includes(`"${tf}": { seconds: ${x.seconds}, windowSec: `), tf);
  for (const [sym, [code, name]] of Object.entries(VOLUME_PROXY)) assert.ok(volume.includes(`${sym}: ["${code}", "${name}"]`), sym);
  assert.equal(cleanSymbol('oanda:us500'), 'SPXUSD'); assert.equal(cleanSymbol('NOPE'), null);
});

function yahooBody(ts, close, vol = 0) {
  return { chart: { result: [{ timestamp: ts, indicators: { quote: [{ open: close, high: close, low: close, close, volume: ts.map(() => vol) }] } }] } };
}

test('Yahoo history: 3m from 1m bars, flat bars repaired, futures volume merged, cached, stale on failure', async () => {
  const calls = []; let fail = false; let t = 1_790_000_000;
  const fetchImpl = async (url) => {
    calls.push(url); if (fail) throw new Error('down');
    const ts = Array.from({ length: 9 }, (_, i) => Math.floor(1_790_000_040 / 180) * 180 + i * 60);
    return { ok: true, json: async () => yahooBody(ts, ts.map((_, i) => 1.1 + i * 0.001), url.includes('6E%3DF') ? 50 : 0) };
  };
  const store = new TickStore(), handle = createCandles({ store, fetchImpl, now: () => t * 1000 });
  const r = await handle('EURUSD', '3');
  assert.equal(r.status, 200); assert.equal(r.body.source, 'yahoo'); assert.equal(r.body.seconds, 180);
  assert.equal(r.body.bars.length, 3, '9 one-minute bars -> 3 three-minute bars');
  assert.ok(r.body.bars[1].o < r.body.bars[1].c, 'flat 1m bars were rebuilt close-to-close');
  assert.equal(r.body.volume_source, 'CME Euro FX (6E) futures'); assert.ok(r.body.bars.every((b) => b.v > 0));
  const n = calls.length; await handle('EURUSD', '3'); assert.equal(calls.length, n, 'served from cache inside 20s');
  t += 30; fail = true;
  const stale = await handle('EURUSD', '3'); assert.equal(stale.status, 200); assert.equal(stale.cache, 10, 'stale beats a blank chart');
  assert.equal((await handle('GBPUSD', '60')).status, 502, 'no history and no cache: an honest error');
  assert.equal((await handle('NOPE', '60')).status, 400); assert.equal((await handle('EURUSD', '2')).status, 400);
});

test('the candles endpoint is rate limited in memory, per IP', () => {
  let t = 0; const ok = rateLimiter({ perMinute: 3, now: () => t });
  assert.deepEqual([ok('a'), ok('a'), ok('a'), ok('a'), ok('b')], [true, true, true, false, true]);
  t = 60_000; assert.equal(ok('a'), true, 'a new minute');
});

test('hub server: ticks recorded on every accepted price, saved each minute and on shutdown, public CORS endpoint', () => {
  assert.match(server, /quotes\.set\(q\.s, q\); counters\.quotesIn\+\+;\n\s*ticks\.add\(q\.s, q\.rt, q\.m\);/);
  assert.match(server, /req\.url\.startsWith\('\/candles\?'\)/);
  assert.match(server, /'Access-Control-Allow-Origin': '\*'/);
  assert.match(server, /if \(!candleLimit\(ip\)\)/);
  assert.match(server, /setInterval\(\(\) => \{ ticks\.prune\(\); ticks\.save\(\); \}, 60_000\)/);
  assert.match(server, /process\.once\(sig, \(\) => \{ ticks\.save\(\); process\.exit\(0\); \}\)/);
  assert.match(server, /env\.STATE_DIRECTORY/, 'systemd state directory (the only writable path)');
});

test('engine: every price change reaches the hub; Supabase keeps ticks only for watched/held symbols and FX conversion pairs', () => {
  assert.match(engine, /for \(const q of qs\) hubPending\.set\(q\.symbol, q\);/);
  assert.doesNotMatch(engine, /if \(watched\.has\(q\.symbol\)\) hubPending\.set/);
  const a = engine.indexOf('const TICK_FX'), b = engine.indexOf('function rowsToWrite');
  const js = engine.slice(a, b).replace(/: \{ symbol: string \}\[\]/g, '').replace(/: Set<string>/g, '');
  const ctx = {}; vm.createContext(ctx); vm.runInContext(js + '\nglobalThis.f = ticksToStore;', ctx);
  const out = ctx.f([{ symbol: 'XAUUSD' }, { symbol: 'NSXUSD' }, { symbol: 'USDJPY' }, { symbol: 'ETHUSD' }], new Set(['XAUUSD']));
  assert.deepEqual(out.map((q) => q.symbol), ['XAUUSD', 'USDJPY']);
  assert.match(engine, /tickRows\.length \? db\.from\("quote_ticks"\)\.insert\(tickRows\.map/);
});

test('page: hub first, Edge Function fallback, and empty second-level history falls back too', () => {
  assert.match(chart, /const HUB_CANDLES_URL = "https:\/\/hub\.ipfxcapital\.com\/candles";/);
  assert.match(chart, /AbortSignal\.timeout\(4000\)/);
  assert.match(chart, /j\.bars\.length \|\| j\.source !== "ipfx-ticks"/);
  assert.equal((chart.match(/fetchCandles\(/g) || []).length, 4, 'definition + history load + other-symbol closes + volume refresh');
  assert.equal((chart.match(/\$\{CANDLES_URL\}\?/g) || []).length, 1, 'the Edge URL is only used inside the fallback');
  assert.match(read('trading.html'), /ipfx-chart\.js\?v=20261024-hubcandles/);
});
