// IPFX Markets indicators — ICT extras (opening gaps, displacement, round-number levels), a
// consensus Technical Rating, and the last built-ins from TradingView's list: Elliott Wave
// Oscillator, Accumulative Swing Index, the range-based volatility estimators, Price Channel,
// Moving Average Channel and Hamming, Session Volume and the log-return correlation.
// Needs ipfx-indicators.js loaded first; causal, like the other families.
(function (root) {
  "use strict";
  const IND = typeof module !== "undefined" && module.exports ? require("./ipfx-indicators.js") : root.IPFX_INDICATORS;
  const { ta, SOURCE, len } = IND;
  const { src, sma, ema, rma, wma, stdev, highest, lowest, trueRange, map2 } = ta;

  const flt = (key, label, d, min, max, step) => ({ key, label, type: "float", default: d, min, max, step });
  const int = (key, label, d, min = 1, max = 500) => ({ key, label, type: "int", default: d, min, max });
  const sel = (key, label, options, d) => ({ key, label, type: "select", options, default: d != null ? d : options[0] });
  const line = (key, label, color, extra) => ({ key, label, type: "line", color, ...extra });
  const nulls = (n) => new Array(n).fill(null);
  const rgba = (rgb, a) => `rgba(${rgb},${a})`;
  const GREEN = "34,197,94", RED = "239,68,68", AMBER = "245,158,11", BLUE = "59,130,246", SLATE = "148,163,184";
  const ANCHOR = [{ key: "anchor", label: "", type: "dots", color: "#94a3b8", hideValue: true }];
  const withAnchor = (map) => { for (const d of Object.values(map)) if (d.plots[0].key === "anchor") { const c = d.calc; d.calc = (bars, p, ctx) => ({ ...c(bars, p, ctx), anchor: new Array(bars.length).fill(null) }); } return map; };
  const last = (a, k) => (k >= a.length ? a.slice() : a.slice(a.length - k));
  const atrOf = (bars, n = 14) => rma(trueRange(bars), n);
  const bucketOf = (time, period) => {
    const day = Math.floor(time / 86400);
    return period === "week" ? Math.floor((day + 3) / 7) : day;
  };

  // Directional movement (Wilder): +DI, -DI and ADX.
  function dmi(bars, n) {
    const up = bars.map((b, i) => (i === 0 ? null : b.high - bars[i - 1].high)), dn = bars.map((b, i) => (i === 0 ? null : bars[i - 1].low - b.low));
    const plus = up.map((u, i) => (u == null ? null : u > dn[i] && u > 0 ? u : 0)), minus = dn.map((d, i) => (d == null ? null : d > up[i] && d > 0 ? d : 0));
    const tr = rma(trueRange(bars), n), pdi = rma(plus, n).map((v, i) => (v == null || !tr[i] ? null : (100 * v) / tr[i])), mdi = rma(minus, n).map((v, i) => (v == null || !tr[i] ? null : (100 * v) / tr[i]));
    const dx = map2(pdi, mdi, (a, b) => (a + b === 0 ? 0 : (100 * Math.abs(a - b)) / (a + b)));
    return { pdi, mdi, adx: rma(dx, n) };
  }
  const hull = (x, n) => wma(map2(wma(x, Math.floor(n / 2)), wma(x, n), (a, b) => 2 * a - b), Math.round(Math.sqrt(n)));

  IND.register(withAnchor({
    // ------------------------------------------------------------- ICT extras
    "OpeningGaps@ipfx": {
      name: "Opening Gaps (NDOG / NWOG)", short: "Opening gaps", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "New Day / New Week Opening Gaps (NDOG, NWOG)", color: "#f59e0b", brief: "The gap between the last close and the next open",
        explain: "Marks the empty space between one period's final close and the next period's first open. Price is often drawn back to close these gaps, and the halfway point (consequent encroachment) is a common reaction level. A gap is dropped once price trades back through it. Days and weeks are UTC (weeks start Monday); forex weekend gaps are the new-week gaps." },
      inputs: [sel("period", "Gap between", ["day", "week"], "week"), flt("minSize", "Minimum gap (× ATR)", 0.1, 0, 5, 0.05), int("show", "Gaps shown", 6, 1, 30), int("atr", "ATR length", 14, 1, 100)],
      plots: ANCHOR,
      calc: (bars, p) => {
        const n = bars.length, atr = atrOf(bars, p.atr), gaps = [];
        let key = null;
        for (let i = 0; i < n; i++) {
          const k = bucketOf(bars[i].time, p.period);
          if (key != null && k !== key && i > 0 && atr[i] != null) {
            const top = Math.max(bars[i].open, bars[i - 1].close), bottom = Math.min(bars[i].open, bars[i - 1].close);
            if (top - bottom >= p.minSize * atr[i] && top > bottom) gaps.push({ a: i, top, bottom, up: bars[i].open > bars[i - 1].close });
          }
          key = k;
          for (const g of gaps) if (g.end == null && g.a < i && bars[i].low <= g.bottom && bars[i].high >= g.top) g.end = i;
        }
        const boxes = [], lines = [];
        for (const g of last(gaps.filter((x) => x.end == null), p.show)) {
          const rgb = g.up ? GREEN : RED, mid = (g.top + g.bottom) / 2;
          boxes.push({ a: g.a, b: null, top: g.top, bottom: g.bottom, fill: rgba(rgb, 0.16), stroke: rgba(rgb, 0.5), label: p.period === "week" ? "NWOG" : "NDOG", labelColor: rgba(rgb, 1) });
          lines.push({ a: g.a, pa: mid, b: null, color: rgba(rgb, 0.7), dash: "dotted", width: 1 });
        }
        return { draw: { boxes, lines } };
      },
    },
    "Displacement@ipfx": {
      name: "Displacement Candles", short: "Displacement", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "Displacement Candles", color: "#a855f7", brief: "Marks unusually large, one-directional candles",
        explain: "A displacement is a candle with a big body (a set multiple of the average true range) and little wick, the footprint of aggressive buying or selling. They often leave fair value gaps behind and mark the start of a move. Up arrows are bullish displacement, down arrows bearish." },
      inputs: [flt("mult", "Body at least (× ATR)", 1.5, 0.5, 10, 0.1), flt("body", "Body share of range", 0.7, 0.3, 1, 0.05), int("atr", "ATR length", 14, 1, 100), int("bars", "Bars scanned", 500, 20, 2000)],
      plots: ANCHOR,
      calc: (bars, p) => {
        const n = bars.length, atr = atrOf(bars, p.atr), texts = [];
        for (let i = Math.max(1, n - p.bars); i < n; i++) {
          const b = bars[i], body = Math.abs(b.close - b.open), rng = b.high - b.low;
          if (atr[i - 1] == null || rng <= 0 || body < p.mult * atr[i - 1] || body / rng < p.body) continue;
          texts.push(b.close > b.open ? { i, price: b.low, text: "▲", color: rgba(GREEN, 1), pos: "below", size: 11 } : { i, price: b.high, text: "▼", color: rgba(RED, 1), pos: "above", size: 11 });
        }
        return { draw: { texts } };
      },
    },
    "RoundNumbers@ipfx": {
      name: "Round Number Levels", short: "Round numbers", pane: "overlay", repaint: true, needsVisible: true,
      meta: { cat: "smc", full: "Round Number (Psychological) Levels", color: "#94a3b8", brief: "Horizontal lines at round prices traders watch",
        explain: "Draws lines at round prices such as 1.1000, 1.1050 or 2,650. Orders cluster at round numbers, so price often stalls, reverses or accelerates there. Leave the spacing on auto to keep about eight lines on screen, or set your own in price units." },
      inputs: [flt("step", "Spacing (price, 0 = auto)", 0, 0, 1000000, 0.0001)],
      plots: ANCHOR,
      calc: (bars, p, ctx) => {
        const r = (ctx && ctx.visible) || { from: 0, to: bars.length - 1 }, from = Math.max(0, r.from), to = Math.min(bars.length - 1, r.to);
        if (to < from || !bars.length) return { draw: { lines: [] } };
        let lo = Infinity, hi = -Infinity;
        for (let i = from; i <= to; i++) { lo = Math.min(lo, bars[i].low); hi = Math.max(hi, bars[i].high); }
        let step = p.step;
        if (!(step > 0)) { const raw = (hi - lo) / 8, mag = Math.pow(10, Math.floor(Math.log10(raw || 1))); step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10; }
        if (!(step > 0) || (hi - lo) / step > 200) return { draw: { lines: [] } };
        const lines = [];
        for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
          const major = Math.abs(Math.round(v / (step * 5)) * step * 5 - v) < step * 1e-6;
          lines.push({ a: from, pa: v, b: null, color: rgba(SLATE, major ? 0.55 : 0.3), width: 1, dash: major ? undefined : "dotted" });
        }
        return { draw: { lines } };
      },
    },

    // ------------------------------------------------------------- consensus rating
    "TechnicalRating@ipfx": {
      name: "Technical Rating", short: "Rating", pane: "separate", range: [-1, 1], precision: 2,
      meta: { cat: "momentum", full: "Technical Rating (moving averages + oscillators)", color: "#22c55e", brief: "One number summarising what the indicators are saying",
        explain: "Polls moving averages (simple and exponential 10–200, VWMA, Hull) and oscillators (RSI, Stochastic, CCI, ADX/DI, Awesome, Momentum, MACD, Williams %R, Ultimate) and averages their votes into a score from −1 (all say sell) to +1 (all say buy). Above 0.5 is Strong Buy, 0.1 to 0.5 Buy, −0.1 to 0.1 Neutral, and so on. It is a consensus, not a forecast: indicators mostly repeat the same information." },
      inputs: [sel("show", "Show", ["overall", "moving averages", "oscillators"], "overall")],
      plots: [{ key: "rating", label: "Rating", type: "histogram", upColor: "#26a69a", downColor: "#ef5350" }],
      levels: [{ value: 0.5 }, { value: 0.1 }, { value: 0 }, { value: -0.1 }, { value: -0.5 }],
      calc: (bars, p) => {
        const n = bars.length, c = src(bars, "close"), hl2 = src(bars, "hl2"), maVotes = nulls(n), oscVotes = nulls(n);
        const mas = [];
        for (const k of [10, 20, 30, 50, 100, 200]) { mas.push(sma(c, k), ema(c, k)); }
        const vw = map2(sma(bars.map((b, i) => b.close * (b.volume || 1)), 20), sma(bars.map((b) => b.volume || 1), 20), (a, v) => (v ? a / v : null));
        mas.push(vw, hull(c, 9));
        const rs = ta.rsi(c, 14), hh = highest(bars.map((b) => b.high), 14), ll = lowest(bars.map((b) => b.low), 14);
        const kRaw = c.map((v, i) => (hh[i] == null ? null : hh[i] === ll[i] ? 50 : (100 * (v - ll[i])) / (hh[i] - ll[i]))), k = sma(sma(kRaw, 3), 3), d = sma(k, 3);
        const m20 = sma(src(bars, "hlc3"), 20), dev20 = ta.dev(src(bars, "hlc3"), 20), cci = src(bars, "hlc3").map((v, i) => (m20[i] == null || !dev20[i] ? null : (v - m20[i]) / (0.015 * dev20[i])));
        const dm = dmi(bars, 14), ao = map2(sma(hl2, 5), sma(hl2, 34), (a, b) => a - b), mom = c.map((v, i) => (i < 10 ? null : v - c[i - 10]));
        const macd = map2(ema(c, 12), ema(c, 26), (a, b) => a - b), sig = ema(macd, 9), wr = c.map((v, i) => (hh[i] == null ? null : hh[i] === ll[i] ? -50 : (-100 * (hh[i] - v)) / (hh[i] - ll[i])));
        const bp = map2(bars.map((b) => b.high), ema(c, 13), (h, e) => h - e), br = map2(bars.map((b) => b.low), ema(c, 13), (l, e) => l - e);
        for (let i = 1; i < n; i++) {
          let mv = 0, mc = 0;
          for (const m of mas) if (m[i] != null) { mv += c[i] > m[i] ? 1 : c[i] < m[i] ? -1 : 0; mc++; }
          if (mc >= 8) maVotes[i] = mv / mc;
          let ov = 0, oc = 0;
          const vote = (x) => { ov += x; oc++; };
          if (rs[i] != null && rs[i - 1] != null) vote(rs[i] < 30 && rs[i] > rs[i - 1] ? 1 : rs[i] > 70 && rs[i] < rs[i - 1] ? -1 : 0);
          if (k[i] != null && d[i] != null) vote(k[i] < 20 && k[i] > d[i] ? 1 : k[i] > 80 && k[i] < d[i] ? -1 : 0);
          if (cci[i] != null && cci[i - 1] != null) vote(cci[i] < -100 && cci[i] > cci[i - 1] ? 1 : cci[i] > 100 && cci[i] < cci[i - 1] ? -1 : 0);
          if (dm.adx[i] != null && dm.pdi[i] != null) vote(dm.adx[i] > 20 ? (dm.pdi[i] > dm.mdi[i] ? 1 : -1) : 0);
          if (ao[i] != null && ao[i - 1] != null) vote(ao[i] > 0 && ao[i] > ao[i - 1] ? 1 : ao[i] < 0 && ao[i] < ao[i - 1] ? -1 : 0);
          if (mom[i] != null && mom[i - 1] != null) vote(mom[i] > mom[i - 1] ? 1 : mom[i] < mom[i - 1] ? -1 : 0);
          if (macd[i] != null && sig[i] != null) vote(macd[i] > sig[i] ? 1 : macd[i] < sig[i] ? -1 : 0);
          if (wr[i] != null && wr[i - 1] != null) vote(wr[i] < -80 && wr[i] > wr[i - 1] ? 1 : wr[i] > -20 && wr[i] < wr[i - 1] ? -1 : 0);
          if (bp[i] != null && br[i] != null) vote(bp[i] > 0 && bp[i] > bp[i - 1] ? 1 : br[i] < 0 && br[i] < br[i - 1] ? -1 : 0);
          if (oc >= 6) oscVotes[i] = ov / oc;
        }
        const rating = p.show === "moving averages" ? maVotes : p.show === "oscillators" ? oscVotes : map2(maVotes, oscVotes, (a, b) => (a + b) / 2);
        return { rating };
      },
    },

    // ------------------------------------------------------------- built-ins that were missing
    "ElliottWaveOscillator@ipfx": {
      name: "Elliott Wave Oscillator", short: "EWO", pane: "separate", priceUnits: true,
      meta: { cat: "momentum", full: "Elliott Wave Oscillator (EWO)", color: "#22c55e", brief: "The gap between a fast and slow average of the candle midpoints",
        explain: "The difference between a 5-period and a 35-period simple average of (high + low) / 2, drawn as a histogram. Wave 3 typically shows the biggest reading and wave 5 a smaller one, so a shrinking peak while price makes a new high warns the move is tiring." },
      inputs: [int("fast", "Fast", 5), int("slow", "Slow", 35)],
      plots: [{ key: "ewo", label: "EWO", type: "histogram", upColor: "#26a69a", downColor: "#ef5350" }],
      levels: [{ value: 0 }],
      calc: (bars, p) => { const x = src(bars, "hl2"); return { ewo: map2(sma(x, p.fast), sma(x, p.slow), (a, b) => a - b) }; },
    },
    "AccumulativeSwingIndex@ipfx": {
      name: "Accumulative Swing Index", short: "ASI", pane: "separate", priceUnits: true,
      meta: { cat: "momentum", full: "Accumulative Swing Index (ASI)", color: "#3b82f6", brief: "Wilder's running total of how strongly each candle moved",
        explain: "Welles Wilder's Swing Index scores every candle from −100 to +100 for how far it moved and where it closed relative to the last candle; the Accumulative Swing Index is the running total. A rising line confirms an up-trend, and a break of an earlier ASI high or low can confirm a price breakout." },
      inputs: [flt("limit", "Limit move", 0.5, 0.0001, 100000, 0.0001)],
      plots: [line("asi", "ASI", "#3b82f6", { width: 1.5 })],
      calc: (bars, p) => {
        let acc = 0;
        return { asi: bars.map((b, i) => {
          if (i === 0) return 0;
          const q = bars[i - 1], K = Math.max(Math.abs(b.high - q.close), Math.abs(b.low - q.close)), A = Math.abs(b.high - q.close), B = Math.abs(b.low - q.close), C = Math.abs(b.high - b.low), D = Math.abs(q.close - q.open);
          let R = A >= B && A >= C ? A - 0.5 * B + 0.25 * D : B >= A && B >= C ? B - 0.5 * A + 0.25 * D : C + 0.25 * D;
          if (R === 0) return acc;
          const si = (50 * ((b.close - q.close) + 0.5 * (b.close - b.open) + 0.25 * (q.close - q.open)) / R) * (K / p.limit);
          acc += si; return acc;
        }) };
      },
    },
    "RangeVolatility@ipfx": {
      name: "Range-Based Volatility", short: "Range vol", pane: "separate", precision: 2,
      meta: { cat: "volatility", full: "Volatility Estimators (Close-to-Close, Parkinson, Garman-Klass, Rogers-Satchell)", color: "#f97316", brief: "Annualised volatility measured from closes, or from the full candle range",
        explain: "Estimates how much price is moving as an annualised percentage. Close-to-close uses only closes; Parkinson uses each candle's high and low; Garman-Klass and Rogers-Satchell also use the open and close, so they extract more information from each candle. On daily bars the annualising factor is 252; on other timeframes it scales with the number of bars per year." },
      inputs: [int("length", "Length", 20, 2, 500), sel("method", "Method", ["close-to-close", "parkinson", "garman-klass", "rogers-satchell"], "garman-klass"), int("perYear", "Bars per year", 252, 1, 100000)],
      plots: [line("vol", "Volatility %", "#f97316", { width: 1.5 })],
      calc: (bars, p) => {
        const ln = Math.log, r = bars.map((b, i) => (i === 0 || !(b.close > 0) || !(bars[i - 1].close > 0) ? null : ln(b.close / bars[i - 1].close)));
        let v;
        if (p.method === "close-to-close") { const s = stdev(r, p.length); return { vol: s.map((x) => (x == null ? null : 100 * x * Math.sqrt(p.perYear) * Math.sqrt(p.length / (p.length - 1)))) }; }
        if (p.method === "parkinson") v = bars.map((b) => (b.low > 0 && b.high > 0 ? Math.pow(ln(b.high / b.low), 2) / (4 * ln(2)) : null));
        else if (p.method === "garman-klass") v = bars.map((b) => (b.low > 0 && b.open > 0 ? 0.5 * Math.pow(ln(b.high / b.low), 2) - (2 * ln(2) - 1) * Math.pow(ln(b.close / b.open), 2) : null));
        else v = bars.map((b) => (b.low > 0 && b.open > 0 ? ln(b.high / b.close) * ln(b.high / b.open) + ln(b.low / b.close) * ln(b.low / b.open) : null));
        return { vol: sma(v, p.length).map((x) => (x == null ? null : 100 * Math.sqrt(Math.max(0, x) * p.perYear))) };
      },
    },
    "PriceChannel@ipfx": {
      name: "Price Channel", short: "Price Channel", pane: "overlay",
      meta: { cat: "volatility", full: "Price Channel", color: "#3b82f6", brief: "The highest high and lowest low of the last N candles, with the midline",
        explain: "The channel between the highest high and the lowest low of the last N candles, with the middle line halfway. A break above the top or below the bottom is a breakout; the midline is a simple trend guide." },
      inputs: [int("length", "Length", 20)],
      plots: [line("upper", "Upper", "#2962ff", { width: 1 }), line("mid", "Middle", "#ff6d00", { width: 1 }), line("lower", "Lower", "#2962ff", { width: 1 })],
      calc: (bars, p) => { const hi = highest(bars.map((b) => b.high), p.length), lo = lowest(bars.map((b) => b.low), p.length); return { upper: hi, lower: lo, mid: map2(hi, lo, (a, b) => (a + b) / 2) }; },
    },
    "MovingAverageChannel@ipfx": {
      name: "Moving Average Channel", short: "MA Channel", pane: "overlay",
      meta: { cat: "trend", full: "Moving Average Channel", color: "#8b5cf6", brief: "An average of the highs and an average of the lows",
        explain: "Two moving averages, one of the highs and one of the lows, forming a channel around price. Closing above the top suggests strength, below the bottom weakness, and inside it a pause. Offset is added to the upper line and taken from the lower." },
      inputs: [int("length", "Length", 20), sel("type", "Average", ["sma", "ema", "wma"], "sma"), flt("offset", "Offset (%)", 0, 0, 20, 0.1)],
      plots: [line("upper", "Upper", "#8b5cf6", { width: 1.5 }), line("lower", "Lower", "#8b5cf6", { width: 1.5 })],
      calc: (bars, p) => {
        const f = p.type === "ema" ? ema : p.type === "wma" ? wma : sma, k = p.offset / 100;
        return { upper: f(bars.map((b) => b.high), p.length).map((v) => (v == null ? null : v * (1 + k))), lower: f(bars.map((b) => b.low), p.length).map((v) => (v == null ? null : v * (1 - k))) };
      },
    },
    "HammingMA@ipfx": {
      name: "Hamming Moving Average", short: "Hamming MA", pane: "overlay",
      meta: { cat: "trend", full: "Moving Average Hamming", color: "#14b8a6", brief: "An average weighted by a smooth bell-shaped window",
        explain: "A weighted average whose weights follow a Hamming window: gentle at the ends and strongest in the middle of the look-back. That gives a very smooth line that ignores the oldest and newest candles slightly, which reduces noise at the cost of a little lag." },
      inputs: [len(20), SOURCE],
      plots: [line("ma", "Hamming MA", "#14b8a6", { width: 2 })],
      calc: (bars, p) => {
        const x = src(bars, p.source), n = p.length, w = Array.from({ length: n }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1))), sw = w.reduce((s, v) => s + v, 0);
        return { ma: x.map((_, i) => { if (i < n - 1) return null; let s = 0; for (let k = 0; k < n; k++) { const v = x[i - n + 1 + k]; if (v == null) return null; s += v * w[k]; } return s / sw; }) };
      },
    },
    "SessionVolume@ipfx": {
      name: "Session Volume", short: "Session Vol", pane: "separate", format: "volume",
      meta: { cat: "volume", full: "Session Volume", color: "#3b82f6", brief: "Volume added up from the start of each day",
        explain: "A running total of volume that restarts at the beginning of each UTC day, so you can see how busy today has been compared with earlier days at the same time. Forex pairs use the matching CME future's volume where one exists; pairs without one show nothing." },
      inputs: [],
      plots: [{ key: "vol", label: "Session volume", type: "histogram", color: "#3b82f6" }],
      calc: (bars) => { let key = null, acc = 0; return { vol: bars.map((b) => { const k = Math.floor(b.time / 86400); if (k !== key) { key = k; acc = 0; } acc += b.volume || 0; return acc; }) }; },
    },
    "CorrelationLog@ipfx": {
      name: "Correlation - Log", short: "Corr (log)", pane: "separate", range: [-1, 1], precision: 3, needsSymbol: "symbol",
      meta: { cat: "momentum", full: "Correlation Coefficient of Log Returns", color: "#a855f7", brief: "Whether this symbol moves with or against another, by returns",
        explain: "Correlates the candle-to-candle percentage changes (log returns) of this symbol with another, over the last N candles. +1 means they move together, −1 opposite, 0 unrelated. Correlating returns rather than prices avoids the false relationships that trending prices create." },
      inputs: [{ key: "symbol", label: "Compare with", type: "select", options: ["SPXUSD", "NSXUSD", "DJI", "UK100", "GER40", "JPN225", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "XAUUSD", "XAGUSD", "BTCUSD", "ETHUSD"], default: "SPXUSD" }, len(20)],
      plots: [line("cc", "Correlation", "#a855f7", { width: 1.5 })],
      levels: [{ value: 0.5 }, { value: 0 }, { value: -0.5 }],
      calc: (bars, p, ctx) => {
        if (!ctx || !ctx.other) return { cc: nulls(bars.length) };
        const lr = (x) => x.map((v, i) => (i === 0 || !(v > 0) || !(x[i - 1] > 0) ? null : Math.log(v / x[i - 1])));
        return { cc: ta.correlation(lr(bars.map((b) => b.close)), lr(ctx.other), p.length) };
      },
    },
  }));
  IND.plus = { dmi, hull };
  void [ta.sum];
})(typeof window !== "undefined" ? window : globalThis);
