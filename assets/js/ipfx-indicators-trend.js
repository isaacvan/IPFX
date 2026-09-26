// IPFX Markets indicators — trend family: moving averages, trailing stops, clouds.
// Registers into IPFX_INDICATORS (see ipfx-indicators.js for the definition format).
(function (root) {
  "use strict";
  const IND = typeof module !== "undefined" && module.exports ? require("./ipfx-indicators.js") : root.IPFX_INDICATORS;
  const { ta, SOURCE, len } = IND;
  const { src, sma, ema, rma, wma, highest, lowest, trueRange, linreg, median, ma, map2, map1 } = ta;

  const flt = (key, label, d, min, max, step) => ({ key, label, type: "float", default: d, min, max, step });
  const int = (key, label, d, min = 1, max = 500) => ({ key, label, type: "int", default: d, min, max });
  const MA_TYPE = { key: "type", label: "MA type", type: "select", options: ["sma", "ema", "wma"], default: "sma" };
  const line = (key, label, color, extra) => ({ key, label, type: "line", color, ...extra });

  // Day/week/month bucket for anchored indicators (UTC; weeks start Monday).
  function bucket(time, anchor) {
    const day = Math.floor(time / 86400);
    if (anchor === "week") return Math.floor((day + 3) / 7);
    if (anchor === "month") { const d = new Date(time * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }
    return day;
  }

  // Parabolic SAR exactly as Pine's ta.sar.
  function sar(bars, start, inc, max) {
    const out = new Array(bars.length).fill(null), below = new Array(bars.length).fill(false);
    let result = null, maxMin = null, accel = null, isBelow = false;
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], p1 = bars[i - 1], p2 = i > 1 ? bars[i - 2] : null;
      let first = false;
      if (i === 1) {
        if (b.close > p1.close) { isBelow = true; maxMin = b.high; result = p1.low; }
        else { isBelow = false; maxMin = b.low; result = p1.high; }
        first = true; accel = start;
      }
      result = result + accel * (maxMin - result);
      if (isBelow) {
        if (result > b.low) { first = true; isBelow = false; result = Math.max(b.high, maxMin); maxMin = b.low; accel = start; }
      } else if (result < b.high) { first = true; isBelow = true; result = Math.min(b.low, maxMin); maxMin = b.high; accel = start; }
      if (!first) {
        if (isBelow) { if (b.high > maxMin) { maxMin = b.high; accel = Math.min(accel + inc, max); } }
        else if (b.low < maxMin) { maxMin = b.low; accel = Math.min(accel + inc, max); }
      }
      if (isBelow) { result = Math.min(result, p1.low); if (p2) result = Math.min(result, p2.low); }
      else { result = Math.max(result, p1.high); if (p2) result = Math.max(result, p2.high); }
      out[i] = result; below[i] = isBelow;
    }
    return { out, below };
  }

  const RIBBON_COLORS = ["#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#22d3ee", "#60a5fa", "#a78bfa"];

  IND.register({
    "MAWeighted@tv-basicstudies": {
      name: "WMA", pane: "overlay",
      meta: { cat: "trend", full: "Weighted Moving Average", color: "#f97316", brief: "Average that counts recent candles more",
        explain: "Like a simple average, but each candle is weighted by how recent it is, so the newest candle counts most. It follows price more closely than the SMA without the extra wobble of a very fast EMA." },
      inputs: [len(9), SOURCE],
      plots: [line("ma", "WMA", "#f97316")],
      calc: (bars, p) => ({ ma: wma(src(bars, p.source), p.length) }),
    },
    "DoubleEMA@tv-basicstudies": {
      name: "DEMA", pane: "overlay",
      inputs: [len(9), SOURCE],
      plots: [line("ma", "DEMA", "#22d3ee")],
      calc: (bars, p) => {
        const e1 = ema(src(bars, p.source), p.length), e2 = ema(e1, p.length);
        return { ma: map2(e1, e2, (a, b) => 2 * a - b) };
      },
    },
    "TripleEMA@tv-basicstudies": {
      name: "TEMA", pane: "overlay",
      meta: { cat: "trend", full: "Triple Exponential Moving Average", color: "#06b6d4", brief: "Very fast average with little lag",
        explain: "Combines three EMAs to cancel most of the lag an EMA normally has. It hugs price tightly, so it turns early — useful for quick trend changes, but it also reacts to small pullbacks." },
      inputs: [len(9), SOURCE],
      plots: [line("ma", "TEMA", "#06b6d4")],
      calc: (bars, p) => {
        const e1 = ema(src(bars, p.source), p.length), e2 = ema(e1, p.length), e3 = ema(e2, p.length);
        return { ma: e1.map((a, i) => (a == null || e2[i] == null || e3[i] == null ? null : 3 * (a - e2[i]) + e3[i])) };
      },
    },
    "MAVolumeWeighted@tv-basicstudies": {
      name: "VWMA", pane: "overlay",
      meta: { cat: "trend", full: "Volume Weighted Moving Average", color: "#eab308", brief: "Average that counts heavy-volume candles more",
        explain: "An average where candles with more volume count for more. Where a market has no real volume (most forex pairs) it behaves exactly like a simple average, so it is most useful on crypto, indices and futures." },
      inputs: [len(20), SOURCE],
      plots: [line("ma", "VWMA", "#eab308")],
      calc: (bars, p) => {
        const x = src(bars, p.source), vol = bars.map((b) => b.volume || 0);
        const pv = sma(x.map((v, i) => v * vol[i]), p.length), v = sma(vol, p.length), plain = sma(x, p.length);
        return { ma: pv.map((a, i) => (a == null ? null : v[i] > 0 ? a / v[i] : plain[i])) };
      },
    },
    "SMMA@tv-basicstudies": {
      name: "SMMA", pane: "overlay",
      meta: { cat: "trend", full: "Smoothed Moving Average", color: "#a78bfa", brief: "Slow, smooth average (Wilder's method)",
        explain: "A very smooth moving average that reacts slowly, the same smoothing RSI and ATR use internally. Good for seeing the underlying trend and ignoring noise." },
      inputs: [len(7), SOURCE],
      plots: [line("ma", "SMMA", "#a78bfa")],
      calc: (bars, p) => ({ ma: rma(src(bars, p.source), p.length) }),
    },
    "LinearRegression@tv-basicstudies": {
      name: "LSMA", pane: "overlay",
      meta: { cat: "trend", full: "Least Squares Moving Average", color: "#14b8a6", brief: "Best-fit line's end point",
        explain: "Fits a straight line through the last N candles and plots where that line ends now. It has less lag than an average and shows the direction and steepness of the recent trend." },
      inputs: [len(25), int("offset", "Offset", 0, -100, 100), SOURCE],
      plots: [line("ma", "LSMA", "#14b8a6")],
      calc: (bars, p) => ({ ma: linreg(src(bars, p.source), p.length, p.offset) }),
    },
    "ALMA@tv-basicstudies": {
      name: "ALMA", pane: "overlay",
      meta: { cat: "trend", full: "Arnaud Legoux Moving Average", color: "#ec4899", brief: "Smooth average with almost no lag",
        explain: "Uses a bell-shaped weighting shifted towards recent candles. That gives a smooth line that still follows price closely. Offset moves the bell towards new (high) or old (low) candles; sigma sets how sharp it is." },
      inputs: [len(9, "Window size"), flt("offset", "Offset", 0.85, 0, 1, 0.05), flt("sigma", "Sigma", 6, 0.1, 50, 0.5), SOURCE],
      plots: [line("ma", "ALMA", "#ec4899")],
      calc: (bars, p) => {
        const x = src(bars, p.source), n = p.length, m = Math.floor(p.offset * (n - 1)), s = n / p.sigma;
        const w = []; let norm = 0;
        for (let j = 0; j < n; j++) { const v = Math.exp(-((j - m) ** 2) / (2 * s * s)); w.push(v); norm += v; }
        return { ma: x.map((_, i) => {
          if (i < n - 1) return null;
          let t = 0;
          for (let j = 0; j < n; j++) { const v = x[i - (n - 1) + j]; if (v == null) return null; t += v * w[j]; }
          return t / norm;
        }) };
      },
    },
    "McGinleyDynamic@tv-basicstudies": {
      name: "McGinley", pane: "overlay",
      meta: { cat: "trend", full: "McGinley Dynamic", color: "#f472b6", brief: "Average that adjusts its own speed",
        explain: "A moving average that speeds up when price runs away from it and slows down when price is quiet, so it avoids much of the whipsawing a normal average has." },
      inputs: [len(14), SOURCE],
      plots: [line("ma", "McGinley", "#f472b6")],
      calc: (bars, p) => {
        const x = src(bars, p.source), e = ema(x, p.length), out = new Array(x.length).fill(null);
        for (let i = 0; i < x.length; i++) {
          if (e[i] == null) continue;
          const prev = out[i - 1];
          out[i] = prev == null ? e[i] : prev + (x[i] - prev) / (p.length * Math.pow(x[i] / prev, 4));
        }
        return { ma: out };
      },
    },
    "MACross@tv-basicstudies": {
      name: "MA Cross", pane: "overlay",
      meta: { cat: "trend", full: "Moving Average Cross", color: "#3b82f6", brief: "Two averages and where they cross",
        explain: "Plots a fast and a slow moving average and marks each crossing with a dot. A fast line crossing above the slow one suggests the trend turned up; below suggests it turned down." },
      inputs: [int("short", "Short length", 9), int("long", "Long length", 21), MA_TYPE, SOURCE],
      plots: [line("short", "Short", "#3b82f6"), line("long", "Long", "#f59e0b"), { key: "cross", label: "Cross", type: "dots", color: "#e5e7eb" }],
      calc: (bars, p) => {
        const x = src(bars, p.source), a = ma(p.type, x, p.short), b = ma(p.type, x, p.long);
        const cross = a.map((v, i) => {
          if (i === 0 || v == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) return null;
          const now = v - b[i], before = a[i - 1] - b[i - 1];
          return (now > 0) !== (before > 0) && now !== 0 ? (v + b[i]) / 2 : null;
        });
        return { short: a, long: b, cross };
      },
    },
    "MARibbon@tv-basicstudies": {
      name: "MA Ribbon", pane: "overlay",
      meta: { cat: "trend", full: "Moving Average Ribbon", color: "#34d399", brief: "Eight averages fanned out like a ribbon",
        explain: "Eight moving averages of increasing length. When they fan out in order the trend is strong; when they twist together and cross the market is ranging or turning." },
      inputs: [int("start", "First length", 20), int("step", "Step", 5), { ...MA_TYPE, default: "ema" }, SOURCE],
      plots: RIBBON_COLORS.map((c, k) => line("ma" + k, "MA " + (k + 1), c, { width: 1 })),
      calc: (bars, p) => {
        const x = src(bars, p.source), out = {};
        for (let k = 0; k < 8; k++) out["ma" + k] = ma(p.type, x, p.start + k * p.step);
        return out;
      },
    },
    "Median@tv-basicstudies": {
      name: "Median", pane: "overlay",
      meta: { cat: "trend", full: "Median with ATR bands", color: "#818cf8", brief: "Median price with volatility bands",
        explain: "The middle value of the last few candles (ignoring spikes) with bands one or two ATRs either side. Price outside the band is stretched." },
      inputs: [len(3, "Median length"), int("atrLength", "ATR length", 14), flt("mult", "ATR multiplier", 2, 0.1, 20, 0.1)],
      plots: [line("median", "Median", "#818cf8"), line("upper", "Upper", "#a5b4fc", { width: 1 }), line("lower", "Lower", "#a5b4fc", { width: 1 })],
      calc: (bars, p) => {
        const m = median(src(bars, "hl2"), p.length), atr = rma(trueRange(bars), p.atrLength);
        return { median: m, upper: map2(m, atr, (a, b) => a + p.mult * b), lower: map2(m, atr, (a, b) => a - p.mult * b) };
      },
    },
    "hullMA@tv-basicstudies": {
      name: "Hull MA", short: "HMA", pane: "overlay",
      inputs: [len(9), SOURCE],
      plots: [line("ma", "HMA", "#a855f7")],
      calc: (bars, p) => {
        const x = src(bars, p.source), half = wma(x, Math.max(1, Math.floor(p.length / 2))), full = wma(x, p.length);
        return { ma: wma(map2(half, full, (a, b) => 2 * a - b), Math.max(1, Math.floor(Math.sqrt(p.length)))) };
      },
    },
    "PSAR@tv-basicstudies": {
      name: "Parabolic SAR", short: "SAR", pane: "overlay",
      inputs: [flt("start", "Start", 0.02, 0.001, 1, 0.01), flt("inc", "Increment", 0.02, 0.001, 1, 0.01), flt("max", "Maximum", 0.2, 0.01, 1, 0.01)],
      plots: [{ key: "up", label: "SAR (uptrend)", type: "dots", color: "#10b981" }, { key: "down", label: "SAR (downtrend)", type: "dots", color: "#ef4444" }],
      calc: (bars, p) => {
        const { out, below } = sar(bars, p.start, p.inc, p.max);
        return { up: out.map((v, i) => (v != null && below[i] ? v : null)), down: out.map((v, i) => (v != null && !below[i] ? v : null)) };
      },
    },
    "Supertrend@tv-basicstudies": {
      name: "Supertrend", pane: "overlay",
      meta: { cat: "trend", full: "Supertrend", color: "#22c55e", brief: "Trailing trend line that flips green/red",
        explain: "A line that sits below price in an uptrend (green) and above it in a downtrend (red), trailing at a multiple of ATR. When price closes through it the line flips sides. Traders use the line as a trailing stop and the flip as a trend-change signal." },
      inputs: [int("atrLength", "ATR length", 10), flt("factor", "Factor", 3, 0.1, 50, 0.1)],
      plots: [line("up", "Up trend", "#22c55e"), line("down", "Down trend", "#ef4444")],
      calc: (bars, p) => {
        const atr = rma(trueRange(bars), p.atrLength), n = bars.length;
        const upper = new Array(n).fill(null), lower = new Array(n).fill(null), st = new Array(n).fill(null), dir = new Array(n).fill(null);
        for (let i = 0; i < n; i++) {
          if (atr[i] == null) continue;
          const mid = (bars[i].high + bars[i].low) / 2;
          let ub = mid + p.factor * atr[i], lb = mid - p.factor * atr[i];
          const pl = lower[i - 1], pu = upper[i - 1], pc = i > 0 ? bars[i - 1].close : null;
          if (pl != null) lb = lb > pl || pc < pl ? lb : pl;
          if (pu != null) ub = ub < pu || pc > pu ? ub : pu;
          let d;
          if (st[i - 1] == null) d = 1;
          else if (st[i - 1] === pu) d = bars[i].close > ub ? -1 : 1;
          else d = bars[i].close < lb ? 1 : -1;
          upper[i] = ub; lower[i] = lb; dir[i] = d; st[i] = d === -1 ? lb : ub;
        }
        return { up: st.map((v, i) => (dir[i] === -1 ? v : null)), down: st.map((v, i) => (dir[i] === 1 ? v : null)) };
      },
    },
    "VolatilityStop@tv-basicstudies": {
      name: "Volatility Stop", short: "VStop", pane: "overlay",
      meta: { cat: "trend", full: "Volatility Stop", color: "#f43f5e", brief: "ATR trailing stop that flips with the trend",
        explain: "A trailing stop that follows price at a distance set by recent volatility. It only ever moves in the direction of the trade, and flips to the other side when price closes through it." },
      inputs: [len(20), SOURCE, flt("mult", "ATR multiplier", 2, 0.1, 50, 0.1)],
      plots: [line("up", "Uptrend stop", "#10b981"), line("down", "Downtrend stop", "#ef4444")],
      calc: (bars, p) => {
        const x = src(bars, p.source), tr = trueRange(bars), atr = rma(tr, p.length), n = bars.length;
        const stops = new Array(n).fill(null), ups = new Array(n).fill(false);
        let max = x[0], min = x[0], stop = 0, up = true;
        for (let i = 0; i < n; i++) {
          const atrM = atr[i] != null ? atr[i] * p.mult : tr[i];
          max = Math.max(max, x[i]); min = Math.min(min, x[i]);
          stop = up ? Math.max(stop, max - atrM) : Math.min(stop, min + atrM);
          const prevUp = up;
          up = x[i] - stop >= 0;
          if (up !== prevUp) { max = x[i]; min = x[i]; stop = up ? x[i] - atrM : x[i] + atrM; }
          stops[i] = stop; ups[i] = up;
        }
        return { up: stops.map((v, i) => (ups[i] ? v : null)), down: stops.map((v, i) => (!ups[i] ? v : null)) };
      },
    },
    "IchimokuCloud@tv-basicstudies": {
      name: "Ichimoku", pane: "overlay",
      inputs: [int("conversion", "Conversion line", 9), int("base", "Base line", 26), int("spanB", "Leading span B", 52), int("displacement", "Lagging span", 26)],
      plots: [
        line("tenkan", "Conversion", "#2962ff", { width: 1 }),
        line("kijun", "Base", "#b71c1c", { width: 1 }),
        line("chikou", "Lagging", "#43a047", { width: 1, shiftInput: "displacement", shiftSign: -1 }),
        line("spanA", "Leading A", "#a5d6a7", { width: 1, shiftInput: "displacement", shiftSign: 1 }),
        line("spanB", "Leading B", "#ef9a9a", { width: 1, shiftInput: "displacement", shiftSign: 1 }),
      ],
      calc: (bars, p) => {
        const H = bars.map((b) => b.high), L = bars.map((b) => b.low);
        const dc = (n) => map2(highest(H, n), lowest(L, n), (a, b) => (a + b) / 2);
        const tenkan = dc(p.conversion), kijun = dc(p.base);
        return { tenkan, kijun, chikou: bars.map((b) => b.close), spanA: map2(tenkan, kijun, (a, b) => (a + b) / 2), spanB: dc(p.spanB) };
      },
    },
    "VWAP@tv-basicstudies": {
      name: "VWAP", pane: "overlay",
      inputs: [{ key: "anchor", label: "Anchor", type: "select", options: ["day", "week", "month"], default: "day" }, { ...SOURCE, default: "hlc3" }],
      plots: [line("vwap", "VWAP", "#2962ff")],
      calc: (bars, p) => {
        const x = src(bars, p.source), hasVol = bars.some((b) => b.volume > 0);
        // Above daily bars a one-day anchor is meaningless, so anchor monthly there.
        const anchor = ta.barSeconds(bars) >= 86400 && p.anchor === "day" ? "month" : p.anchor;
        let key = null, spv = 0, sv = 0;
        return { vwap: bars.map((b, i) => {
          const k = bucket(b.time, anchor);
          if (k !== key) { key = k; spv = 0; sv = 0; }
          // Forex has no real volume: weight every bar equally rather than draw nothing.
          const w = hasVol ? b.volume || 0 : 1;
          spv += x[i] * w; sv += w;
          return sv > 0 ? spv / sv : null;
        }) };
      },
    },
    "WilliamsAlligator@tv-basicstudies": {
      name: "Alligator", pane: "overlay",
      meta: { cat: "trend", full: "Williams Alligator", color: "#4caf50", brief: "Three shifted averages: jaw, teeth, lips",
        explain: "Three smoothed averages (blue jaw, red teeth, green lips) drawn ahead of price. When they are tangled the 'alligator sleeps' and the market is ranging; when they fan apart in order it is 'feeding' on a trend." },
      inputs: [int("jaw", "Jaw length", 13), int("teeth", "Teeth length", 8), int("lips", "Lips length", 5)],
      plots: [line("jaw", "Jaw", "#2196f3", { shift: 8 }), line("teeth", "Teeth", "#f23645", { shift: 5 }), line("lips", "Lips", "#4caf50", { shift: 3 })],
      calc: (bars, p) => {
        const x = src(bars, "hl2");
        return { jaw: rma(x, p.jaw), teeth: rma(x, p.teeth), lips: rma(x, p.lips) };
      },
    },
  });
})(typeof window !== "undefined" ? window : globalThis);
