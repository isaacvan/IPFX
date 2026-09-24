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
   *   loaded({symbol,tf,proxy,bars})-> optional; history arrived (proxy = futures history for a spot price)
   */
  function createIpfxChart(container, overlay, hooks) {
    if (!LWC) throw new Error("Lightweight Charts failed to load");

    let dark = true, gridAlpha = 0, style = 1;
    let symbol = null, tf = "60", seconds = 3600;
    let raw = [];            // [{time, open, high, low, close}] in engine-aligned prices
    let aligned = false;     // history shifted onto the engine's live price yet?
    let proxy = false;
    let loadSeq = 0;
    let loadingHistory = false;
    let pendingMid = null;   // newest quote that arrived while history was loading
    let series = null;
    let trades = [];
    const draft = new Map(); // tradeId -> {sl, tp, saving}
    let drag = null;
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
      pushAll();
    }
    function view() {
      if (style === 2) return raw.map((b) => ({ time: b.time, value: b.close }));
      if (style === 8) return heikinAshi(raw);
      return raw;
    }
    function pushAll() { if (series) series.setData(view()); }
    function pushLast() {
      if (!series || !raw.length) return;
      if (style === 8) { pushAll(); return; } // HA depends on the previous bar
      const b = raw[raw.length - 1];
      series.update(style === 2 ? { time: b.time, value: b.close } : b);
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
      if (symbolChanged) { trades = []; draft.clear(); render(true); }
      makeSeries();
      hooks.loading(true);
      try {
        const r = await fetch(`${CANDLES_URL}?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`);
        const j = await r.json().catch(() => null);
        if (seq !== loadSeq) return; // a newer symbol/timeframe won the race
        if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || "Chart history unavailable");
        proxy = !!j.proxy;
        raw = j.bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c }));
        pushAll();
        chart.timeScale().scrollToRealTime();
        if (hooks.loaded) hooks.loaded({ symbol, tf, proxy, bars: raw.length });
      } catch (e) {
        if (seq !== loadSeq) return;
        hooks.status("Chart history is unavailable right now — live prices will still draw.", true);
      } finally {
        if (seq === loadSeq) {
          loadingHistory = false;
          hooks.loading(false);
          // Align to the quote that arrived mid-load rather than wait for the next poll.
          if (pendingMid !== null) { const m = pendingMid; pendingMid = null; onQuote(m); }
        }
      }
      schedule();
    }

    // Engine quote -> align history once, then extend the current candle.
    function onQuote(mid) {
      mid = Number(mid);
      if (!symbol || !isFinite(mid) || mid <= 0) return;
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
      if (!last || (intraday && bucket > last.time)) {
        raw.push({ time: intraday ? bucket : now, open: last ? last.close : mid, high: Math.max(mid, last ? last.close : mid),
          low: Math.min(mid, last ? last.close : mid), close: mid });
      } else {
        last.close = mid; last.high = Math.max(last.high, mid); last.low = Math.min(last.low, mid);
      }
      pushLast();
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
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
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
      setTheme(isDark, alpha) { dark = !!isDark; gridAlpha = alpha || 0; applyTheme(); },
      isDragging() { return !!drag; },
      setVisible(on) { overlay.hidden = !on; if (on) render(true); },
      destroy() { overlay.innerHTML = ""; shield.remove(); chart.remove(); },
    };
  }

  window.createIpfxChart = createIpfxChart;
})();
