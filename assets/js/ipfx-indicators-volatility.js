// IPFX Markets indicators — volatility family: bands, channels, range and choppiness measures.
(function (root) {
  "use strict";
  const IND = typeof module !== "undefined" && module.exports ? require("./ipfx-indicators.js") : root.IPFX_INDICATORS;
  const { ta, SOURCE, len } = IND;
  const { src, sma, ema, rma, stdev, highest, lowest, trueRange, sum, map1, map2, ma } = ta;

  const flt = (key, label, d, min, max, step) => ({ key, label, type: "float", default: d, min, max, step });
  const int = (key, label, d, min = 1, max = 500) => ({ key, label, type: "int", default: d, min, max });
  const line = (key, label, color, extra) => ({ key, label, type: "line", color, ...extra });

  function bands(x, n, mult) {
    const basis = sma(x, n), sd = stdev(x, n);
    return {
      basis,
      upper: basis.map((b, i) => (b == null ? null : b + mult * sd[i])),
      lower: basis.map((b, i) => (b == null ? null : b - mult * sd[i])),
    };
  }

  IND.register({
    "BollingerBandsR@tv-basicstudies": {
      name: "Bollinger %B", short: "%B", pane: "separate", precision: 3,
      meta: { cat: "volatility", full: "Bollinger Bands %B", color: "#2962ff", brief: "Where price sits inside the Bollinger Bands",
        explain: "Shows price's position within the Bollinger Bands as a number: 1 = on the upper band, 0.5 = on the middle line, 0 = on the lower band. Above 1 or below 0 means price has closed outside the bands." },
      inputs: [len(20), SOURCE, flt("mult", "StdDev", 2, 0.1, 10, 0.1)],
      plots: [line("pctb", "%B", "#26a69a")],
      levels: [{ value: 1 }, { value: 0.5 }, { value: 0 }],
      calc: (bars, p) => {
        const x = src(bars, p.source), b = bands(x, p.length, p.mult);
        return { pctb: x.map((v, i) => (b.upper[i] == null || b.upper[i] === b.lower[i] ? null : (v - b.lower[i]) / (b.upper[i] - b.lower[i]))) };
      },
    },
    "BollingerBandsWidth@tv-basicstudies": {
      name: "BB Width", short: "BBW", pane: "separate", precision: 4,
      meta: { cat: "volatility", full: "Bollinger Bands Width", color: "#60a5fa", brief: "How wide the Bollinger Bands are",
        explain: "The distance between the upper and lower Bollinger Bands relative to the middle line. A very low reading (a 'squeeze') often comes before a big move; a high reading means volatility is already elevated." },
      inputs: [len(20), SOURCE, flt("mult", "StdDev", 2, 0.1, 10, 0.1)],
      plots: [line("bbw", "BBW", "#2962ff")],
      calc: (bars, p) => {
        const b = bands(src(bars, p.source), p.length, p.mult);
        return { bbw: b.basis.map((m, i) => (m == null || m === 0 ? null : (b.upper[i] - b.lower[i]) / m)) };
      },
    },
    "KLTNR@tv-basicstudies": {
      name: "Keltner Channels", short: "KC", pane: "overlay",
      meta: { cat: "volatility", full: "Keltner Channels", color: "#06b6d4", brief: "Moving average with ATR-based bands",
        explain: "An average with bands a set number of ATRs above and below. Unlike Bollinger Bands the width follows the average candle size, so it is smoother. Price closing outside the channel signals a strong move." },
      inputs: [len(20), flt("mult", "Multiplier", 2, 0.1, 20, 0.1), { key: "maType", label: "Average", type: "select", options: ["ema", "sma"], default: "ema" }, int("atrLength", "ATR length", 10), SOURCE],
      plots: [line("basis", "Basis", "#2962ff"), line("upper", "Upper", "#2962ff", { width: 1 }), line("lower", "Lower", "#2962ff", { width: 1 })],
      calc: (bars, p) => {
        const basis = ma(p.maType, src(bars, p.source), p.length), atr = rma(trueRange(bars), p.atrLength);
        return { basis, upper: map2(basis, atr, (a, b) => a + p.mult * b), lower: map2(basis, atr, (a, b) => a - p.mult * b) };
      },
    },
    "DONCH@tv-basicstudies": {
      name: "Donchian Channels", short: "DC", pane: "overlay",
      meta: { cat: "volatility", full: "Donchian Channels", color: "#2196f3", brief: "Highest high and lowest low of N candles",
        explain: "Draws the highest high and lowest low of the last N candles with a middle line. A close above the upper line is a breakout to a new N-candle high — the basis of classic 'turtle' trend following." },
      inputs: [len(20)],
      plots: [line("upper", "Upper", "#2196f3"), line("basis", "Basis", "#ff6d00", { width: 1 }), line("lower", "Lower", "#2196f3")],
      calc: (bars, p) => {
        const upper = highest(bars.map((b) => b.high), p.length), lower = lowest(bars.map((b) => b.low), p.length);
        return { upper, lower, basis: map2(upper, lower, (a, b) => (a + b) / 2) };
      },
    },
    "ENV@tv-basicstudies": {
      name: "Envelope", short: "ENV", pane: "overlay",
      meta: { cat: "volatility", full: "Moving Average Envelope", color: "#8b5cf6", brief: "Average with fixed-percentage bands",
        explain: "A moving average with a band a fixed percentage above and below it. Price reaching an outer band is stretched from its average; a persistent ride along a band shows a strong trend." },
      inputs: [len(20), flt("percent", "Percent", 10, 0.01, 100, 0.1), { key: "maType", label: "Average", type: "select", options: ["sma", "ema"], default: "sma" }, SOURCE],
      plots: [line("upper", "Upper", "#2962ff", { width: 1 }), line("basis", "Basis", "#ff6d00"), line("lower", "Lower", "#2962ff", { width: 1 })],
      calc: (bars, p) => {
        const basis = ma(p.maType, src(bars, p.source), p.length);
        return { basis, upper: map1(basis, (v) => v * (1 + p.percent / 100)), lower: map1(basis, (v) => v * (1 - p.percent / 100)) };
      },
    },
    "LinearRegressionChannel@tv-basicstudies": {
      name: "Linear Regression Channel", short: "LRC", pane: "overlay",
      meta: { cat: "volatility", full: "Linear Regression Channel", color: "#14b8a6", brief: "Best-fit trend line with a channel around it",
        explain: "Fits a straight line through the last N candles and draws bands a set number of standard deviations either side. Price at the outer bands is far from the trend line. This rolling version moves with each new candle." },
      inputs: [len(100), flt("mult", "Deviations", 2, 0.1, 10, 0.1), SOURCE],
      plots: [line("upper", "Upper", "#14b8a6", { width: 1 }), line("middle", "Middle", "#ff6d00"), line("lower", "Lower", "#14b8a6", { width: 1 })],
      calc: (bars, p) => {
        const x = src(bars, p.source), n = p.length, m = new Array(x.length).fill(null), sd = new Array(x.length).fill(null);
        const sx = (n * (n - 1)) / 2, sxx = ((n - 1) * n * (2 * n - 1)) / 6;
        for (let i = n - 1; i < x.length; i++) {
          let sy = 0, sxy = 0, ok = true;
          for (let k = 0; k < n; k++) { const v = x[i - n + 1 + k]; if (v == null) { ok = false; break; } sy += v; sxy += k * v; }
          if (!ok) continue;
          const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), icpt = (sy - slope * sx) / n;
          let ss = 0;
          for (let k = 0; k < n; k++) { const r = x[i - n + 1 + k] - (icpt + slope * k); ss += r * r; }
          m[i] = icpt + slope * (n - 1);
          sd[i] = Math.sqrt(ss / n);
        }
        return { middle: m, upper: m.map((v, i) => (v == null ? null : v + p.mult * sd[i])), lower: m.map((v, i) => (v == null ? null : v - p.mult * sd[i])) };
      },
    },
    "ChandeKrollStop@tv-basicstudies": {
      name: "Chande Kroll Stop", short: "CKS", pane: "overlay",
      meta: { cat: "volatility", full: "Chande Kroll Stop", color: "#ef4444", brief: "Two trailing stops, one for longs and one for shorts",
        explain: "Draws a stop for long trades (below price) and one for short trades (above), each based on recent extremes and ATR. A long is protected while price stays above the long stop." },
      inputs: [int("period", "ATR length", 10), flt("mult", "ATR multiplier", 1, 0.1, 20, 0.1), int("stop", "Stop length", 9)],
      plots: [line("short", "Stop Short", "#ef4444", { width: 1 }), line("long", "Stop Long", "#10b981", { width: 1 })],
      calc: (bars, p) => {
        const atr = rma(trueRange(bars), p.period);
        const hh = highest(bars.map((b) => b.high), p.period), ll = lowest(bars.map((b) => b.low), p.period);
        const fhs = map2(hh, atr, (a, b) => a - p.mult * b), fls = map2(ll, atr, (a, b) => a + p.mult * b);
        return { short: highest(fhs, p.stop), long: lowest(fls, p.stop) };
      },
    },
    "HistoricalVolatility@tv-basicstudies": {
      name: "Historical Volatility", short: "HV", pane: "separate", precision: 2,
      meta: { cat: "volatility", full: "Historical Volatility", color: "#f97316", brief: "How much price has been moving, as a yearly %",
        explain: "The standard deviation of recent candle-to-candle returns, scaled to a yearly percentage. Higher means wilder price swings. Useful to size stops and to see when the market is unusually quiet or active." },
      inputs: [len(10)],
      plots: [line("hv", "HV", "#2962ff")],
      calc: (bars, p) => {
        const dt = ta.barSeconds(bars);
        const perYear = dt < 86400 ? (365 * 86400) / dt : dt <= 86400 * 1.5 ? 365 : dt <= 86400 * 8 ? 52 : 12;
        const r = bars.map((b, i) => (i === 0 ? null : Math.log(b.close / bars[i - 1].close)));
        return { hv: map1(stdev(r, p.length), (v) => 100 * v * Math.sqrt(perYear)) };
      },
    },
    "AverageDayRange@tv-basicstudies": {
      name: "Average Range", short: "ADR", pane: "separate", priceUnits: true,
      meta: { cat: "volatility", full: "Average Day Range", color: "#fb923c", brief: "Average high-to-low range of a candle",
        explain: "The average distance from high to low over the last N candles. On a daily chart this is the Average Day Range — how far the market typically moves in a day — handy for setting realistic targets and stops." },
      inputs: [len(14)],
      plots: [line("adr", "ADR", "#2962ff")],
      calc: (bars, p) => ({ adr: sma(bars.map((b) => b.high - b.low), p.length) }),
    },
    "BBTrend@tv-basicstudies": {
      name: "BBTrend", pane: "separate", precision: 2,
      meta: { cat: "volatility", full: "Bollinger BandWidth Trend", color: "#22c55e", brief: "Trend strength from two Bollinger Bands",
        explain: "Compares a short and a long Bollinger Band set. Green bars mean the bands are expanding upward (strong up-move); red bars mean expanding downward. Bars near zero mean no clear trend." },
      inputs: [int("short", "Short length", 20), int("long", "Long length", 50), flt("mult", "StdDev", 2, 0.1, 10, 0.1), SOURCE],
      plots: [{ key: "bbt", label: "BBTrend", type: "histogram", upColor: "#26a69a", downColor: "#ef5350" }],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const x = src(bars, p.source), s = bands(x, p.short, p.mult), l = bands(x, p.long, p.mult);
        return { bbt: x.map((_, i) => (s.basis[i] == null || l.basis[i] == null || s.basis[i] === 0 ? null
          : ((Math.abs(s.lower[i] - l.lower[i]) - Math.abs(s.upper[i] - l.upper[i])) / s.basis[i]) * 100)) };
      },
    },
    "ChoppinessIndex@tv-basicstudies": {
      name: "Choppiness Index", short: "CHOP", pane: "separate", range: [0, 100], precision: 2,
      meta: { cat: "volatility", full: "Choppiness Index", color: "#a78bfa", brief: "Is the market trending or going sideways?",
        explain: "Scores from 0 to 100 how choppy price is. Above 61.8 the market is going sideways (range strategies work); below 38.2 it is trending (trend strategies work). It says nothing about direction." },
      inputs: [len(14)],
      plots: [line("chop", "CHOP", "#2962ff")],
      levels: [{ value: 61.8 }, { value: 38.2 }],
      calc: (bars, p) => {
        const s = sum(trueRange(bars), p.length), hh = highest(bars.map((b) => b.high), p.length), ll = lowest(bars.map((b) => b.low), p.length);
        return { chop: s.map((v, i) => (v == null || hh[i] === ll[i] ? null : (100 * Math.log10(v / (hh[i] - ll[i]))) / Math.log10(p.length))) };
      },
    },
    "MassIndex@tv-basicstudies": {
      name: "Mass Index", short: "MASS", pane: "separate", precision: 2,
      meta: { cat: "volatility", full: "Mass Index", color: "#e879f9", brief: "Spots reversals from widening ranges",
        explain: "Adds up how the high-to-low range is expanding over 25 candles. A 'reversal bulge' is when it rises above 27 and then falls back under 26.5, which can warn of a trend reversal (it does not say which way)." },
      inputs: [len(25)],
      plots: [line("mass", "Mass Index", "#2962ff")],
      levels: [{ value: 27 }, { value: 26.5 }],
      calc: (bars, p) => {
        const r = bars.map((b) => b.high - b.low), e1 = ema(r, 9), e2 = ema(e1, 9);
        return { mass: sum(map2(e1, e2, (a, b) => (b === 0 ? null : a / b)), p.length) };
      },
    },
  });
})(typeof window !== "undefined" ? window : globalThis);
