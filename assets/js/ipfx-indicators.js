// IPFX Markets — native indicators for the IPFX chart.
//
// Each indicator is a plain definition: inputs (with defaults), plots, optional
// horizontal levels, and a pure calc(bars, inputs) that returns one array per
// plot, aligned to `bars` (null during warm-up). The chart module renders them;
// nothing here touches the DOM, so every calculation is unit-testable in Node
// (tests/ipfx-indicators.test.mjs).
//
// Keys are TradingView study ids so the same selection also drives the classic
// TradingView chart. Maths follows TradingView's built-ins (Pine ta.* semantics):
// RMA = Wilder smoothing seeded with an SMA, EMA seeded with an SMA, population
// standard deviation, etc. When adding one, match TradingView's default inputs
// and check a few values against a TradingView chart.
//
// bars: [{time, open, high, low, close, volume}]
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- ta helpers
  const src = (bars, key) => bars.map((b) => {
    switch (key) {
      case "open": return b.open;
      case "high": return b.high;
      case "low": return b.low;
      case "hl2": return (b.high + b.low) / 2;
      case "hlc3": return (b.high + b.low + b.close) / 3;
      case "ohlc4": return (b.open + b.high + b.low + b.close) / 4;
      default: return b.close;
    }
  });
  const nz = (v) => (v == null || !isFinite(v) ? null : v);

  function sma(x, n) {
    const out = new Array(x.length).fill(null);
    let sum = 0, count = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (v == null) { sum = 0; count = 0; continue; }
      sum += v; count++;
      if (count > n) { sum -= x[i - n]; count = n; }
      if (count === n) out[i] = sum / n;
    }
    return out;
  }
  // EMA seeded with the SMA of the first n values (as ta.ema).
  function ema(x, n) {
    const out = new Array(x.length).fill(null);
    const a = 2 / (n + 1);
    let prev = null, seed = 0, seen = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (v == null) continue;
      if (prev == null) {
        seed += v; seen++;
        if (seen === n) { prev = seed / n; out[i] = prev; }
        continue;
      }
      prev = a * v + (1 - a) * prev;
      out[i] = prev;
    }
    return out;
  }
  // Wilder's moving average (ta.rma): alpha = 1/n, seeded with an SMA.
  function rma(x, n) {
    const out = new Array(x.length).fill(null);
    let prev = null, seed = 0, seen = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (v == null) continue;
      if (prev == null) {
        seed += v; seen++;
        if (seen === n) { prev = seed / n; out[i] = prev; }
        continue;
      }
      prev = (prev * (n - 1) + v) / n;
      out[i] = prev;
    }
    return out;
  }
  function wma(x, n) {
    const out = new Array(x.length).fill(null);
    const denom = (n * (n + 1)) / 2;
    for (let i = n - 1; i < x.length; i++) {
      let s = 0, ok = true;
      for (let k = 0; k < n; k++) { const v = x[i - k]; if (v == null) { ok = false; break; } s += v * (n - k); }
      if (ok) out[i] = s / denom;
    }
    return out;
  }
  // Population standard deviation over n (ta.stdev default).
  function stdev(x, n) {
    const mean = sma(x, n);
    return x.map((_, i) => {
      if (mean[i] == null) return null;
      let s = 0;
      for (let k = 0; k < n; k++) { const d = x[i - k] - mean[i]; s += d * d; }
      return Math.sqrt(s / n);
    });
  }
  // Rolling extremes; null if any value in the window is null (Pine na semantics).
  function highest(x, n) {
    return x.map((_, i) => {
      if (i < n - 1) return null;
      let m = -Infinity;
      for (let k = 0; k < n; k++) { const v = x[i - k]; if (v == null) return null; if (v > m) m = v; }
      return m;
    });
  }
  function lowest(x, n) {
    return x.map((_, i) => {
      if (i < n - 1) return null;
      let m = Infinity;
      for (let k = 0; k < n; k++) { const v = x[i - k]; if (v == null) return null; if (v < m) m = v; }
      return m;
    });
  }
  function trueRange(bars) {
    return bars.map((b, i) => (i === 0 ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
  }
  function change(x) { return x.map((v, i) => (i === 0 || v == null || x[i - 1] == null ? null : v - x[i - 1])); }
  const sub = (a, b) => a.map((v, i) => (v == null || b[i] == null ? null : v - b[i]));
  // Mean absolute deviation around the SMA (ta.dev).
  function dev(x, n) {
    const mean = sma(x, n);
    return x.map((_, i) => {
      if (mean[i] == null) return null;
      let s = 0;
      for (let k = 0; k < n; k++) s += Math.abs(x[i - k] - mean[i]);
      return s / n;
    });
  }

  // Rolling sum over n values; null if the window has a null.
  function sum(x, n) {
    return x.map((_, i) => {
      if (i < n - 1) return null;
      let s = 0;
      for (let k = 0; k < n; k++) { const v = x[i - k]; if (v == null) return null; s += v; }
      return s;
    });
  }
  // Running total (ta.cum); nulls count as 0.
  function cum(x) { let t = 0; return x.map((v) => (t += v == null ? 0 : v)); }
  // The value k bars ago.
  function back(x, k) { return x.map((_, i) => (i - k < 0 ? null : x[i - k])); }
  const map2 = (a, b, f) => a.map((v, i) => (v == null || b[i] == null ? null : f(v, b[i], i)));
  const map1 = (a, f) => a.map((v, i) => (v == null ? null : f(v, i)));
  function rsi(x, n) {
    const ch = change(x);
    const up = rma(ch.map((v) => (v == null ? null : Math.max(v, 0))), n);
    const dn = rma(ch.map((v) => (v == null ? null : Math.max(-v, 0))), n);
    return up.map((u, i) => (u == null || dn[i] == null ? null : dn[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / dn[i])));
  }
  // Least-squares line over the last n values, evaluated at the newest bar minus `offset` (ta.linreg).
  function linreg(x, n, offset = 0) {
    const out = new Array(x.length).fill(null);
    const sx = (n * (n - 1)) / 2, sxx = ((n - 1) * n * (2 * n - 1)) / 6;
    for (let i = n - 1; i < x.length; i++) {
      let sy = 0, sxy = 0, ok = true;
      for (let k = 0; k < n; k++) { const v = x[i - n + 1 + k]; if (v == null) { ok = false; break; } sy += v; sxy += k * v; }
      if (!ok) continue;
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), icpt = (sy - slope * sx) / n;
      out[i] = icpt + slope * (n - 1 - offset);
    }
    return out;
  }
  // Pearson correlation of x with a second series over n values (ta.correlation).
  function correlation(x, y, n) {
    return x.map((_, i) => {
      if (i < n - 1) return null;
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let k = 0; k < n; k++) {
        const a = x[i - k], b = y[i - k];
        if (a == null || b == null) return null;
        sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
      }
      const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
      return den === 0 ? null : (n * sxy - sx * sy) / den;
    });
  }
  function median(x, n) {
    return x.map((_, i) => {
      if (i < n - 1) return null;
      const w = [];
      for (let k = 0; k < n; k++) { const v = x[i - k]; if (v == null) return null; w.push(v); }
      w.sort((a, b) => a - b);
      return n % 2 ? w[(n - 1) / 2] : (w[n / 2 - 1] + w[n / 2]) / 2;
    });
  }
  // A moving average chosen by name (for indicators with an "MA type" input).
  function ma(type, x, n) {
    if (type === "ema") return ema(x, n);
    if (type === "wma") return wma(x, n);
    if (type === "rma") return rma(x, n);
    return sma(x, n);
  }
  // Seconds between bars (median gap), for indicators that depend on the timeframe.
  function barSeconds(bars) {
    if (bars.length < 2) return 3600;
    const gaps = [];
    for (let i = 1; i < Math.min(bars.length, 200); i++) gaps.push(bars[i].time - bars[i - 1].time);
    gaps.sort((a, b) => a - b);
    return gaps[gaps.length >> 1] || 3600;
  }

  const ta = { src, nz, sma, ema, rma, wma, stdev, highest, lowest, trueRange, change, sub, dev,
    sum, cum, back, map1, map2, rsi, linreg, correlation, median, ma, barSeconds };

  // ---------------------------------------------------------------- definitions
  // input types: "int" | "float" | "source" (close/open/high/low/hl2/hlc3/ohlc4) | "select" (options: [...])
  // plot types:  "line" | "histogram" | "dots" (markers only, e.g. SAR, fractals)
  //   histogram colours: `out.colors[plotKey]` per bar if the calc gives it, else up/down by sign,
  //   else the plot's fixed `color`.
  // plot options: width, dashed, shift (bars into the future; negative = back), breakOnChange
  //   (a gap whenever the value changes — pivot levels), scale: "volume" (own scale at the bottom of
  //   the price pane).
  // meta (for the Indicators list): cat (trend|volatility|momentum|volume|structure), full, color, brief, explain
  // repaint: true when earlier values can change as new bars arrive (zig-zag, swing points)
  // pane:        "overlay" (on price) | "separate" (own pane below)
  // priceUnits:  values are in price units (MACD, ATR) → shown with the instrument's decimals
  // range:       fixed [min, max] for the pane (RSI 0–100); precision: decimals otherwise (default 2)
  const SOURCE = { key: "source", label: "Source", type: "source", default: "close" };
  const len = (d, label = "Length") => ({ key: "length", label, type: "int", default: d, min: 1, max: 1000 });

  const defs = {
    "MASimple@tv-basicstudies": {
      name: "SMA", pane: "overlay",
      inputs: [len(9), SOURCE],
      plots: [{ key: "ma", label: "SMA", type: "line", color: "#f59e0b" }],
      calc: (bars, p) => ({ ma: sma(src(bars, p.source), p.length) }),
    },
    "MAExp@tv-basicstudies": {
      name: "EMA", pane: "overlay",
      inputs: [len(9), SOURCE],
      plots: [{ key: "ma", label: "EMA", type: "line", color: "#3b82f6" }],
      calc: (bars, p) => ({ ma: ema(src(bars, p.source), p.length) }),
    },
    "BB@tv-basicstudies": {
      name: "Bollinger Bands", short: "BB", pane: "overlay",
      inputs: [len(20), SOURCE, { key: "mult", label: "StdDev", type: "float", default: 2, min: 0.1, max: 10, step: 0.1 }],
      plots: [
        { key: "basis", label: "Basis", type: "line", color: "#f59e0b" },
        { key: "upper", label: "Upper", type: "line", color: "#2962ff" },
        { key: "lower", label: "Lower", type: "line", color: "#2962ff" },
      ],
      calc: (bars, p) => {
        const x = src(bars, p.source), basis = sma(x, p.length), sd = stdev(x, p.length);
        return {
          basis,
          upper: basis.map((b, i) => (b == null ? null : b + p.mult * sd[i])),
          lower: basis.map((b, i) => (b == null ? null : b - p.mult * sd[i])),
        };
      },
    },
    "RSI@tv-basicstudies": {
      name: "RSI", pane: "separate", range: [0, 100],
      inputs: [len(14), SOURCE],
      plots: [{ key: "rsi", label: "RSI", type: "line", color: "#7e57c2" }],
      levels: [{ value: 70, label: "Overbought" }, { value: 50, label: "Middle" }, { value: 30, label: "Oversold" }],
      calc: (bars, p) => ({ rsi: rsi(src(bars, p.source), p.length) }),
    },
    "MACD@tv-basicstudies": {
      name: "MACD", pane: "separate", priceUnits: true,
      inputs: [
        { key: "fast", label: "Fast length", type: "int", default: 12, min: 1, max: 500 },
        { key: "slow", label: "Slow length", type: "int", default: 26, min: 1, max: 500 },
        SOURCE,
        { key: "signal", label: "Signal smoothing", type: "int", default: 9, min: 1, max: 100 },
      ],
      plots: [
        { key: "hist", label: "Histogram", type: "histogram", upColor: "#26a69a", downColor: "#ef5350" },
        { key: "macd", label: "MACD", type: "line", color: "#2962ff" },
        { key: "signal", label: "Signal", type: "line", color: "#ff6d00" },
      ],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const x = src(bars, p.source);
        const macd = sub(ema(x, p.fast), ema(x, p.slow));
        const signal = ema(macd, p.signal);
        return { macd, signal, hist: sub(macd, signal) };
      },
    },
    "Stochastic@tv-basicstudies": {
      name: "Stochastic", short: "Stoch", pane: "separate", range: [0, 100],
      inputs: [
        { key: "k", label: "%K length", type: "int", default: 14, min: 1, max: 500 },
        { key: "kSmooth", label: "%K smoothing", type: "int", default: 1, min: 1, max: 100 },
        { key: "d", label: "%D smoothing", type: "int", default: 3, min: 1, max: 100 },
      ],
      plots: [
        { key: "k", label: "%K", type: "line", color: "#2962ff" },
        { key: "d", label: "%D", type: "line", color: "#ff6d00" },
      ],
      levels: [{ value: 80 }, { value: 20 }],
      calc: (bars, p) => {
        const hh = highest(bars.map((b) => b.high), p.k), ll = lowest(bars.map((b) => b.low), p.k);
        const raw = bars.map((b, i) => (hh[i] == null ? null : hh[i] === ll[i] ? 0 : (100 * (b.close - ll[i])) / (hh[i] - ll[i])));
        const k = sma(raw, p.kSmooth);
        return { k, d: sma(k, p.d) };
      },
    },
    "ATR@tv-basicstudies": {
      name: "ATR", pane: "separate", priceUnits: true,
      inputs: [len(14)],
      plots: [{ key: "atr", label: "ATR", type: "line", color: "#b71c1c" }],
      calc: (bars, p) => ({ atr: rma(trueRange(bars), p.length) }),
    },
    "CCI@tv-basicstudies": {
      name: "CCI", pane: "separate",
      inputs: [len(20), { ...SOURCE, default: "hlc3" }],
      plots: [{ key: "cci", label: "CCI", type: "line", color: "#2962ff" }],
      levels: [{ value: 100 }, { value: 0 }, { value: -100 }],
      calc: (bars, p) => {
        const x = src(bars, p.source), m = sma(x, p.length), d = dev(x, p.length);
        return { cci: x.map((v, i) => (m[i] == null ? null : d[i] === 0 ? 0 : (v - m[i]) / (0.015 * d[i]))) };
      },
    },
  };

  function defaults(id) {
    const d = defs[id];
    if (!d) return {};
    return Object.fromEntries(d.inputs.map((i) => [i.key, i.default]));
  }
  // Clamp/typing for values typed by a trader.
  function cleanInputs(id, values) {
    const d = defs[id], out = defaults(id);
    if (!d) return out;
    for (const i of d.inputs) {
      const v = values ? values[i.key] : undefined;
      if (v === undefined || v === null || v === "") continue;
      if (i.type === "source") { if (["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"].includes(v)) out[i.key] = v; continue; }
      if (i.type === "select") { if (i.options.includes(v)) out[i.key] = v; continue; }
      let n = Number(v);
      if (!isFinite(n)) continue;
      if (i.type === "int") n = Math.round(n);
      if (i.min != null) n = Math.max(i.min, n);
      if (i.max != null) n = Math.min(i.max, n);
      out[i.key] = n;
    }
    return out;
  }
  // "EMA 20" / "BB 20 2" — the inputs a trader changes most, for legends.
  function label(id, values) {
    const d = defs[id];
    if (!d) return id;
    const shown = d.inputs.filter((i) => i.type !== "source").map((i) => values[i.key]);
    return (d.short || d.name) + (shown.length ? " " + shown.join(" ") : "");
  }

  // Family files call register() to add their definitions.
  function register(map) {
    for (const [id, d] of Object.entries(map)) {
      if (defs[id]) throw new Error("duplicate indicator id " + id);
      defs[id] = d;
    }
  }
  // Entries for the Indicators list, from definitions that carry meta (the original
  // hand-written catalog entries stay in trading.html).
  function catalog() {
    return Object.entries(defs).filter(([, d]) => d.meta).map(([id, d]) => ({
      id, name: d.name, cat: d.meta.cat, full: d.meta.full || d.name, color: d.meta.color,
      brief: d.meta.brief, explain: d.meta.explain,
    }));
  }

  const api = { defs, ta, defaults, cleanInputs, label, register, catalog, SOURCE, len };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.IPFX_INDICATORS = api;
})(typeof window !== "undefined" ? window : globalThis);
