// Chart candles served by the hub (2026-10-24, "Big Build" step 1). Replaces, for IPFX Markets, the chart-candles Edge Function and
// the Supabase quote_ticks table it read: every Edge call wrote a rate-limit row to the database and the tick table took ~15 inserts a
// second plus a purge every 5 minutes. The hub already receives every price change, so it keeps the last 6 hours of ticks in memory
// (saved to its state directory once a minute so a restart loses nothing) and serves:
//   - 1s / 15s / 30s candles from those ticks (same algorithm and output as chart-candles' "ipfx-ticks" source), and
//   - 1m .. 1W history from Yahoo (same codes, grouping, flat-bar repair and futures volume as chart-candles), cached in memory.
// The page falls back to the chart-candles Edge Function whenever the hub cannot answer.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Must match INSTRUMENTS in trading-engine/index.ts and CODES in chart-candles. [yahoo code, proxy?]
export const CODES = {
  EURUSD: ['EURUSD=X', false], GBPUSD: ['GBPUSD=X', false], USDJPY: ['USDJPY=X', false],
  AUDUSD: ['AUDUSD=X', false], USDCAD: ['USDCAD=X', false], USDCHF: ['USDCHF=X', false],
  NZDUSD: ['NZDUSD=X', false], GBPJPY: ['GBPJPY=X', false], EURJPY: ['EURJPY=X', false],
  EURGBP: ['EURGBP=X', false], EURCAD: ['EURCAD=X', false], AUDCAD: ['AUDCAD=X', false],
  XAUUSD: ['GC=F', true], XAGUSD: ['SI=F', true], XPTUSD: ['PL=F', false], XPDUSD: ['PA=F', false],
  SPXUSD: ['^GSPC', false], NSXUSD: ['^NDX', false], DJI: ['^DJI', false], UK100: ['^FTSE', false],
  GER40: ['^GDAXI', false], FRA40: ['^FCHI', false], JPN225: ['^N225', false], US2000: ['^RUT', false],
  BTCUSD: ['BTC-USD', false], ETHUSD: ['ETH-USD', false], LTCUSD: ['LTC-USD', false],
  ADAUSD: ['ADA-USD', false], SOLUSD: ['SOL-USD', false], DOTUSD: ['DOT-USD', false],
  ES: ['ES=F', false], MES: ['MES=F', false], NQ: ['NQ=F', false], MNQ: ['MNQ=F', false],
  YM: ['YM=F', false], MYM: ['MYM=F', false], RTY: ['RTY=F', false], M2K: ['M2K=F', false],
  CL: ['CL=F', false], MCL: ['MCL=F', false], GC: ['GC=F', false], MGC: ['MGC=F', false],
  NG: ['NG=F', false], ZB: ['ZB=F', false], ZN: ['ZN=F', false],
};
const ALIASES = { US500: 'SPXUSD', SPX500: 'SPXUSD', NAS100: 'NSXUSD', US30: 'DJI' };

export const TF = {
  1: { interval: '1m', range: '5d', group: 1, seconds: 60, cache: 20 },
  3: { interval: '1m', range: '5d', group: 3, seconds: 180, cache: 20 },
  5: { interval: '5m', range: '1mo', group: 1, seconds: 300, cache: 30 },
  15: { interval: '15m', range: '1mo', group: 1, seconds: 900, cache: 60 },
  30: { interval: '30m', range: '1mo', group: 1, seconds: 1800, cache: 60 },
  60: { interval: '60m', range: '6mo', group: 1, seconds: 3600, cache: 120 },
  240: { interval: '60m', range: '2y', group: 4, seconds: 14400, cache: 300 },
  D: { interval: '1d', range: '5y', group: 1, seconds: 86400, cache: 900 },
  W: { interval: '1wk', range: '10y', group: 1, seconds: 604800, cache: 1800 },
};
export const SEC_TF = {
  '1S': { seconds: 1, windowSec: 45 * 60, cache: 1 },
  '15S': { seconds: 15, windowSec: 6 * 3600, cache: 2 },
  '30S': { seconds: 30, windowSec: 6 * 3600, cache: 3 },
};
export const VOLUME_PROXY = {
  EURUSD: ['6E=F', 'CME Euro FX (6E) futures'], GBPUSD: ['6B=F', 'CME British pound (6B) futures'],
  USDJPY: ['6J=F', 'CME Japanese yen (6J) futures'], AUDUSD: ['6A=F', 'CME Australian dollar (6A) futures'],
  USDCAD: ['6C=F', 'CME Canadian dollar (6C) futures'], USDCHF: ['6S=F', 'CME Swiss franc (6S) futures'],
  NZDUSD: ['6N=F', 'CME New Zealand dollar (6N) futures'], EURGBP: ['RP=F', 'CME Euro/British pound (RP) futures'],
  EURJPY: ['RY=F', 'CME Euro/Japanese yen (RY) futures'],
};

