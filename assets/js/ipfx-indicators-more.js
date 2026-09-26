// IPFX Markets indicators — the rest of TradingView's built-in list that can be drawn from candles:
// adaptive/anchored averages, composite momentum, volume estimates, calendar markers, and the
// "auto" indicators that draw levels and lines from swing points.
// Needs the other family files loaded first (it reuses their swing-point, zig-zag, RCI and Aroon code).
(function (root) {
  "use strict";
  const IND = typeof module !== "undefined" && module.exports ? require("./ipfx-indicators.js") : root.IPFX_INDICATORS;
  const { ta, SOURCE, len } = IND;
  const { src, sma, ema, rma, highest, lowest, trueRange, change, sum, map1, map2, rsi } = ta;

  const flt = (key, label, d, min, max, step) => ({ key, label, type: "float", default: d, min, max, step });
  const int = (key, label, d, min = 1, max = 500) => ({ key, label, type: "int", default: d, min, max });
  const line = (key, label, color, extra) => ({ key, label, type: "line", color, ...extra });
  const NOTE = " Volume is the exchange's for crypto, indices, metals and futures; for the forex majors IPFX uses the matching CME currency future (named in the chart footer); pairs without one, such as GBP/JPY, have none.";
  const nulls = (n) => new Array(n).fill(null);

  // DecisionPoint's EMA: smoothing 2/n (not 2/(n+1)), seeded with the first value.
  function cema(x, n) {
    const a = 2 / n; let prev = null;
    return x.map((v) => { if (v == null) return null; prev = prev == null ? v : prev + a * (v - prev); return prev; });
  }
  const roc = (x, n) => x.map((v, i) => (i < n || v == null || x[i - n] == null || x[i - n] === 0 ? null : (100 * (v - x[i - n])) / x[i - n]));
  function bucket(time, anchor) {
    const day = Math.floor(time / 86400);
    if (anchor === "week") return Math.floor((day + 3) / 7);
    if (anchor === "month") { const d = new Date(time * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }
    return day;
  }
  // Running average of a source from an anchor bar (weights = volume, or 1 when there is no volume).
  function anchoredAverage(bars, x, from, useVolume) {
    const out = nulls(bars.length), hasVol = useVolume && bars.some((b) => b.volume > 0);
    let spv = 0, sv = 0;
    for (let i = from; i < bars.length; i++) {
      const w = hasVol ? bars[i].volume || 0 : 1;
      spv += x[i] * w; sv += w;
      out[i] = sv > 0 ? spv / sv : null;
    }
    return out;
  }
  // A horizontal level that begins at bar `from`.
  const levelFrom = (n, from, price) => new Array(n).fill(null).map((_, i) => (i >= from ? price : null));
  // A straight line through (i0, p0) with the given slope, from bar i0 onward.
  const lineFrom = (n, i0, p0, slope) => new Array(n).fill(null).map((_, i) => (i >= i0 ? p0 + slope * (i - i0) : null));
  const dayOf = (t) => Math.floor(t / 86400);

  // Moon age in days since the last new moon (mean lunation; good to within about half a day).
  const SYNODIC = 29.530588853, REF_NEW_MOON_JD = 2451550.1;
  const moonAge = (t) => { const a = (t / 86400 + 2440587.5 - REF_NEW_MOON_JD) % SYNODIC; return a < 0 ? a + SYNODIC : a; };

  const FIB_COLORS = ["#9ca3af", "#f59e0b", "#84cc16", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7"];
  const CHOP = { turquoise: "#26c6da", darkGreen: "#43a047", paleGreen: "#a5d6a7", lime: "#d4e157", darkRed: "#b71c1c", red: "#f44336", orange: "#ff9800", lightOrange: "#ffcc80", yellow: "#ffeb3b" };

  IND.register({
    // ---------------------------------------------------------------- momentum
    "AroonOscillator@tv-basicstudies": {
      name: "Aroon Oscillator", pane: "separate", range: [-100, 100], precision: 2,
      meta: { cat: "momentum", full: "Aroon Oscillator", color: "#fb923c", brief: "Aroon Up minus Aroon Down",
        explain: "The gap between Aroon Up and Aroon Down as one line from -100 to 100. Above zero the highest high is more recent than the lowest low (uptrend); below zero the reverse. Near ±100 the trend is strong." },
      inputs: [len(14)],
      plots: [line("osc", "Aroon Osc", "#2962ff")],
      levels: [{ value: 0 }],
      calc: (bars, p) => { const a = ta.aroon(bars, p.length); return { osc: map2(a.up, a.down, (u, d) => u - d) }; },
    },
    "PMO@tv-basicstudies": {
      name: "Price Momentum Oscillator", short: "PMO", pane: "separate", precision: 3,
      meta: { cat: "momentum", full: "Price Momentum Oscillator", color: "#38bdf8", brief: "Smoothed rate of change with a signal line",
        explain: "DecisionPoint's oscillator: the one-candle rate of change, smoothed twice, plus a signal line. Crossing the signal line or zero marks changes in momentum, and it works the same on any instrument." },
      inputs: [int("first", "First smoothing", 35), int("second", "Second smoothing", 20), int("signal", "Signal length", 10), SOURCE],
      plots: [line("pmo", "PMO", "#2962ff"), line("signal", "Signal", "#f23645")],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const x = src(bars, p.source), r1 = x.map((v, i) => (i === 0 || x[i - 1] === 0 ? null : (v / x[i - 1] - 1) * 100));
        const pmo = cema(map1(cema(r1, p.first), (v) => v * 10), p.second);
        return { pmo, signal: ema(pmo, p.signal) };
      },
    },
    "SpecialK@tv-basicstudies": {
      name: "Pring's Special K", short: "Special K", pane: "separate", precision: 2,
      meta: { cat: "momentum", full: "Pring's Special K", color: "#a3e635", brief: "Twelve momentum readings blended for the big picture",
        explain: "Martin Pring's composite of twelve smoothed rates of change from short to very long. Because it blends every time scale it turns slowly, so it is used to judge the major trend; it needs about 250 candles of history." },
      inputs: [SOURCE],
      plots: [line("sk", "Special K", "#2962ff")],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const x = src(bars, p.source), t = (r, s, w) => map1(sma(roc(x, r), s), (v) => v * w);
        const parts = [t(10, 10, 1), t(15, 10, 2), t(20, 10, 3), t(30, 15, 4), t(50, 50, 1), t(65, 65, 2), t(75, 75, 3), t(100, 100, 4), t(75, 100, 1), t(100, 100, 2), t(130, 100, 3), t(150, 150, 4)];
        return { sk: x.map((_, i) => { let s = 0; for (const a of parts) { if (a[i] == null) return null; s += a[i]; } return s; }) };
      },
    },
    "RCIRibbon@tv-basicstudies": {
      name: "RCI Ribbon", pane: "separate", range: [-100, 100], precision: 2,
      meta: { cat: "momentum", full: "Rank Correlation Index Ribbon", color: "#818cf8", brief: "Three RCI lines: short, medium and long term",
        explain: "The Rank Correlation Index over three lengths at once. When all three lines agree near +100 or -100 the trend is strong across time scales; when the short line turns first, it warns of a reversal." },
      inputs: [int("short", "Short", 9), int("mid", "Middle", 26), int("long", "Long", 52), SOURCE],
      plots: [line("short", "Short", "#f97316", { width: 1 }), line("mid", "Middle", "#2962ff", { width: 1 }), line("long", "Long", "#26a69a", { width: 1 })],
      levels: [{ value: 80 }, { value: 0 }, { value: -80 }],
      calc: (bars, p) => { const x = src(bars, p.source); return { short: ta.rci(x, p.short), mid: ta.rci(x, p.mid), long: ta.rci(x, p.long) }; },
    },
    "RSIDivergence@tv-basicstudies": {
      name: "RSI Divergence Indicator", short: "RSI Div", pane: "separate", range: [0, 100], precision: 2, repaint: true,
      meta: { cat: "momentum", full: "RSI Divergence Indicator", color: "#c084fc", brief: "RSI with bullish and bearish divergence marked",
        explain: "Shows the RSI and marks regular divergences: 'Bull' when price makes a lower low but RSI makes a higher low (selling is weakening), 'Bear' when price makes a higher high but RSI a lower high. A divergence is only confirmed a few candles after the pivot, so marks appear late." },
      inputs: [len(14, "RSI length"), int("left", "Pivot bars left", 5), int("right", "Pivot bars right", 5), int("min", "Min bars between", 5), int("max", "Max bars between", 60)],
      plots: [line("rsi", "RSI", "#7e57c2"), { key: "bull", label: "Bullish", type: "dots", color: "#22c55e", markerText: "Bull" }, { key: "bear", label: "Bearish", type: "dots", color: "#ef4444", markerText: "Bear" }],
      levels: [{ value: 70 }, { value: 50 }, { value: 30 }],
      calc: (bars, p) => {
        const r = rsi(bars.map((b) => b.close), p.length), n = bars.length, bull = nulls(n), bear = nulls(n);
        const pivot = (i, low) => {
          if (r[i] == null) return false;
          for (let k = 1; k <= p.left; k++) { const v = r[i - k]; if (v == null || (low ? v < r[i] : v > r[i])) return false; }
          for (let k = 1; k <= p.right; k++) { const v = r[i + k]; if (v == null || (low ? v <= r[i] : v >= r[i])) return false; }
          return true;
        };
        let pl = null, ph = null;
        for (let i = p.left; i < n - p.right; i++) {
          if (pivot(i, true)) {
            if (pl != null && i - pl >= p.min && i - pl <= p.max && r[i] > r[pl] && bars[i].low < bars[pl].low) bull[i] = r[i];
            pl = i;
          }
          if (pivot(i, false)) {
            if (ph != null && i - ph >= p.min && i - ph <= p.max && r[i] < r[ph] && bars[i].high > bars[ph].high) bear[i] = r[i];
            ph = i;
          }
        }
        return { rsi: r, bull, bear };
      },
    },
    "UlcerIndex@tv-basicstudies": {
      name: "Ulcer Index", pane: "separate", precision: 2,
      meta: { cat: "volatility", full: "Ulcer Index", color: "#f472b6", brief: "How deep and how long price has been below its recent high",
        explain: "Measures downside risk: the typical percentage drawdown from the highest close of the last N candles. Unlike standard deviation it ignores upward moves. A rising Ulcer Index means holders are being hurt more." },
      inputs: [len(14), SOURCE],
      plots: [line("ulcer", "Ulcer", "#f23645")],
      calc: (bars, p) => {
        const x = src(bars, p.source), hh = highest(x, p.length);
        const dd = x.map((v, i) => (hh[i] == null || hh[i] === 0 ? null : (100 * (v - hh[i])) / hh[i]));
        return { ulcer: map1(sma(dd.map((v) => (v == null ? null : v * v)), p.length), Math.sqrt) };
      },
    },
    "ChopZone@tv-basicstudies": {
      name: "Chop Zone", pane: "separate", range: [0, 1],
      meta: { cat: "volatility", full: "Chop Zone", color: "#26c6da", brief: "Colour strip: strong trend or chop?",
        explain: "A strip of colour showing how steeply a 34-candle EMA is rising or falling. Turquoise and greens = strong uptrend, reds and oranges = strong downtrend, yellow = chop (no trend). Approximates TradingView's script." },
      inputs: [int("periods", "Range length", 30)],
      plots: [{ key: "zone", label: "Zone", type: "histogram", color: CHOP.yellow, hideValue: true }],
      calc: (bars, p) => {
        const hh = highest(bars.map((b) => b.high), p.periods), ll = lowest(bars.map((b) => b.low), p.periods), e = ema(bars.map((b) => b.close), 34);
        const zone = [], colors = [];
        bars.forEach((b, i) => {
          if (i === 0 || e[i] == null || e[i - 1] == null || hh[i] == null || hh[i] === ll[i]) { zone.push(null); colors.push(null); return; }
          const span = (25 / (hh[i] - ll[i])) * ll[i], avg = (b.high + b.low + b.close) / 3;
          const y = ((e[i - 1] - e[i]) / avg) * span, ang = Math.round((Math.acos(1 / Math.sqrt(1 + y * y)) * 180) / Math.PI), angle = y > 0 ? -ang : ang;
          zone.push(1);
          colors.push(angle >= 5 ? CHOP.turquoise : angle >= 3.57 ? CHOP.darkGreen : angle >= 2.14 ? CHOP.paleGreen : angle >= 0.71 ? CHOP.lime
            : angle <= -5 ? CHOP.darkRed : angle <= -3.57 ? CHOP.red : angle <= -2.14 ? CHOP.orange : angle <= -0.71 ? CHOP.lightOrange : CHOP.yellow);
        });
        return { zone, colors: { zone: colors } };
      },
    },
    // ---------------------------------------------------------------- trend
    "KAMA@tv-basicstudies": {
      name: "Kaufman's Adaptive MA", short: "KAMA", pane: "overlay",
      meta: { cat: "trend", full: "Kaufman's Adaptive Moving Average", color: "#f43f5e", brief: "Average that speeds up in trends and slows in chop",
        explain: "Measures how efficiently price is moving (a straight run vs. back-and-forth) and adjusts its speed to match: it follows closely in a clean trend and flattens out in sideways noise, so it whipsaws less than a normal average." },
      inputs: [len(14), int("fast", "Fast length", 2), int("slow", "Slow length", 30), SOURCE],
      plots: [line("kama", "KAMA", "#f43f5e")],
      calc: (bars, p) => {
        const x = src(bars, p.source), n = p.length, out = nulls(x.length), f = 2 / (p.fast + 1), s = 2 / (p.slow + 1);
        let prev = null;
        for (let i = n; i < x.length; i++) {
          let vol = 0;
          for (let k = 0; k < n; k++) vol += Math.abs(x[i - k] - x[i - k - 1]);
          const er = vol === 0 ? 0 : Math.abs(x[i] - x[i - n]) / vol, sc = (er * (f - s) + s) ** 2, base = prev == null ? x[i] : prev;
          prev = base + sc * (x[i] - base); out[i] = prev;
        }
        return { kama: out };
      },
    },
    "TWAP@tv-basicstudies": {
      name: "Time Weighted Average Price", short: "TWAP", pane: "overlay",
      meta: { cat: "trend", full: "Time Weighted Average Price", color: "#0ea5e9", brief: "Average price so far today, every candle equal",
        explain: "The average price since the start of the day (or week/month), counting every candle equally regardless of volume. Institutions use it as a benchmark for how well they executed; price above it means buyers have been in control." },
      inputs: [{ key: "anchor", label: "Anchor", type: "select", options: ["day", "week", "month"], default: "day" }, { ...SOURCE, default: "hlc3" }],
      plots: [line("twap", "TWAP", "#0ea5e9")],
      calc: (bars, p) => {
        const x = src(bars, p.source), anchor = ta.barSeconds(bars) >= 86400 && p.anchor === "day" ? "month" : p.anchor;
        let key = null, s = 0, c = 0;
        return { twap: bars.map((b, i) => { const k = bucket(b.time, anchor); if (k !== key) { key = k; s = 0; c = 0; } s += x[i]; c++; return s / c; }) };
      },
    },
    "ChandelierExit@tv-basicstudies": {
      name: "Chandelier Exit", pane: "overlay",
      meta: { cat: "trend", full: "Chandelier Exit", color: "#f59e0b", brief: "Trailing stop hung from the highest high",
        explain: "A trailing stop placed a multiple of ATR below the highest high (for longs, green) or above the lowest low (for shorts, red), only ever moving in the trade's favour. Closing through it flips the direction." },
      inputs: [len(22), flt("mult", "ATR multiplier", 3, 0.1, 50, 0.1), { key: "basis", label: "Extremes from", type: "select", options: ["close", "high/low"], default: "close" }],
      plots: [line("long", "Long stop", "#22c55e"), line("short", "Short stop", "#ef4444")],
      calc: (bars, p) => {
        const n = bars.length, atr = map1(rma(trueRange(bars), p.length), (v) => v * p.mult);
        const hh = highest(bars.map((b) => (p.basis === "close" ? b.close : b.high)), p.length), ll = lowest(bars.map((b) => (p.basis === "close" ? b.close : b.low)), p.length);
        const long = nulls(n), short = nulls(n), dir = new Array(n).fill(1);
        let ls = null, ss = null, d = 1;
        for (let i = 0; i < n; i++) {
          if (atr[i] == null || hh[i] == null) continue;
          let l = hh[i] - atr[i], s = ll[i] + atr[i];
          const pl = ls == null ? l : ls, ps = ss == null ? s : ss;
          if (i > 0 && bars[i - 1].close > pl) l = Math.max(l, pl);
          if (i > 0 && bars[i - 1].close < ps) s = Math.min(s, ps);
          d = bars[i].close > ps ? 1 : bars[i].close < pl ? -1 : d;
          ls = l; ss = s; dir[i] = d;
          if (d === 1) long[i] = l; else short[i] = s;
        }
        return { long, short };
      },
    },
    "BollingerBars@tv-basicstudies": {
      name: "Bollinger Bars", pane: "overlay", candleColors: true,
      meta: { cat: "volatility", full: "Bollinger Bars", color: "#2962ff", brief: "Colours each candle by where it closes in the Bollinger Bands",
        explain: "Recolours the candles: green when a candle closes above the upper Bollinger Band, red when it closes below the lower band, grey when it is inside. It shows at a glance when price is stretched outside its normal range. The bands are drawn faintly." },
      inputs: [len(20), SOURCE, flt("mult", "StdDev", 2, 0.1, 10, 0.1)],
      plots: [line("upper", "Upper", "#2962ff", { width: 1, dashed: true }), line("lower", "Lower", "#2962ff", { width: 1, dashed: true })],
      calc: (bars, p) => {
        const x = src(bars, p.source), basis = sma(x, p.length), sd = ta.stdev(x, p.length);
        const upper = basis.map((b, i) => (b == null ? null : b + p.mult * sd[i])), lower = basis.map((b, i) => (b == null ? null : b - p.mult * sd[i]));
        return { upper, lower, candleColors: bars.map((b, i) => (upper[i] == null ? null : b.close > upper[i] ? "#26a69a" : b.close < lower[i] ? "#ef5350" : "#8a8a90")) };
      },
    },
    "VWAPAutoAnchored@tv-basicstudies": {
      name: "VWAP Auto Anchored", short: "AVWAP", pane: "overlay", repaint: true,
      meta: { cat: "trend", full: "VWAP Auto Anchored", color: "#a855f7", brief: "VWAP started from the latest swing high and swing low",
        explain: "Two VWAP lines, one anchored at the most recent swing high (red) and one at the most recent swing low (green). Price often reacts to these lines because they show the average price paid since that turning point." + NOTE },
      inputs: [int("swing", "Swing size (bars each side)", 20, 2, 200)],
      plots: [line("high", "From swing high", "#ef4444"), line("low", "From swing low", "#22c55e")],
      calc: (bars, p) => {
        const sw = ta.swingPivots(bars, p.swing, p.swing), x = src(bars, "hlc3");
        const ph = sw.highs.length ? sw.highs[sw.highs.length - 1] : null, pl = sw.lows.length ? sw.lows[sw.lows.length - 1] : null;
        return { high: ph == null ? nulls(bars.length) : anchoredAverage(bars, x, ph, true), low: pl == null ? nulls(bars.length) : anchoredAverage(bars, x, pl, true) };
      },
    },
    // ---------------------------------------------------------------- needs chart context
    "VisibleAveragePrice@tv-basicstudies": {
      name: "Visible Average Price", short: "VAP", pane: "overlay", needsVisible: true,
      meta: { cat: "trend", full: "Visible Average Price", color: "#f59e0b", brief: "Average price of the candles you can see",
        explain: "A horizontal line at the average price of the candles currently on screen (volume-weighted where there is volume). It moves as you scroll and zoom, so it shows where the middle of whatever you are looking at is." },
      inputs: [{ ...SOURCE, default: "hlc3" }],
      plots: [line("avg", "Visible average", "#f59e0b", { dashed: true, width: 1 })],
      calc: (bars, p, ctx) => {
        const r = (ctx && ctx.visible) || { from: 0, to: bars.length - 1 }, x = src(bars, p.source), hasVol = bars.slice(r.from, r.to + 1).some((b) => b.volume > 0);
        let spv = 0, sv = 0;
        for (let i = r.from; i <= r.to && i < bars.length; i++) { const w = hasVol ? bars[i].volume || 0 : 1; spv += x[i] * w; sv += w; }
        const v = sv > 0 ? spv / sv : null;
        return { avg: bars.map((_, i) => (i >= r.from && i <= r.to ? v : null)) };
      },
    },
    "CorrelationCoefficient@tv-basicstudies": {
      name: "Correlation Coefficient", short: "Corr", pane: "separate", range: [-1, 1], precision: 3, needsSymbol: "symbol",
      meta: { cat: "momentum", full: "Correlation Coefficient", color: "#22d3ee", brief: "How closely this market moves with another",
        explain: "The correlation between this instrument's closes and another instrument's over the last N candles: +1 they move together, -1 they move opposite, 0 unrelated. Pick the instrument to compare with in the settings (the cog next to it on the chart). Useful to avoid doubling up on the same risk." },
      inputs: [{ key: "symbol", label: "Compare with", type: "select", options: ["SPXUSD", "NSXUSD", "DJI", "UK100", "GER40", "JPN225", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "XAUUSD", "XAGUSD", "BTCUSD", "ETHUSD"], default: "SPXUSD" }, len(20), SOURCE],
      plots: [line("cc", "Correlation", "#2962ff")],
      levels: [{ value: 1 }, { value: 0 }, { value: -1 }],
      calc: (bars, p, ctx) => (ctx && ctx.other ? { cc: ta.correlation(src(bars, p.source), ctx.other, p.length) } : { cc: nulls(bars.length) }),
    },
    // ---------------------------------------------------------------- volume
    "Volume24h@tv-basicstudies": {
      name: "24-hour Volume", pane: "separate", format: "volume",
      meta: { cat: "volume", full: "24-hour Volume", color: "#38bdf8", brief: "Total volume traded over the last 24 hours",
        explain: "A rolling total of the volume in the last 24 hours, updated every candle. Handy on markets that trade around the clock." + NOTE },
      inputs: [],
      plots: [line("vol", "24h Volume", "#2962ff")],
      calc: (bars) => {
        let j = 0, s = 0;
        return { vol: bars.map((b, i) => { s += b.volume || 0; while (bars[j].time <= b.time - 86400) { s -= bars[j].volume || 0; j++; } return s; }) };
      },
    },
    "RelativeVolumeAtTime@tv-basicstudies": {
      name: "Relative Volume at Time", short: "RVOL", pane: "separate", precision: 2,
      meta: { cat: "volume", full: "Relative Volume at Time", color: "#34d399", brief: "Volume compared with the same time on recent days",
        explain: "Divides each candle's volume by the average volume of the same time of day over the previous N days. Above 1 means unusually busy for that time; well below 1 means quiet. On daily charts it compares with the previous N candles." + NOTE },
      inputs: [int("days", "Days to average", 10, 1, 100)],
      plots: [{ key: "rvol", label: "RVOL", type: "histogram", color: "#26a69a" }],
      levels: [{ value: 1 }],
      calc: (bars, p) => {
        const daily = ta.barSeconds(bars) >= 86400, hist = new Map(), rvol = nulls(bars.length), colors = nulls(bars.length);
        bars.forEach((b, i) => {
          const v = b.volume || 0;
          let avg = null;
          if (daily) { const from = Math.max(0, i - p.days); if (i > 0) { let s = 0; for (let k = from; k < i; k++) s += bars[k].volume || 0; avg = s / (i - from); } }
          else { const key = b.time % 86400, h = hist.get(key) || []; if (h.length) avg = h.reduce((a, c) => a + c, 0) / h.length; h.push(v); if (h.length > p.days) h.shift(); hist.set(key, h); }
          if (avg > 0) { rvol[i] = v / avg; colors[i] = rvol[i] >= 1 ? "#26a69a" : "#8a8a90"; }
        });
        return { rvol, colors: { rvol: colors } };
      },
    },
    "VolumeDelta@tv-basicstudies": {
      name: "Volume Delta", pane: "separate", format: "volume",
      meta: { cat: "volume", full: "Volume Delta (estimated)", color: "#26a69a", brief: "Buying volume minus selling volume per candle",
        explain: "Each candle's volume counted as buying if the candle closed up and selling if it closed down. This is an estimate from candle direction — a true delta needs tick-by-tick data, which IPFX's history does not have." + NOTE },
      inputs: [],
      plots: [{ key: "delta", label: "Delta", type: "histogram", upColor: "#26a69a", downColor: "#ef5350" }],
      levels: [{ value: 0 }],
      calc: (bars) => ({ delta: bars.map((b) => (b.close > b.open ? b.volume || 0 : b.close < b.open ? -(b.volume || 0) : 0)) }),
    },
    "CumulativeVolumeDelta@tv-basicstudies": {
      name: "Cumulative Volume Delta", short: "CVD", pane: "separate", format: "volume",
      meta: { cat: "volume", full: "Cumulative Volume Delta (estimated)", color: "#14b8a6", brief: "Running total of buying minus selling volume",
        explain: "The running total of Volume Delta. A rising line means buyers have been dominating; divergence between CVD and price can warn of a turn. Estimated from candle direction rather than tick data." + NOTE },
      inputs: [],
      plots: [line("cvd", "CVD", "#2962ff")],
      calc: (bars) => ({ cvd: ta.cum(bars.map((b) => (b.close > b.open ? b.volume || 0 : b.close < b.open ? -(b.volume || 0) : 0))) }),
    },
    "UpDownVolume@tv-basicstudies": {
      name: "Up/Down Volume", pane: "separate", format: "volume",
      meta: { cat: "volume", full: "Up/Down Volume (estimated)", color: "#4ade80", brief: "Volume on up-candles above zero, on down-candles below",
        explain: "Draws each candle's volume upward (green) if it closed up and downward (red) if it closed down, so you can compare buying and selling volume side by side. Estimated from candle direction." + NOTE },
      inputs: [],
      plots: [{ key: "up", label: "Up volume", type: "histogram", color: "#26a69a" }, { key: "down", label: "Down volume", type: "histogram", color: "#ef5350" }],
      levels: [{ value: 0 }],
      calc: (bars) => ({ up: bars.map((b) => (b.close >= b.open ? b.volume || 0 : 0)), down: bars.map((b) => (b.close < b.open ? -(b.volume || 0) : 0)) }),
    },
    "NegativeVolumeIndex@tv-basicstudies": {
      name: "Negative Volume Index", short: "NVI", pane: "separate", precision: 2,
      meta: { cat: "volume", full: "Negative Volume Index", color: "#a78bfa", brief: "Follows price only on days volume falls",
        explain: "Changes only on candles where volume fell from the previous one — the idea being that 'smart money' acts on quiet days. The slow signal line (EMA 255) marks the long-term direction: NVI above it has historically favoured bulls." + NOTE },
      inputs: [int("signal", "Signal length", 255, 2, 1000)],
      plots: [line("nvi", "NVI", "#2962ff"), line("signal", "Signal", "#f97316", { width: 1 })],
      calc: (bars, p) => {
        let v = 1000; const nvi = bars.map((b, i) => { if (i > 0 && (b.volume || 0) < (bars[i - 1].volume || 0) && bars[i - 1].close) v += v * (b.close / bars[i - 1].close - 1); return v; });
        return { nvi, signal: ema(nvi, p.signal) };
      },
    },
    "PositiveVolumeIndex@tv-basicstudies": {
      name: "Positive Volume Index", short: "PVI", pane: "separate", precision: 2,
      meta: { cat: "volume", full: "Positive Volume Index", color: "#c084fc", brief: "Follows price only when volume rises",
        explain: "The mirror image of the Negative Volume Index: it changes only on candles where volume rose, reflecting what the crowd is doing. Read it against its slow signal line." + NOTE },
      inputs: [int("signal", "Signal length", 255, 2, 1000)],
      plots: [line("pvi", "PVI", "#2962ff"), line("signal", "Signal", "#f97316", { width: 1 })],
      calc: (bars, p) => {
        let v = 1000; const pvi = bars.map((b, i) => { if (i > 0 && (b.volume || 0) > (bars[i - 1].volume || 0) && bars[i - 1].close) v += v * (b.close / bars[i - 1].close - 1); return v; });
        return { pvi, signal: ema(pvi, p.signal) };
      },
    },
    "PercentageVolumeOscillator@tv-basicstudies": {
      name: "Percentage Volume Oscillator", short: "PVO", pane: "separate", precision: 2,
      meta: { cat: "volume", full: "Percentage Volume Oscillator", color: "#0ea5e9", brief: "MACD, but of volume",
        explain: "The gap between a fast and slow average of volume, as a percentage, with a signal line and histogram. Rising above zero means volume is expanding; a price move on rising PVO has more conviction." + NOTE },
      inputs: [int("fast", "Fast length", 12), int("slow", "Slow length", 26), int("signal", "Signal length", 9)],
      plots: [{ key: "hist", label: "Histogram", type: "histogram", upColor: "#26a69a", downColor: "#ef5350" }, line("pvo", "PVO", "#2962ff"), line("signal", "Signal", "#ff6d00")],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const v = bars.map((b) => b.volume || 0), slow = ema(v, p.slow);
        const pvo = map2(ema(v, p.fast), slow, (a, b) => (b === 0 ? null : (100 * (a - b)) / b)), signal = ema(pvo, p.signal);
        return { pvo, signal, hist: map2(pvo, signal, (a, b) => a - b) };
      },
    },
    // ---------------------------------------------------------------- calendar / session markers
    "MoonPhases@tv-basicstudies": {
      name: "Moon Phases", pane: "overlay",
      meta: { cat: "structure", full: "Moon Phases", color: "#fbbf24", brief: "Marks new moons and full moons",
        explain: "Marks the candles in which a new moon (grey dot at the low) or full moon (yellow dot at the high) occurs. Some traders look for lunar-cycle patterns; there is no proven link to price, so treat it as a curiosity. Timing is the mean lunar cycle, accurate to within about half a day." },
      inputs: [],
      plots: [{ key: "newMoon", label: "New moon", type: "dots", color: "#9ca3af" }, { key: "fullMoon", label: "Full moon", type: "dots", color: "#fbbf24" }],
      calc: (bars) => {
        const dt = ta.barSeconds(bars), n = bars.length, newMoon = nulls(n), fullMoon = nulls(n), half = SYNODIC / 2;
        bars.forEach((b, i) => {
          const a0 = moonAge(b.time), a1 = moonAge(b.time + dt);
          if (a1 < a0) newMoon[i] = b.low;
          else if (a0 < half && a1 >= half) fullMoon[i] = b.high;
        });
        return { newMoon, fullMoon };
      },
    },
    "Gaps@tv-basicstudies": {
      name: "Gaps", pane: "overlay",
      meta: { cat: "structure", full: "Gaps", color: "#f472b6", brief: "Marks candles that open in a price gap",
        explain: "Marks candles whose whole range sits above the previous candle's high (gap up, green dot at the low) or below the previous candle's low (gap down, red dot at the high), when the gap is at least the minimum size. Gaps often get 'filled' later." },
      inputs: [flt("minPercent", "Minimum gap %", 0.1, 0, 50, 0.05)],
      plots: [{ key: "up", label: "Gap up", type: "dots", color: "#22c55e" }, { key: "down", label: "Gap down", type: "dots", color: "#ef4444" }],
      calc: (bars, p) => {
        const n = bars.length, up = nulls(n), down = nulls(n);
        for (let i = 1; i < n; i++) {
          const prev = bars[i - 1], b = bars[i];
          if (b.low > prev.high && ((b.low - prev.high) / prev.high) * 100 >= p.minPercent) up[i] = b.low;
          else if (b.high < prev.low && ((prev.low - b.high) / prev.low) * 100 >= p.minPercent) down[i] = b.high;
        }
        return { up, down };
      },
    },
    "TradingSessions@tv-basicstudies": {
      name: "Trading Sessions", pane: "overlay", range: [0, 1],
      meta: { cat: "structure", full: "Trading Sessions", color: "#3b82f6", brief: "Shades the Asian, London and New York sessions",
        explain: "Shades the chart background for the three main forex sessions: Asia (blue, 00:00–08:00 UTC), London (amber, 08:00–16:00) and New York (red, 13:00–21:00, over London where they overlap). Fixed UTC times, so daylight-saving shifts of an hour are not reflected. Only on intraday charts." },
      inputs: [],
      plots: [{ key: "sessions", label: "Sessions", type: "histogram", color: "#3b82f617", scale: "sessions", scaleMargins: { top: 0, bottom: 0 }, hideValue: true }],
      calc: (bars) => {
        const intraday = ta.barSeconds(bars) < 86400, vals = nulls(bars.length), colors = nulls(bars.length);
        if (intraday) bars.forEach((b, i) => {
          const h = (b.time % 86400) / 3600;
          const c = h >= 13 && h < 21 ? "#ef444417" : h >= 8 && h < 16 ? "#f59e0b17" : h < 8 ? "#3b82f617" : null;
          if (c) { vals[i] = 1; colors[i] = c; }
        });
        return { sessions: vals, colors: { sessions: colors } };
      },
    },
    // ---------------------------------------------------------------- auto-drawn levels and lines
    "AutoFibRetracement@tv-basicstudies": {
      name: "Auto Fib Retracement", pane: "overlay", repaint: true,
      meta: { cat: "structure", full: "Auto Fib Retracement", color: "#f59e0b", brief: "Fibonacci levels on the latest swing",
        explain: "Finds the most recent swing (using the ZigZag) and draws the Fibonacci retracement levels — 23.6%, 38.2%, 50%, 61.8%, 78.6% — from its start to the newest candle. Traders watch these levels for pullbacks to end. The swing updates as price makes new extremes." },
      inputs: [flt("deviation", "Swing deviation %", 3, 0.05, 100, 0.05)],
      plots: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((lv, k) => line("l" + k, lv * 100 + "%", FIB_COLORS[k], { width: 1 })),
      calc: (bars, p) => {
        const piv = ta.zigzagPivots(bars, p.deviation), n = bars.length, out = {};
        const [i1, p1] = piv.length >= 2 ? piv[piv.length - 2] : [null, null], [, p2] = piv.length >= 2 ? piv[piv.length - 1] : [null, null];
        [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].forEach((lv, k) => { out["l" + k] = i1 == null ? nulls(n) : levelFrom(n, i1, p2 + (p1 - p2) * lv); });
        return out;
      },
    },
    "AutoFibExtension@tv-basicstudies": {
      name: "Auto Fib Extension", pane: "overlay", repaint: true,
      meta: { cat: "structure", full: "Auto Fib Extension", color: "#eab308", brief: "Fibonacci targets projected from the latest three swings",
        explain: "Takes the last three ZigZag swing points (A, B, C) and projects the A→B move from C at Fibonacci ratios (61.8%, 100%, 127.2%, 161.8%, 261.8%) to suggest where a continuing move may reach." },
      inputs: [flt("deviation", "Swing deviation %", 3, 0.05, 100, 0.05)],
      plots: [0, 0.618, 1, 1.272, 1.618, 2.618].map((r, k) => line("e" + k, r * 100 + "%", FIB_COLORS[k], { width: 1 })),
      calc: (bars, p) => {
        const piv = ta.zigzagPivots(bars, p.deviation), n = bars.length, out = {};
        const ok = piv.length >= 3, A = ok && piv[piv.length - 3], B = ok && piv[piv.length - 2], C = ok && piv[piv.length - 1];
        [0, 0.618, 1, 1.272, 1.618, 2.618].forEach((r, k) => { out["e" + k] = ok ? levelFrom(n, C[0], C[1] + (B[1] - A[1]) * r) : nulls(n); });
        return out;
      },
    },
    "AutoKeyLevels@tv-basicstudies": {
      name: "Auto Key Levels", pane: "overlay", repaint: true,
      meta: { cat: "structure", full: "Auto Key Levels", color: "#94a3b8", brief: "Horizontal lines at the last three swing highs and lows",
        explain: "Draws a level at each of the last three swing highs (red) and swing lows (green), running from the swing to the newest candle. Price tends to react at levels it has turned from before. A simple version of automatic support and resistance." },
      inputs: [int("swing", "Swing size (bars each side)", 10, 2, 100)],
      plots: [line("r1", "Resistance 1", "#ef4444", { width: 1 }), line("r2", "Resistance 2", "#f87171", { width: 1 }), line("r3", "Resistance 3", "#fca5a5", { width: 1 }),
        line("s1", "Support 1", "#22c55e", { width: 1 }), line("s2", "Support 2", "#4ade80", { width: 1 }), line("s3", "Support 3", "#86efac", { width: 1 })],
      calc: (bars, p) => {
        const sw = ta.swingPivots(bars, p.swing, p.swing), n = bars.length, out = {};
        for (let k = 0; k < 3; k++) {
          const h = sw.highs[sw.highs.length - 1 - k], l = sw.lows[sw.lows.length - 1 - k];
          out["r" + (k + 1)] = h == null ? nulls(n) : levelFrom(n, h, bars[h].high);
          out["s" + (k + 1)] = l == null ? nulls(n) : levelFrom(n, l, bars[l].low);
        }
        return out;
      },
    },
    "AutoPitchfork@tv-basicstudies": {
      name: "Auto Pitchfork", pane: "overlay", repaint: true,
      meta: { cat: "structure", full: "Auto Pitchfork", color: "#6366f1", brief: "Andrews' pitchfork on the latest three swings",
        explain: "Takes the last three ZigZag swing points and draws Andrews' pitchfork: a median line from the first through the midpoint of the other two, with parallel lines through each. Price often travels within the fork and reacts at its lines." },
      inputs: [flt("deviation", "Swing deviation %", 3, 0.05, 100, 0.05)],
      plots: [line("median", "Median", "#6366f1"), line("upper", "Upper", "#94a3b8", { width: 1 }), line("lower", "Lower", "#94a3b8", { width: 1 })],
      calc: (bars, p) => {
        const piv = ta.zigzagPivots(bars, p.deviation), n = bars.length;
        if (piv.length < 3) return { median: nulls(n), upper: nulls(n), lower: nulls(n) };
        const [A, B, C] = piv.slice(-3), mi = (B[0] + C[0]) / 2, mp = (B[1] + C[1]) / 2, slope = (mp - A[1]) / (mi - A[0]);
        const hi = B[1] >= C[1] ? B : C, lo = B[1] >= C[1] ? C : B;
        return { median: lineFrom(n, A[0], A[1], slope), upper: lineFrom(n, hi[0], hi[1], slope), lower: lineFrom(n, lo[0], lo[1], slope) };
      },
    },
    "AutoTrendlines@tv-basicstudies": {
      name: "Auto Trendlines", pane: "overlay", repaint: true,
      meta: { cat: "structure", full: "Auto Trendlines", color: "#64748b", brief: "Lines through the last two swing highs and last two swing lows",
        explain: "Draws a resistance line through the last two swing highs (red) and a support line through the last two swing lows (green), extended to the newest candle. A close beyond a trendline is often read as a breakout." },
      inputs: [int("swing", "Swing size (bars each side)", 10, 2, 100)],
      plots: [line("res", "Resistance", "#ef4444"), line("sup", "Support", "#22c55e")],
      calc: (bars, p) => {
        const sw = ta.swingPivots(bars, p.swing, p.swing), n = bars.length;
        const through = (idx, key) => {
          if (idx.length < 2) return nulls(n);
          const i1 = idx[idx.length - 2], i2 = idx[idx.length - 1];
          return lineFrom(n, i1, bars[i1][key], (bars[i2][key] - bars[i1][key]) / (i2 - i1));
        };
        return { res: through(sw.highs, "high"), sup: through(sw.lows, "low") };
      },
    },
  });
})(typeof window !== "undefined" ? window : globalThis);
