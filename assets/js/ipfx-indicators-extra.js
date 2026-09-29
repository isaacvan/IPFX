// IPFX Markets indicators — more TradingView built-ins and the community indicators traders ask for
// most: Squeeze Momentum, WaveTrend, UT Bot, Range Filter, Nadaraya-Watson, HalfTrend, Schaff Trend
// Cycle, SSL Channel, Trend Magic, previous-period levels, central pivot range, Guppy, Gator,
// Accelerator, Elder Impulse, regression and error bands, and a few price series.
// Needs ipfx-indicators.js loaded first; all maths is causal (nothing looks ahead).
(function (root) {
  "use strict";
  const IND = typeof module !== "undefined" && module.exports ? require("./ipfx-indicators.js") : root.IPFX_INDICATORS;
  const { ta, SOURCE, len } = IND;
  const { src, sma, ema, rma, wma, stdev, highest, lowest, trueRange, sum, map1, map2, back } = ta;

  const flt = (key, label, d, min, max, step) => ({ key, label, type: "float", default: d, min, max, step });
  const int = (key, label, d, min = 1, max = 500) => ({ key, label, type: "int", default: d, min, max });
  const sel = (key, label, options, d) => ({ key, label, type: "select", options, default: d != null ? d : options[0] });
  const line = (key, label, color, extra) => ({ key, label, type: "line", color, ...extra });
  const nulls = (n) => new Array(n).fill(null);
  const GREEN = "#26a69a", RED = "#ef5350";

  const smma = (x, n) => rma(x, n);
  // Least-squares line over the last n values: value at the newest bar, slope per bar, and the residual
  // standard error (n - 2 degrees of freedom).
  function regression(x, n) {
    const val = nulls(x.length), slope = nulls(x.length), err = nulls(x.length);
    const sx = (n * (n - 1)) / 2, sxx = ((n - 1) * n * (2 * n - 1)) / 6, den = n * sxx - sx * sx;
    for (let i = n - 1; i < x.length; i++) {
      let sy = 0, sxy = 0, ok = true;
      for (let k = 0; k < n; k++) { const v = x[i - n + 1 + k]; if (v == null) { ok = false; break; } sy += v; sxy += k * v; }
      if (!ok) continue;
      const m = (n * sxy - sx * sy) / den, c = (sy - m * sx) / n;
      val[i] = c + m * (n - 1); slope[i] = m;
      if (n > 2) { let ss = 0; for (let k = 0; k < n; k++) { const e = x[i - n + 1 + k] - (c + m * k); ss += e * e; } err[i] = Math.sqrt(ss / (n - 2)); }
    }
    return { val, slope, err };
  }
  const shift = (x, k) => x.map((_, i) => (i - k < 0 ? null : x[i - k]));
  const cross = (a, b, i) => i > 0 && a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null;
  function bucketOf(time, period) {
    const day = Math.floor(time / 86400);
    if (period === "week") return Math.floor((day + 3) / 7);
    if (period === "month") { const d = new Date(time * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }
    return day;
  }
  // For each bar, the high / low / open / close of the PREVIOUS period (day, week or month).
  function previousPeriod(bars, period) {
    const n = bars.length, out = { high: nulls(n), low: nulls(n), open: nulls(n), close: nulls(n) };
    let curKey = null, cur = null, prev = null;
    for (let i = 0; i < n; i++) {
      const b = bars[i], key = bucketOf(b.time, period);
      if (key !== curKey) { prev = cur; cur = { h: b.high, l: b.low, o: b.open, c: b.close }; curKey = key; }
      else { cur.h = Math.max(cur.h, b.high); cur.l = Math.min(cur.l, b.low); cur.c = b.close; }
      if (prev) { out.high[i] = prev.h; out.low[i] = prev.l; out.open[i] = prev.o; out.close[i] = prev.c; }
    }
    return out;
  }
  function periodOpen(bars, period) {
    let curKey = null, o = null;
    return bars.map((b) => { const k = bucketOf(b.time, period); if (k !== curKey) { curKey = k; o = b.open; } return o; });
  }

  const gr = (ids) => ids;
  void gr;
  // Zone-only indicators have nothing to plot: give them an empty anchor series so the chart can mount them.
  const withAnchor = (map) => { for (const d of Object.values(map)) if (d.plots[0].key === "anchor") { const c = d.calc; d.calc = (bars, p, ctx) => ({ ...c(bars, p, ctx), anchor: new Array(bars.length).fill(null) }); } return map; };
  IND.register(withAnchor({
    // ------------------------------------------------------------- community favourites
    "SqueezeMomentum@ipfx": {
      name: "Squeeze Momentum", short: "Squeeze", pane: "separate", priceUnits: true,
      meta: { cat: "momentum", full: "Squeeze Momentum (LazyBear)", color: "#22c55e", brief: "Shows when volatility is coiled and which way momentum leans",
        explain: "When Bollinger Bands sit inside Keltner Channels, volatility is squeezed and a bigger move often follows (dots on the zero line: red dots while squeezed, grey once released). The histogram is a smoothed measure of momentum: lime is rising above zero, dark green fading above, red is falling below, dark red fading below." },
      inputs: [int("length", "BB length", 20), flt("mult", "BB multiplier", 2, 0.1, 10, 0.1), int("lengthKC", "KC length", 20), flt("multKC", "KC multiplier", 1.5, 0.1, 10, 0.1)],
      plots: [{ key: "hist", label: "Momentum", type: "histogram", upColor: "#22c55e", downColor: "#ef4444" }, { key: "on", label: "Squeeze on", type: "dots", color: "#ef4444" }, { key: "off", label: "Squeeze off", type: "dots", color: "#94a3b8" }],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const n = bars.length, c = src(bars, "close"), basis = sma(c, p.length), dev = stdev(c, p.length).map((d) => (d == null ? null : d * p.mult));
        const ma = sma(c, p.lengthKC), rng = sma(trueRange(bars), p.lengthKC);
        const hh = highest(bars.map((b) => b.high), p.lengthKC), ll = lowest(bars.map((b) => b.low), p.lengthKC), mid = sma(c, p.lengthKC);
        const delta = c.map((v, i) => (hh[i] == null || mid[i] == null ? null : v - ((hh[i] + ll[i]) / 2 + mid[i]) / 2));
        const hist = regression(delta, p.lengthKC).val, colors = nulls(n), on = nulls(n), off = nulls(n);
        for (let i = 0; i < n; i++) {
          if (basis[i] == null || rng[i] == null || dev[i] == null) continue;
          const sqzOn = basis[i] - dev[i] > ma[i] - rng[i] * p.multKC && basis[i] + dev[i] < ma[i] + rng[i] * p.multKC;
          const sqzOff = basis[i] - dev[i] < ma[i] - rng[i] * p.multKC && basis[i] + dev[i] > ma[i] + rng[i] * p.multKC;
          if (sqzOn) on[i] = 0; else if (sqzOff) off[i] = 0;
          const v = hist[i], pv = i > 0 ? hist[i - 1] : null;
          if (v != null) colors[i] = v > 0 ? (pv != null && v > pv ? "#22c55e" : "#166534") : (pv != null && v < pv ? "#ef4444" : "#7f1d1d");
        }
        return { hist, on, off, colors: { hist: colors } };
      },
    },
    "WaveTrend@ipfx": {
      name: "WaveTrend Oscillator", short: "WaveTrend", pane: "separate", precision: 1,
      meta: { cat: "momentum", full: "WaveTrend Oscillator (LazyBear)", color: "#3b82f6", brief: "A fast momentum oscillator with overbought and oversold zones",
        explain: "Measures how far price has moved from its smoothed average, scaled by typical movement. The two lines are WT1 and its signal; crossings above the oversold line (−53) or below the overbought line (+53) are the classic signals. The histogram is the gap between the lines." },
      inputs: [int("channel", "Channel length", 10), int("average", "Average length", 21), int("signal", "Signal length", 4)],
      plots: [{ key: "diff", label: "Difference", type: "histogram", color: "rgba(148,163,184,0.5)" }, line("wt1", "WT1", "#3b82f6"), line("wt2", "WT2", "#f97316", { width: 1 })],
      levels: [{ value: 60 }, { value: 53 }, { value: 0 }, { value: -53 }, { value: -60 }],
      calc: (bars, p) => {
        const ap = src(bars, "hlc3"), esa = ema(ap, p.channel), d = ema(map2(ap, esa, (a, e) => Math.abs(a - e)), p.channel);
        const ci = map2(map2(ap, esa, (a, e) => a - e), d, (x, dd) => (dd === 0 ? 0 : x / (0.015 * dd)));
        const wt1 = ema(ci, p.average), wt2 = sma(wt1, p.signal);
        return { wt1, wt2, diff: map2(wt1, wt2, (a, b) => a - b) };
      },
    },
    "UTBot@ipfx": {
      name: "UT Bot Alerts", short: "UT Bot", pane: "overlay", repaint: false,
      meta: { cat: "trend", full: "UT Bot Alerts", color: "#22c55e", brief: "An ATR trailing stop that flips to give buy and sell signals",
        explain: "A trailing stop placed a set number of ATRs from price that only moves in the trade's favour. When price closes across the stop, the line flips sides and a Buy or Sell marker is drawn. Larger sensitivity numbers give fewer, later signals." },
      inputs: [flt("key", "Sensitivity (ATR ×)", 1, 0.1, 20, 0.1), int("atr", "ATR length", 10)],
      plots: [line("stop", "Trailing stop", "#94a3b8", { width: 1.5 }), { key: "buy", label: "Buy", type: "dots", color: "#22c55e", markerText: "Buy" }, { key: "sell", label: "Sell", type: "dots", color: "#ef4444", markerText: "Sell" }],
      calc: (bars, p) => {
        const n = bars.length, c = src(bars, "close"), atr = rma(trueRange(bars), p.atr), stop = nulls(n), buy = nulls(n), sell = nulls(n), colors = nulls(n);
        let prev = null;
        for (let i = 0; i < n; i++) {
          if (atr[i] == null) continue;
          const loss = p.key * atr[i], pc = i > 0 ? c[i - 1] : c[i];
          let s;
          if (prev == null) s = c[i] - loss;
          else if (c[i] > prev && pc > prev) s = Math.max(prev, c[i] - loss);
          else if (c[i] < prev && pc < prev) s = Math.min(prev, c[i] + loss);
          else s = c[i] > prev ? c[i] - loss : c[i] + loss;
          if (prev != null) { if (pc <= prev && c[i] > s && c[i] > prev) buy[i] = s; if (pc >= prev && c[i] < s && c[i] < prev) sell[i] = s; }
          stop[i] = s; colors[i] = c[i] > s ? "#22c55e" : "#ef4444"; prev = s;
        }
        return { stop, buy, sell, colors: { stop: colors } };
      },
    },
    "RangeFilter@ipfx": {
      name: "Range Filter", short: "Range Filter", pane: "overlay",
      meta: { cat: "trend", full: "Range Filter (DonovanWall)", color: "#22c55e", brief: "A filter that ignores small moves and follows only large ones",
        explain: "Price is only allowed to move the line when it travels further than a smoothed average range, so the line stays flat through noise and steps in the direction of real moves. Green while rising, red while falling; the two bands are the range either side." },
      inputs: [int("period", "Sampling period", 100), flt("mult", "Range multiplier", 3, 0.1, 20, 0.1)],
      plots: [line("filt", "Filter", "#22c55e", { width: 2 }), line("hi", "Upper band", "#22c55e", { width: 1 }), line("lo", "Lower band", "#ef4444", { width: 1 })],
      calc: (bars, p) => {
        const n = bars.length, x = src(bars, "close");
        const avrng = ema(x.map((v, i) => (i === 0 ? null : Math.abs(v - x[i - 1]))), p.period), smrng = ema(avrng, p.period * 2 - 1).map((v) => (v == null ? null : v * p.mult));
        const filt = nulls(n), hi = nulls(n), lo = nulls(n), colors = nulls(n);
        let prev = null;
        for (let i = 0; i < n; i++) {
          if (smrng[i] == null) continue;
          const r = smrng[i];
          let f = prev == null ? x[i] : x[i] > prev ? (x[i] - r < prev ? prev : x[i] - r) : (x[i] + r > prev ? prev : x[i] + r);
          colors[i] = prev == null || f === prev ? (i > 0 && colors[i - 1]) || "#94a3b8" : f > prev ? "#22c55e" : "#ef4444";
          filt[i] = f; hi[i] = f + r; lo[i] = f - r; prev = f;
        }
        return { filt, hi, lo, colors: { filt: colors } };
      },
    },
    "NadarayaWatson@ipfx": {
      name: "Nadaraya-Watson Envelope", short: "NW Envelope", pane: "overlay",
      meta: { cat: "volatility", full: "Nadaraya-Watson Envelope", color: "#14b8a6", brief: "A smooth kernel-regression line with bands of average error",
        explain: "Estimates fair value with a kernel regression: each recent candle is weighted by how close it is in time (a bell curve), so the line hugs price gently. Bands sit a multiple of the average error above and below. This version uses only past candles, so it does not repaint; it lags a little more than the repainting original." },
      inputs: [flt("h", "Bandwidth", 8, 1, 50, 0.5), flt("mult", "Band multiplier", 3, 0.5, 10, 0.1), int("lookback", "Look back (bars)", 60, 10, 200), SOURCE],
      plots: [line("mid", "Estimate", "#94a3b8", { width: 1.5 }), line("upper", "Upper", "#ef4444", { width: 1 }), line("lower", "Lower", "#22c55e", { width: 1 })],
      calc: (bars, p) => {
        const n = bars.length, x = src(bars, p.source), w = Array.from({ length: p.lookback }, (_, k) => Math.exp(-(k * k) / (2 * p.h * p.h)));
        const mid = nulls(n);
        for (let i = p.lookback - 1; i < n; i++) { let s = 0, ws = 0; for (let k = 0; k < p.lookback; k++) { s += x[i - k] * w[k]; ws += w[k]; } mid[i] = s / ws; }
        const mae = sma(map2(x, mid, (a, m) => Math.abs(a - m)), 100).map((v) => (v == null ? null : v * p.mult));
        return { mid, upper: map2(mid, mae, (m, e) => m + e), lower: map2(mid, mae, (m, e) => m - e) };
      },
    },
    "HalfTrend@ipfx": {
      name: "HalfTrend", short: "HalfTrend", pane: "overlay",
      meta: { cat: "trend", full: "HalfTrend", color: "#22c55e", brief: "A trend line that flips when price closes beyond recent extremes",
        explain: "Tracks the recent high and low over a short window and flips direction when price closes beyond the opposite side. The line is blue-green in an uptrend and red in a downtrend, with an arrow where it flips. Higher amplitude means fewer, later flips." },
      inputs: [int("amp", "Amplitude", 2, 1, 50), flt("dev", "Channel deviation", 2, 0.1, 10, 0.1)],
      plots: [line("ht", "HalfTrend", "#22c55e", { width: 2 }), { key: "up", label: "Buy", type: "dots", color: "#22c55e", markerText: "Buy" }, { key: "down", label: "Sell", type: "dots", color: "#ef4444", markerText: "Sell" }],
      calc: (bars, p) => {
        const n = bars.length, atr2 = rma(trueRange(bars), 100).map((v) => (v == null ? null : v / 2));
        const hp = highest(bars.map((b) => b.high), p.amp), lp = lowest(bars.map((b) => b.low), p.amp), hma = sma(bars.map((b) => b.high), p.amp), lma = sma(bars.map((b) => b.low), p.amp);
        const ht = nulls(n), buy = nulls(n), sell = nulls(n), colors = nulls(n);
        let trend = 0, next = 0, maxLow = n ? bars[0].low : 0, minHigh = n ? bars[0].high : 0, up = null, down = null, prevTrend = null;
        for (let i = 1; i < n; i++) {
          if (hp[i] == null || lma[i] == null) { maxLow = bars[i].low; minHigh = bars[i].high; continue; }
          const b = bars[i], pb = bars[i - 1];
          if (next === 1) { maxLow = Math.max(lp[i], maxLow); if (hma[i] < maxLow && b.close < pb.low) { trend = 1; next = 0; minHigh = hp[i]; } }
          else { minHigh = Math.min(hp[i], minHigh); if (lma[i] > minHigh && b.close > pb.high) { trend = 0; next = 1; maxLow = lp[i]; } }
          if (trend === 0) {
            if (prevTrend != null && prevTrend !== 0) { up = down == null ? maxLow : down; if (atr2[i] != null) buy[i] = up - atr2[i]; }
            else up = up == null ? maxLow : Math.max(maxLow, up);
            ht[i] = up;
          } else {
            if (prevTrend != null && prevTrend !== 1) { down = up == null ? minHigh : up; if (atr2[i] != null) sell[i] = down + atr2[i]; }
            else down = down == null ? minHigh : Math.min(minHigh, down);
            ht[i] = down;
          }
          colors[i] = trend === 0 ? "#22c55e" : "#ef4444"; prevTrend = trend;
        }
        return { ht, up: buy, down: sell, colors: { ht: colors } };
      },
    },
    "SchaffTrendCycle@ipfx": {
      name: "Schaff Trend Cycle", short: "STC", pane: "separate", range: [0, 100],
      meta: { cat: "momentum", full: "Schaff Trend Cycle", color: "#a855f7", brief: "A fast, smooth cycle oscillator between 0 and 100",
        explain: "Runs a MACD through two stochastic calculations to make an oscillator that turns earlier than MACD and stays smoother than a plain stochastic. Readings above 75 are strong up-moves, below 25 strong down-moves. Crossing back through 25 (up) or 75 (down) are the usual signals." },
      inputs: [int("fast", "Fast length", 23), int("slow", "Slow length", 50), int("cycle", "Cycle length", 10), flt("factor", "Smoothing factor", 0.5, 0.05, 1, 0.05)],
      plots: [line("stc", "STC", "#a855f7", { width: 2 })],
      levels: [{ value: 75 }, { value: 50 }, { value: 25 }],
      calc: (bars, p) => {
        const c = src(bars, "close"), macd = map2(ema(c, p.fast), ema(c, p.slow), (a, b) => a - b), n = bars.length;
        const stochOf = (x) => { const hh = highest(x, p.cycle), ll = lowest(x, p.cycle); return x.map((v, i) => (hh[i] == null || v == null ? null : hh[i] === ll[i] ? null : (100 * (v - ll[i])) / (hh[i] - ll[i]))); };
        const smooth = (x) => { const out = nulls(n); let prev = null; for (let i = 0; i < n; i++) { if (x[i] == null) { out[i] = prev; continue; } prev = prev == null ? x[i] : prev + p.factor * (x[i] - prev); out[i] = prev; } return out; };
        const pf = smooth(stochOf(macd)), pff = smooth(stochOf(pf));
        return { stc: pff.map((v) => (v == null ? null : Math.max(0, Math.min(100, v)))) };
      },
    },
    "SSLChannel@ipfx": {
      name: "SSL Channel", short: "SSL", pane: "overlay",
      meta: { cat: "trend", full: "SSL Channel", color: "#22c55e", brief: "Two moving averages of highs and lows that swap when trend changes",
        explain: "Averages the highs and the lows separately. When price closes above the average of highs the trend is up and the lower line becomes the support (green); below the average of lows it is down and the upper line becomes the resistance (red). The lines cross when the trend flips." },
      inputs: [int("length", "Length", 10)],
      plots: [line("up", "SSL up", "#22c55e", { width: 1.5 }), line("down", "SSL down", "#ef4444", { width: 1.5 })],
      calc: (bars, p) => {
        const hi = sma(bars.map((b) => b.high), p.length), lo = sma(bars.map((b) => b.low), p.length), n = bars.length, up = nulls(n), down = nulls(n);
        let hlv = 0;
        for (let i = 0; i < n; i++) {
          if (hi[i] == null) continue;
          if (bars[i].close > hi[i]) hlv = 1; else if (bars[i].close < lo[i]) hlv = -1;
          up[i] = hlv < 0 ? lo[i] : hi[i]; down[i] = hlv < 0 ? hi[i] : lo[i];
        }
        return { up, down };
      },
    },
    "TrendMagic@ipfx": {
      name: "Trend Magic", short: "Trend Magic", pane: "overlay",
      meta: { cat: "trend", full: "Trend Magic", color: "#f59e0b", brief: "A stop-and-reverse line steered by CCI and ATR",
        explain: "When CCI is above zero the line trails below price (blue, uptrend), and when below zero it trails above (red, downtrend). It only ever moves in the trend's direction until CCI changes sign. Use it as a trailing stop." },
      inputs: [int("cci", "CCI period", 20), int("atr", "ATR period", 5), flt("mult", "ATR multiplier", 1, 0.1, 10, 0.1)],
      plots: [line("tm", "Trend Magic", "#3b82f6", { width: 2 })],
      calc: (bars, p) => {
        const n = bars.length, x = src(bars, "hlc3"), m = sma(x, p.cci), d = ta.dev(x, p.cci), atr = sma(trueRange(bars), p.atr), tm = nulls(n), colors = nulls(n);
        let prev = null;
        for (let i = 0; i < n; i++) {
          if (m[i] == null || atr[i] == null) continue;
          const cci = d[i] === 0 ? 0 : (x[i] - m[i]) / (0.015 * d[i]), up = bars[i].low - atr[i] * p.mult, dn = bars[i].high + atr[i] * p.mult;
          const v = prev == null ? (cci >= 0 ? up : dn) : cci >= 0 ? (up < prev ? prev : up) : (dn > prev ? prev : dn);
          tm[i] = v; colors[i] = cci >= 0 ? "#3b82f6" : "#ef4444"; prev = v;
        }
        return { tm, colors: { tm: colors } };
      },
    },

    // ------------------------------------------------------------- previous-period levels
    "PrevDayWeekLevels@ipfx": {
      name: "Previous Day / Week High Low", short: "PDH/PDL", pane: "overlay", repaint: false,
      meta: { cat: "structure", full: "Previous Day / Week High and Low", color: "#f59e0b", brief: "The prior day's and week's high, low and close as levels",
        explain: "Draws the previous day's high, low and close, and the previous week's high and low, across today's candles. These are levels many traders watch for support, resistance, and liquidity sweeps. Days and weeks are UTC (weeks start Monday)." },
      inputs: [sel("close", "Previous close", ["show", "hide"], "show"), sel("week", "Weekly levels", ["show", "hide"], "show")],
      plots: [line("pdh", "Prev day high", "#ef4444", { width: 1, breakOnChange: true }), line("pdl", "Prev day low", "#22c55e", { width: 1, breakOnChange: true }), line("pdc", "Prev day close", "#94a3b8", { width: 1, dashed: true, breakOnChange: true }),
        line("pwh", "Prev week high", "#f97316", { width: 1, dashed: true, breakOnChange: true, noScale: true }), line("pwl", "Prev week low", "#14b8a6", { width: 1, dashed: true, breakOnChange: true, noScale: true })],
      calc: (bars, p) => {
        const d = previousPeriod(bars, "day"), w = previousPeriod(bars, "week"), n = bars.length;
        return { pdh: d.high, pdl: d.low, pdc: p.close === "show" ? d.close : nulls(n), pwh: p.week === "show" ? w.high : nulls(n), pwl: p.week === "show" ? w.low : nulls(n) };
      },
    },
    "PeriodOpens@ipfx": {
      name: "Day / Week / Month Open", short: "Opens", pane: "overlay",
      meta: { cat: "structure", full: "Day, Week and Month Open", color: "#3b82f6", brief: "Horizontal lines at each period's opening price",
        explain: "Marks the opening price of the current day, week and month. Price above the open means buyers are in control for that period; below means sellers. Many traders fade or follow moves around these prices. UTC days; weeks start Monday." },
      inputs: [],
      plots: [line("day", "Day open", "#3b82f6", { width: 1, breakOnChange: true }), line("week", "Week open", "#a855f7", { width: 1, dashed: true, breakOnChange: true, noScale: true }), line("month", "Month open", "#f59e0b", { width: 1, dashed: true, breakOnChange: true, noScale: true })],
      calc: (bars) => ({ day: periodOpen(bars, "day"), week: periodOpen(bars, "week"), month: periodOpen(bars, "month") }),
    },
    "CentralPivotRange@ipfx": {
      name: "Central Pivot Range", short: "CPR", pane: "overlay",
      meta: { cat: "structure", full: "Central Pivot Range (CPR)", color: "#a855f7", brief: "Pivot with top and bottom central lines from yesterday",
        explain: "Built from the previous day's high, low and close: the pivot (P), bottom central pivot (BC) and top central pivot (TC). A narrow range often precedes a trending day; a wide range often means a rangebound one. Price above TC is bullish, below BC bearish." },
      inputs: [sel("period", "Timeframe", ["day", "week"], "day")],
      plots: [line("tc", "TC", "#a855f7", { width: 1, breakOnChange: true }), line("pp", "Pivot", "#eab308", { width: 1.5, breakOnChange: true }), line("bc", "BC", "#a855f7", { width: 1, breakOnChange: true })],
      calc: (bars, p) => {
        const q = previousPeriod(bars, p.period), n = bars.length, tc = nulls(n), pp = nulls(n), bc = nulls(n);
        for (let i = 0; i < n; i++) if (q.high[i] != null) { const P = (q.high[i] + q.low[i] + q.close[i]) / 3, B = (q.high[i] + q.low[i]) / 2, T = 2 * P - B; pp[i] = P; bc[i] = Math.min(B, T); tc[i] = Math.max(B, T); }
        return { tc, pp, bc };
      },
    },
    "AverageDayRange@ipfx": {
      name: "Average Day Range", short: "ADR", pane: "separate", priceUnits: true,
      meta: { cat: "volatility", full: "Average Day Range (ADR)", color: "#f97316", brief: "How far price normally travels from a day's low to its high",
        explain: "The average of the last N completed days' high-minus-low, in price. Compare it with how far today has already moved to judge how much room is left. The lower line is today's range so far." },
      inputs: [int("length", "Days", 14, 1, 100)],
      plots: [line("adr", "ADR", "#f97316", { width: 2 }), line("today", "Today's range", "#94a3b8", { width: 1, dashed: true })],
      calc: (bars, p) => {
        const n = bars.length, adr = nulls(n), today = nulls(n), ranges = [];
        let curKey = null, h = 0, l = 0;
        for (let i = 0; i < n; i++) {
          const b = bars[i], k = Math.floor(b.time / 86400);
          if (k !== curKey) { if (curKey != null) ranges.push(h - l); curKey = k; h = b.high; l = b.low; } else { h = Math.max(h, b.high); l = Math.min(l, b.low); }
          const recent = ranges.slice(-p.length);
          if (recent.length) adr[i] = recent.reduce((s, v) => s + v, 0) / recent.length; // fewer days on screen: average what there is
          today[i] = h - l;
        }
        return { adr, today };
      },
    },
    "VWAPBands@ipfx": {
      name: "VWAP with Bands", short: "VWAP bands", pane: "overlay",
      meta: { cat: "trend", full: "VWAP with Standard Deviation Bands", color: "#3b82f6", brief: "Session VWAP with one- and two-deviation bands",
        explain: "Volume-weighted average price restarted each period, with bands at one and two standard deviations of price around it. Price tends to be pulled back toward VWAP and reacts at the outer bands. Where a symbol has no volume, candles are weighted equally." },
      inputs: [sel("anchor", "Anchor", ["day", "week", "month"], "day"), flt("k1", "Band 1 (σ)", 1, 0.1, 5, 0.1), flt("k2", "Band 2 (σ)", 2, 0.1, 5, 0.1)],
      plots: [line("vwap", "VWAP", "#3b82f6", { width: 2, breakOnChange: true }), line("u1", "+1σ", "#3b82f6", { width: 1, breakOnChange: true }), line("l1", "−1σ", "#3b82f6", { width: 1, breakOnChange: true }),
        line("u2", "+2σ", "#94a3b8", { width: 1, dashed: true, breakOnChange: true }), line("l2", "−2σ", "#94a3b8", { width: 1, dashed: true, breakOnChange: true })],
      calc: (bars, p) => {
        const n = bars.length, hasVol = bars.some((b) => b.volume > 0), o = { vwap: nulls(n), u1: nulls(n), l1: nulls(n), u2: nulls(n), l2: nulls(n) };
        let key = null, W = 0, S1 = 0, S2 = 0;
        for (let i = 0; i < n; i++) {
          const b = bars[i], k = bucketOf(b.time, p.anchor), x = (b.high + b.low + b.close) / 3, w = hasVol ? b.volume || 0 : 1;
          if (k !== key) { key = k; W = 0; S1 = 0; S2 = 0; }
          W += w; S1 += w * x; S2 += w * x * x;
          if (W <= 0) continue;
          const m = S1 / W, sd = Math.sqrt(Math.max(0, S2 / W - m * m));
          o.vwap[i] = m; o.u1[i] = m + p.k1 * sd; o.l1[i] = m - p.k1 * sd; o.u2[i] = m + p.k2 * sd; o.l2[i] = m - p.k2 * sd;
        }
        return o;
      },
    },

    // ------------------------------------------------------------- TradingView built-ins that were missing
    "AcceleratorOscillator@ipfx": {
      name: "Accelerator Oscillator", short: "AC", pane: "separate", priceUnits: true,
      meta: { cat: "momentum", full: "Accelerator Oscillator (AC)", color: "#22c55e", brief: "Shows whether momentum is speeding up or slowing down",
        explain: "The Awesome Oscillator minus its own 5-period average. It changes before the Awesome Oscillator, so it warns of a momentum shift sooner. Green bars are rising, red bars are falling." },
      inputs: [],
      plots: [{ key: "ac", label: "AC", type: "histogram", upColor: GREEN, downColor: RED }],
      levels: [{ value: 0 }],
      calc: (bars) => {
        const hl2 = src(bars, "hl2"), ao = map2(sma(hl2, 5), sma(hl2, 34), (a, b) => a - b), ac = map2(ao, sma(ao, 5), (a, b) => a - b);
        const colors = ac.map((v, i) => (v == null || i === 0 || ac[i - 1] == null ? null : v > ac[i - 1] ? GREEN : RED));
        return { ac, colors: { ac: colors } };
      },
    },
    "GuppyMMA@ipfx": {
      name: "Guppy Multiple Moving Average", short: "GMMA", pane: "overlay",
      meta: { cat: "trend", full: "Guppy Multiple Moving Average (GMMA)", color: "#3b82f6", brief: "Two ribbons of averages, short-term traders and long-term investors",
        explain: "Six short averages (3–15) show what traders are doing and six long averages (30–60) show investors. When the short ribbon is above the long ribbon and both fan out, the trend is strong; when they tangle, it is unclear." },
      inputs: [],
      plots: [3, 5, 8, 10, 12, 15].map((n) => line("s" + n, "EMA " + n, "#3b82f6", { width: 1 })).concat([30, 35, 40, 45, 50, 60].map((n) => line("l" + n, "EMA " + n, "#ef4444", { width: 1 }))),
      calc: (bars) => { const c = src(bars, "close"), o = {}; for (const n of [3, 5, 8, 10, 12, 15]) o["s" + n] = ema(c, n); for (const n of [30, 35, 40, 45, 50, 60]) o["l" + n] = ema(c, n); return o; },
    },
    "GatorOscillator@ipfx": {
      name: "Gator Oscillator", short: "Gator", pane: "separate", priceUnits: true,
      meta: { cat: "momentum", full: "Gator Oscillator", color: "#22c55e", brief: "Shows when the Alligator is asleep, waking or feeding",
        explain: "Two histograms built from the Alligator's lines: the gap between jaw and teeth above zero, and between teeth and lips below it. Short bars mean the Alligator is asleep (no trend); growing green bars mean it is feeding on a trend; shrinking bars mean it is sated." },
      inputs: [],
      plots: [{ key: "upper", label: "Jaw − Teeth", type: "histogram", upColor: GREEN, downColor: RED }, { key: "lower", label: "Teeth − Lips", type: "histogram", upColor: GREEN, downColor: RED }],
      levels: [{ value: 0 }],
      calc: (bars) => {
        const hl2 = src(bars, "hl2"), jaw = shift(smma(hl2, 13), 8), teeth = shift(smma(hl2, 8), 5), lips = shift(smma(hl2, 5), 3);
        const upper = map2(jaw, teeth, (a, b) => Math.abs(a - b)), lower = map2(teeth, lips, (a, b) => -Math.abs(a - b));
        const col = (x) => x.map((v, i) => (v == null || i === 0 || x[i - 1] == null ? null : Math.abs(v) >= Math.abs(x[i - 1]) ? GREEN : RED));
        return { upper, lower, colors: { upper: col(upper), lower: col(lower) } };
      },
    },
    "ElderImpulse@ipfx": {
      name: "Elder Impulse System", short: "Impulse", pane: "overlay", candleColors: true,
      meta: { cat: "momentum", full: "Elder Impulse System", color: "#22c55e", brief: "Colours candles by whether trend and momentum agree",
        explain: "Colours each candle green when both the 13-period EMA and the MACD histogram are rising (buyers in control, avoid shorting), red when both are falling (avoid buying), and blue when they disagree. It changes the colour of your candles while it is on." },
      inputs: [int("length", "EMA length", 13)],
      plots: [{ key: "anchor", label: "", type: "dots", color: "#94a3b8", hideValue: true }],
      calc: (bars, p) => {
        const c = src(bars, "close"), e = ema(c, p.length), macd = map2(ema(c, 12), ema(c, 26), (a, b) => a - b), hist = map2(macd, ema(macd, 9), (a, b) => a - b);
        return { candleColors: bars.map((_, i) => (i === 0 || e[i] == null || e[i - 1] == null || hist[i] == null || hist[i - 1] == null ? null : e[i] > e[i - 1] && hist[i] > hist[i - 1] ? "#22c55e" : e[i] < e[i - 1] && hist[i] < hist[i - 1] ? "#ef4444" : "#3b82f6")) };
      },
    },
    "LinearRegressionSlope@ipfx": {
      name: "Linear Regression Slope", short: "LR Slope", pane: "separate", priceUnits: true, precision: 5,
      meta: { cat: "trend", full: "Linear Regression Slope", color: "#3b82f6", brief: "How steeply the best-fit line through recent prices is rising or falling",
        explain: "The slope, per candle, of the straight line that best fits the last N closes. Above zero the fitted trend is up, below zero it is down, and the further from zero the steeper it is." },
      inputs: [len(14), SOURCE],
      plots: [line("slope", "Slope", "#3b82f6", { width: 1.5 })],
      levels: [{ value: 0 }],
      calc: (bars, p) => ({ slope: regression(src(bars, p.source), p.length).slope }),
    },
    "StandardDeviation@ipfx": {
      name: "Standard Deviation", short: "StdDev", pane: "separate", priceUnits: true,
      meta: { cat: "volatility", full: "Standard Deviation", color: "#f59e0b", brief: "How widely prices have been spread around their average",
        explain: "The standard deviation of the last N prices. It rises when price is swinging widely and falls when it is quiet; it is the measure that sets the width of Bollinger Bands." },
      inputs: [len(20), SOURCE],
      plots: [line("sd", "StdDev", "#f59e0b", { width: 1.5 })],
      calc: (bars, p) => ({ sd: stdev(src(bars, p.source), p.length) }),
    },
    "StandardError@ipfx": {
      name: "Standard Error", short: "StdErr", pane: "separate", priceUnits: true,
      meta: { cat: "volatility", full: "Standard Error", color: "#f97316", brief: "How far price strays from its best-fit line",
        explain: "The typical distance between the last N closes and the straight line that best fits them. Low values mean price has been following a clean trend; high values mean it has been choppy around it." },
      inputs: [int("length", "Length", 21, 3, 500), SOURCE],
      plots: [line("se", "Standard error", "#f97316", { width: 1.5 })],
      calc: (bars, p) => ({ se: regression(src(bars, p.source), p.length).err }),
    },
    "StandardErrorBands@ipfx": {
      name: "Standard Error Bands", short: "SE Bands", pane: "overlay",
      meta: { cat: "volatility", full: "Standard Error Bands", color: "#3b82f6", brief: "Bands around a regression line, sized by how tightly price follows it",
        explain: "A smoothed regression line with bands a multiple of the standard error above and below. Because the error shrinks when price follows a clean trend, the bands narrow in strong trends and widen when price gets choppy." },
      inputs: [int("length", "Length", 21, 3, 500), flt("mult", "Multiplier", 2, 0.1, 10, 0.1), int("smooth", "Smoothing", 3, 1, 50)],
      plots: [line("mid", "Regression", "#3b82f6", { width: 1.5 }), line("upper", "Upper", "#ef4444", { width: 1 }), line("lower", "Lower", "#22c55e", { width: 1 })],
      calc: (bars, p) => {
        const r = regression(src(bars, "close"), p.length), mid = sma(r.val, p.smooth), err = sma(r.err, p.smooth);
        return { mid, upper: map2(mid, err, (m, e) => m + p.mult * e), lower: map2(mid, err, (m, e) => m - p.mult * e) };
      },
    },
    "ChaikinVolatility@ipfx": {
      name: "Chaikin Volatility", short: "Chaikin Vol", pane: "separate", precision: 2,
      meta: { cat: "volatility", full: "Chaikin Volatility", color: "#a855f7", brief: "Whether the high-low range is widening or narrowing",
        explain: "The percentage change over N candles in the smoothed high-to-low range. Positive means candles are getting bigger (volatility rising); negative means they are shrinking." },
      inputs: [int("length", "EMA length", 10), int("roc", "Rate of change", 10)],
      plots: [line("cv", "Chaikin Volatility", "#a855f7", { width: 1.5 })],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const e = ema(bars.map((b) => b.high - b.low), p.length);
        return { cv: e.map((v, i) => (v == null || i < p.roc || e[i - p.roc] == null || e[i - p.roc] === 0 ? null : (100 * (v - e[i - p.roc])) / e[i - p.roc])) };
      },
    },
    "ZLEMA@ipfx": {
      name: "Zero Lag EMA", short: "ZLEMA", pane: "overlay",
      meta: { cat: "trend", full: "Zero Lag Exponential Moving Average", color: "#22c55e", brief: "An EMA with most of the lag removed",
        explain: "Adds back the recent change in price before smoothing, so the average turns sooner than a normal EMA. It reacts faster but gives more false turns in choppy markets." },
      inputs: [len(21), SOURCE],
      plots: [line("ma", "ZLEMA", "#22c55e", { width: 2 })],
      calc: (bars, p) => { const x = src(bars, p.source), lag = Math.floor((p.length - 1) / 2); return { ma: ema(x.map((v, i) => (i < lag ? null : v + (v - x[i - lag]))), p.length) }; },
    },
    "T3@ipfx": {
      name: "T3 Moving Average", short: "T3", pane: "overlay",
      meta: { cat: "trend", full: "T3 Moving Average (Tillson)", color: "#f59e0b", brief: "A very smooth average that still follows price closely",
        explain: "Tillson's T3 applies an EMA six times with a volume factor that controls overshoot. It is much smoother than an EMA of the same length with less lag. A higher factor makes it more responsive but overshoots turns." },
      inputs: [len(8), flt("vfactor", "Volume factor", 0.7, 0, 1, 0.05), SOURCE],
      plots: [line("ma", "T3", "#f59e0b", { width: 2 })],
      calc: (bars, p) => {
        const a = p.vfactor, c1 = -a * a * a, c2 = 3 * a * a + 3 * a * a * a, c3 = -6 * a * a - 3 * a - 3 * a * a * a, c4 = 1 + 3 * a + a * a * a + 3 * a * a;
        const x = src(bars, p.source), e1 = ema(x, p.length), e2 = ema(e1, p.length), e3 = ema(e2, p.length), e4 = ema(e3, p.length), e5 = ema(e4, p.length), e6 = ema(e5, p.length);
        return { ma: e6.map((_, i) => (e6[i] == null ? null : c1 * e6[i] + c2 * e5[i] + c3 * e4[i] + c4 * e3[i])) };
      },
    },
    "TypicalPrice@ipfx": {
      name: "Typical / Median Price", short: "Typical", pane: "overlay",
      meta: { cat: "trend", full: "Typical, Median and Average Price", color: "#94a3b8", brief: "Each candle's average price rather than just its close",
        explain: "Three ways to summarise a candle as one number: median (high + low) / 2, typical (high + low + close) / 3, and average (open + high + low + close) / 4. Useful as a less noisy line than the close." },
      inputs: [],
      plots: [line("median", "Median", "#94a3b8", { width: 1 }), line("typical", "Typical", "#f59e0b", { width: 1 }), line("average", "Average", "#3b82f6", { width: 1 })],
      calc: (bars) => ({ median: src(bars, "hl2"), typical: src(bars, "hlc3"), average: src(bars, "ohlc4") }),
    },
    "Ratio@ipfx": {
      name: "Ratio", short: "Ratio", pane: "separate", precision: 4, needsSymbol: "symbol",
      meta: { cat: "momentum", full: "Ratio (versus another symbol)", color: "#3b82f6", brief: "This symbol's price divided by another symbol's price",
        explain: "Divides this chart's close by another symbol's close. A rising line means this symbol is outperforming the other. Useful for comparing an index with a currency or gold against silver." },
      inputs: [{ key: "symbol", label: "Compare with", type: "select", options: ["SPXUSD", "NSXUSD", "DJI", "UK100", "GER40", "JPN225", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "XAUUSD", "XAGUSD", "BTCUSD", "ETHUSD"], default: "XAGUSD" }],
      plots: [line("ratio", "Ratio", "#3b82f6", { width: 1.5 })],
      calc: (bars, p, ctx) => ({ ratio: ctx && ctx.other ? map2(bars.map((b) => b.close), ctx.other, (a, o) => (o === 0 ? null : a / o)) : nulls(bars.length) }),
    },
    "Spread@ipfx": {
      name: "Spread", short: "Spread", pane: "separate", priceUnits: true, needsSymbol: "symbol",
      meta: { cat: "momentum", full: "Spread (versus another symbol)", color: "#f97316", brief: "This symbol's price minus another symbol's price",
        explain: "Subtracts another symbol's close from this chart's close. It is most useful for two instruments that trade in similar price ranges, such as two currency pairs or two index futures." },
      inputs: [{ key: "symbol", label: "Compare with", type: "select", options: ["SPXUSD", "NSXUSD", "DJI", "UK100", "GER40", "JPN225", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "XAUUSD", "XAGUSD", "BTCUSD", "ETHUSD"], default: "GBPUSD" }],
      plots: [line("spread", "Spread", "#f97316", { width: 1.5 })],
      calc: (bars, p, ctx) => ({ spread: ctx && ctx.other ? map2(bars.map((b) => b.close), ctx.other, (a, o) => a - o) : nulls(bars.length) }),
    },
  }));
  IND.extra = { regression, previousPeriod };
  void [wma, sum, map1, back];
})(typeof window !== "undefined" ? window : globalThis);
