// Price history in, validated bars out: [{ time (unix s, bar open), open, high, low, close, volume }].
//
// Serious tests need 10+ years of history. The chart's own feed (chart-candles) returns at most
// 2,000 bars, which is fine for a smoke test but never for a verdict. For real runs, export
// history with dukascopy-node, for example:
//   npx dukascopy-node -i eurusd -from 2010-01-01 -to 2026-09-01 -t h1 -f csv -v
// and pass the CSV with --csv. Dukascopy quotes are bid; add half the spread back when comparing
// with IPFX mid prices (backtest.mjs works on mid, so the difference is at most half a spread).

import fs from "node:fs";
import crypto from "node:crypto";

const CANDLES_URL = "https://agulweemteoeagscmppy.supabase.co/functions/v1/chart-candles";

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].toLowerCase().split(/[,;\t]/).map((s) => s.trim());
  const hasHeader = head.some((h) => /^[a-z]/.test(h));
  const col = (names, fallback) => { const k = head.findIndex((h) => names.includes(h)); return hasHeader && k >= 0 ? k : fallback; };
  const iT = col(["timestamp", "time", "date", "datetime", "gmt time", "local time"], 0);
  const iO = col(["open"], 1), iH = col(["high"], 2), iL = col(["low"], 3), iC = col(["close"], 4), iV = col(["volume", "vol"], 5);
  const bars = [];
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const f = line.split(/[,;\t]/);
    const time = parseTime(f[iT]);
    const b = { time, open: +f[iO], high: +f[iH], low: +f[iL], close: +f[iC], volume: f[iV] == null ? 0 : +f[iV] || 0 };
    bars.push(b);
  }
  return bars;
}

function parseTime(raw) {
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) { const n = +s; return Math.floor(n > 1e11 ? n / 1000 : n); }
  // "01.01.2020 00:00:00.000 GMT+0000" (Dukascopy website export)
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) / 1000;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) throw new Error("Unreadable time: " + s);
  return Math.floor(t / 1000);
}

// Sorts, removes duplicates and impossible bars, and reports what it had to do. A report with many
// repairs means the data is not fit for a verdict.
export function validate(bars) {
  const issues = { unsorted: 0, duplicates: 0, invalid: 0, flat: 0, gaps: 0 };
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  for (let i = 1; i < bars.length; i++) if (bars[i].time < bars[i - 1].time) { issues.unsorted++; }
  const out = [];
  for (const b of sorted) {
    const ok = [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0) &&
      b.high >= Math.max(b.open, b.close) - 1e-12 && b.low <= Math.min(b.open, b.close) + 1e-12;
    if (!ok) { issues.invalid++; continue; }
    if (out.length && out[out.length - 1].time === b.time) { issues.duplicates++; continue; }
    if (b.high === b.low) issues.flat++;
    out.push(b);
  }
  // gaps longer than 4 days (a weekend is ~2) suggest missing data
  for (let i = 1; i < out.length; i++) if (out[i].time - out[i - 1].time > 4 * 86400) issues.gaps++;
  const years = out.length > 1 ? (out[out.length - 1].time - out[0].time) / (365.25 * 86400) : 0;
  return { bars: out, issues, years, first: out[0]?.time, last: out[out.length - 1]?.time };
}

// Aggregate to a longer bar (e.g. 1h -> 4h or 1D), UTC-aligned.
export function resample(bars, seconds) {
  const out = [];
  for (const b of bars) {
    const t = Math.floor(b.time / seconds) * seconds, last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; last.volume += b.volume || 0;
    } else out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
  }
  return out;
}

export function loadCsv(path) { return validate(parseCsv(fs.readFileSync(path, "utf8"))); }

export async function fetchCandles(symbol, tf = "D") {
  const r = await fetch(`${CANDLES_URL}?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "chart-candles failed");
  return validate(j.bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0 })));
}

// Fingerprint of a dataset, so a result can always be traced to exactly the data it came from.
export function datasetId(bars) {
  const h = crypto.createHash("sha256");
  for (const b of bars) h.update(`${b.time},${b.open},${b.high},${b.low},${b.close};`);
  return h.digest("hex").slice(0, 16);
}
