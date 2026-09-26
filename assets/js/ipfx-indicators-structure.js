// IPFX Markets indicators — market structure: pivot levels, swing points, fractals, zig-zag.
(function (root) {
  "use strict";
  const IND = typeof module !== "undefined" && module.exports ? require("./ipfx-indicators.js") : root.IPFX_INDICATORS;
  const { ta } = IND;

  const int = (key, label, d, min = 1, max = 500) => ({ key, label, type: "int", default: d, min, max });
  const flt = (key, label, d, min, max, step) => ({ key, label, type: "float", default: d, min, max, step });
  const lv = (key, label, color) => ({ key, label, type: "line", color, width: 1, breakOnChange: true });

  function bucket(time, period) {
    const day = Math.floor(time / 86400);
    if (period === "week") return Math.floor((day + 3) / 7); // Monday-start weeks
    if (period === "month") { const d = new Date(time * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }
    return day;
  }
  // Each bar gets the levels worked out from the PREVIOUS period's high, low, open and close.
  function pivotLevels(kind, q) {
    const { H, L, C, O } = q, R = H - L, P = (H + L + C) / 3;
    const none = { pp: null, r1: null, r2: null, r3: null, s1: null, s2: null, s3: null };
    switch (kind) {
      case "fibonacci":
        return { pp: P, r1: P + 0.382 * R, r2: P + 0.618 * R, r3: P + R, s1: P - 0.382 * R, s2: P - 0.618 * R, s3: P - R };
      case "classic":
        return { pp: P, r1: 2 * P - L, r2: P + R, r3: P + 2 * R, s1: 2 * P - H, s2: P - R, s3: P - 2 * R };
      case "woodie": {
        const W = (H + L + 2 * C) / 4;
        return { ...none, pp: W, r1: 2 * W - L, r2: W + R, s1: 2 * W - H, s2: W - R };
      }
      case "camarilla":
        return { pp: P, r1: C + (R * 1.1) / 12, r2: C + (R * 1.1) / 6, r3: C + (R * 1.1) / 4, s1: C - (R * 1.1) / 12, s2: C - (R * 1.1) / 6, s3: C - (R * 1.1) / 4 };
      case "dm": {
        const X = C < O ? H + 2 * L + C : C > O ? 2 * H + L + C : H + L + 2 * C;
        return { ...none, pp: X / 4, r1: X / 2 - L, s1: X / 2 - H };
      }
      default: // traditional
        return { pp: P, r1: 2 * P - L, r2: P + R, r3: H + 2 * (P - L), s1: 2 * P - H, s2: P - R, s3: L - 2 * (H - P) };
    }
  }

  IND.register({
    "PivotPointsStandard@tv-basicstudies": {
      name: "Pivot Points", short: "Pivots", pane: "overlay",
      inputs: [
        { key: "kind", label: "Type", type: "select", options: ["traditional", "fibonacci", "classic", "woodie", "camarilla", "dm"], default: "traditional" },
        { key: "period", label: "Timeframe", type: "select", options: ["auto", "day", "week", "month"], default: "auto" },
      ],
      plots: [
        lv("r3", "R3", "#b91c1c"), lv("r2", "R2", "#dc2626"), lv("r1", "R1", "#f87171"), lv("pp", "PP", "#9ca3af"),
        lv("s1", "S1", "#4ade80"), lv("s2", "S2", "#22c55e"), lv("s3", "S3", "#15803d"),
      ],
      calc: (bars, p) => {
        const dt = ta.barSeconds(bars);
        const period = p.period !== "auto" ? p.period : dt < 86400 ? "day" : dt <= 86400 * 1.5 ? "week" : "month";
        const out = { pp: [], r1: [], r2: [], r3: [], s1: [], s2: [], s3: [] };
        let key = null, cur = null, prev = null, levels = null;
        for (const b of bars) {
          const k = bucket(b.time, period);
          if (k !== key) {
            if (cur) { prev = cur; levels = pivotLevels(p.kind, prev); }
            key = k; cur = { H: b.high, L: b.low, O: b.open, C: b.close };
          } else { cur.H = Math.max(cur.H, b.high); cur.L = Math.min(cur.L, b.low); cur.C = b.close; }
          for (const name in out) out[name].push(levels ? levels[name] : null);
        }
        return out;
      },
    },
    "PivotPointsHighLow@tv-basicstudies": {
      name: "Pivot Points High Low", short: "Swing H/L", pane: "overlay", repaint: true,
      meta: { cat: "structure", full: "Pivot Points High Low", color: "#f472b6", brief: "Marks recent swing highs and swing lows",
        explain: "Puts a dot on every candle whose high is the highest (or low the lowest) of the N candles either side. These are the swing points traders use for support, resistance and stops. A swing is only confirmed N candles after it happens, so the newest ones appear late." },
      inputs: [int("left", "Left bars", 10), int("right", "Right bars", 10)],
      plots: [{ key: "high", label: "Pivot High", type: "dots", color: "#ef4444" }, { key: "low", label: "Pivot Low", type: "dots", color: "#22c55e" }],
      calc: (bars, p) => {
        const n = bars.length, high = new Array(n).fill(null), low = new Array(n).fill(null);
        for (let i = p.left; i < n - p.right; i++) {
          let isH = true, isL = true;
          for (let k = 1; k <= p.left && (isH || isL); k++) { if (bars[i - k].high > bars[i].high) isH = false; if (bars[i - k].low < bars[i].low) isL = false; }
          for (let k = 1; k <= p.right && (isH || isL); k++) { if (bars[i + k].high >= bars[i].high) isH = false; if (bars[i + k].low <= bars[i].low) isL = false; }
          if (isH) high[i] = bars[i].high;
          if (isL) low[i] = bars[i].low;
        }
        return { high, low };
      },
    },
    "WilliamsFractal@tv-basicstudies": {
      name: "Williams Fractal", short: "Fractals", pane: "overlay", repaint: true,
      meta: { cat: "structure", full: "Williams Fractal", color: "#fb7185", brief: "Five-candle turning points",
        explain: "A fractal high is a candle whose high is higher than the two candles on each side; a fractal low is the mirror image. Traders use them as breakout levels and as places for stops. They confirm two candles late." },
      inputs: [int("periods", "Candles each side", 2, 1, 20)],
      plots: [{ key: "up", label: "Up Fractal", type: "dots", color: "#ef4444" }, { key: "down", label: "Down Fractal", type: "dots", color: "#22c55e" }],
      calc: (bars, p) => {
        const n = bars.length, up = new Array(n).fill(null), down = new Array(n).fill(null);
        for (let i = p.periods; i < n - p.periods; i++) {
          let isH = true, isL = true;
          for (let k = 1; k <= p.periods; k++) {
            if (bars[i - k].high >= bars[i].high || bars[i + k].high >= bars[i].high) isH = false;
            if (bars[i - k].low <= bars[i].low || bars[i + k].low <= bars[i].low) isL = false;
          }
          if (isH) up[i] = bars[i].high;
          if (isL) down[i] = bars[i].low;
        }
        return { up, down };
      },
    },
    "ZigZag@tv-basicstudies": {
      name: "ZigZag", pane: "overlay", repaint: true,
      meta: { cat: "structure", full: "ZigZag", color: "#3b82f6", brief: "Connects the major swings, ignoring small moves",
        explain: "Joins the significant highs and lows with straight lines, ignoring any reversal smaller than the deviation percentage. It strips a chart down to its swings. The last leg is provisional and can move until price reverses by the deviation, and past pivots are only known in hindsight." },
      inputs: [flt("deviation", "Deviation %", 5, 0.05, 100, 0.05)],
      plots: [{ key: "zz", label: "ZigZag", type: "line", color: "#2962ff", width: 2 }],
      calc: (bars, p) => {
        const n = bars.length, H = bars.map((b) => b.high), L = bars.map((b) => b.low), dev = p.deviation;
        const pivots = []; // [index, price]
        let mode = 0, hiIdx = 0, hiP = H[0], loIdx = 0, loP = L[0];
        for (let i = 1; i < n; i++) {
          if (mode === 0) {
            if (H[i] > hiP) { hiP = H[i]; hiIdx = i; }
            if (L[i] < loP) { loP = L[i]; loIdx = i; }
            if (loP > 0 && ((hiP - loP) / loP) * 100 >= dev) {
              if (loIdx < hiIdx) { pivots.push([loIdx, loP]); mode = 1; } else { pivots.push([hiIdx, hiP]); mode = -1; }
            }
          } else if (mode === 1) {
            if (H[i] > hiP) { hiP = H[i]; hiIdx = i; }
            else if (((hiP - L[i]) / hiP) * 100 >= dev) { pivots.push([hiIdx, hiP]); mode = -1; loP = L[i]; loIdx = i; }
          } else if (L[i] < loP) { loP = L[i]; loIdx = i; }
          else if (loP > 0 && ((H[i] - loP) / loP) * 100 >= dev) { pivots.push([loIdx, loP]); mode = 1; hiP = H[i]; hiIdx = i; }
        }
        if (mode === 1) pivots.push([hiIdx, hiP]); else if (mode === -1) pivots.push([loIdx, loP]);
        const zz = new Array(n).fill(null);
        for (let k = 0; k < pivots.length - 1; k++) {
          const [i0, p0] = pivots[k], [i1, p1] = pivots[k + 1];
          for (let i = i0; i <= i1; i++) zz[i] = i1 === i0 ? p0 : p0 + ((p1 - p0) * (i - i0)) / (i1 - i0);
        }
        return { zz };
      },
    },
  });
})(typeof window !== "undefined" ? window : globalThis);
