// IPFX Markets chart — Lightweight Charts v5 with draggable SL/TP.
//
// Drawn from IPFX's own prices: history from /functions/v1/chart-candles,
// aligned to the trading engine's live price, then extended tick by tick from
// the same engine quotes that orders fill against. What a trader sees is the
// price they trade at, so the chart itself gives nobody a head start.
//
// Position lines sit on the real price. SL and TP lines can be dragged; on
// release the new level goes through the engine's `modify` action, which is
// the only authority — a rejected change snaps back and says why.
//
// The page supplies trading context through `hooks` (see createIpfxChart).
(function () {
  "use strict";

  const LWC = window.LightweightCharts;
  const CANDLES_URL = "https://agulweemteoeagscmppy.supabase.co/functions/v1/chart-candles";
  const TZ = "Europe/London";
  const TF_SECONDS = { "1": 60, "3": 180, "5": 300, "15": 900, "30": 1800, "60": 3600, "240": 14400, D: 86400, W: 604800 };
  const UP = "#10b981", DOWN = "#ef4444", BLUE = "#2563eb";
  const TF_LABEL = { "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m", "60": "1H", "240": "4H", D: "1D", W: "1W" };

  // ---------------------------------------------------------------- time labels (London)
  const fmtCache = {};
  function fmt(opts) {
    const k = JSON.stringify(opts);
    return fmtCache[k] || (fmtCache[k] = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...opts }));
  }
  function tickLabel(time, type) {
    const d = new Date(Number(time) * 1000);
    // TickMarkType: 0 Year, 1 Month, 2 DayOfMonth, 3 Time, 4 TimeWithSeconds
    if (type === 0) return fmt({ year: "numeric" }).format(d);
    if (type === 1) return fmt({ month: "short" }).format(d);
    if (type === 2) return fmt({ day: "numeric", month: "short" }).format(d);
    return fmt({ hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  }
  function crosshairLabel(time) {
    return fmt({ day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .format(new Date(Number(time) * 1000));
  }

  // ---------------------------------------------------------------- helpers
  function heikinAshi(bars) {
    const out = [];
    let prevO = null, prevC = null;
    for (const b of bars) {
      const c = (b.open + b.high + b.low + b.close) / 4;
      const o = prevO === null ? (b.open + b.close) / 2 : (prevO + prevC) / 2;
      out.push({ time: b.time, open: o, high: Math.max(b.high, o, c), low: Math.min(b.low, o, c), close: c });
      prevO = o; prevC = c;
    }
    return out;
  }
  // 1.23K / 4.56M for volume-sized numbers
  const compact = (v) => { const a = Math.abs(v); return a >= 1e9 ? (v / 1e9).toFixed(2) + "B" : a >= 1e6 ? (v / 1e6).toFixed(2) + "M" : a >= 1e3 ? (v / 1e3).toFixed(2) + "K" : v.toFixed(0); };
  const money = (v) => (v < 0 ? "-$" : "+$") + Math.abs(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /**
   * @param {HTMLElement} container  element the chart canvas mounts into
   * @param {HTMLElement} overlay    absolutely positioned layer over the chart for trade lines
   * @param {object} hooks
   *   digits(symbol)                -> price decimals
   *   mark(trade)                   -> current closing price for that trade (bid for buys, ask for sells)
   *   pnlAt(trade, price)           -> USD P&L if the trade closed at price (null if unknown)
   *   riskAt(trade, stop)           -> USD at risk with that stop, measured from entry (null if unknown)
   *   riskLimit()                   -> current max risk per trade in USD (null if none)
   *   stopRequired()                -> true if every position must keep a stop
   *   save(trade, {sl, tp})         -> Promise<boolean>; must send BOTH levels (engine sets both)
   *   close(trade)                  -> close the position
   *   edit(trade)                   -> open the precise SL/TP dialog
   *   status(text, isError)         -> show a short message to the trader
   *   loading(bool)                 -> show / hide the page's loading overlay
   *   loaded({symbol,tf,proxy,closesOnly,bars}) -> optional; history arrived (proxy = futures history
   *                                    for a spot price; closesOnly = history had one price per bar)
   *   label(symbol)                 -> optional display name for the legend (e.g. "EUR/USD")
   *   pickSymbol()                  -> optional; the legend's symbol name was clicked
   *   legendExtra()                 -> optional HTML appended to the legend (e.g. market status)
   *   editIndicator(uid) / removeIndicator(uid) -> optional; legend buttons on an indicator
   *   scaleChanged({mode, auto})    -> optional; price scale mode (0 normal, 1 log, 2 %) or auto-fit changed
   */
  function createIpfxChart(container, overlay, hooks) {
    if (!LWC) throw new Error("Lightweight Charts failed to load");

    let dark = true, gridAlpha = 0, style = 1;
    let symbol = null, tf = "60", seconds = 3600;
    let raw = [];            // [{time, open, high, low, close}] in engine-aligned prices
    let aligned = false;     // history shifted onto the engine's live price yet?
    let closesOnly = false;
    let volumeSource = null; // e.g. "CME Euro FX (6E) futures" when spot forex borrows futures volume  // history sampled once per bar (FX 1m on Yahoo): wicks are not real
    let proxy = false;
    let loadSeq = 0;
    let loadingHistory = false;
    let pendingMid = null;   // newest quote that arrived while history was loading
    let series = null;
    let trades = [];
    const draft = new Map(); // tradeId -> {sl, tp, saving}
    let drag = null;
    let bid = null, ask = null, bidLine = null, askLine = null;
    let markersApi = null, tradeMarks = [];
    let pendingRange = null;
    const shield = document.createElement("div");
    shield.className = "ipc-shield";
    shield.hidden = true;
    overlay.parentNode.insertBefore(shield, overlay.nextSibling);

    const chart = LWC.createChart(container, {
      autoSize: true,
      layout: { background: { type: "solid", color: "#0a0a0c" }, textColor: "#8a8a90", fontSize: 11,
        fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Text',Inter,'Helvetica Neue',Arial,sans-serif" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "#2a2a2c", scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: "#2a2a2c", timeVisible: true, secondsVisible: false, rightOffset: 6,
        tickMarkFormatter: tickLabel },
      localization: { timeFormatter: crosshairLabel },
      crosshair: { mode: LWC.CrosshairMode.Normal },
    });

    // ---------------------------------------------------------------- legend (symbol · TF · OHLC)
    const legend = document.createElement("div");
    legend.className = "ipc-legend";
    container.appendChild(legend);
    let hoverTime = null;
    function barAt(time) {
      let lo = 0, hi = raw.length - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (raw[m].time === time) return m;
        if (raw[m].time < time) lo = m + 1; else hi = m - 1;
      }
      return -1;
    }
    function drawLegend() {
      if (!symbol) { legend.innerHTML = ""; return; }
      const i = hoverTime == null ? raw.length - 1 : barAt(hoverTime);
      const b = raw[i];
      const name = esc(hooks.label ? hooks.label(symbol) : symbol);
      // The symbol is a button: clicking it opens the page's instrument picker.
      let html = `<button type="button" class="ipc-lg-sym" title="Change instrument (/)">${name}<svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button>` +
        `<span class="ipc-lg-tf">${TF_LABEL[tf] || tf}</span>`;
      if (b) {
        const d = hooks.digits(symbol), f = (v) => v.toFixed(d);
        const prev = raw[i - 1] ? raw[i - 1].close : b.open;
        const chg = b.close - prev, pct = prev ? (chg / prev) * 100 : 0;
        const cls = b.close >= b.open ? "up" : "down";
        const sign = chg >= 0 ? "+" : "";
        html += `<span class="ipc-lg-ohlc ${cls}">O<b>${f(b.open)}</b> H<b>${f(b.high)}</b> L<b>${f(b.low)}</b> C<b>${f(b.close)}</b>` +
          `<b class="ipc-lg-chg">${sign}${f(chg)} (${sign}${pct.toFixed(2)}%)</b></span>`;
      }
      if (hooks.legendExtra) html += hooks.legendExtra();
      legend.innerHTML = html;
    }
    legend.addEventListener("click", (e) => {
      if (e.target.closest(".ipc-lg-sym") && hooks.pickSymbol) hooks.pickSymbol();
    });
    chart.subscribeCrosshairMove((param) => {
      const t = param && param.time != null && param.point ? Number(param.time) : null;
      if (t === hoverTime) return;
      hoverTime = t;
      drawLegend();
    });

    // Keep SL/TP/entry inside the visible price range so a trader can always grab them.
    const autoscale = (original) => {
      const res = original();
      const levels = [];
      for (const t of trades) {
        const d = draft.get(t.id) || {};
        for (const v of [t.open_price, d.sl !== undefined ? d.sl : t.sl, d.tp !== undefined ? d.tp : t.tp]) {
          if (v != null && isFinite(v)) levels.push(Number(v));
        }
      }
      if (!res || !levels.length) return res;
      res.priceRange.minValue = Math.min(res.priceRange.minValue, ...levels);
      res.priceRange.maxValue = Math.max(res.priceRange.maxValue, ...levels);
      return res;
    };

    function makeSeries() {
      if (series) chart.removeSeries(series);
      const digits = symbol ? hooks.digits(symbol) : 5;
      const priceFormat = { type: "price", precision: digits, minMove: 1 / Math.pow(10, digits) };
      series = style === 2
        ? chart.addSeries(LWC.LineSeries, { color: BLUE, lineWidth: 2, priceFormat, autoscaleInfoProvider: autoscale })
        : style === 3
        ? chart.addSeries(LWC.BarSeries, { upColor: UP, downColor: DOWN, priceFormat, autoscaleInfoProvider: autoscale })
        : chart.addSeries(LWC.CandlestickSeries, {
          upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
          priceFormat, autoscaleInfoProvider: autoscale,
        });
      bidLine = askLine = null;       // they belonged to the removed series
      markersApi = LWC.createSeriesMarkers ? LWC.createSeriesMarkers(series, []) : null;
      pushAll();
      syncQuoteLines();
      applyMarkers();
    }

    // ---------------------------------------------------------------- bid / ask lines
    // Two labelled lines, like a trading platform: sells fill at the bid, buys at the ask.
    function syncQuoteLines() {
      if (!series) return;
      if (bid == null || ask == null) {
        if (bidLine) { series.removePriceLine(bidLine); bidLine = null; }
        if (askLine) { series.removePriceLine(askLine); askLine = null; }
        series.applyOptions({ lastValueVisible: true, priceLineVisible: true });
        return;
      }
      const last = raw[raw.length - 1];
      const color = !last || last.close >= last.open ? UP : DOWN;
      const opts = (price) => ({ price, color, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title: "" });
      if (bidLine) bidLine.applyOptions(opts(bid)); else bidLine = series.createPriceLine(opts(bid));
      if (askLine) askLine.applyOptions(opts(ask)); else askLine = series.createPriceLine(opts(ask));
      series.applyOptions({ lastValueVisible: false, priceLineVisible: false });
    }

    // ---------------------------------------------------------------- trade markers
    // Entries (and recent exits) drawn on the candle they happened in.
    function snapTime(sec) {
      if (!raw.length || !isFinite(sec)) return null;
      if (seconds < 86400) sec = Math.floor(sec / seconds) * seconds;
      let lo = 0, hi = raw.length - 1, hit = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (raw[m].time <= sec) { hit = m; lo = m + 1; } else hi = m - 1; }
      return hit < 0 ? null : raw[hit].time;
    }
    // Labels are only drawn where they have room at the current zoom: open
    // positions first, then the newest closes. Crowded markers keep their
    // arrow or dot without text, so labels never print over each other.
    let markerSpacing = 0;
    function applyMarkers() {
      if (!markersApi) return;
      markerSpacing = chart.timeScale().options().barSpacing;
      const minGap = Math.ceil(72 / Math.max(1, markerSpacing));   // bars a label needs
      const items = [];
      for (const m of tradeMarks) {
        const time = snapTime(m.time);
        if (time == null) continue;
        const buy = m.side === "buy", exit = m.kind === "exit";
        const pnl = Number(m.pnl) || 0;
        items.push({
          idx: barAt(time), open: !!m.open,
          marker: exit
            ? { time, position: buy ? "aboveBar" : "belowBar", color: pnl >= 0 ? UP : DOWN, shape: "circle", size: 0.8 }
            : { time, position: buy ? "belowBar" : "aboveBar", color: buy ? UP : DOWN, shape: buy ? "arrowUp" : "arrowDown" },
          text: exit ? money(pnl) : (buy ? "Buy " : "Sell ") + Number(m.volume).toFixed(2),
        });
      }
      const taken = { aboveBar: [], belowBar: [] };
      [...items].sort((a, b) => (b.open - a.open) || (b.idx - a.idx)).forEach((it) => {
        const lane = taken[it.marker.position];
        if (lane.every((i) => Math.abs(i - it.idx) >= minGap)) { it.marker.text = it.text; lane.push(it.idx); }
      });
      const out = items.map((it) => it.marker).sort((a, b) => a.time - b.time);
      markersApi.setMarkers(out);
    }

    // ---------------------------------------------------------------- indicators
    // Definitions and maths live in ipfx-indicators.js; this renders them.
    // Overlays share the price pane; each oscillator gets its own pane.
    const IND = window.IPFX_INDICATORS;
    let indicators = [];          // [{uid, id, inputs, def, series:{key:api}, pane, lines:[]}]
    let indRaf = 0;
    const indLegend = document.createElement("div");
    indLegend.className = "ipc-ind-legends";
    container.appendChild(indLegend);

    function scheduleIndicators() {
      if (!indicators.length || indRaf) return;
      indRaf = requestAnimationFrame(() => { indRaf = 0; computeIndicators(); });
    }
    function mkSeries(ind, plot, paneIndex, first) {
      const digits = symbol ? hooks.digits(symbol) : 5;
      const prec = ind.def.precision != null ? ind.def.precision : 2;
      const base = {
        // Axis labels only for indicators with a few lines; ribbons, clouds and pivots would bury the axis.
        priceLineVisible: false, lastValueVisible: !plot.scale && !plot.hideValue && plot.type !== "dots" && (ind.def.pane !== "overlay" || ind.def.plots.length <= 3), crosshairMarkerVisible: false,
        priceFormat: ind.def.format === "volume" ? { type: "volume" }
          : ind.def.pane === "overlay" || ind.def.priceUnits ? { type: "price", precision: digits, minMove: 1 / Math.pow(10, digits) }
          : { type: "price", precision: prec, minMove: 1 / Math.pow(10, prec) },
      };
      if (plot.scale) base.priceScaleId = plot.scale; // own scale inside the price pane (volume bars)
      if (first && ind.def.range) {
        const [lo, hi] = ind.def.range;
        base.autoscaleInfoProvider = () => ({ priceRange: { minValue: lo, maxValue: hi } });
      }
      let api;
      if (plot.type === "histogram") {
        api = chart.addSeries(LWC.HistogramSeries, { ...base, color: plot.color || plot.upColor || "#26a69a" }, paneIndex);
      } else if (plot.type === "dots") {
        // Sparse single points do not paint as line point-markers, so dots are series markers
        // (set in computeIndicators) on an invisible line.
        api = chart.addSeries(LWC.LineSeries, { ...base, color: plot.color, lineVisible: false, pointMarkersVisible: false }, paneIndex);
        api._dots = LWC.createSeriesMarkers(api, []);
      } else {
        api = chart.addSeries(LWC.LineSeries, { ...base, color: plot.color, lineWidth: plot.width || (ind.def.pane === "overlay" ? 2 : 1.5),
          lineStyle: plot.dashed ? LWC.LineStyle.Dashed : LWC.LineStyle.Solid }, paneIndex);
      }
      if (plot.scale) chart.priceScale(plot.scale, paneIndex).applyOptions({ scaleMargins: plot.scaleMargins || { top: 0.8, bottom: 0 } });
      return api;
    }
    function mountIndicator(ind) {
      ind.pane = ind.def.pane === "overlay" ? 0 : chart.panes().length;
      ind.series = {};
      ind.def.plots.forEach((plot, k) => { ind.series[plot.key] = mkSeries(ind, plot, ind.pane, k === 0); });
      ind.lines = [];
      const firstSeries = ind.series[ind.def.plots[0].key];
      for (const lv of ind.def.levels || []) {
        ind.lines.push(firstSeries.createPriceLine({ price: lv.value, color: "rgba(140,140,150,0.55)", lineWidth: 1,
          lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: false, title: "" }));
      }
      sizePanes();
    }
    function unmountIndicator(ind) {
      for (const k in ind.series) { try { chart.removeSeries(ind.series[k]); } catch (_) { /* already gone */ } }
      ind.series = {};
    }
    function dropEmptyPanes() {
      const panes = chart.panes();
      for (let i = panes.length - 1; i > 0; i--) if (!panes[i].getSeries().length) chart.removePane(i);
      sizePanes();
    }
    // Panes share the height by proportion: price keeps the most, each
    // indicator pane gets about a quarter of it (a little less when stacked).
    function sizePanes() {
      const panes = chart.panes();
      if (panes.length < 2) return;
      const each = panes.length > 3 ? 0.22 : 0.3;
      panes.forEach((pane, i) => pane.setStretchFactor(i === 0 ? 1 : each));
    }
    // Bars a plot is drawn ahead of (positive) or behind (negative) the candle it was computed on.
    function plotShift(ind, plot) {
      if (plot.shiftInput) return (plot.shiftSign || 1) * Math.max(0, Number(ind.inputs[plot.shiftInput]) - 1);
      return plot.shift || 0;
    }
    function maxAhead() {
      let m = 0;
      for (const ind of indicators) for (const pl of ind.def.plots) m = Math.max(m, plotShift(ind, pl));
      return m;
    }
    // One chart point per bar (whitespace where the value is missing). Plots shifted into the
    // future extend past the last candle on extrapolated times.
    function pointsFor(ind, plot, vals, colors, times, from) {
      const shift = plotShift(ind, plot), n = raw.length, pts = [];
      let prev;
      if (plot.breakOnChange && from > 0) prev = vals[from - 1];
      for (let i = from; i < n; i++) {
        const j = i + shift, t = times[j];
        if (t === undefined) continue;
        const v = vals[i];
        if (v == null || !isFinite(v)) { prev = undefined; pts.push({ time: t }); continue; }
        if (plot.breakOnChange && prev != null && v !== prev) { prev = v; pts.push({ time: t }); continue; } // a gap where the level changes
        prev = v;
        if (plot.type === "histogram") {
          const c = colors && colors[i] ? colors[i] : plot.upColor || plot.downColor ? (v >= 0 ? plot.upColor || UP : plot.downColor || DOWN) : plot.color;
          pts.push({ time: t, value: v, color: c });
        } else pts.push({ time: t, value: v });
      }
      return pts;
    }
    // Extra context some indicators need: the visible bar range (Visible Average Price) and
    // another symbol's closes aligned to these bars (Correlation Coefficient).
    const otherCache = new Map(); // "SYMBOL|tf" -> { at, closes: Map(time -> close) } or { pending: true }
    function otherCloses(sym) {
      if (!sym || sym === symbol) return raw.map((b) => b.close);
      const key = sym + "|" + tf, hit = otherCache.get(key);
      if (!hit || (!hit.pending && Date.now() - hit.at > 300000)) {
        otherCache.set(key, { ...(hit || {}), pending: true });
        fetch(`${CANDLES_URL}?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`).then((r) => r.json()).then((j) => {
          if (!j || !j.ok) throw new Error("no data");
          otherCache.set(key, { at: Date.now(), closes: new Map(j.bars.map((b) => [b.t, b.c])) });
          indFull = true; scheduleIndicators();
        }).catch(() => otherCache.set(key, { at: Date.now(), closes: new Map() }));
      }
      const c = otherCache.get(key);
      if (!c || !c.closes) return null;
      let last = null; // markets that are closed at different times: carry the last close forward
      return raw.map((b) => { if (c.closes.has(b.time)) last = c.closes.get(b.time); return last; });
    }
    function visibleRange() {
      const r = chart.timeScale().getVisibleLogicalRange();
      return r ? { from: Math.max(0, Math.floor(r.from)), to: Math.min(raw.length - 1, Math.ceil(r.to)) } : { from: 0, to: raw.length - 1 };
    }
    function contextFor(ind) {
      const ctx = {};
      if (ind.def.needsVisible) ctx.visible = visibleRange();
      if (ind.def.needsSymbol) ctx.other = otherCloses(ind.inputs[ind.def.needsSymbol]);
      return ctx;
    }
    let lastVisKey = "", lastAhead = -1;
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      if (!indicators.some((x) => x.def.needsVisible)) return;
      const v = visibleRange(), key = v.from + ":" + v.to;
      if (key === lastVisKey) return;
      lastVisKey = key; indFull = true; scheduleIndicators();
    });
    function computeIndicators() {
      if (!raw.length) return;
      const full = indFull; indFull = false;
      const ahead = maxAhead();
      const baseTimes = raw.map((b) => b.time);
      const times = ahead ? baseTimes.concat(Array.from({ length: ahead }, (_, k) => raw[raw.length - 1].time + (k + 1) * seconds)) : baseTimes;
      for (const ind of indicators) {
        let out;
        try { out = ind.def.calc(raw, ind.inputs, contextFor(ind)); } catch (e) { out = null; }
        ind.out = out;
        // A tick that only moved the last candle (or added one) needs just the last points redrawn,
        // unless the indicator repaints history or draws ahead of price.
        const live = !full && !ind.def.repaint && ind.lastCount != null && raw.length - ind.lastCount <= 1
          && !ind.def.plots.some((pl) => plotShift(ind, pl) !== 0 || pl.breakOnChange || pl.type === "dots");
        ind.lastCount = raw.length;
        for (const plot of ind.def.plots) {
          const api = ind.series[plot.key], vals = out && out[plot.key];
          if (!api || !vals) continue;
          const colors = out.colors && out.colors[plot.key];
          if (live) { for (const pt of pointsFor(ind, plot, vals, colors, times, Math.max(0, raw.length - 2))) api.update(pt); }
          else {
            const pts = pointsFor(ind, plot, vals, colors, times, 0);
            api.setData(pts);
            if (api._dots) api._dots.setMarkers(pts.filter((q) => q.value !== undefined).map((q) => ({ time: q.time, position: "inBar", shape: "circle", color: plot.color, size: plot.markerText ? 0.7 : 0.4, ...(plot.markerText ? { text: plot.markerText } : {}) })));
          }
        }
      }
      if (ahead !== lastAhead) { lastAhead = ahead; chart.timeScale().applyOptions({ rightOffset: Math.max(6, ahead) }); }
      // candle recolouring (Bollinger Bars): the last indicator asking for it wins
      const recolour = [...indicators].reverse().find((ind) => ind.def.candleColors && ind.out && ind.out.candleColors);
      const map = new Map();
      if (recolour) recolour.out.candleColors.forEach((c, i) => { if (c) map.set(raw[i].time, c); });
      if (map.size || candleOverride.size) setCandleColors(map);
      drawIndLegends();
    }
    // One legend row per indicator: name + inputs, live values, settings and remove.
    function drawIndLegends() {
      const panes = chart.panes();
      const cTop = container.getBoundingClientRect().top;
      const i = hoverTime == null ? raw.length - 1 : barAt(hoverTime);
      const groups = new Map();
      for (const ind of indicators) {
        const key = ind.pane;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ind);
      }
      let html = "";
      for (const [paneIdx, list] of groups) {
        let top = 30; // price pane: under the main legend
        if (paneIdx > 0) {
          const el = panes[paneIdx] && panes[paneIdx].getHTMLElement();
          if (!el) continue;
          top = el.getBoundingClientRect().top - cTop + 4;
        }
        html += `<div class="ipc-ind-group" style="top:${Math.round(top)}px">`;
        for (const ind of list) {
          const vals = ind.def.plots.filter((p) => p.type !== "dots" && !p.hideValue).map((p) => {
            const src = ind.out && ind.out[p.key], k = i - plotShift(ind, p);
            const v = src && i >= 0 && k >= 0 && k < raw.length ? src[k] : null;
            if (v == null || !isFinite(v)) return "";
            const d = ind.def.pane === "overlay" || ind.def.priceUnits ? hooks.digits(symbol) : (ind.def.precision != null ? ind.def.precision : 2);
            if (ind.def.format === "volume") return `<b style="color:${p.color || p.upColor || "#8a8a90"}">${compact(v)}</b>`;
            const col = p.type === "histogram" ? (p.upColor || p.downColor ? (v >= 0 ? (p.upColor || UP) : (p.downColor || DOWN)) : p.color) : p.color;
            return `<b style="color:${col}">${v.toFixed(d)}</b>`;
          }).join(" ");
          html += `<div class="ipc-ind-row" data-uid="${esc(ind.uid)}"><span class="ipc-ind-name">${esc(IND.label(ind.id, ind.inputs))}</span>` +
            `<span class="ipc-ind-vals">${vals}</span>` +
            `<button type="button" class="ipc-ind-btn" data-act="edit" title="Settings" aria-label="Indicator settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>` +
            `<button type="button" class="ipc-ind-btn" data-act="remove" title="Remove" aria-label="Remove indicator">✕</button></div>`;
        }
        html += "</div>";
      }
      indLegend.innerHTML = html;
    }
    indLegend.addEventListener("click", (e) => {
      const btn = e.target.closest(".ipc-ind-btn"), row = e.target.closest(".ipc-ind-row");
      if (!btn || !row) return;
      if (btn.dataset.act === "edit" && hooks.editIndicator) hooks.editIndicator(row.dataset.uid);
      if (btn.dataset.act === "remove" && hooks.removeIndicator) hooks.removeIndicator(row.dataset.uid);
    });
    chart.subscribeCrosshairMove(() => { if (indicators.length) drawIndLegends(); });

    // list: [{uid, id, inputs}] — the full set to show; unchanged ones are kept.
    function setIndicators(list) {
      if (!IND) return;
      const next = (list || []).filter((x) => IND.defs[x.id]);
      const sig = (x) => x.uid + "|" + x.id + "|" + JSON.stringify(x.inputs || {});
      const keep = new Map(indicators.map((x) => [sig(x), x]));
      const nextSigs = new Set(next.map((x) => sig({ ...x, inputs: IND.cleanInputs(x.id, x.inputs) })));
      for (const ind of indicators) if (!nextSigs.has(sig(ind))) unmountIndicator(ind);
      dropEmptyPanes();
      // pane indexes shift when a pane goes away, so rebuild the order
      const built = [];
      for (const x of next) {
        const inputs = IND.cleanInputs(x.id, x.inputs);
        const existing = keep.get(sig({ ...x, inputs }));
        if (existing && Object.keys(existing.series).length) { built.push(existing); continue; }
        const ind = { uid: x.uid, id: x.id, inputs, def: IND.defs[x.id] };
        mountIndicator(ind);
        built.push(ind);
      }
      indicators = built;
      for (const ind of indicators) {
        const first = ind.series[ind.def.plots[0].key];
        if (first) { try { ind.pane = first.getPane().paneIndex(); } catch (_) { /* older API */ } }
      }
      computeIndicators();
      if (!indicators.length) indLegend.innerHTML = "";
    }

    // Volume of the newest candles keeps growing (and new candles start at 0 here), so pull fresh
    // volume from the candle service every minute and update only the volume fields.
    async function refreshVolume() {
      if (!symbol || loadingHistory || !raw.some((b) => b.volume > 0)) return;
      const sym = symbol, timeframe = tf;
      try {
        const j = await (await fetch(`${CANDLES_URL}?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(timeframe)}`)).json();
        if (!j || !j.ok || sym !== symbol || timeframe !== tf) return;
        const m = new Map(j.bars.map((b) => [b.t, b.v || 0]));
        let changed = false;
        for (const b of raw) { const v = m.get(b.time); if (v !== undefined && v !== b.volume) { b.volume = v; changed = true; } }
        if (changed) { indFull = true; scheduleIndicators(); }
      } catch (_) { /* keep what we have */ }
    }
    setInterval(() => { if (!document.hidden) refreshVolume(); }, 60000);

    // ---------------------------------------------------------------- range + scale
    function applyRange() {
      if (pendingRange == null || !raw.length) return;
      const to = raw[raw.length - 1].time;
      let from = Math.max(raw[0].time, to - pendingRange);
      // Short ranges count trading days, not calendar days, so a weekend
      // does not leave "5D" showing three days of candles.
      const days = pendingRange / 86400;
      if (days <= 7 && seconds < 86400) {
        const seen = new Set();
        for (let i = raw.length - 1; i >= 0; i--) {
          // +3h folds the FX Sunday-evening open into Monday's session.
          const day = Math.floor((raw[i].time + 10800) / 86400);
          if (!seen.has(day) && seen.size === days) break;
          seen.add(day);
          from = raw[i].time;
        }
      }
      pendingRange = null;
      chart.timeScale().setVisibleRange({ from, to });
    }
    let lastScale = "";
    function checkScale() {
      const o = chart.priceScale("right").options();
      const key = o.mode + ":" + o.autoScale;
      if (key === lastScale) return;
      lastScale = key;
      if (hooks.scaleChanged) hooks.scaleChanged({ mode: o.mode, auto: !!o.autoScale });
    }
    setInterval(() => { if (!document.hidden) { checkScale(); if (indicators.length) drawIndLegends(); } }, 400);
    // Indicators such as Bollinger Bars recolour candles: time -> colour.
    let candleOverride = new Map();
    const coloured = (b) => { const c = candleOverride.get(b.time); return c ? { ...b, color: c, borderColor: c, wickColor: c } : b; };
    function view() {
      if (style === 2) return raw.map((b) => ({ time: b.time, value: b.close }));
      if (style === 8) return heikinAshi(raw);
      return candleOverride.size ? raw.map(coloured) : raw;
    }
    function setCandleColors(map) {
      // Only the newest candles changing (a live tick) -> update those; anything else -> redraw.
      const changed = [];
      for (let i = 0; i < raw.length; i++) if (candleOverride.get(raw[i].time) !== map.get(raw[i].time)) changed.push(i);
      const old = candleOverride; candleOverride = map;
      if (!changed.length || !series || style === 2 || style === 8) return;
      if (changed.length <= 2 && changed[0] >= raw.length - 2 && old.size) changed.forEach((i) => series.update(coloured(raw[i])));
      else series.setData(view());
    }
    let indFull = true; // history changed (new load, price alignment, style): indicators redraw whole
    function pushAll() { if (series) series.setData(view()); indFull = true; scheduleIndicators(); }
    function pushLast() {
      if (!series || !raw.length) return;
      if (style === 8) { pushAll(); return; } // HA depends on the previous bar
      const b = raw[raw.length - 1];
      series.update(style === 2 ? { time: b.time, value: b.close } : coloured(b));
    }

    function applyTheme() {
      const gridColor = gridAlpha ? (dark ? `rgba(255,255,255,${gridAlpha})` : `rgba(0,0,0,${gridAlpha})`) : "transparent";
      chart.applyOptions({
        layout: { background: { type: "solid", color: dark ? "#0a0a0c" : "#ffffff" }, textColor: dark ? "#8a8a90" : "#6e6e73" },
        grid: { vertLines: { visible: gridAlpha > 0, color: gridColor }, horzLines: { visible: gridAlpha > 0, color: gridColor } },
        rightPriceScale: { borderColor: dark ? "#2a2a2c" : "#e2e4e8" },
        timeScale: { borderColor: dark ? "#2a2a2c" : "#e2e4e8" },
        crosshair: { vertLine: { labelBackgroundColor: dark ? "#2a2a2c" : "#6e6e73" }, horzLine: { labelBackgroundColor: dark ? "#2a2a2c" : "#6e6e73" } },
      });
      overlay.classList.toggle("ipc-light", !dark);
    }

    // ---------------------------------------------------------------- data
    async function load(newSymbol, newTf) {
      const seq = ++loadSeq;
      const symbolChanged = newSymbol !== symbol;
      symbol = newSymbol; tf = newTf; seconds = TF_SECONDS[tf] || 3600;
      raw = []; aligned = false; proxy = false; pendingMid = null; loadingHistory = true;
      bid = ask = null; hoverTime = null;
      if (symbolChanged) {
        trades = []; draft.clear(); render(true);
        // price precision of overlay indicators follows the instrument
        if (indicators.length) { const l = indicators.map((x) => ({ uid: x.uid, id: x.id, inputs: x.inputs })); indicators.forEach(unmountIndicator); indicators = []; dropEmptyPanes(); setIndicators(l); }
      }
      makeSeries();
      hooks.loading(true);
      try {
        const r = await fetch(`${CANDLES_URL}?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`);
        const j = await r.json().catch(() => null);
        if (seq !== loadSeq) return; // a newer symbol/timeframe won the race
        if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || "Chart history unavailable");
        proxy = !!j.proxy;
        closesOnly = !!j.closes_only;
        volumeSource = j.volume_source || null;
        raw = j.bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0 }));
        pushAll();
        chart.timeScale().scrollToRealTime();
        applyRange();
        applyMarkers();
        drawLegend();
        if (hooks.loaded) hooks.loaded({ symbol, tf, proxy, closesOnly, volumeSource, bars: raw.length });
      } catch (e) {
        if (seq !== loadSeq) return;
        hooks.status("Chart history is unavailable right now — live prices will still draw.", true);
      } finally {
        if (seq === loadSeq) {
          loadingHistory = false;
          hooks.loading(false);
          // Align to the quote that arrived mid-load rather than wait for the next poll.
          if (pendingMid !== null) { const m = pendingMid; pendingMid = null; onQuote(m, bid, ask); }
        }
      }
      schedule();
    }

    // Engine quote -> align history once, then extend the current candle.
    function onQuote(mid, qBid, qAsk) {
      mid = Number(mid);
      if (!symbol || !isFinite(mid) || mid <= 0) return;
      const qb = Number(qBid), qa = Number(qAsk);
      if (isFinite(qb) && isFinite(qa) && qb > 0 && qa >= qb) { bid = qb; ask = qa; }
      if (loadingHistory) { pendingMid = mid; return; }
      if (!aligned && raw.length) {
        // History is Yahoo's feed (or a futures proxy for spot metals); the
        // engine's price is what trades fill at. Shift history onto it once,
        // so candles, SL and TP all share one price scale.
        const offset = mid - raw[raw.length - 1].close;
        if (offset !== 0) for (const b of raw) { b.open += offset; b.high += offset; b.low += offset; b.close += offset; }
        aligned = true;
        pushAll();
      }
      aligned = true;
      const now = Math.floor(Date.now() / 1000);
      const intraday = seconds < 86400;
      const bucket = intraday ? Math.floor(now / seconds) * seconds : null;
      const last = raw[raw.length - 1];
      let newBar = false;
      if (!last || (intraday && bucket > last.time)) {
        raw.push({ time: intraday ? bucket : now, open: last ? last.close : mid, high: Math.max(mid, last ? last.close : mid),
          low: Math.min(mid, last ? last.close : mid), close: mid, volume: 0 });
        newBar = true;
      } else {
        last.close = mid; last.high = Math.max(last.high, mid); last.low = Math.min(last.low, mid);
      }
      pushLast();
      scheduleIndicators();
      syncQuoteLines();
      if (newBar) applyMarkers();
      if (hoverTime == null) drawLegend();
      schedule();
    }

    // ---------------------------------------------------------------- trade lines
    function level(t, kind) {
      const d = draft.get(t.id);
      if (d && d[kind] !== undefined) return d[kind];
      return t[kind] == null ? null : Number(t[kind]);
    }

    function setTrades(list) {
      trades = (list || []).filter((t) => t && t.id != null);
      const ids = new Set(trades.map((t) => t.id));
      for (const [id, d] of draft) {
        const t = trades.find((x) => x.id === id);
        if (!ids.has(id)) { draft.delete(id); continue; }
        // Drop a draft once the engine reports the saved value.
        if (!d.saving && (!drag || drag.id !== id)) {
          const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9);
          if ((d.sl === undefined || same(d.sl, t.sl)) && (d.tp === undefined || same(d.tp, t.tp))) draft.delete(id);
        }
      }
      render();
      refit();
    }

    // Re-run autoscale when a level changes so a new SL/TP is on screen.
    // Never mid-drag: rescaling under the cursor would move the line away from it.
    let levelsKey = "";
    function refit() {
      if (drag || !series) return;
      const key = trades.map((t) => [t.id, level(t, "sl"), level(t, "tp")].join(":")).join("|");
      if (key === levelsKey) return;
      levelsKey = key;
      series.applyOptions({ autoscaleInfoProvider: autoscale });
    }

    // Rebuilt only when the set of lines changes, so a poll that just moves
    // P&L never steals keyboard focus or hover from a line.
    let lastSig = "";
    function render(force) {
      const sig = JSON.stringify([hooks.stopRequired(), trades.map((t) => {
        const d = draft.get(t.id) || {};
        return [t.id, t.side, t.volume, t.open_price, level(t, "sl") == null, level(t, "tp") == null, !!d.saving];
      })]);
      if (!force && sig === lastSig) { position(); return; }
      lastSig = sig;
      const html = [];
      for (const t of trades) {
        const side = String(t.side || "").toLowerCase();
        const pnl = t.live_pnl == null ? null : Number(t.live_pnl);
        const col = pnl == null || pnl >= 0 ? UP : DOWN;
        const d = draft.get(t.id) || {};
        const sl = level(t, "sl"), tp = level(t, "tp");
        const digits = hooks.digits(t.symbol);
        const busy = d.saving ? " ipc-saving" : "";
        html.push(
          `<div class="ipc-line ipc-entry" data-id="${esc(t.id)}" data-kind="entry" style="--c:${col}">` +
            `<div class="ipc-tag"><b>${side === "buy" ? "BUY" : "SELL"}</b> ${Number(t.volume).toFixed(2)} @ ${Number(t.open_price).toFixed(digits)}` +
            `<span class="ipc-pnl">${pnl == null ? "—" : money(pnl)}</span>` +
            (sl == null ? `<button type="button" class="ipc-add" data-add="sl" data-id="${esc(t.id)}" title="Click to add a stop loss, or drag it into place">+ SL</button>` : "") +
            (tp == null ? `<button type="button" class="ipc-add" data-add="tp" data-id="${esc(t.id)}" title="Click to add a take profit, or drag it into place">+ TP</button>` : "") +
            `<button type="button" class="ipc-x" data-close="${esc(t.id)}" title="Close position" aria-label="Close position">✕</button></div></div>`,
        );
        for (const kind of ["sl", "tp"]) {
          const v = kind === "sl" ? sl : tp;
          if (v == null) continue;
          const removable = kind === "tp" || !hooks.stopRequired();
          html.push(
            `<div class="ipc-line ipc-${kind}${busy}" data-id="${esc(t.id)}" data-kind="${kind}">` +
              `<div class="ipc-grab" data-drag="${kind}" data-id="${esc(t.id)}" role="slider" tabindex="0"` +
              ` aria-label="${kind === "sl" ? "Stop loss" : "Take profit"} — drag or use arrow keys" aria-valuenow="${v}"></div>` +
              `<div class="ipc-tag" data-drag="${kind}" data-id="${esc(t.id)}"><b>${kind.toUpperCase()}</b> <span class="ipc-px"></span>` +
              `<span class="ipc-val"></span>` +
              (removable ? `<button type="button" class="ipc-x" data-remove="${kind}" data-id="${esc(t.id)}" title="Remove ${kind.toUpperCase()}" aria-label="Remove ${kind.toUpperCase()}">✕</button>` : "") +
              `</div></div>`,
          );
        }
      }
      overlay.innerHTML = html.join("");
      position();
    }

    function tradeById(id) { return trades.find((t) => String(t.id) === String(id)); }

    // Place every line at its price and refresh the live labels.
    function position() {
      if (!series) return;
      const pane = chart.paneSize();
      overlay.style.setProperty("--pane-w", pane.width + "px");
      overlay.querySelectorAll(".ipc-line").forEach((el) => {
        const t = tradeById(el.dataset.id);
        if (!t) return;
        const kind = el.dataset.kind;
        const price = kind === "entry" ? Number(t.open_price) : level(t, kind);
        const y = price == null ? null : series.priceToCoordinate(price);
        if (y == null || y < -2 || y > pane.height + 2) { el.style.display = "none"; return; }
        el.style.display = "";
        el.style.transform = `translateY(${Math.round(y)}px)`;
        if (kind === "entry") {
          const p = el.querySelector(".ipc-pnl");
          if (p && t.live_pnl != null) {
            p.textContent = money(Number(t.live_pnl));
            el.style.setProperty("--c", Number(t.live_pnl) >= 0 ? UP : DOWN);
          }
          return;
        }
        const digits = hooks.digits(t.symbol);
        el.querySelector(".ipc-px").textContent = price.toFixed(digits);
        const val = el.querySelector(".ipc-val");
        const pnl = hooks.pnlAt(t, price);
        let text = pnl == null ? "" : money(pnl);
        let over = false;
        if (kind === "sl") {
          // Same measure as the engine (distance from entry), so "over" here
          // means the engine would refuse it too.
          const risk = hooks.riskAt(t, price), limit = hooks.riskLimit();
          if (risk != null && limit != null) over = risk > limit + 0.01;
          if (over) text += ` · over your ${money(limit).slice(1)} limit`;
          else if (pnl != null && pnl >= 0) text = `locks ${money(pnl)}`;
          else if (risk != null && limit != null) text += ` · ${(risk / limit * 100).toFixed(0)}% of limit`;
        }
        val.textContent = text;
        el.classList.toggle("ipc-over", over);
      });
    }

    let raf = 0;
    function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; position(); }); }
    // The price scale can rescale without an event (autoscale, axis drag),
    // so keep lines glued to their prices while any are shown.
    setInterval(() => { if (!document.hidden && overlay.childElementCount) schedule(); }, 120);
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      schedule();
      // zooming changes how many labels fit
      const sp = chart.timeScale().options().barSpacing;
      if (tradeMarks.length && Math.abs(sp - markerSpacing) > markerSpacing * 0.15) applyMarkers();
    });
    chart.timeScale().subscribeSizeChange(schedule);

    // ---------------------------------------------------------------- dragging
    // A stop must sit on the loss side of the current price and a target on
    // the profit side (the engine enforces the same rule on save).
    function clampLevel(t, kind, price) {
      const mark = hooks.mark(t);
      const digits = hooks.digits(t.symbol);
      const tick = 1 / Math.pow(10, digits);
      const buy = String(t.side).toLowerCase() === "buy";
      if (mark != null && isFinite(mark)) {
        const lossSide = kind === "sl" ? buy : !buy; // true -> must be below mark
        if (lossSide) price = Math.min(price, mark - tick);
        else price = Math.max(price, mark + tick);
      }
      return Math.max(tick, Number(price.toFixed(digits)));
    }

    function defaultLevel(t, kind) {
      const mark = hooks.mark(t) ?? Number(t.open_price);
      const recent = raw.slice(-20);
      const avgRange = recent.length ? recent.reduce((a, b) => a + (b.high - b.low), 0) / recent.length : mark * 0.002;
      let dist = Math.max(avgRange * 2, mark * 0.0005);
      if (kind === "sl") {
        // stay inside the risk limit when one applies
        const limit = hooks.riskLimit(), perUnit = hooks.riskAt(t, Number(t.open_price) - 1);
        if (limit != null && perUnit != null && perUnit > 0) dist = Math.min(dist, (limit * 0.9) / perUnit);
      }
      const buy = String(t.side).toLowerCase() === "buy";
      const below = kind === "sl" ? buy : !buy;
      return clampLevel(t, kind, below ? mark - dist : mark + dist);
    }

    async function commit(t, kind, value) {
      const next = { sl: level(t, "sl"), tp: level(t, "tp") };
      next[kind] = value;
      if (kind === "sl" && value == null && hooks.stopRequired()) {
        hooks.status("This challenge requires a stop loss on every position.", true);
        draft.delete(t.id); render(); return;
      }
      if (kind === "sl" && value != null) {
        const risk = hooks.riskAt(t, value), limit = hooks.riskLimit();
        if (risk != null && limit != null && risk > limit + 0.01) {
          hooks.status(`That stop risks ${money(risk).slice(1)}, above your ${money(limit).slice(1)} limit — moved back.`, true);
          draft.delete(t.id); render(); return;
        }
      }
      draft.set(t.id, { ...next, saving: true });
      render();
      let ok = false;
      try { ok = await hooks.save(t, next); } catch (_) { ok = false; }
      // Either way the engine's state is now the truth: on success it already
      // carries the new level, on failure the old one (the engine message is shown).
      draft.delete(t.id);
      render();
      refit();
    }

    function yFromEvent(e) { return e.clientY - overlay.getBoundingClientRect().top; }

    overlay.addEventListener("pointerdown", (e) => {
      const add = e.target.closest("[data-add]");
      const grab = add ? null : e.target.closest("[data-drag]");
      if (!add && !grab) return;
      if (e.target.closest(".ipc-x")) return;
      const t = tradeById((add || grab).dataset.id);
      if (!t || (draft.get(t.id) || {}).saving) return;
      const kind = add ? add.dataset.add : grab.dataset.drag;
      e.preventDefault();
      const start = add ? null : level(t, kind);
      drag = { id: t.id, kind, start, fresh: !!add, moved: false, pointerId: e.pointerId, y0: e.clientY };
      if (add) { draft.set(t.id, { ...(draft.get(t.id) || {}), [kind]: Number(t.open_price) }); render(); }
      // A transparent shield takes over the pointer for the rest of the drag:
      // the chart underneath does not pan, and lines can be re-rendered by a
      // price poll mid-drag without dropping the gesture.
      shield.hidden = false;
      document.body.classList.add("ipc-dragging");
      const line = overlay.querySelector(`.ipc-line[data-id="${CSS.escape(String(t.id))}"][data-kind="${kind}"]`);
      if (line) line.classList.add("ipc-active");
    });

    window.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (Math.abs(e.clientY - drag.y0) > 2) drag.moved = true;
      if (!drag.moved) return;
      const t = tradeById(drag.id);
      const raw2 = series.coordinateToPrice(yFromEvent(e));
      if (!t || raw2 == null) return;
      draft.set(t.id, { ...(draft.get(t.id) || {}), [drag.kind]: clampLevel(t, drag.kind, Number(raw2)) });
      schedule();
    });

    function endDrag(cancel) {
      if (!drag) return;
      const d0 = drag; drag = null;
      shield.hidden = true;
      document.body.classList.remove("ipc-dragging");
      overlay.querySelectorAll(".ipc-active").forEach((el) => el.classList.remove("ipc-active"));
      const t = tradeById(d0.id);
      if (!t) return;
      if (cancel) { draft.delete(t.id); render(); return; }
      let value = level(t, d0.kind);
      if (d0.fresh && !d0.moved) value = defaultLevel(t, d0.kind); // a click places it at a sensible distance
      if (!d0.fresh && (!d0.moved || value === d0.start)) { draft.delete(t.id); render(); return; }
      commit(t, d0.kind, value);
    }
    window.addEventListener("pointerup", (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(false); });
    window.addEventListener("pointercancel", (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(true); });
    window.addEventListener("blur", () => endDrag(true));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drag) endDrag(true); });

    overlay.addEventListener("click", (e) => {
      const close = e.target.closest("[data-close]");
      if (close) { const t = tradeById(close.dataset.close); if (t) hooks.close(t); return; }
      const rm = e.target.closest("[data-remove]");
      if (rm) { const t = tradeById(rm.dataset.id); if (t) commit(t, rm.dataset.remove, null); }
    });
    overlay.addEventListener("dblclick", (e) => {
      const line = e.target.closest(".ipc-line");
      if (!line || e.target.closest("button")) return;
      const t = tradeById(line.dataset.id);
      if (t) hooks.edit(t);
    });

    // Keyboard: arrows nudge one tick (Shift = 10), saved 700ms after the last press.
    let keyTimer = 0;
    overlay.addEventListener("keydown", (e) => {
      const g = e.target.closest(".ipc-grab");
      if (!g || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      const t = tradeById(g.dataset.id), kind = g.dataset.drag;
      if (!t || (draft.get(t.id) || {}).saving) return;
      const tick = 1 / Math.pow(10, hooks.digits(t.symbol));
      const cur = level(t, kind);
      const next = clampLevel(t, kind, cur + (e.key === "ArrowUp" ? 1 : -1) * tick * (e.shiftKey ? 10 : 1));
      draft.set(t.id, { ...(draft.get(t.id) || {}), [kind]: next });
      schedule();
      clearTimeout(keyTimer);
      keyTimer = setTimeout(() => { const tt = tradeById(t.id); if (tt) commit(tt, kind, level(tt, kind)); }, 700);
    });

    return {
      load,
      onQuote,
      setTrades,
      // For page-level features built on top (indicators, drawing tools).
      get chart() { return chart; },
      get series() { return series; },
      get bars() { return raw; },
      get symbol() { return symbol; },
      get tf() { return tf; },
      setStyle(s) { if (s === style) return; style = s; makeSeries(); },
      refreshLegend() { drawLegend(); },
      setIndicators,
      get indicators() { return indicators.map((x) => ({ uid: x.uid, id: x.id, inputs: x.inputs, pane: x.pane })); },
      // [{time (unix s), side, volume, kind: "entry"|"exit", pnl}]
      setMarkers(list) { tradeMarks = Array.isArray(list) ? list : []; applyMarkers(); },
      // Show the last `spanSeconds` of history (applied after the next load if one is pending).
      setRange(spanSeconds) { pendingRange = spanSeconds; if (!loadingHistory) applyRange(); },
      setScaleMode(mode) { chart.priceScale("right").applyOptions({ mode }); checkScale(); },
      autoFit() { chart.priceScale("right").applyOptions({ autoScale: true }); checkScale(); },
      setTheme(isDark, alpha) { dark = !!isDark; gridAlpha = alpha || 0; applyTheme(); },
      isDragging() { return !!drag; },
      setVisible(on) { overlay.hidden = !on; if (on) render(true); },
      destroy() { overlay.innerHTML = ""; shield.remove(); chart.remove(); },
    };
  }

  window.createIpfxChart = createIpfxChart;
})();
