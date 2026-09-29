// IPFX Markets indicators — Smart Money Concepts and price action: fair value gaps, inverse fair
// value gaps, order and breaker blocks, market structure (BOS / CHoCH), liquidity, premium and
// discount, supply and demand, kill zones, volume profile, auto support and resistance, candle patterns.
//
// These draw zones, rays and labels rather than lines, so their calc returns `draw` next to (or
// instead of) plot arrays: { boxes, lines, texts, hbars } in bar indexes and prices (see the drawings
// section of ipfx-chart.js). Everything is causal: a swing point is used only after enough later bars
// have confirmed it, so nothing is drawn from information the chart could not have had at the time.
(function (root) {
  "use strict";
  const IND = typeof module !== "undefined" && module.exports ? require("./ipfx-indicators.js") : root.IPFX_INDICATORS;
  const { ta } = IND;
  const { rma, trueRange } = ta;

  const int = (key, label, d, min = 1, max = 500) => ({ key, label, type: "int", default: d, min, max });
  const flt = (key, label, d, min, max, step) => ({ key, label, type: "float", default: d, min, max, step });
  const sel = (key, label, options, d) => ({ key, label, type: "select", options, default: d != null ? d : options[0] });
  // Zone indicators have nothing to plot; this invisible line keeps the chart's series bookkeeping simple.
  const ANCHOR = [{ key: "anchor", label: "", type: "dots", color: "#94a3b8", hideValue: true }];
  const GREEN = "34,197,94", RED = "239,68,68", BLUE = "59,130,246", AMBER = "245,158,11", PURPLE = "168,85,247", TEAL = "20,184,166", ORANGE = "249,115,22", SLATE = "148,163,184";
  const rgba = (rgb, a) => `rgba(${rgb},${a})`;
  const atrOf = (bars, n = 14) => rma(trueRange(bars), n);
  const last = (a, k) => (k >= a.length ? a.slice() : a.slice(a.length - k));

  // Bar index j where a swing high (low) of `len` bars either side is CONFIRMED, i.e. the pivot itself
  // sits at j - len. Ties on the left count as pivots, ties on the right do not.
  function confirmedPivots(bars, len) {
    const n = bars.length, hi = new Array(n).fill(false), lo = new Array(n).fill(false);
    for (let j = 2 * len; j < n; j++) {
      const p = j - len;
      let isH = true, isL = true;
      for (let k = 1; k <= len && (isH || isL); k++) {
        if (bars[p - k].high > bars[p].high) isH = false;
        if (bars[p - k].low < bars[p].low) isL = false;
        if (bars[p + k].high >= bars[p].high) isH = false;
        if (bars[p + k].low <= bars[p].low) isL = false;
      }
      hi[j] = isH; lo[j] = isL;
    }
    return { hi, lo };
  }

  // ---------------------------------------------------------------- fair value gaps
  // Three candles where the first candle's high is below the third candle's low leave a bullish gap
  // (the mirror image is bearish). The zone is the gap between those two prices; it starts at the middle
  // candle. Filled when price wicks (or closes) through the far side.
  function scanFvg(bars, minSize, atr, mitigation) {
    const n = bars.length, active = [], done = [];
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      for (let k = active.length - 1; k >= 0; k--) {
        const g = active[k];
        const filled = g.dir > 0 ? (mitigation === "wick" ? b.low <= g.bottom : b.close < g.bottom) : (mitigation === "wick" ? b.high >= g.top : b.close > g.top);
        if (filled) { g.end = i; active.splice(k, 1); done.push(g); }
      }
      if (i >= 2 && atr[i] != null) {
        const a = bars[i - 2];
        if (b.low > a.high && b.low - a.high >= minSize * atr[i]) active.push({ dir: 1, a: i - 1, born: i, top: b.low, bottom: a.high });
        else if (b.high < a.low && a.low - b.high >= minSize * atr[i]) active.push({ dir: -1, a: i - 1, born: i, top: a.low, bottom: b.high });
      }
    }
    return { active, done };
  }
  const fvgBox = (g, b, label, dim) => {
    const rgb = g.dir > 0 ? GREEN : RED;
    return { a: g.a, b, top: g.top, bottom: g.bottom, fill: rgba(rgb, dim ? 0.07 : 0.2), stroke: dim ? null : rgba(rgb, 0.55), label, labelColor: rgba(rgb, 0.95) };
  };

  // ---------------------------------------------------------------- order blocks
  // A close beyond the latest confirmed swing high (low) is a break of structure. The order block is the
  // candle with the lowest low (highest high) between that swing and the break: the last push against the
  // move before it took off. It is used up when price closes (or wicks) through it, and then becomes a
  // breaker: a block that failed and now acts from the other side.
  function scanOrderBlocks(bars, swing, mitigation, bodyOnly) {
    const n = bars.length, piv = confirmedPivots(bars, swing);
    let hi = null, lo = null;
    const obs = [], breakers = [];
    const activeOb = [], activeBr = [];
    for (let j = 0; j < n; j++) {
      const b = bars[j];
      if (piv.hi[j]) hi = { idx: j - swing, price: bars[j - swing].high, crossed: false };
      if (piv.lo[j]) lo = { idx: j - swing, price: bars[j - swing].low, crossed: false };
      // existing blocks first: a block cannot be used up on the bar that created it
      for (let k = activeOb.length - 1; k >= 0; k--) {
        const o = activeOb[k];
        const used = o.dir > 0 ? (mitigation === "wick" ? b.low <= o.bottom : b.close < o.bottom) : (mitigation === "wick" ? b.high >= o.top : b.close > o.top);
        if (used) {
          o.end = j; activeOb.splice(k, 1);
          if (o.dir > 0 ? b.close < o.bottom : b.close > o.top) { const br = { dir: -o.dir, a: o.a, top: o.top, bottom: o.bottom, born: j }; activeBr.push(br); breakers.push(br); }
        }
      }
      for (let k = activeBr.length - 1; k >= 0; k--) {
        const r = activeBr[k];
        if (r.born !== j && (r.dir > 0 ? b.close < r.bottom : b.close > r.top)) { r.end = j; activeBr.splice(k, 1); }
      }
      if (hi && !hi.crossed && b.close > hi.price) {
        hi.crossed = true;
        let m = -1, low = Infinity;
        for (let k = hi.idx; k < j; k++) if (bars[k].low < low) { low = bars[k].low; m = k; }
        if (m >= 0) { const c = bars[m], o = { dir: 1, a: m, born: j, top: bodyOnly ? Math.max(c.open, c.close) : c.high, bottom: bodyOnly ? Math.min(c.open, c.close) : c.low }; obs.push(o); activeOb.push(o); }
      }
      if (lo && !lo.crossed && b.close < lo.price) {
        lo.crossed = true;
        let m = -1, high = -Infinity;
        for (let k = lo.idx; k < j; k++) if (bars[k].high > high) { high = bars[k].high; m = k; }
        if (m >= 0) { const c = bars[m], o = { dir: -1, a: m, born: j, top: bodyOnly ? Math.max(c.open, c.close) : c.high, bottom: bodyOnly ? Math.min(c.open, c.close) : c.low }; obs.push(o); activeOb.push(o); }
      }
    }
    return { obs, breakers };
  }

  const NOTE_ZONES = " Zones are drawn from the candles on your chart, so they update as you change timeframe.";

  // Zone-only indicators have nothing to plot: give them an empty anchor series so the chart can mount them.
  const withAnchor = (map) => { for (const d of Object.values(map)) if (d.plots[0].key === "anchor") { const c = d.calc; d.calc = (bars, p, ctx) => ({ ...c(bars, p, ctx), anchor: new Array(bars.length).fill(null) }); } return map; };
  IND.register(withAnchor({
    "FairValueGap@ipfx": {
      name: "Fair Value Gap", short: "FVG", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "Fair Value Gap (FVG)", color: "#22c55e", brief: "Three-candle imbalances that price tends to come back to fill",
        explain: "When one candle moves so fast that the candle two bars later does not overlap the one before it, the empty space between them is a fair value gap. Green zones are bullish gaps (support below price), red zones are bearish gaps (resistance above). Zones stay on the chart until price fills them." + NOTE_ZONES },
      inputs: [flt("minSize", "Minimum gap (× ATR)", 0.15, 0, 10, 0.05), int("show", "Gaps shown per side", 5, 1, 50), sel("mitigation", "Filled when price", ["wick", "close"], "wick"), sel("history", "Filled gaps", ["hide", "show"], "hide"), int("atr", "ATR length", 14, 1, 100)],
      plots: ANCHOR,
      calc: (bars, p) => {
        const { active, done } = scanFvg(bars, p.minSize, atrOf(bars, p.atr), p.mitigation), boxes = [];
        for (const dir of [1, -1]) {
          for (const g of last(active.filter((x) => x.dir === dir), p.show)) boxes.push(fvgBox(g, null, "FVG", false));
          if (p.history === "show") for (const g of last(done.filter((x) => x.dir === dir), p.show)) boxes.push(fvgBox(g, g.end, "", true));
        }
        return { draw: { boxes } };
      },
    },
    "InverseFairValueGap@ipfx": {
      name: "Inverse Fair Value Gap", short: "IFVG", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "Inverse Fair Value Gap (IFVG)", color: "#a855f7", brief: "Fair value gaps that price closed through, now working the other way",
        explain: "A fair value gap is inverted when a candle closes clean through it. The gap then flips role: a bullish gap that fails becomes resistance (red), a bearish gap that fails becomes support (green). The zone is dropped once price closes back through it." + NOTE_ZONES },
      inputs: [flt("minSize", "Minimum gap (× ATR)", 0.15, 0, 10, 0.05), int("show", "Zones shown per side", 4, 1, 50), sel("history", "Invalidated zones", ["hide", "show"], "hide"), int("atr", "ATR length", 14, 1, 100)],
      plots: ANCHOR,
      calc: (bars, p) => {
        const n = bars.length, atr = atrOf(bars, p.atr), gaps = [], inv = [], activeInv = [];
        for (let i = 0; i < n; i++) {
          const b = bars[i];
          for (let k = activeInv.length - 1; k >= 0; k--) {
            const z = activeInv[k];
            if (z.born !== i && (z.dir > 0 ? b.close < z.bottom : b.close > z.top)) { z.end = i; activeInv.splice(k, 1); }
          }
          for (let k = gaps.length - 1; k >= 0; k--) {
            const g = gaps[k];
            if (g.dir > 0 ? b.close < g.bottom : b.close > g.top) {
              gaps.splice(k, 1);
              const z = { dir: -g.dir, a: i, born: i, top: g.top, bottom: g.bottom, gapAt: g.a };
              inv.push(z); activeInv.push(z);
            }
          }
          if (i >= 2 && atr[i] != null) {
            const a = bars[i - 2];
            if (b.low > a.high && b.low - a.high >= p.minSize * atr[i]) gaps.push({ dir: 1, a: i - 1, top: b.low, bottom: a.high });
            else if (b.high < a.low && a.low - b.high >= p.minSize * atr[i]) gaps.push({ dir: -1, a: i - 1, top: a.low, bottom: b.high });
          }
        }
        const boxes = [];
        for (const dir of [1, -1]) {
          for (const z of last(activeInv.filter((x) => x.dir === dir), p.show)) boxes.push({ a: z.a, b: null, top: z.top, bottom: z.bottom, fill: rgba(dir > 0 ? GREEN : RED, 0.2), stroke: rgba(dir > 0 ? GREEN : RED, 0.7), dash: "dashed", label: "IFVG", labelColor: rgba(dir > 0 ? GREEN : RED, 0.95) });
          if (p.history === "show") for (const z of last(inv.filter((x) => x.dir === dir && x.end != null), p.show)) boxes.push({ a: z.a, b: z.end, top: z.top, bottom: z.bottom, fill: rgba(SLATE, 0.08) });
        }
        return { draw: { boxes } };
      },
    },
    "OrderBlocks@ipfx": {
      name: "Order Blocks", short: "OB", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "Order Blocks (OB)", color: "#3b82f6", brief: "The last opposite candle before a move that broke structure",
        explain: "When price closes beyond the latest swing high or low it breaks structure. The order block is the last candle that pushed the other way before that move started, where larger orders are thought to sit. Blue zones below price are bullish blocks, orange zones above are bearish. A block is dropped once price trades through it." + NOTE_ZONES },
      inputs: [int("swing", "Swing length", 8, 2, 60), int("show", "Blocks shown per side", 5, 1, 30), sel("range", "Block covers", ["full candle", "body only"], "full candle"), sel("mitigation", "Used up when price", ["close", "wick"], "close")],
      plots: ANCHOR,
      calc: (bars, p) => {
        const { obs } = scanOrderBlocks(bars, p.swing, p.mitigation, p.range === "body only"), boxes = [];
        for (const dir of [1, -1]) for (const o of last(obs.filter((x) => x.dir === dir && x.end == null), p.show)) {
          const rgb = dir > 0 ? BLUE : ORANGE;
          boxes.push({ a: o.a, b: null, top: o.top, bottom: o.bottom, fill: rgba(rgb, 0.22), stroke: rgba(rgb, 0.7), label: dir > 0 ? "Bull OB" : "Bear OB", labelColor: rgba(rgb, 1) });
        }
        return { draw: { boxes } };
      },
    },
    "BreakerBlocks@ipfx": {
      name: "Breaker Blocks", short: "Breaker", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "Breaker Blocks", color: "#14b8a6", brief: "Order blocks that failed and now act from the other side",
        explain: "When price closes through an order block, the block has failed. Traders then treat it as a breaker: a failed bullish block becomes resistance and a failed bearish block becomes support. The breaker is dropped when price closes back through it." + NOTE_ZONES },
      inputs: [int("swing", "Swing length", 8, 2, 60), int("show", "Breakers shown per side", 4, 1, 30), sel("range", "Block covers", ["full candle", "body only"], "full candle")],
      plots: ANCHOR,
      calc: (bars, p) => {
        const { breakers } = scanOrderBlocks(bars, p.swing, "close", p.range === "body only"), boxes = [];
        for (const dir of [1, -1]) for (const r of last(breakers.filter((x) => x.dir === dir && x.end == null), p.show)) {
          const rgb = dir > 0 ? TEAL : PURPLE;
          boxes.push({ a: r.a, b: null, top: r.top, bottom: r.bottom, fill: rgba(rgb, 0.2), stroke: rgba(rgb, 0.7), dash: "dashed", label: dir > 0 ? "Bull Breaker" : "Bear Breaker", labelColor: rgba(rgb, 1) });
        }
        return { draw: { boxes } };
      },
    },
    "MarketStructure@ipfx": {
      name: "Market Structure (BOS / CHoCH)", short: "Structure", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "Market Structure (BOS / CHoCH)", color: "#eab308", brief: "Labels breaks of structure and changes of character",
        explain: "A close beyond the last swing high or low is a break of structure (BOS) when it follows the current trend, and a change of character (CHoCH) when it goes against it, the first sign the trend may be turning. Optional labels mark each swing as a higher high (HH), higher low (HL), lower high (LH) or lower low (LL)." },
      inputs: [int("swing", "Swing length", 5, 2, 60), sel("swings", "Swing labels", ["show", "hide"], "show"), int("show", "Breaks shown", 25, 1, 100)],
      plots: ANCHOR,
      calc: (bars, p) => {
        const n = bars.length, piv = confirmedPivots(bars, p.swing), lines = [], texts = [];
        let hi = null, lo = null, prevH = null, prevL = null, trend = 0;
        for (let j = 0; j < n; j++) {
          const b = bars[j];
          if (piv.hi[j]) {
            const idx = j - p.swing, price = bars[idx].high;
            hi = { idx, price, crossed: false };
            if (prevH != null && p.swings === "show") texts.push({ i: idx, price, text: price > prevH ? "HH" : "LH", color: rgba(SLATE, 1), pos: "above", size: 9 });
            prevH = price;
          }
          if (piv.lo[j]) {
            const idx = j - p.swing, price = bars[idx].low;
            lo = { idx, price, crossed: false };
            if (prevL != null && p.swings === "show") texts.push({ i: idx, price, text: price > prevL ? "HL" : "LL", color: rgba(SLATE, 1), pos: "below", size: 9 });
            prevL = price;
          }
          if (hi && !hi.crossed && b.close > hi.price) {
            hi.crossed = true;
            lines.push({ a: hi.idx, pa: hi.price, b: j, pb: hi.price, color: rgba(GREEN, 0.9), dash: "dashed", label: trend === -1 ? "CHoCH" : "BOS" });
            trend = 1;
          }
          if (lo && !lo.crossed && b.close < lo.price) {
            lo.crossed = true;
            lines.push({ a: lo.idx, pa: lo.price, b: j, pb: lo.price, color: rgba(RED, 0.9), dash: "dashed", label: trend === 1 ? "CHoCH" : "BOS" });
            trend = -1;
          }
        }
        return { draw: { lines: last(lines, p.show), texts: last(texts, p.show * 3) } };
      },
    },
    "EqualHighsLows@ipfx": {
      name: "Equal Highs and Lows", short: "EQH/EQL", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "Equal Highs and Lows (EQH / EQL)", color: "#f59e0b", brief: "Twin swing points that leave stop orders resting just beyond them",
        explain: "Two swing highs (or lows) at almost the same price mark a level many traders use for stops and breakouts. Price is often driven through such a level to trigger those orders, a liquidity grab, before the real move. Marked where two consecutive swings sit within the tolerance." },
      inputs: [int("swing", "Swing length", 3, 1, 30), flt("tol", "Tolerance (× ATR)", 0.15, 0.01, 3, 0.01), int("show", "Pairs shown", 12, 1, 60), int("atr", "ATR length", 14, 1, 100)],
      plots: ANCHOR,
      calc: (bars, p) => {
        const n = bars.length, piv = confirmedPivots(bars, p.swing), atr = atrOf(bars, p.atr), lines = [], texts = [];
        let ph = null, pl = null;
        for (let j = 0; j < n; j++) {
          const tol = atr[j] == null ? null : p.tol * atr[j];
          if (piv.hi[j]) {
            const idx = j - p.swing, price = bars[idx].high;
            if (ph && tol != null && Math.abs(price - ph.price) <= tol) {
              lines.push({ a: ph.idx, pa: ph.price, b: idx, pb: price, color: rgba(AMBER, 0.9), dash: "dotted", width: 1.5 });
              texts.push({ i: Math.round((ph.idx + idx) / 2), price: Math.max(price, ph.price), text: "EQH", color: rgba(AMBER, 1), pos: "above" });
            }
            ph = { idx, price };
          }
          if (piv.lo[j]) {
            const idx = j - p.swing, price = bars[idx].low;
            if (pl && tol != null && Math.abs(price - pl.price) <= tol) {
              lines.push({ a: pl.idx, pa: pl.price, b: idx, pb: price, color: rgba(AMBER, 0.9), dash: "dotted", width: 1.5 });
              texts.push({ i: Math.round((pl.idx + idx) / 2), price: Math.min(price, pl.price), text: "EQL", color: rgba(AMBER, 1), pos: "below" });
            }
            pl = { idx, price };
          }
        }
        return { draw: { lines: last(lines, p.show), texts: last(texts, p.show) } };
      },
    },
    "LiquiditySweeps@ipfx": {
      name: "Liquidity Sweeps", short: "Sweeps", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "Liquidity Sweeps (Grabs)", color: "#ef4444", brief: "Wicks that poke past a swing point and close back inside",
        explain: "Stop orders rest beyond obvious swing highs and lows. A sweep is a candle that trades beyond such a swing but closes back on the other side, taking that liquidity and often marking a reversal. A candle that closes beyond the swing is a breakout, not a sweep, and is ignored." },
      inputs: [int("swing", "Swing length", 5, 2, 40), int("lookback", "Look back (bars)", 200, 20, 1000), int("show", "Sweeps shown", 15, 1, 60)],
      plots: ANCHOR,
      calc: (bars, p) => {
        const n = bars.length, piv = confirmedPivots(bars, p.swing), lines = [], texts = [];
        let highs = [], lows = [];
        for (let j = 0; j < n; j++) {
          const b = bars[j];
          if (piv.hi[j]) highs.push({ idx: j - p.swing, price: bars[j - p.swing].high });
          if (piv.lo[j]) lows.push({ idx: j - p.swing, price: bars[j - p.swing].low });
          highs = highs.filter((h) => j - h.idx <= p.lookback);
          lows = lows.filter((l) => j - l.idx <= p.lookback);
          for (let k = highs.length - 1; k >= 0; k--) {
            const h = highs[k];
            if (b.high > h.price) {
              if (b.close < h.price) { lines.push({ a: h.idx, pa: h.price, b: j, pb: h.price, color: rgba(RED, 0.85), dash: "dashed" }); texts.push({ i: j, price: b.high, text: "Sweep", color: rgba(RED, 1), pos: "above" }); }
              highs.splice(k, 1);
            }
          }
          for (let k = lows.length - 1; k >= 0; k--) {
            const l = lows[k];
            if (b.low < l.price) {
              if (b.close > l.price) { lines.push({ a: l.idx, pa: l.price, b: j, pb: l.price, color: rgba(GREEN, 0.85), dash: "dashed" }); texts.push({ i: j, price: b.low, text: "Sweep", color: rgba(GREEN, 1), pos: "below" }); }
              lows.splice(k, 1);
            }
          }
        }
        return { draw: { lines: last(lines, p.show), texts: last(texts, p.show) } };
      },
    },
    "PremiumDiscount@ipfx": {
      name: "Premium / Discount", short: "P/D", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "Premium and Discount Zones", color: "#ef4444", brief: "Splits the current swing range into expensive and cheap halves",
        explain: "Takes the latest confirmed swing high and swing low and splits the range at its midpoint (equilibrium). Above it is premium, where sellers look for entries; below it is discount, where buyers do. The optional zone marks the 62%–79% retracement, often called the optimal trade entry." },
      inputs: [int("swing", "Swing length", 10, 2, 100), sel("ote", "Optimal entry zone", ["show", "hide"], "show")],
      plots: ANCHOR,
      calc: (bars, p) => {
        const n = bars.length, piv = confirmedPivots(bars, p.swing);
        let hi = null, lo = null;
        for (let j = 0; j < n; j++) {
          if (piv.hi[j]) hi = { idx: j - p.swing, price: bars[j - p.swing].high };
          if (piv.lo[j]) lo = { idx: j - p.swing, price: bars[j - p.swing].low };
        }
        if (!hi || !lo || hi.price <= lo.price) return { draw: { boxes: [], lines: [] } };
        const a = Math.min(hi.idx, lo.idx), mid = (hi.price + lo.price) / 2, R = hi.price - lo.price;
        const boxes = [
          { a, b: null, top: hi.price, bottom: mid, fill: rgba(RED, 0.09), label: "Premium", labelColor: rgba(RED, 0.9) },
          { a, b: null, top: mid, bottom: lo.price, fill: rgba(GREEN, 0.09), label: "Discount", labelColor: rgba(GREEN, 0.9) },
        ];
        if (p.ote === "show") {
          const upLeg = lo.idx < hi.idx; // low first, then high: the pullback to buy is down from the high
          const t = upLeg ? hi.price - 0.62 * R : lo.price + 0.79 * R, bt = upLeg ? hi.price - 0.79 * R : lo.price + 0.62 * R;
          boxes.push({ a: Math.max(hi.idx, lo.idx), b: null, top: t, bottom: bt, fill: rgba(AMBER, 0.2), stroke: rgba(AMBER, 0.6), label: "OTE", labelColor: rgba(AMBER, 1) });
        }
        const lines = [
          { a, pa: hi.price, b: null, color: rgba(RED, 0.7), width: 1 }, { a, pa: lo.price, b: null, color: rgba(GREEN, 0.7), width: 1 },
          { a, pa: mid, b: null, color: rgba(SLATE, 0.9), dash: "dashed", label: "EQ" },
        ];
        return { draw: { boxes, lines } };
      },
    },
    "SupplyDemand@ipfx": {
      name: "Supply and Demand Zones", short: "S/D", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "Supply and Demand Zones", color: "#f97316", brief: "Tight bases that price left in a hurry",
        explain: "A base is one to three small candles, followed by a strong candle that closes out of it. The base is where orders were left unfilled, so it is drawn as demand (green) if price left upwards and supply (red) if it left downwards. A zone is dropped once price closes through it." + NOTE_ZONES },
      inputs: [flt("impulse", "Impulse candle (× ATR)", 1.5, 0.5, 10, 0.1), flt("base", "Base candle at most (× ATR)", 0.7, 0.1, 3, 0.05), int("show", "Zones shown per side", 4, 1, 30), int("atr", "ATR length", 14, 1, 100)],
      plots: ANCHOR,
      calc: (bars, p) => {
        const n = bars.length, atr = atrOf(bars, p.atr), zones = [], usedUntil = { v: -1 };
        for (let i = 2; i < n; i++) {
          const a = atr[i - 1], c = bars[i];
          if (a == null || i - 1 <= usedUntil.v) continue;
          const range = c.high - c.low;
          if (range < p.impulse * a || Math.abs(c.close - c.open) < 0.6 * range) continue;
          let k = i - 1, cnt = 0;
          while (k >= 0 && cnt < 3 && bars[k].high - bars[k].low <= p.base * a) { k--; cnt++; }
          if (cnt === 0) continue;
          const base = bars.slice(k + 1, i);
          const top = Math.max(...base.map((b) => b.high)), bottom = Math.min(...base.map((b) => b.low));
          if (c.close > c.open && c.close > top) zones.push({ dir: 1, a: k + 1, born: i, top, bottom });
          else if (c.close < c.open && c.close < bottom) zones.push({ dir: -1, a: k + 1, born: i, top, bottom });
          else continue;
          usedUntil.v = i;
        }
        for (const z of zones) {
          for (let j = z.born + 1; j < n; j++) if (z.dir > 0 ? bars[j].close < z.bottom : bars[j].close > z.top) { z.end = j; break; }
        }
        const boxes = [];
        for (const dir of [1, -1]) for (const z of last(zones.filter((x) => x.dir === dir && x.end == null), p.show)) {
          const rgb = dir > 0 ? GREEN : RED;
          boxes.push({ a: z.a, b: null, top: z.top, bottom: z.bottom, fill: rgba(rgb, 0.16), stroke: rgba(rgb, 0.5), label: dir > 0 ? "Demand" : "Supply", labelColor: rgba(rgb, 1) });
        }
        return { draw: { boxes } };
      },
    },
    "AutoSupportResistance@ipfx": {
      name: "Auto Support and Resistance", short: "S/R", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "Auto Support and Resistance", color: "#94a3b8", brief: "Horizontal levels where several swings have turned price",
        explain: "Collects recent swing highs and lows, groups those that sit close together, and draws a line for every level that has turned price at least the chosen number of times. Levels above price are red (resistance) and below are green (support). Thicker lines are levels that have been touched more often." },
      inputs: [int("swing", "Swing length", 8, 2, 60), int("touches", "Minimum touches", 2, 2, 10), flt("tol", "Grouping (× ATR)", 0.5, 0.05, 5, 0.05), int("lookback", "Look back (bars)", 500, 50, 2000), int("show", "Levels shown", 8, 1, 30), int("atr", "ATR length", 14, 1, 100)],
      plots: ANCHOR,
      calc: (bars, p) => {
        const n = bars.length, piv = confirmedPivots(bars, p.swing), atr = atrOf(bars, p.atr), pts = [];
        if (!n) return { draw: { lines: [] } };
        for (let j = 0; j < n; j++) {
          if (j < n - p.lookback) continue;
          if (piv.hi[j]) pts.push({ idx: j - p.swing, price: bars[j - p.swing].high });
          if (piv.lo[j]) pts.push({ idx: j - p.swing, price: bars[j - p.swing].low });
        }
        const a = atr[n - 1], px = bars[n - 1].close;
        if (a == null || !pts.length) return { draw: { lines: [] } };
        const tol = p.tol * a, groups = [];
        for (const pt of pts.sort((x, y) => x.price - y.price)) {
          const g = groups[groups.length - 1];
          if (g && pt.price - g.max <= tol) { g.pts.push(pt); g.max = pt.price; } else groups.push({ pts: [pt], max: pt.price });
        }
        const levels = groups.filter((g) => g.pts.length >= p.touches).map((g) => ({ price: g.pts.reduce((s, q) => s + q.price, 0) / g.pts.length, from: Math.min(...g.pts.map((q) => q.idx)), touches: g.pts.length }));
        levels.sort((x, y) => Math.abs(x.price - px) - Math.abs(y.price - px));
        const lines = levels.slice(0, p.show).map((l) => ({ a: l.from, pa: l.price, b: null, color: rgba(l.price > px ? RED : GREEN, 0.75), width: l.touches >= 4 ? 2 : 1 }));
        return { draw: { lines } };
      },
    },
    "Killzones@ipfx": {
      name: "Kill Zones (Session Ranges)", short: "Kill zones", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "Kill Zones / Killzones (Asia, London, New York)", color: "#a855f7", brief: "Boxes each session's high and low",
        explain: "Draws a box around the high and low of the Asian, London and New York sessions for each day, so you can see where each session's range sits and when price sweeps it. Hours are UTC. Works on intraday timeframes." },
      inputs: [int("asiaFrom", "Asia from (UTC hour)", 0, 0, 23), int("asiaTo", "Asia to", 6, 1, 24), int("lonFrom", "London from", 7, 0, 23), int("lonTo", "London to", 10, 1, 24), int("nyFrom", "New York from", 12, 0, 23), int("nyTo", "New York to", 15, 1, 24), int("days", "Days shown", 4, 1, 30)],
      plots: ANCHOR,
      calc: (bars, p) => {
        const sessions = [["Asia", p.asiaFrom, p.asiaTo, PURPLE], ["London", p.lonFrom, p.lonTo, BLUE], ["New York", p.nyFrom, p.nyTo, ORANGE]];
        const map = new Map(), boxes = [];
        bars.forEach((b, i) => {
          const day = Math.floor(b.time / 86400), hour = ((b.time % 86400) + 86400) % 86400 / 3600;
          for (const [name, from, to, rgb] of sessions) {
            if (hour >= from && hour < to) {
              const key = day + name; let s = map.get(key);
              if (!s) { s = { name, rgb, day, a: i, b: i, top: b.high, bottom: b.low }; map.set(key, s); }
              s.b = i; s.top = Math.max(s.top, b.high); s.bottom = Math.min(s.bottom, b.low);
            }
          }
        });
        const all = [...map.values()].sort((x, y) => x.a - y.a), days = [...new Set(all.map((s) => s.day))].slice(-p.days);
        for (const s of all) if (days.includes(s.day)) boxes.push({ a: s.a, b: s.b, top: s.top, bottom: s.bottom, fill: rgba(s.rgb, 0.1), stroke: rgba(s.rgb, 0.5), label: s.name, labelColor: rgba(s.rgb, 1) });
        return { draw: { boxes } };
      },
    },
    "VolumeProfileVisible@ipfx": {
      name: "Volume Profile (Visible Range)", short: "Vol profile", pane: "overlay", repaint: true, needsVisible: true,
      meta: { cat: "smc", full: "Volume Profile (Visible Range)", color: "#3b82f6", brief: "Where volume traded across the prices on screen",
        explain: "Adds up the volume traded at each price level across the candles you can see and draws it as bars on the right. The longest bar is the point of control (POC), the price with the most trading; the shaded bars around it hold 70% of the volume (the value area, between VAH and VAL). Moves as you scroll and zoom. Forex pairs use the matching CME future's volume where one exists; without volume the profile counts time spent at each price." },
      inputs: [int("rows", "Rows", 28, 8, 100), int("area", "Value area %", 70, 10, 100)],
      plots: ANCHOR,
      calc: (bars, p, ctx) => {
        const r = (ctx && ctx.visible) || { from: 0, to: bars.length - 1 }, from = Math.max(0, r.from), to = Math.min(bars.length - 1, r.to);
        let lo = Infinity, hi = -Infinity, hasVol = false;
        for (let i = from; i <= to; i++) { lo = Math.min(lo, bars[i].low); hi = Math.max(hi, bars[i].high); if (bars[i].volume > 0) hasVol = true; }
        if (!(hi > lo)) return { draw: { hbars: [], lines: [] } };
        const rows = p.rows, step = (hi - lo) / rows, vol = new Array(rows).fill(0);
        for (let i = from; i <= to; i++) {
          const b = bars[i], w = hasVol ? b.volume || 0 : 1, rng = Math.max(b.high - b.low, step * 0.01);
          const k0 = Math.max(0, Math.min(rows - 1, Math.floor((b.low - lo) / step))), k1 = Math.max(0, Math.min(rows - 1, Math.floor((b.high - lo) / step)));
          for (let k = k0; k <= k1; k++) {
            const overlap = Math.min(b.high, lo + (k + 1) * step) - Math.max(b.low, lo + k * step);
            vol[k] += w * (b.high === b.low ? 1 / (k1 - k0 + 1) : Math.max(0, overlap) / rng);
          }
        }
        const total = vol.reduce((s, v) => s + v, 0), max = Math.max(...vol), poc = vol.indexOf(max);
        let inArea = new Set([poc]), acc = vol[poc], up = poc + 1, dn = poc - 1;
        while (acc < (p.area / 100) * total && (up < rows || dn >= 0)) {
          const vu = up < rows ? vol[up] : -1, vd = dn >= 0 ? vol[dn] : -1;
          if (vu >= vd) { inArea.add(up); acc += vu; up++; } else { inArea.add(dn); acc += vd; dn--; }
        }
        const hbars = vol.map((v, k) => ({ top: lo + (k + 1) * step, bottom: lo + k * step, frac: max > 0 ? v / max : 0, side: "right",
          fill: k === poc ? rgba(AMBER, 0.6) : inArea.has(k) ? rgba(BLUE, 0.4) : rgba(SLATE, 0.28) }));
        const vah = lo + (Math.max(...inArea) + 1) * step, val = lo + Math.min(...inArea) * step, pocPrice = lo + (poc + 0.5) * step;
        const lines = [
          { a: from, pa: pocPrice, b: null, color: rgba(AMBER, 0.9), width: 1.5, label: "POC" },
          { a: from, pa: vah, b: null, color: rgba(BLUE, 0.7), dash: "dotted", label: "VAH" },
          { a: from, pa: val, b: null, color: rgba(BLUE, 0.7), dash: "dotted", label: "VAL" },
        ];
        return { draw: { hbars, lines } };
      },
    },
    "CandlePatterns@ipfx": {
      name: "Candlestick Patterns", short: "Patterns", pane: "overlay", repaint: true,
      meta: { cat: "smc", full: "Candlestick Patterns", color: "#eab308", brief: "Labels engulfing, hammer, star, doji and three-candle patterns",
        explain: "Labels common candle patterns as they form: bullish and bearish engulfing, hammer and shooting star (small body, long wick), doji (open and close almost equal), morning and evening star, and three white soldiers or three black crows. Patterns matter most at support, resistance or after a run, so treat a label as a prompt to look, not a trade signal." },
      inputs: [int("bars", "Bars scanned", 400, 20, 2000), flt("wick", "Wick at least (× body)", 2, 1, 6, 0.1)],
      plots: ANCHOR,
      calc: (bars, p) => {
        const n = bars.length, texts = [], from = Math.max(2, n - p.bars);
        const body = (b) => Math.abs(b.close - b.open), rng = (b) => b.high - b.low, bull = (b) => b.close > b.open, bear = (b) => b.close < b.open;
        const up = (b) => b.high - Math.max(b.open, b.close), dn = (b) => Math.min(b.open, b.close) - b.low;
        for (let i = from; i < n; i++) {
          const b = bars[i], a = bars[i - 1], z = bars[i - 2], r = rng(b);
          if (r <= 0) continue;
          const say = (text, color, pos) => texts.push({ i, price: pos === "below" ? b.low : b.high, text, color, pos, size: 9 });
          if (body(b) <= r * 0.08) { say("Doji", rgba(SLATE, 1), "above"); continue; }
          if (bull(b) && bear(a) && b.close >= a.open && b.open <= a.close && body(b) > body(a)) { say("Bull Engulf", rgba(GREEN, 1), "below"); continue; }
          if (bear(b) && bull(a) && b.close <= a.open && b.open >= a.close && body(b) > body(a)) { say("Bear Engulf", rgba(RED, 1), "above"); continue; }
          if (dn(b) >= p.wick * body(b) && up(b) <= body(b) * 0.5 && body(b) >= r * 0.1) { say("Hammer", rgba(GREEN, 1), "below"); continue; }
          if (up(b) >= p.wick * body(b) && dn(b) <= body(b) * 0.5 && body(b) >= r * 0.1) { say("Shooting Star", rgba(RED, 1), "above"); continue; }
          if (bear(z) && body(z) > rng(z) * 0.5 && body(a) < body(z) * 0.4 && bull(b) && b.close > (z.open + z.close) / 2) { say("Morning Star", rgba(GREEN, 1), "below"); continue; }
          if (bull(z) && body(z) > rng(z) * 0.5 && body(a) < body(z) * 0.4 && bear(b) && b.close < (z.open + z.close) / 2) { say("Evening Star", rgba(RED, 1), "above"); continue; }
          if (bull(z) && bull(a) && bull(b) && a.close > z.close && b.close > a.close && a.open > z.open && b.open > a.open && body(z) > rng(z) * 0.5 && body(a) > rng(a) * 0.5 && body(b) > r * 0.5) { say("3 Soldiers", rgba(GREEN, 1), "below"); continue; }
          if (bear(z) && bear(a) && bear(b) && a.close < z.close && b.close < a.close && a.open < z.open && b.open < a.open && body(z) > rng(z) * 0.5 && body(a) > rng(a) * 0.5 && body(b) > r * 0.5) { say("3 Crows", rgba(RED, 1), "above"); continue; }
        }
        return { draw: { texts } };
      },
    },
  }));
  // for the tests
  IND.smc = { confirmedPivots, scanFvg, scanOrderBlocks };
})(typeof window !== "undefined" ? window : globalThis);
