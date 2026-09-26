// IPFX Markets indicators — momentum family: oscillators, trend-strength and rank/correlation measures.
(function (root) {
  "use strict";
  const IND = typeof module !== "undefined" && module.exports ? require("./ipfx-indicators.js") : root.IPFX_INDICATORS;
  const { ta, SOURCE, len } = IND;
  const { src, sma, ema, rma, wma, stdev, highest, lowest, trueRange, change, sum, back, map1, map2, rsi, correlation } = ta;

  const flt = (key, label, d, min, max, step) => ({ key, label, type: "float", default: d, min, max, step });
  const int = (key, label, d, min = 1, max = 500) => ({ key, label, type: "int", default: d, min, max });
  const line = (key, label, color, extra) => ({ key, label, type: "line", color, ...extra });
  const hist = (key, label, up = "#26a69a", down = "#ef5350") => ({ key, label, type: "histogram", upColor: up, downColor: down });

  const roc = (x, n) => x.map((v, i) => (i < n || v == null || x[i - n] == null || x[i - n] === 0 ? null : (100 * (v - x[i - n])) / x[i - n]));
  const swma = (x) => x.map((_, i) => (i < 3 || [0, 1, 2, 3].some((k) => x[i - k] == null) ? null : (x[i - 3] + 2 * x[i - 2] + 2 * x[i - 1] + x[i]) / 6));
  // True Strength Index as a ratio in [-1, 1]: double-smoothed momentum / double-smoothed |momentum|.
  function tsiRatio(x, long, short) {
    const pc = change(x);
    const num = ema(ema(pc, long), short), den = ema(ema(pc.map((v) => (v == null ? null : Math.abs(v))), long), short);
    return map2(num, den, (a, b) => (b === 0 ? null : a / b));
  }
  // Directional movement (Wilder), as Pine's ta.dmi.
  function dmi(bars, diLen, adxLen) {
    const H = bars.map((b) => b.high), L = bars.map((b) => b.low);
    const up = change(H), dn = change(L).map((v) => (v == null ? null : -v));
    const plusDM = up.map((u, i) => (u == null || dn[i] == null ? null : u > dn[i] && u > 0 ? u : 0));
    const minusDM = up.map((u, i) => (u == null || dn[i] == null ? null : dn[i] > u && dn[i] > 0 ? dn[i] : 0));
    const trur = rma(trueRange(bars), diLen);
    const scale = (d) => rma(d, diLen).map((v, i) => (v == null || trur[i] == null || trur[i] === 0 ? null : (100 * v) / trur[i]));
    const plus = scale(plusDM), minus = scale(minusDM);
    const ratio = plus.map((a, i) => (a == null || minus[i] == null ? null : Math.abs(a - minus[i]) / (a + minus[i] === 0 ? 1 : a + minus[i])));
    return { plus, minus, adx: map1(rma(ratio, adxLen), (v) => 100 * v) };
  }
  // Average ranks (1 = highest) for Spearman correlation.
  function ranksDesc(w) {
    return w.map((v) => {
      let above = 0, equal = 0;
      for (const u of w) { if (u > v) above++; else if (u === v) equal++; }
      return above + (equal + 1) / 2;
    });
  }

  // Spearman rank correlation of the last n values with time, in percent (+100 = every close higher).
  function rci(x, n) {
    return x.map((_, i) => {
      if (i < n - 1) return null;
      const w = [];
      for (let k = 0; k < n; k++) { const v = x[i - k]; if (v == null) return null; w.push(v); } // w[0] = newest
      const pr = ranksDesc(w);
      let d2 = 0;
      for (let k = 0; k < n; k++) d2 += (k + 1 - pr[k]) ** 2;
      return (1 - (6 * d2) / (n * (n * n - 1))) * 100;
    });
  }
  // Aroon up/down: how many bars ago the highest high / lowest low of the last n+1 bars was.
  function aroon(bars, n) {
    const up = new Array(bars.length).fill(null), down = new Array(bars.length).fill(null);
    for (let i = n; i < bars.length; i++) {
      let hi = -Infinity, lo = Infinity, hiAgo = 0, loAgo = 0;
      for (let k = n; k >= 0; k--) { // oldest to newest, so ties keep the newest
        const b = bars[i - k];
        if (b.high >= hi) { hi = b.high; hiAgo = k; }
        if (b.low <= lo) { lo = b.low; loAgo = k; }
      }
      up[i] = (100 * (n - hiAgo)) / n; down[i] = (100 * (n - loAgo)) / n;
    }
    return { up, down };
  }
  ta.rci = rci; ta.aroon = aroon;

  IND.register({
    "WilliamR@tv-basicstudies": {
      name: "Williams %R", short: "%R", pane: "separate", range: [-100, 0], precision: 2,
      inputs: [len(14)],
      plots: [line("wr", "%R", "#7e57c2")],
      levels: [{ value: -20 }, { value: -50 }, { value: -80 }],
      calc: (bars, p) => {
        const hh = highest(bars.map((b) => b.high), p.length), ll = lowest(bars.map((b) => b.low), p.length);
        return { wr: bars.map((b, i) => (hh[i] == null || hh[i] === ll[i] ? null : (-100 * (hh[i] - b.close)) / (hh[i] - ll[i]))) };
      },
    },
    "ADX@tv-basicstudies": {
      name: "ADX", pane: "separate", precision: 2,
      inputs: [int("adxSmoothing", "ADX smoothing", 14), int("diLength", "DI length", 14)],
      plots: [line("adx", "ADX", "#f23645")],
      levels: [{ value: 25 }],
      calc: (bars, p) => ({ adx: dmi(bars, p.diLength, p.adxSmoothing).adx }),
    },
    "DM@tv-basicstudies": {
      name: "DMI", pane: "separate", precision: 2,
      inputs: [int("diLength", "DI length", 14), int("adxSmoothing", "ADX smoothing", 14)],
      plots: [line("plus", "+DI", "#2962ff"), line("minus", "-DI", "#ff6d00"), line("adx", "ADX", "#f23645")],
      levels: [{ value: 25 }],
      calc: (bars, p) => dmi(bars, p.diLength, p.adxSmoothing),
    },
    "AwesomeOscillator@tv-basicstudies": {
      name: "Awesome Oscillator", short: "AO", pane: "separate", priceUnits: true,
      meta: { cat: "momentum", full: "Awesome Oscillator", color: "#26a69a", brief: "Momentum: fast average minus slow average of the midpoint",
        explain: "The difference between a 5-candle and a 34-candle average of each candle's midpoint, drawn as bars. Green bars mean momentum is rising, red bars falling; crossing zero suggests the trend is changing direction." },
      inputs: [int("fast", "Fast length", 5), int("slow", "Slow length", 34)],
      plots: [hist("ao", "AO")],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const x = src(bars, "hl2"), ao = map2(sma(x, p.fast), sma(x, p.slow), (a, b) => a - b);
        return { ao, colors: { ao: ao.map((v, i) => (v == null ? null : i > 0 && ao[i - 1] != null && v < ao[i - 1] ? "#ef5350" : "#26a69a")) } };
      },
    },
    "MOM@tv-basicstudies": {
      name: "Momentum", short: "MOM", pane: "separate", priceUnits: true,
      meta: { cat: "momentum", full: "Momentum", color: "#3b82f6", brief: "Price now minus price N candles ago",
        explain: "How far price has moved over the last N candles. Above zero price is higher than N candles ago; below zero, lower. A rising line means the move is speeding up." },
      inputs: [len(10), SOURCE],
      plots: [line("mom", "MOM", "#2962ff")],
      levels: [{ value: 0 }],
      calc: (bars, p) => { const x = src(bars, p.source); return { mom: map2(x, back(x, p.length), (a, b) => a - b) }; },
    },
    "ROC@tv-basicstudies": {
      name: "Rate of Change", short: "ROC", pane: "separate", precision: 2,
      meta: { cat: "momentum", full: "Rate of Change", color: "#60a5fa", brief: "Percentage move over the last N candles",
        explain: "The percentage change in price over the last N candles. Like Momentum but comparable between instruments because it is a percentage. Extreme readings show moves that may be stretched." },
      inputs: [len(9), SOURCE],
      plots: [line("roc", "ROC", "#2962ff")],
      levels: [{ value: 0 }],
      calc: (bars, p) => ({ roc: roc(src(bars, p.source), p.length) }),
    },
    "StochasticRSI@tv-basicstudies": {
      name: "Stochastic RSI", short: "Stoch RSI", pane: "separate", range: [0, 100], precision: 2,
      meta: { cat: "momentum", full: "Stochastic RSI", color: "#8b5cf6", brief: "A faster, twitchier RSI",
        explain: "Applies the Stochastic formula to the RSI instead of to price, so it swings between 0 and 100 much more often than RSI. Above 80 is overbought, below 20 oversold — good for timing entries inside a trend." },
      inputs: [int("k", "%K smoothing", 3), int("d", "%D smoothing", 3), int("rsiLength", "RSI length", 14), int("stochLength", "Stochastic length", 14), SOURCE],
      plots: [line("k", "%K", "#2962ff"), line("d", "%D", "#ff6d00")],
      levels: [{ value: 80 }, { value: 20 }],
      calc: (bars, p) => {
        const r = rsi(src(bars, p.source), p.rsiLength), hh = highest(r, p.stochLength), ll = lowest(r, p.stochLength);
        const st = r.map((v, i) => (hh[i] == null ? null : hh[i] === ll[i] ? 0 : (100 * (v - ll[i])) / (hh[i] - ll[i])));
        const k = sma(st, p.k);
        return { k, d: sma(k, p.d) };
      },
    },
    "UltimateOsc@tv-basicstudies": {
      name: "Ultimate Oscillator", short: "UO", pane: "separate", range: [0, 100], precision: 2,
      meta: { cat: "momentum", full: "Ultimate Oscillator", color: "#f59e0b", brief: "Buying pressure over three timeframes",
        explain: "Blends buying pressure across a short, medium and long window into one 0–100 line, which reduces false signals. Below 30 suggests oversold, above 70 overbought." },
      inputs: [int("fast", "Fast length", 7), int("mid", "Middle length", 14), int("slow", "Slow length", 28)],
      plots: [line("uo", "UO", "#f23645")],
      levels: [{ value: 70 }, { value: 50 }, { value: 30 }],
      calc: (bars, p) => {
        const bp = bars.map((b, i) => (i === 0 ? null : b.close - Math.min(b.low, bars[i - 1].close)));
        const tr = bars.map((b, i) => (i === 0 ? null : Math.max(b.high, bars[i - 1].close) - Math.min(b.low, bars[i - 1].close)));
        const avg = (n) => map2(sum(bp, n), sum(tr, n), (a, b) => (b === 0 ? null : a / b));
        const a1 = avg(p.fast), a2 = avg(p.mid), a3 = avg(p.slow);
        return { uo: a1.map((v, i) => (v == null || a2[i] == null || a3[i] == null ? null : (100 * (4 * v + 2 * a2[i] + a3[i])) / 7)) };
      },
    },
    "TSI@tv-basicstudies": {
      name: "True Strength Index", short: "TSI", pane: "separate", precision: 2,
      meta: { cat: "momentum", full: "True Strength Index", color: "#06b6d4", brief: "Smoothed momentum from -100 to 100",
        explain: "Momentum that has been smoothed twice, shown from -100 to 100 with a signal line. It cuts through noise: crossing above zero or above the signal line points to rising momentum." },
      inputs: [int("long", "Long length", 25), int("short", "Short length", 13), int("signal", "Signal length", 13), SOURCE],
      plots: [line("tsi", "TSI", "#2962ff"), line("signal", "Signal", "#e91e63")],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const t = map1(tsiRatio(src(bars, p.source), p.long, p.short), (v) => 100 * v);
        return { tsi: t, signal: ema(t, p.signal) };
      },
    },
    "Trix@tv-basicstudies": {
      name: "TRIX", pane: "separate", precision: 4,
      meta: { cat: "momentum", full: "Triple Exponential Average (TRIX)", color: "#10b981", brief: "Rate of change of a triple-smoothed average",
        explain: "Smooths price with three EMAs and plots how fast that smoothed line is changing. Because the noise is filtered out, crossings of zero are slow but reliable signs of a trend change." },
      inputs: [len(18)],
      plots: [line("trix", "TRIX", "#f23645")],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const e = ema(ema(ema(bars.map((b) => Math.log(b.close)), p.length), p.length), p.length);
        return { trix: map1(change(e), (v) => 10000 * v) };
      },
    },
    "KST@tv-basicstudies": {
      name: "Know Sure Thing", short: "KST", pane: "separate", precision: 2,
      meta: { cat: "momentum", full: "Know Sure Thing", color: "#84cc16", brief: "Four rates of change blended into one line",
        explain: "Blends the rate of change over four different periods, smoothed and weighted towards the longer ones. Crossing its signal line or zero suggests a shift in the medium-term trend." },
      inputs: [int("r1", "ROC 1", 10), int("r2", "ROC 2", 15), int("r3", "ROC 3", 20), int("r4", "ROC 4", 30),
        int("s1", "SMA 1", 10), int("s2", "SMA 2", 10), int("s3", "SMA 3", 10), int("s4", "SMA 4", 15), int("signal", "Signal", 9)],
      plots: [line("kst", "KST", "#089981"), line("signal", "Signal", "#f23645")],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const x = bars.map((b) => b.close);
        const a = sma(roc(x, p.r1), p.s1), b = sma(roc(x, p.r2), p.s2), c = sma(roc(x, p.r3), p.s3), d = sma(roc(x, p.r4), p.s4);
        const kst = a.map((v, i) => (v == null || b[i] == null || c[i] == null || d[i] == null ? null : v + 2 * b[i] + 3 * c[i] + 4 * d[i]));
        return { kst, signal: sma(kst, p.signal) };
      },
    },
    "PriceOsc@tv-basicstudies": {
      name: "Price Oscillator", short: "PPO", pane: "separate", precision: 3,
      meta: { cat: "momentum", full: "Price Oscillator (PPO)", color: "#0ea5e9", brief: "MACD as a percentage",
        explain: "The gap between a fast and slow EMA as a percentage of the slow one, with a signal line and histogram. It works like MACD but can be compared between different instruments and price levels." },
      inputs: [int("fast", "Fast length", 12), int("slow", "Slow length", 26), int("signal", "Signal length", 9), SOURCE],
      plots: [hist("hist", "Histogram"), line("ppo", "PPO", "#2962ff"), line("signal", "Signal", "#ff6d00")],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const x = src(bars, p.source), slow = ema(x, p.slow);
        const ppo = map2(ema(x, p.fast), slow, (a, b) => (b === 0 ? null : (100 * (a - b)) / b)), signal = ema(ppo, p.signal);
        return { ppo, signal, hist: map2(ppo, signal, (a, b) => a - b) };
      },
    },
    "ChandeMO@tv-basicstudies": {
      name: "Chande Momentum Oscillator", short: "CMO", pane: "separate", range: [-100, 100], precision: 2,
      meta: { cat: "momentum", full: "Chande Momentum Oscillator", color: "#f43f5e", brief: "Up-moves versus down-moves, from -100 to 100",
        explain: "Compares the total of the up-moves to the total of the down-moves over N candles. Near +100 nearly every candle is up; near -100 nearly every candle is down. Beyond ±50 is usually stretched." },
      inputs: [len(9), SOURCE],
      plots: [line("cmo", "CMO", "#2962ff")],
      levels: [{ value: 50 }, { value: 0 }, { value: -50 }],
      calc: (bars, p) => {
        const ch = change(src(bars, p.source));
        const up = sum(ch.map((v) => (v == null ? null : Math.max(v, 0))), p.length), dn = sum(ch.map((v) => (v == null ? null : Math.max(-v, 0))), p.length);
        return { cmo: map2(up, dn, (a, b) => (a + b === 0 ? null : (100 * (a - b)) / (a + b))) };
      },
    },
    "ConnorsRSI@tv-basicstudies": {
      name: "Connors RSI", short: "CRSI", pane: "separate", range: [0, 100], precision: 2,
      meta: { cat: "momentum", full: "Connors RSI", color: "#a855f7", brief: "Three short-term measures averaged into one RSI",
        explain: "Averages a fast RSI, an RSI of how many candles in a row price has gone up or down, and where the latest change ranks against recent changes. Built for short-term mean-reversion: below ~10 is deeply oversold, above ~90 overbought." },
      inputs: [int("rsiLength", "RSI length", 3), int("streakLength", "Up/down streak length", 2), int("rankLength", "Rate-of-change rank length", 100)],
      plots: [line("crsi", "CRSI", "#2962ff")],
      levels: [{ value: 70 }, { value: 30 }],
      calc: (bars, p) => {
        const x = bars.map((b) => b.close), streak = new Array(x.length).fill(0);
        for (let i = 1; i < x.length; i++) {
          streak[i] = x[i] > x[i - 1] ? (streak[i - 1] <= 0 ? 1 : streak[i - 1] + 1) : x[i] < x[i - 1] ? (streak[i - 1] >= 0 ? -1 : streak[i - 1] - 1) : 0;
        }
        const r1 = rsi(x, p.rsiLength), r2 = rsi(streak.map((v, i) => (i === 0 ? null : v)), p.streakLength), r1c = roc(x, 1);
        const rank = r1c.map((v, i) => {
          if (v == null || i < p.rankLength + 1) return null;
          let c = 0;
          for (let k = 1; k <= p.rankLength; k++) if (r1c[i - k] <= v) c++;
          return (100 * c) / p.rankLength;
        });
        return { crsi: r1.map((a, i) => (a == null || r2[i] == null || rank[i] == null ? null : (a + r2[i] + rank[i]) / 3)) };
      },
    },
    "FisherTransform@tv-basicstudies": {
      name: "Fisher Transform", short: "Fisher", pane: "separate", precision: 3,
      meta: { cat: "momentum", full: "Fisher Transform", color: "#fb7185", brief: "Sharp turning-point signals",
        explain: "Reshapes price into a bell curve so extremes stand out. The line crossing above its trigger (the previous value) suggests turning up; crossing below suggests turning down. Beyond ±1.5 is stretched." },
      inputs: [len(9)],
      plots: [line("fisher", "Fisher", "#2962ff"), line("trigger", "Trigger", "#ff6d00")],
      levels: [{ value: 1.5 }, { value: 0.75 }, { value: 0 }, { value: -0.75 }, { value: -1.5 }],
      calc: (bars, p) => {
        const x = src(bars, "hl2"), hh = highest(x, p.length), ll = lowest(x, p.length);
        const fish = new Array(x.length).fill(null), trigger = new Array(x.length).fill(null);
        let value = 0, f = 0;
        for (let i = 0; i < x.length; i++) {
          if (hh[i] == null) continue;
          const v = 0.66 * ((x[i] - ll[i]) / Math.max(hh[i] - ll[i], 0.001) - 0.5) + 0.67 * value;
          value = v > 0.99 ? 0.999 : v < -0.99 ? -0.999 : v;
          const prev = f;
          f = 0.5 * Math.log((1 + value) / Math.max(1 - value, 0.001)) + 0.5 * f;
          fish[i] = f; trigger[i] = i > 0 && fish[i - 1] != null ? prev : null;
        }
        return { fisher: fish, trigger };
      },
    },
    "VigorIndex@tv-basicstudies": {
      name: "Relative Vigor Index", short: "RVGI", pane: "separate", precision: 4,
      meta: { cat: "momentum", full: "Relative Vigor Index", color: "#22d3ee", brief: "Do candles close near their highs or lows?",
        explain: "In an uptrend candles tend to close higher than they open, in a downtrend lower. RVGI measures that, with a signal line. A cross of the two lines suggests a change in direction." },
      inputs: [len(10)],
      plots: [line("rvgi", "RVGI", "#089981"), line("signal", "Signal", "#f23645")],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const num = swma(bars.map((b) => b.close - b.open)), den = swma(bars.map((b) => b.high - b.low));
        const rvgi = map2(sma(num, p.length), sma(den, p.length), (a, b) => (b === 0 ? null : a / b));
        return { rvgi, signal: swma(rvgi) };
      },
    },
    "VolatilityIndex@tv-basicstudies": {
      name: "Relative Volatility Index", short: "RVI", pane: "separate", range: [0, 100], precision: 2,
      meta: { cat: "momentum", full: "Relative Volatility Index", color: "#c084fc", brief: "RSI, but of volatility",
        explain: "Like RSI, but instead of counting price moves it counts volatility on up-candles versus down-candles. Above 50 volatility is coming from rising prices (bullish); below 50 from falling prices." },
      inputs: [len(10, "StdDev length"), int("smooth", "EMA length", 14), SOURCE],
      plots: [line("rvi", "RVI", "#7e57c2")],
      levels: [{ value: 80 }, { value: 50 }, { value: 20 }],
      calc: (bars, p) => {
        const x = src(bars, p.source), sd = stdev(x, p.length), ch = change(x);
        const upper = ema(sd.map((v, i) => (v == null || ch[i] == null ? null : ch[i] <= 0 ? 0 : v)), p.smooth);
        const lower = ema(sd.map((v, i) => (v == null || ch[i] == null ? null : ch[i] > 0 ? 0 : v)), p.smooth);
        return { rvi: map2(upper, lower, (a, b) => (a + b === 0 ? null : (a / (a + b)) * 100)) };
      },
    },
    "SMIErgodicIndicator@tv-basicstudies": {
      name: "SMI Ergodic Indicator", short: "SMI Erg", pane: "separate", precision: 4,
      meta: { cat: "momentum", full: "SMI Ergodic Indicator", color: "#2dd4bf", brief: "Smoothed momentum with a signal line",
        explain: "William Blau's ergodic indicator: the True Strength Index (as a ratio from -1 to 1) with a signal line. Crossing the signal or zero marks changes in momentum." },
      inputs: [int("long", "Long length", 20), int("short", "Short length", 5), int("signal", "Signal length", 5), SOURCE],
      plots: [line("erg", "Ergodic", "#2962ff"), line("signal", "Signal", "#ff6d00")],
      levels: [{ value: 0 }],
      calc: (bars, p) => { const erg = tsiRatio(src(bars, p.source), p.long, p.short); return { erg, signal: ema(erg, p.signal) }; },
    },
    "SMIErgodicOscillator@tv-basicstudies": {
      name: "SMI Ergodic Oscillator", short: "SMI Osc", pane: "separate", precision: 4,
      meta: { cat: "momentum", full: "SMI Ergodic Oscillator", color: "#14b8a6", brief: "The gap between the ergodic line and its signal",
        explain: "The difference between the SMI Ergodic Indicator and its signal line, drawn as bars. Bars turning from red to green mean momentum is picking up." },
      inputs: [int("long", "Long length", 20), int("short", "Short length", 5), int("signal", "Signal length", 5), SOURCE],
      plots: [hist("osc", "Oscillator")],
      levels: [{ value: 0 }],
      calc: (bars, p) => { const erg = tsiRatio(src(bars, p.source), p.long, p.short); return { osc: map2(erg, ema(erg, p.signal), (a, b) => a - b) }; },
    },
    "StochasticMomentumIndex@tv-basicstudies": {
      name: "Stochastic Momentum Index", short: "SMI", pane: "separate", range: [-100, 100], precision: 2,
      meta: { cat: "momentum", full: "Stochastic Momentum Index", color: "#38bdf8", brief: "Where price closes relative to the middle of its range",
        explain: "Measures where the close sits relative to the midpoint of the recent high-low range (not just the low), giving a smoother stochastic between -100 and 100. Above 40 is overbought, below -40 oversold." },
      inputs: [int("k", "%K length", 10), int("d", "%D length", 3), int("emaLength", "EMA length", 3)],
      plots: [line("smi", "SMI", "#2962ff"), line("signal", "Signal", "#ff6d00")],
      levels: [{ value: 40 }, { value: 0 }, { value: -40 }],
      calc: (bars, p) => {
        const hh = highest(bars.map((b) => b.high), p.k), ll = lowest(bars.map((b) => b.low), p.k);
        const rel = bars.map((b, i) => (hh[i] == null ? null : b.close - (hh[i] + ll[i]) / 2)), rng = map2(hh, ll, (a, b) => a - b);
        const smi = map2(ema(ema(rel, p.d), p.d), ema(ema(rng, p.d), p.d), (a, b) => (b === 0 ? null : (200 * a) / b));
        return { smi, signal: ema(smi, p.emaLength) };
      },
    },
    "CoppockCurve@tv-basicstudies": {
      name: "Coppock Curve", short: "Coppock", pane: "separate", precision: 3,
      meta: { cat: "momentum", full: "Coppock Curve", color: "#fbbf24", brief: "Long-term momentum, used to spot market bottoms",
        explain: "Originally built for spotting market bottoms on monthly charts: a weighted average of two rates of change. A turn upward from below zero has traditionally been read as a buy signal." },
      inputs: [int("wmaLength", "WMA length", 10), int("longRoc", "Long ROC length", 14), int("shortRoc", "Short ROC length", 11), SOURCE],
      plots: [line("cc", "Coppock", "#2962ff")],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const x = src(bars, p.source);
        return { cc: wma(map2(roc(x, p.longRoc), roc(x, p.shortRoc), (a, b) => a + b), p.wmaLength) };
      },
    },
    "DPO@tv-basicstudies": {
      name: "Detrended Price Oscillator", short: "DPO", pane: "separate", priceUnits: true,
      meta: { cat: "momentum", full: "Detrended Price Oscillator", color: "#34d399", brief: "Removes the trend to show cycles",
        explain: "Compares price with an average from about half a period ago, which strips out the long-term trend so the shorter cycles are easier to see. It is for spotting cycle highs and lows, not the trend itself." },
      inputs: [len(21, "Period"), SOURCE],
      plots: [line("dpo", "DPO", "#43a047")],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const x = src(bars, p.source), m = back(sma(x, p.length), Math.floor(p.length / 2) + 1);
        return { dpo: map2(x, m, (a, b) => a - b) };
      },
    },
    "BalanceOfPower@tv-basicstudies": {
      name: "Balance of Power", short: "BoP", pane: "separate", precision: 3,
      meta: { cat: "momentum", full: "Balance of Power", color: "#f97316", brief: "Who is winning each candle: buyers or sellers?",
        explain: "For each candle: (close - open) / (high - low). Near +1 buyers pushed price up the whole candle; near -1 sellers pushed it down. Persistent positive readings show buyers in control." },
      inputs: [],
      plots: [line("bop", "BoP", "#2962ff")],
      levels: [{ value: 0 }],
      calc: (bars) => ({ bop: bars.map((b) => (b.high === b.low ? null : (b.close - b.open) / (b.high - b.low))) }),
    },
    "BullBearPower@tv-basicstudies": {
      name: "Bull Bear Power", short: "BBP", pane: "separate", priceUnits: true,
      meta: { cat: "momentum", full: "Elder-Ray Bull Bear Power", color: "#84cc16", brief: "How far highs and lows reach past the average",
        explain: "Bull power is how far the high goes above a 13-candle EMA (buyers' strength); bear power is how far the low goes below it (sellers' strength). In an uptrend, buy when bear power is negative but rising." },
      inputs: [len(13), SOURCE],
      plots: [{ key: "bull", label: "Bull power", type: "histogram", color: "#26a69a" }, { key: "bear", label: "Bear power", type: "histogram", color: "#ef5350" }],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const e = ema(src(bars, p.source), p.length);
        return { bull: bars.map((b, i) => (e[i] == null ? null : b.high - e[i])), bear: bars.map((b, i) => (e[i] == null ? null : b.low - e[i])) };
      },
    },
    "WoodiesCCI@tv-basicstudies": {
      name: "Woodies CCI", short: "WCCI", pane: "separate", precision: 2,
      meta: { cat: "momentum", full: "Woodies CCI", color: "#f472b6", brief: "A slow and a fast CCI together",
        explain: "Shows a standard 14-period CCI with a faster 6-period 'turbo' CCI. Woodies traders watch for the fast line crossing the slow one and for trades that follow the CCI's side of zero." },
      inputs: [int("cci", "CCI length", 14), int("turbo", "Turbo CCI length", 6)],
      plots: [line("cci", "CCI", "#2962ff"), line("turbo", "Turbo", "#ff6d00", { width: 1 })],
      levels: [{ value: 100 }, { value: 0 }, { value: -100 }],
      calc: (bars, p) => {
        const x = src(bars, "hlc3");
        const c = (n) => { const m = sma(x, n), d = ta.dev(x, n); return x.map((v, i) => (m[i] == null ? null : d[i] === 0 ? 0 : (v - m[i]) / (0.015 * d[i]))); };
        return { cci: c(p.cci), turbo: c(p.turbo) };
      },
    },
    "RankCorrelationIndex@tv-basicstudies": {
      name: "Rank Correlation Index", short: "RCI", pane: "separate", range: [-100, 100], precision: 2,
      meta: { cat: "momentum", full: "Rank Correlation Index", color: "#818cf8", brief: "How steadily price has been rising or falling",
        explain: "Ranks the last N closes by price and by time and measures how well they match (Spearman's rank correlation, from -100 to 100). +100 means every candle closed higher than the last; -100, lower. Above 80 or below -80 is stretched." },
      inputs: [len(9), SOURCE],
      plots: [line("rci", "RCI", "#2962ff")],
      levels: [{ value: 80 }, { value: 0 }, { value: -80 }],
      calc: (bars, p) => ({ rci: rci(src(bars, p.source), p.length) }),
    },
    "TrendStrengthIndex@tv-basicstudies": {
      name: "Trend Strength Index", short: "TSI", pane: "separate", range: [-1, 1], precision: 3,
      meta: { cat: "momentum", full: "Trend Strength Index", color: "#4ade80", brief: "How straight the trend is, from -1 to 1",
        explain: "The correlation between price and time over the last N candles. +1 is a perfectly straight rise, -1 a perfectly straight fall, near 0 no trend at all." },
      inputs: [len(14), SOURCE],
      plots: [line("tsi", "TSI", "#2962ff")],
      levels: [{ value: 0.5 }, { value: 0 }, { value: -0.5 }],
      calc: (bars, p) => ({ tsi: correlation(src(bars, p.source), bars.map((_, i) => i), p.length) }),
    },
    "VortexIndicator@tv-basicstudies": {
      name: "Vortex Indicator", short: "VI", pane: "separate", precision: 3,
      meta: { cat: "momentum", full: "Vortex Indicator", color: "#2dd4bf", brief: "Two lines that cross when the trend changes",
        explain: "VI+ measures upward movement and VI- downward movement. When VI+ crosses above VI- an uptrend is starting; when it crosses below, a downtrend." },
      inputs: [len(14)],
      plots: [line("plus", "VI +", "#2962ff"), line("minus", "VI -", "#e91e63")],
      levels: [{ value: 1 }],
      calc: (bars, p) => {
        const vmp = bars.map((b, i) => (i === 0 ? null : Math.abs(b.high - bars[i - 1].low)));
        const vmm = bars.map((b, i) => (i === 0 ? null : Math.abs(b.low - bars[i - 1].high)));
        const st = sum(trueRange(bars).map((v, i) => (i === 0 ? null : v)), p.length);
        return { plus: map2(sum(vmp, p.length), st, (a, b) => (b === 0 ? null : a / b)), minus: map2(sum(vmm, p.length), st, (a, b) => (b === 0 ? null : a / b)) };
      },
    },
    "Aroon@tv-basicstudies": {
      name: "Aroon", pane: "separate", range: [0, 100], precision: 2,
      meta: { cat: "momentum", full: "Aroon", color: "#fb8c00", brief: "How recently the high and low happened",
        explain: "Aroon Up is 100 when the highest high of the window was this candle, falling as it gets older; Aroon Down does the same for the lowest low. Up above 70 with Down below 30 is a strong uptrend." },
      inputs: [len(14)],
      plots: [line("up", "Aroon Up", "#fb8c00"), line("down", "Aroon Down", "#2962ff")],
      levels: [{ value: 70 }, { value: 50 }, { value: 30 }],
      calc: (bars, p) => aroon(bars, p.length),
    },
  });
})(typeof window !== "undefined" ? window : globalThis);