export function cleanSymbol(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.toUpperCase().replace(/^[A-Z_]+:/, '').replace(/[^A-Z0-9]/g, '');
  if (ALIASES[s]) s = ALIASES[s];
  return CODES[s] ? s : null;
}

export function aggregate(bars, seconds) {
  const out = [];
  for (const b of bars) {
    const bucket = Math.floor(b.t / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last.t === bucket) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; }
    else out.push({ ...b, t: bucket });
  }
  return out;
}

export function repairFlatBars(bars, stepSeconds) {
  let flat = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.o !== b.h || b.h !== b.l || b.l !== b.c) continue;
    flat++;
    if (b.t - bars[i - 1].t > stepSeconds * 3) continue;
    b.o = bars[i - 1].c; b.h = Math.max(b.o, b.c); b.l = Math.min(b.o, b.c);
  }
  return bars.length > 1 ? flat / (bars.length - 1) : 0;
}

export function volumeKey(t, seconds, isFutures) {
  if (seconds < 86400) return t;
  if (seconds <= 86400) return Math.floor((isFutures ? t : t - 79200) / 86400);
  return Math.floor((isFutures ? t : t + 7200) / 604800);
}
export function mergeVolume(spot, fut, seconds) {
  const byKey = new Map();
  for (const f of fut) { const k = volumeKey(f.t, seconds, true); byKey.set(k, (byKey.get(k) ?? 0) + (f.v || 0)); }
  let matched = 0;
  for (const s of spot) { const v = byKey.get(volumeKey(s.t, seconds, false)); if (v !== undefined && v > 0) { s.v = v; matched++; } }
  return matched;
}

// ---------- the last 6 hours of price changes, per symbol ----------
export class TickStore {
  constructor({ keepMs = 6 * 3600_000, path = null, log = () => {} } = {}) {
    this.keepMs = keepMs; this.path = path; this.log = log;
    this.data = new Map();                         // symbol -> { t: number[] (ms), m: number[] (mid) }
  }
  add(symbol, tMs, mid) {
    if (!Number.isFinite(tMs) || !Number.isFinite(mid) || mid <= 0) return;
    let d = this.data.get(symbol);
    if (!d) { d = { t: [], m: [] }; this.data.set(symbol, d); }
    if (d.t.length && tMs < d.t[d.t.length - 1]) return; // ticks arrive in order; never rewrite history
    d.t.push(tMs); d.m.push(mid);
  }
  prune(now = Date.now()) {
    const cut = now - this.keepMs;
    for (const d of this.data.values()) {
      let i = 0; while (i < d.t.length && d.t[i] < cut) i++;
      if (i) { d.t.splice(0, i); d.m.splice(0, i); }
    }
  }
  size() { let n = 0; for (const d of this.data.values()) n += d.t.length; return n; }
  // Same construction as chart-candles' second timeframes: the first bar opens at its first tick, every later bar opens at the
  // previous close, and each tick extends the bar's high/low/close.
  bars(symbol, seconds, windowSec, now = Date.now()) {
    const d = this.data.get(symbol); if (!d) return [];
    const since = now - windowSec * 1000;
    let i = 0; while (i < d.t.length && d.t[i] < since) i++;
    const bars = [];
    for (; i < d.t.length; i++) {
      const time = Math.floor(d.t[i] / 1000 / seconds) * seconds, px = d.m[i], last = bars[bars.length - 1];
      if (last && last.t === time) { last.h = Math.max(last.h, px); last.l = Math.min(last.l, px); last.c = px; }
      else bars.push({ t: time, o: last ? last.c : px, h: Math.max(px, last ? last.c : px), l: Math.min(px, last ? last.c : px), c: px, v: 0 });
    }
    return bars.slice(-2000);
  }
  save() {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const s = {}; for (const [k, d] of this.data) s[k] = [d.t, d.m];
      writeFileSync(this.path + '.tmp', JSON.stringify({ v: 1, at: Date.now(), s }));
      renameSync(this.path + '.tmp', this.path);
    } catch (e) { this.log('tick save failed', String(e)); }
  }
  load(now = Date.now()) {
    if (!this.path) return 0;
    try {
      const j = JSON.parse(readFileSync(this.path, 'utf8'));
      for (const [k, [t, m]] of Object.entries(j.s || {})) {
        if (!cleanSymbol(k) || !Array.isArray(t) || !Array.isArray(m) || t.length !== m.length) continue;
        this.data.set(k, { t: t.slice(), m: m.slice() });
      }
      this.prune(now);
      return this.size();
    } catch { return 0; }
  }
}

