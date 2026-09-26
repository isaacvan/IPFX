// Strategy families to test, each with the reason it might work. A family without a reason for an
// edge to exist is a data-mining trial and nothing more; the rationale is written down BEFORE any
// result is seen, and every grid point run is logged to the trial registry (registry.mjs) so the
// Deflated Sharpe Ratio charges for all of them.
//
// Indicators come from the IPFX chart's own library (assets/js/ipfx-indicators.js), so what is
// tested here is exactly what a trader sees on IPFX Markets. All of them are causal.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ta } = require("../../assets/js/ipfx-indicators.js");

function atr(bars, n) { return ta.rma(ta.trueRange(bars), n); }
const closes = (bars) => bars.map((b) => b.close);
const utcHour = (t) => Math.floor((t % 86400) / 3600);

export const FAMILIES = {
  donchian: {
    name: "Donchian channel breakout",
    rationale: "Trend following: slow-moving information and herding make prices trend; the classic Turtle rule. " +
      "Documented across FX, commodities and indices for decades (Moskowitz, Ooi & Pedersen 2012; Hurst, Ooi & Pedersen 2017), " +
      "but simple FX trend rules decayed after the early 1990s (Neely, Weller & Ulrich 2009), so FX results need extra suspicion.",
    grid: { n: [20, 55, 100], atrMult: [1.5, 2, 3], rr: [1.5, 2, 3] },
    prepare(bars, p) {
      const hi = ta.highest(bars.map((b) => b.high), p.n), lo = ta.lowest(bars.map((b) => b.low), p.n), a = atr(bars, 20);
      return {
        entry(i) {
          if (i < 1 || hi[i - 1] == null || a[i] == null) return null;
          const c = bars[i].close, stopDist = p.atrMult * a[i];
          if (c > hi[i - 1]) return { side: 1, stopDist, targetDist: p.rr * stopDist };
          if (c < lo[i - 1]) return { side: -1, stopDist, targetDist: p.rr * stopDist };
          return null;
        },
      };
    },
  },
  tsmom: {
    name: "Time-series momentum",
    rationale: "Past return over a lookback predicts the next period's sign (Moskowitz, Ooi & Pedersen 2012); the most replicated " +
      "trend anomaly. Held for a fixed period with a wide protective stop.",
    grid: { lookback: [20, 60, 120, 250], hold: [5, 20, 60], atrMult: [2, 3, 4] },
    prepare(bars, p) {
      const c = closes(bars), a = atr(bars, 20);
      return {
        entry(i) {
          if (i < p.lookback || a[i] == null) return null;
          const ret = c[i] - c[i - p.lookback];
          if (ret === 0) return null;
          return { side: ret > 0 ? 1 : -1, stopDist: p.atrMult * a[i], maxBars: p.hold };
        },
      };
    },
  },
  maCross: {
    name: "Moving-average crossover",
    rationale: "A smoothed form of trend following; included because traders use it widely, so it is a baseline and a common " +
      "fingerprint in traders' own trades, not because it is expected to beat Donchian or momentum.",
    grid: { fast: [10, 20, 50], slow: [50, 100, 200], atrMult: [1.5, 2, 3], rr: [2, 3] },
    valid: (p) => p.fast < p.slow,
    prepare(bars, p) {
      const c = closes(bars), f = ta.ema(c, p.fast), s = ta.ema(c, p.slow), a = atr(bars, 20);
      return {
        entry(i) {
          if (i < 1 || s[i - 1] == null || a[i] == null) return null;
          const up = f[i - 1] <= s[i - 1] && f[i] > s[i], down = f[i - 1] >= s[i - 1] && f[i] < s[i];
          if (!up && !down) return null;
          const stopDist = p.atrMult * a[i];
          return { side: up ? 1 : -1, stopDist, targetDist: p.rr * stopDist };
        },
      };
    },
  },
  bollingerReversion: {
    name: "Bollinger band mean reversion",
    rationale: "Short-horizon overreaction and liquidity provision: stretched moves away from the mean partly reverse, most " +
      "reliably in range-bound FX crosses and index futures intraday. Pays the spread often, so it lives or dies on costs.",
    grid: { n: [20, 50], k: [2, 2.5], atrMult: [1, 1.5, 2], maxBars: [10, 30] },
    prepare(bars, p) {
      const c = closes(bars), mid = ta.sma(c, p.n), sd = ta.stdev(c, p.n), a = atr(bars, 20);
      return {
        entry(i) {
          if (mid[i] == null || sd[i] == null || a[i] == null) return null;
          const up = mid[i] + p.k * sd[i], lo = mid[i] - p.k * sd[i], stopDist = p.atrMult * a[i];
          if (c[i] < lo) return { side: 1, stopDist, targetDist: mid[i] - c[i], maxBars: p.maxBars };
          if (c[i] > up) return { side: -1, stopDist, targetDist: c[i] - mid[i], maxBars: p.maxBars };
          return null;
        },
      };
    },
  },
  rsi2: {
    name: "RSI(2) pullback in a trend (Connors)",
    rationale: "Buy short-term weakness inside a long-term uptrend (and the reverse): combines the trend premium with " +
      "short-horizon reversal. Well known on equity indices; weaker evidence elsewhere.",
    grid: { threshold: [5, 10, 15], maxBars: [3, 5, 10], atrMult: [2, 3] },
    prepare(bars, p) {
      const c = closes(bars), r = ta.rsi(c, 2), trend = ta.sma(c, 200), exitMa = ta.sma(c, 5), a = atr(bars, 20);
      return {
        entry(i) {
          if (trend[i] == null || r[i] == null || a[i] == null) return null;
          const stopDist = p.atrMult * a[i];
          if (c[i] > trend[i] && r[i] < p.threshold) return { side: 1, stopDist, maxBars: p.maxBars };
          if (c[i] < trend[i] && r[i] > 100 - p.threshold) return { side: -1, stopDist, maxBars: p.maxBars };
          return null;
        },
        exit: (j, side) => exitMa[j] != null && (side > 0 ? c[j] > exitMa[j] : c[j] < exitMa[j]),
      };
    },
  },
  sessionBreakout: {
    name: "London open breakout",
    rationale: "Liquidity and information arrive at the London open; a break of the quiet Asian-session range can carry. " +
      "Popular with prop traders, so it is also a fingerprint to look for. Intraday bars only; flat by 16:00 UTC.",
    intradayOnly: true,
    grid: { rangeEnd: [6, 7, 8], rr: [1, 1.5, 2], stopFrac: [0.5, 1] },
    prepare(bars, p) {
      // range of the current UTC day from 00:00 to rangeEnd, known only once rangeEnd has passed
      const rangeHi = new Array(bars.length).fill(null), rangeLo = new Array(bars.length).fill(null), traded = new Set();
      let day = null, hi = -Infinity, lo = Infinity;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i], d = Math.floor(b.time / 86400), hr = utcHour(b.time);
        if (d !== day) { day = d; hi = -Infinity; lo = Infinity; }
        if (hr < p.rangeEnd) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); }
        else if (hi > lo) { rangeHi[i] = hi; rangeLo[i] = lo; }
      }
      return {
        entry(i) {
          const b = bars[i], hr = utcHour(b.time), d = Math.floor(b.time / 86400);
          if (rangeHi[i] == null || hr >= 12 || traded.has(d)) return null;
          const width = rangeHi[i] - rangeLo[i], stopDist = p.stopFrac * width;
          if (b.close > rangeHi[i]) { traded.add(d); return { side: 1, stopDist, targetDist: p.rr * stopDist }; }
          if (b.close < rangeLo[i]) { traded.add(d); return { side: -1, stopDist, targetDist: p.rr * stopDist }; }
          return null;
        },
        exit: (j) => utcHour(bars[j].time + 3600) >= 16,
      };
    },
  },
};

// Every parameter combination in a family's grid (the family's whole trial count).
export function gridOf(family) {
  const keys = Object.keys(family.grid);
  let combos = [{}];
  for (const k of keys) combos = combos.flatMap((c) => family.grid[k].map((v) => ({ ...c, [k]: v })));
  return family.valid ? combos.filter(family.valid) : combos;
}
