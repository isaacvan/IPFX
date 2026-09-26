// IPFX Markets indicators — volume family.
// Note: the candle history feed has no real volume for most forex pairs and metals (it reads 0),
// so these are informative on crypto, indices and futures. The explanations say so.
(function (root) {
  "use strict";
  const IND = typeof module !== "undefined" && module.exports ? require("./ipfx-indicators.js") : root.IPFX_INDICATORS;
  const { ta, len } = IND;
  const { sma, ema, sum, cum, change, map1, map2 } = ta;

  const int = (key, label, d, min = 1, max = 500) => ({ key, label, type: "int", default: d, min, max });
  const line = (key, label, color, extra) => ({ key, label, type: "line", color, ...extra });
  const vol = (bars) => bars.map((b) => b.volume || 0);
  const NOTE = " Volume is the exchange's for crypto, indices, metals and futures; for the forex majors IPFX uses the matching CME currency future (named in the chart footer); pairs without one, such as GBP/JPY, have none.";
  // Money-flow multiplier x volume for each candle (Chaikin).
  const adTerm = (bars) => bars.map((b) => (b.high === b.low || (b.close === b.high && b.close === b.low) ? 0 : ((2 * b.close - b.low - b.high) / (b.high - b.low)) * (b.volume || 0)));

  IND.register({
    "Volume@tv-basicstudies": {
      name: "Volume", pane: "overlay", format: "volume",
      inputs: [],
      plots: [{ key: "volume", label: "Volume", type: "histogram", upColor: "#26a69a80", downColor: "#ef535080", scale: "volume" }],
      calc: (bars) => ({
        volume: vol(bars),
        colors: { volume: bars.map((b) => (b.close >= b.open ? "#26a69a80" : "#ef535080")) },
      }),
    },
    "OBV@tv-basicstudies": {
      name: "On Balance Volume", short: "OBV", pane: "separate", format: "volume",
      inputs: [],
      plots: [line("obv", "OBV", "#2962ff")],
      calc: (bars) => {
        const ch = change(bars.map((b) => b.close));
        return { obv: cum(ch.map((c, i) => (c > 0 ? bars[i].volume || 0 : c < 0 ? -(bars[i].volume || 0) : 0))) };
      },
    },
    "MF@tv-basicstudies": {
      name: "Money Flow Index", short: "MFI", pane: "separate", range: [0, 100], precision: 2,
      inputs: [len(14)],
      plots: [line("mfi", "MFI", "#7e57c2")],
      levels: [{ value: 80 }, { value: 50 }, { value: 20 }],
      calc: (bars, p) => {
        const x = bars.map((b) => (b.high + b.low + b.close) / 3), ch = change(x), v = vol(bars);
        const upper = sum(x.map((p3, i) => (ch[i] == null ? null : ch[i] <= 0 ? 0 : v[i] * p3)), p.length);
        const lower = sum(x.map((p3, i) => (ch[i] == null ? null : ch[i] >= 0 ? 0 : v[i] * p3)), p.length);
        return { mfi: map2(upper, lower, (u, l) => (u === 0 && l === 0 ? null : l === 0 ? 100 : 100 - 100 / (1 + u / l))) };
      },
    },
    "ACCD@tv-basicstudies": {
      name: "Accumulation/Distribution", short: "A/D", pane: "separate", format: "volume",
      meta: { cat: "volume", full: "Accumulation/Distribution", color: "#10b981", brief: "Running total of volume weighted by where candles close",
        explain: "Adds a candle's volume when it closes near its high and subtracts it when it closes near its low, as a running total. A rising line means buyers are accumulating; a falling line means distribution. Divergence from price is the classic signal." + NOTE },
      inputs: [],
      plots: [line("ad", "A/D", "#2962ff")],
      calc: (bars) => ({ ad: cum(adTerm(bars)) }),
    },
    "ChaikinMoneyFlow@tv-basicstudies": {
      name: "Chaikin Money Flow", short: "CMF", pane: "separate", precision: 3, range: [-1, 1],
      meta: { cat: "volume", full: "Chaikin Money Flow", color: "#34d399", brief: "Buying versus selling pressure, -1 to 1",
        explain: "Over the last N candles, how much of the volume came with closes near the high (buying) versus near the low (selling). Above zero is buying pressure, below zero selling pressure." + NOTE },
      inputs: [len(20)],
      plots: [line("cmf", "CMF", "#43a047")],
      levels: [{ value: 0 }],
      calc: (bars, p) => ({ cmf: map2(sum(adTerm(bars), p.length), sum(vol(bars), p.length), (a, b) => (b === 0 ? null : a / b)) }),
    },
    "ChaikinOscillator@tv-basicstudies": {
      name: "Chaikin Oscillator", short: "CHO", pane: "separate", format: "volume",
      meta: { cat: "volume", full: "Chaikin Oscillator", color: "#22c55e", brief: "Momentum of the Accumulation/Distribution line",
        explain: "The difference between a fast and slow EMA of the Accumulation/Distribution line. Crossing above zero means buying pressure is building; below zero, selling pressure." + NOTE },
      inputs: [int("fast", "Fast length", 3), int("slow", "Slow length", 10)],
      plots: [line("cho", "CHO", "#2962ff")],
      levels: [{ value: 0 }],
      calc: (bars, p) => { const ad = cum(adTerm(bars)); return { cho: map2(ema(ad, p.fast), ema(ad, p.slow), (a, b) => a - b) }; },
    },
    "EaseOfMovement@tv-basicstudies": {
      name: "Ease of Movement", short: "EOM", pane: "separate", precision: 3,
      meta: { cat: "volume", full: "Ease of Movement", color: "#f59e0b", brief: "How easily price moves on the volume traded",
        explain: "Relates the size of price moves to volume: high when price rises easily on light volume, low or negative when it takes heavy volume to move it (or it falls easily). Above zero, price is moving up with ease." + NOTE },
      inputs: [len(14), { key: "div", label: "Divisor", type: "int", default: 10000, min: 1, max: 100000000 }],
      plots: [line("eom", "EOM", "#2962ff")],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const mid = bars.map((b) => (b.high + b.low) / 2), ch = change(mid);
        return { eom: sma(bars.map((b, i) => (ch[i] == null || !b.volume ? null : (p.div * ch[i] * (b.high - b.low)) / b.volume)), p.length) };
      },
    },
    "KlingerOscillator@tv-basicstudies": {
      name: "Klinger Oscillator", short: "KVO", pane: "separate", format: "volume",
      meta: { cat: "volume", full: "Klinger Oscillator", color: "#0ea5e9", brief: "Long-term money flow with short-term sensitivity",
        explain: "Compares the volume flowing in on up-candles versus down-candles using a fast and a slow average, with a signal line. Crossing above the signal suggests money is flowing in." + NOTE },
      inputs: [int("fast", "Fast length", 34), int("slow", "Slow length", 55), int("signal", "Signal length", 13)],
      plots: [line("kvo", "KVO", "#2962ff"), line("signal", "Signal", "#43a047")],
      levels: [{ value: 0 }],
      calc: (bars, p) => {
        const h3 = bars.map((b) => (b.high + b.low + b.close) / 3), ch = change(h3);
        const sv = bars.map((b, i) => (ch[i] == null ? null : ch[i] >= 0 ? b.volume || 0 : -(b.volume || 0)));
        const kvo = map2(ema(sv, p.fast), ema(sv, p.slow), (a, b) => a - b);
        return { kvo, signal: ema(kvo, p.signal) };
      },
    },
    "NetVolume@tv-basicstudies": {
      name: "Net Volume", pane: "separate", format: "volume",
      meta: { cat: "volume", full: "Net Volume", color: "#84cc16", brief: "Volume, positive on up-candles and negative on down-candles",
        explain: "Each candle's volume drawn upward if the close rose and downward if it fell. Shows at a glance whether volume is coming with buying or with selling." + NOTE },
      inputs: [],
      plots: [{ key: "nv", label: "Net Volume", type: "histogram", upColor: "#26a69a", downColor: "#ef5350" }],
      levels: [{ value: 0 }],
      calc: (bars) => { const ch = change(bars.map((b) => b.close)); return { nv: ch.map((c, i) => (c > 0 ? bars[i].volume || 0 : c < 0 ? -(bars[i].volume || 0) : 0)) }; },
    },
    "PriceVolumeTrend@tv-basicstudies": {
      name: "Price Volume Trend", short: "PVT", pane: "separate", format: "volume",
      meta: { cat: "volume", full: "Price Volume Trend", color: "#a3e635", brief: "Running volume total weighted by % price change",
        explain: "Adds a slice of each candle's volume equal to the percentage the price moved. It is like OBV but a big move counts far more than a tiny one. Rising with price confirms a trend." + NOTE },
      inputs: [],
      plots: [line("pvt", "PVT", "#2962ff")],
      calc: (bars) => {
        const c = bars.map((b) => b.close), ch = change(c);
        return { pvt: cum(ch.map((d, i) => (d == null ? null : (d / c[i - 1]) * (bars[i].volume || 0)))) };
      },
    },
    "VolumeOscillator@tv-basicstudies": {
      name: "Volume Oscillator", short: "VO", pane: "separate", precision: 2,
      meta: { cat: "volume", full: "Volume Oscillator", color: "#38bdf8", brief: "Is volume rising or falling?",
        explain: "The difference between a fast and slow average of volume, as a percentage. Above zero volume is expanding (a move has conviction); below zero it is fading." + NOTE },
      inputs: [int("short", "Short length", 5), int("long", "Long length", 10)],
      plots: [{ key: "vo", label: "VO", type: "histogram", upColor: "#26a69a", downColor: "#ef5350" }],
      levels: [{ value: 0 }],
      calc: (bars, p) => { const v = vol(bars), l = ema(v, p.long); return { vo: map2(ema(v, p.short), l, (a, b) => (b === 0 ? null : (100 * (a - b)) / b)) }; },
    },
    "EFI@tv-basicstudies": {
      name: "Elder Force Index", short: "EFI", pane: "separate", format: "volume",
      meta: { cat: "volume", full: "Elder's Force Index", color: "#fb923c", brief: "How much force is behind each price move",
        explain: "Price change times volume, smoothed. Positive means buyers are pushing price up with force; negative, sellers pushing it down. A move on big volume registers more strongly." + NOTE },
      inputs: [len(13)],
      plots: [line("efi", "EFI", "#26a69a")],
      levels: [{ value: 0 }],
      calc: (bars, p) => { const ch = change(bars.map((b) => b.close)); return { efi: ema(ch.map((c, i) => (c == null ? null : c * (bars[i].volume || 0))), p.length) }; },
    },
  });
})(typeof window !== "undefined" ? window : globalThis);