// ---------- the request handler ----------
export function createCandles({ store, fetchImpl = fetch, log = () => {}, now = () => Date.now() }) {
  const memo = new Map();                          // "SYMBOL|tf" -> { at, body }
  async function yahoo(code, interval, range) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?interval=${interval}&range=${range}&includePrePost=false`;
    const r = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IPFXCharts/1.0)' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0], ts = res?.timestamp ?? [], q = res?.indicators?.quote?.[0];
    if (!ts.length || !q) return null;
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (![o, h, l, c].every((x) => typeof x === 'number' && isFinite(x) && x > 0)) continue;
      bars.push({ t: ts[i], o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v: Number(q.volume?.[i]) || 0 });
    }
    return bars;
  }
  return async function handle(rawSymbol, rawTf) {
    const symbol = cleanSymbol(rawSymbol), tf = String(rawTf ?? '60');
    if (!symbol) return { status: 400, body: { ok: false, error: 'Unknown instrument' }, cache: 0 };
    if (!TF[tf] && !SEC_TF[tf]) return { status: 400, body: { ok: false, error: 'Unknown timeframe' }, cache: 0 };
    const key = `${symbol}|${tf}`, hit = memo.get(key);
    const sec = SEC_TF[tf];
    if (sec) {
      if (hit && now() - hit.at < sec.cache * 1000) return { status: 200, body: hit.body, cache: sec.cache };
      const body = { ok: true, symbol, tf, source: 'ipfx-ticks', proxy: false, volume_source: null, closes_only: false, seconds: sec.seconds, bars: store.bars(symbol, sec.seconds, sec.windowSec, now()) };
      memo.set(key, { at: now(), body });
      return { status: 200, body, cache: sec.cache };
    }
    const spec = TF[tf];
    if (hit && now() - hit.at < spec.cache * 1000) return { status: 200, body: hit.body, cache: spec.cache };
    const [code, proxy] = CODES[symbol];
    try {
      const raw = await yahoo(code, spec.interval, spec.range);
      if (!raw || !raw.length) return hit ? { status: 200, body: hit.body, cache: 10 } : { status: 502, body: { ok: false, error: 'No chart history for this instrument right now' }, cache: 0 };
      const step = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '60m': 3600 }[spec.interval];
      const flatShare = step ? repairFlatBars(raw, step) : 0;
      const bars = spec.seconds < 86400 ? aggregate(raw, spec.seconds) : raw;
      let volumeSource = null;
      const vp = VOLUME_PROXY[symbol];
      if (vp) {
        try {
          const futRaw = await yahoo(vp[0], spec.interval, spec.range);
          if (futRaw && futRaw.length) {
            const fut = spec.seconds < 86400 ? aggregate(futRaw, spec.seconds) : futRaw;
            if (mergeVolume(bars, fut, spec.seconds) > 0) volumeSource = vp[1];
          }
        } catch { /* candles still work without volume */ }
      }
      const body = { ok: true, symbol, tf, source: 'yahoo', proxy, volume_source: volumeSource, closes_only: flatShare > 0.5, seconds: spec.seconds, bars: bars.slice(-2000) };
      memo.set(key, { at: now(), body });
      if (memo.size > 2000) for (const [k, v] of memo) if (now() - v.at > 3600_000) memo.delete(k);
      return { status: 200, body, cache: spec.cache };
    } catch (e) {
      log('candles fetch failed', symbol, tf, String(e).slice(0, 80));
      if (hit) return { status: 200, body: hit.body, cache: 10 };   // serve stale rather than blank the chart
      return { status: 502, body: { ok: false, error: 'Chart history is temporarily unavailable' }, cache: 0 };
    }
  };
}

// Per-IP limit for the public candles endpoint (in memory: no database write per request).
export function rateLimiter({ perMinute = 120, now = () => Date.now() } = {}) {
  const hits = new Map();
  return (ip) => {
    const t = now(), w = hits.get(ip);
    if (!w || t - w.start >= 60_000) { hits.set(ip, { start: t, n: 1 }); if (hits.size > 100_000) hits.clear(); return true; }
    w.n++; return w.n <= perMinute;
  };
}
