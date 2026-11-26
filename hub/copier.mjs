// Copier v2 (owner request 26 Nov 2026): event-driven copying to IBKR, run on the hub.
//
// The trading engine POSTs every Infinity trade event here the moment it happens (/copy, hub secret, never awaited, no
// database round trip). Everything the decision needs is already in memory: settings, symbol costs, who qualifies,
// the news calendar and live prices. Results are written to the database in batches every 2 seconds, never in the
// order path.
//
//   shadow  every in-scope trade is copied on paper with modelled costs, from the hub's own live prices:
//           entry = a limit at the trader's fill +- tolerance, checked from (fill + modelled latency) until the
//           fill timeout, else "missed"; pending orders rest, so they fill at the trigger (stops slip); stop loss and
//           take profit rest at the broker (stops slip, limits do not); other exits after the modelled latency.
//           Costs: entry and exit slippage + extra broker spread + commission (rate x notional, minimum per order).
//   paper   additionally, traders who qualify are sent to the IBKR bridge (bridge/ibkr_copier.py, paper account
//           only), which reports real fills and timestamps. Shadow rows keep being written for everyone.
//
// Qualification lives in the database (copy_trader_quality): average trade >= 5x copy cost, shadow-copied profit
// >= 70% of the trader's own, enough trades, an A-book classifier state, and an edge not made of stale IPFX prices.
// This module never sends anything to a broker except through the bridge, and refuses a bridge that is not paper.

export const dirOf = (side) => (side === 'buy' ? 1 : -1);
export const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
export function entryLimit(side, price, tolPips, pip) { return side === 'buy' ? price + tolPips * pip : price - tolPips * pip; }
// A buy limit fills when the ask is at or under the limit (at the ask); a sell limit when the bid is at or over it.
export function limitFill(side, limit, q) {
  if (!q) return null;
  if (side === 'buy') return q.a <= limit + 1e-12 ? q.a : null;
  return q.b >= limit - 1e-12 ? q.b : null;
}
// Round-trip commission in pips: per order max(minimum, rate x notional in USD); scale = USD per 1.0 price move per lot.
export function commissionPips({ lots, price, scale, rate, minUsd, pip }) {
  if (!(lots > 0) || !(scale > 0) || !(pip > 0)) return null;
  const perSide = Math.max(minUsd, rate * lots * price * scale);
  return (2 * perSide) / (lots * pip * scale);
}
// Trader and copy results in pips (positive cost = what copying lost against the trader).
export function settle({ side, pip, traderOpen, traderClose, copyOpen, copyClose, extraSpreadPips, commission }) {
  const d = dirOf(side);
  const traderPips = (d * (traderClose - traderOpen)) / pip;
  const entrySlip = (d * (copyOpen - traderOpen)) / pip;
  const exitSlip = (d * (traderClose - copyClose)) / pip;
  const cost = entrySlip + exitSlip + extraSpreadPips + (commission ?? 0);
  return { trader_pips: round(traderPips), entry_slip_pips: round(entrySlip), exit_slip_pips: round(exitSlip),
    commission_pips: round(commission), cost_pips: round(cost), copy_pips: round(traderPips - cost) };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS = ['source_trade_id', 'mode', 'user_id', 'account_id', 'symbol', 'side', 'from_pending', 'trader_lots', 'copy_lots', 'trader_open',
  'copy_open', 'opened_at', 'entry_status', 'skip_reason', 'trader_close', 'copy_close', 'closed_at', 'close_reason', 'trader_pips', 'copy_pips',
  'cost_pips', 'entry_slip_pips', 'exit_slip_pips', 'commission_pips', 'stale_gap_pips', 'latency', 'broker'];

export class Copier {
  constructor({ quotes, rpc, log, news, risk = null, now = () => Date.now() }) {
    this.quotes = quotes; this.rpc = rpc; this.log = log; this.news = news; this.risk = risk; this.now = now;
    this.settings = null; this.symbols = new Map(); this.qualified = new Set();
    this.rows = new Map();          // `${tradeId}:${mode}` -> row (copy_trades columns + private _fields)
    this.pend = new Map();          // pending order id -> { ev, at, paper: {state, fill} }
    this.waits = new Set();         // shadow entries/exits waiting for a price
    this.bridge = null;             // { ws, account, at }
    this.bridgeQuotes = new Map();  // symbol -> {b, a, ts}
    this.parity = new Map();        // `${symbol}|${bucket}` -> {n, sum, max, behind}
    this.dirty = new Set(); this.events = [];
    this.stats = { intents: 0, rejected: 0, shadowFilled: 0, shadowMissed: 0, skipped: 0, paperSent: 0, paperFilled: 0, paperMissed: 0, saveErrors: 0 };
    this.configError = null; this.configAt = 0;
  }

  // ---------- configuration ----------
  applyConfig(c) {
    if (!c || !c.settings) return;
    this.settings = c.settings;
    this.symbols = new Map((c.symbols || []).map((s) => [s.symbol, { ...s, pip: Number(s.pip) }]));
    this.qualified = new Set(c.qualified || []);
    for (const r of c.open || []) {          // copies still open when the hub restarted
      const key = `${r.source_trade_id}:${r.mode}`;
      if (!this.rows.has(key)) this.rows.set(key, { ...r, trader_open: Number(r.trader_open), copy_open: r.copy_open == null ? null : Number(r.copy_open),
        trader_lots: Number(r.trader_lots), copy_lots: r.copy_lots == null ? null : Number(r.copy_lots),
        _sc: Number(r.broker?.sc) || null, _ct: Number(r.broker?.ct) || null, _parts: [], _remaining: 1, _restored: true });
    }
    this.configAt = this.now(); this.configError = null;
  }
  async loadConfig() {
    try { this.applyConfig(await this.rpc('copy_hub_config', {})); }
    catch (e) { this.configError = String(e.message || e).slice(0, 160); this.log('copier config failed', this.configError); }
  }
  mode() { return this.settings?.mode || 'off'; }
  start() {
    this.loadConfig();
    setInterval(() => this.loadConfig(), 60_000).unref();
    setInterval(() => this.flush(), 2_000).unref();
    setInterval(() => this.tick(), 50).unref();
    setInterval(() => this.newsGuard(), 5_000).unref();
  }

  event(source, kind, stage, detail = {}) {
    if (this.events.length < 5000) this.events.push({ at: new Date(this.now()).toISOString(), source_id: UUID.test(String(source)) ? source : null, kind, stage, detail });
  }
  touch(row) { row.updated = this.now(); this.dirty.add(`${row.source_trade_id}:${row.mode}`); }

  // ---------- intents from the engine ----------
  // {k:'open'|'pending'|'pending_cancel'|'modify'|'close'|'partial', id, pid?, u, a, s, sd, v, p, ot?, sl?, tp?, sc, ct, r?, f?, te, tr, tc?}
  onIntent(ev) {
    const hubRx = this.now();
    this.stats.intents++;
    if (!ev || !UUID.test(String(ev.id)) || typeof ev.k !== 'string') { this.stats.rejected++; return { ok: false }; }
    if (this.mode() === 'off') return { ok: true, mode: 'off' };
    ev.hubRx = hubRx;
    try {
      if (ev.k === 'open') this.open(ev);
      else if (ev.k === 'pending') this.pending(ev);
      else if (ev.k === 'pending_cancel') this.pendingCancel(ev);
      else if (ev.k === 'modify') this.modify(ev);
      else if (ev.k === 'close' || ev.k === 'partial') this.close(ev);
      else { this.stats.rejected++; return { ok: false }; }
    } catch (e) { this.log('copier intent error', String(e)); this.event(ev.id, ev.k, 'error', { e: String(e).slice(0, 200) }); }
    return { ok: true, mode: this.mode() };
  }

  validTrade(ev) {
    return UUID.test(String(ev.u)) && UUID.test(String(ev.a)) && (ev.sd === 'buy' || ev.sd === 'sell') && Number(ev.v) > 0
      && Number(ev.p) > 0 && Number(ev.sc) > 0 && typeof ev.s === 'string';
  }
  baseRow(ev, mode, extra) {
    return { source_trade_id: ev.id, mode, user_id: ev.u, account_id: ev.a, symbol: ev.s, side: ev.sd, from_pending: !!ev.pid,
      trader_lots: Number(ev.v), copy_lots: null, trader_open: Number(ev.p), copy_open: null,
      opened_at: new Date(Number(ev.te) || ev.hubRx).toISOString(), entry_status: 'skipped', skip_reason: null,
      trader_close: null, copy_close: null, closed_at: null, close_reason: null, trader_pips: null, copy_pips: null, cost_pips: null,
      entry_slip_pips: null, exit_slip_pips: null, commission_pips: null, stale_gap_pips: null,
      latency: { tc: ev.tc ?? null, tr: ev.tr ?? null, te: ev.te ?? null, hub_rx: ev.hubRx }, broker: { sc: Number(ev.sc), ct: Number(ev.ct) || null },
      _sc: Number(ev.sc), _ct: Number(ev.ct) || null, _sl: ev.sl ?? null, _tp: ev.tp ?? null, _parts: [], _remaining: 1, ...extra };
  }
  skipReason(ev, sym, at) {
    if (!sym || !sym.enabled) return 'unsupported_symbol';
    const n = this.news?.check(sym.news_currencies, at, this.settings.news_window_s);
    return n ? `news:${n.cur} ${n.title}` : null;
  }
  copyLots(lots) {
    const s = this.settings;
    return Math.max(0.01, Math.min(Number(s.max_lots_per_order), Math.round(lots * Number(s.copy_ratio) * 100) / 100));
  }
  staleGap(ev, sym) {
    const bq = this.bridgeQuotes.get(ev.s);
    if (!bq || Math.abs(this.now() - bq.ts) > 2000) return null;
    // positive = the trader's fill was better than the broker's real price at that moment
    return round(ev.sd === 'buy' ? (bq.a - ev.p) / sym.pip : (ev.p - bq.b) / sym.pip);
  }

  open(ev) {
    if (!this.validTrade(ev)) { this.stats.rejected++; return; }
    const sym = this.symbols.get(ev.s), at = Number(ev.te) || ev.hubRx;
    const pend = ev.pid ? this.pend.get(ev.pid) : null;
    if (pend) this.pend.delete(ev.pid);
    const reason = this.skipReason(ev, sym, at);
    // shadow: always
    const row = this.baseRow(ev, 'shadow', {});
    row.copy_lots = this.copyLots(row.trader_lots);
    if (sym) row.stale_gap_pips = this.staleGap(ev, sym);
    this.rows.set(`${ev.id}:shadow`, row);
    if (reason) { row.skip_reason = reason; this.stats.skipped++; this.touch(row); this.event(ev.id, 'open', 'skipped', { reason }); }
    else if (pend) {
      // a resting order at the broker: limits fill at their price, stops slip
      const slip = pend.ev.ot === 'stop' ? Number(sym.stop_slippage_pips) * sym.pip * dirOf(ev.sd) : 0;
      row.copy_open = Number(pend.ev.p) + slip; row.entry_status = 'filled'; row.latency.entry = 'resting';
      this.stats.shadowFilled++; this.touch(row);
    } else this.waitEntry(row, sym);
    // paper: only qualified traders, only with a paper bridge
    if (this.mode() === 'paper') this.paperOpen(ev, sym, reason, pend);
  }
  waitEntry(row, sym) {
    const s = this.settings, tol = sym.tolerance_pips == null ? Number(s.entry_tolerance_pips) : Number(sym.tolerance_pips);
    const start = Number(row.latency.te || row.latency.hub_rx) + Number(s.modelled_latency_ms);
    this.waits.add({ row, sym, kind: 'entry', limit: entryLimit(row.side, row.trader_open, tol, sym.pip), start, end: start + Number(s.fill_timeout_ms) });
  }
  waitExit(row, sym, delayFrom) {
    this.waits.add({ row, sym, kind: 'exit', start: delayFrom + Number(this.settings.modelled_latency_ms), end: Infinity });
  }
  tick() {
    const now = this.now();
    if (now - (this.lastSweep || 0) > 1000) {
      this.lastSweep = now;
      this.syncFromRisk(now);
      const limit = Number(this.settings?.fill_timeout_ms || 1500) + 10_000;
      for (const r of this.rows.values()) if (r.mode === 'paper' && r.entry_status === 'open_order' && !r.from_pending && r.latency.hub_tx && now - r.latency.hub_tx > limit) {
        r.entry_status = 'missed'; r.skip_reason = 'no_bridge_report'; this.touch(r);
      }
    }
    if (!this.waits.size) return;
    for (const w of this.waits) {
      if (now < w.start) continue;
      const q = this.quotes.get(w.sym.symbol);
      if (w.kind === 'entry') {
        const px = limitFill(w.row.side, w.limit, q);
        if (px != null) { w.row.copy_open = px; w.row.entry_status = 'filled'; this.stats.shadowFilled++; this.waits.delete(w); this.touch(w.row); this.afterEntry(w.row); }
        else if (now >= w.end) { w.row.entry_status = 'missed'; this.stats.shadowMissed++; this.waits.delete(w); this.touch(w.row); this.afterEntry(w.row); }
      } else if (q) {
        // leaving: sells at the bid, buys back at the ask (the copy's own side reversed)
        this.waits.delete(w);
        this.finishExit(w.row, w.sym, w.row.side === 'buy' ? q.b : q.a, w.traderPx, w.reason, w.fraction);
      }
    }
  }
  // The hub's position watcher (risk.mjs) holds every open trade's current stop and target and every resting order,
  // refreshed on each database change. Stops moved by any path (the trader, a trailing stop, the automatic stop) are
  // copied from there, and resting orders that left the book (expired, cancelled, one-cancels-other) are cancelled.
  syncFromRisk(now) {
    const r = this.risk; if (!r || !r.lastFull) return;
    for (const [id, p] of this.pend) {
      if (r.pending.has(id)) { p.missingSince = null; continue; }
      if (now - p.at < 3000) continue;
      p.missingSince ??= now;
      if (now - p.missingSince > 3000) this.pendingCancel({ id });
    }
    for (const row of this.rows.values()) {
      if (row.closed_at || row.entry_status !== 'filled') continue;
      const t = r.trades.get(row.source_trade_id); if (!t) continue;
      const sl = t.sl == null ? null : Number(t.sl), tp = t.tp == null ? null : Number(t.tp);
      if (sl === row._sl && tp === row._tp) continue;
      row._sl = sl; row._tp = tp;
      if (row.mode === 'paper' && this.bridge) this.send({ t: 'protect', id: row.broker.key || row.source_trade_id, sl, tp });
    }
  }
  // An exit that arrived while the shadow entry was still waiting is applied once the entry is known.
  afterEntry(row) {
    const queued = row._queuedExits; row._queuedExits = null;
    for (const x of queued || []) this.applyExit(row, x);
  }

  pending(ev) {
    if (!this.validTrade(ev) || (ev.ot !== 'limit' && ev.ot !== 'stop')) { this.stats.rejected++; return; }
    this.pend.set(ev.id, { ev, at: ev.hubRx, paper: null });
    if (this.pend.size > 5000) this.pend.delete(this.pend.keys().next().value);
    if (this.mode() === 'paper' && this.qualified.has(ev.u)) this.paperRest(ev);
  }
  pendingCancel(ev) {
    const p = this.pend.get(ev.id); if (!p) return;
    this.pend.delete(ev.id);
    if (p.paper && this.bridge) this.send({ t: p.paper.state === 'filled' ? 'exit' : 'cancel', id: ev.id, fraction: 1, reason: 'pending_cancelled' });
  }
  modify(ev) {
    for (const mode of ['shadow', 'paper']) {
      const row = this.rows.get(`${ev.id}:${mode}`); if (!row) continue;
      row._sl = ev.sl ?? null; row._tp = ev.tp ?? null;
      if (mode === 'paper' && this.bridge && row.entry_status === 'filled') this.send({ t: 'protect', id: row.broker.key || ev.id, sl: row._sl, tp: row._tp });
    }
    const p = ev.pid ? this.pend.get(ev.pid) : this.pend.get(ev.id);
    if (p) { p.ev.sl = ev.sl ?? null; p.ev.tp = ev.tp ?? null; }
  }

  close(ev) {
    const fraction = ev.k === 'partial' ? Math.min(1, Math.max(0, Number(ev.f) || 0)) : 1;
    const traderPx = Number(ev.p);
    for (const mode of ['shadow', 'paper']) {
      const row = this.rows.get(`${ev.id}:${mode}`); if (!row || row.closed_at) continue;
      const x = { traderPx, reason: String(ev.r || 'close'), fraction, at: Number(ev.te) || ev.hubRx, sl: ev.sl ?? row._sl, tp: ev.tp ?? row._tp };
      if (mode === 'paper') { this.paperExit(row, x); continue; }
      if (row.entry_status === 'skipped' || row.entry_status === 'missed') { this.recordUncopied(row, x); continue; }
      if (row.copy_open == null) { (row._queuedExits ||= []).push(x); continue; }   // entry still being decided
      this.applyExit(row, x);
    }
  }
  // Nothing was copied: record what the trader made (a missed trade counts as 0 pips copied).
  recordUncopied(row, x) {
    if (x.fraction < 1) return;
    row.trader_close = x.traderPx; row.closed_at = new Date(x.at).toISOString(); row.close_reason = x.reason;
    row.trader_pips = round((dirOf(row.side) * (x.traderPx - row.trader_open)) / (this.symbols.get(row.symbol)?.pip || 1));
    if (row.entry_status === 'missed') row.copy_pips = 0;
    this.touch(row);
  }
  applyExit(row, x) {
    const sym = this.symbols.get(row.symbol); if (!sym) return;
    if (row.entry_status !== 'filled') return this.recordUncopied(row, x);
    const d = dirOf(row.side), slip = Number(sym.stop_slippage_pips) * sym.pip;
    // Exits resting at the broker: the stop is a stop order (slips), the target a limit (does not).
    if (/sl|stop/i.test(x.reason) && x.sl != null) return this.finishExit(row, sym, Number(x.sl) - d * slip, x.traderPx, x.reason, x.fraction);
    if (/tp|take/i.test(x.reason) && x.tp != null) return this.finishExit(row, sym, Number(x.tp), x.traderPx, x.reason, x.fraction);
    this.waits.add({ row, sym, kind: 'exit', start: x.at + Number(this.settings.modelled_latency_ms), end: Infinity, traderPx: x.traderPx, reason: x.reason, fraction: x.fraction });
  }
  finishExit(row, sym, copyPx, traderPx, reason, fraction) {
    row._parts.push({ f: fraction * row._remaining, c: copyPx, t: traderPx });
    row._remaining = fraction >= 1 ? 0 : row._remaining * (1 - fraction);
    if (row._remaining > 1e-9) { this.touch(row); return; }
    const w = row._parts.reduce((s, p) => s + p.f, 0) || 1;
    const copyClose = row._parts.reduce((s, p) => s + p.f * p.c, 0) / w, traderClose = row._parts.reduce((s, p) => s + p.f * p.t, 0) / w;
    const commission = commissionPips({ lots: row.copy_lots, price: row.trader_open, scale: row._sc ?? row.broker?.sc, rate: Number(sym.commission_rate), minUsd: Number(sym.commission_min_usd), pip: sym.pip });
    Object.assign(row, settle({ side: row.side, pip: sym.pip, traderOpen: row.trader_open, traderClose, copyOpen: row.copy_open, copyClose,
      extraSpreadPips: Number(sym.extra_spread_pips), commission }));
    row.trader_close = traderClose; row.copy_close = copyClose; row.closed_at = new Date(this.now()).toISOString(); row.close_reason = reason;
    this.touch(row);
  }

  // ---------- paper (IBKR bridge) ----------
  paperAllowed(ev, sym, reason) {
    if (!this.bridge) return 'bridge_offline';
    if (!this.qualified.has(ev.u)) return 'not_qualified';
    if (reason) return reason;
    if (!sym?.enabled || this.bridge.missing?.has(ev.s)) return 'unsupported_symbol';
    const open = [...this.rows.values()].filter((r) => r.mode === 'paper' && !r.closed_at && r.entry_status === 'filled').length;
    if (open >= Number(this.settings.max_open_copies)) return 'max_open_copies';
    return null;
  }
  units(row) { return Math.round(row.copy_lots * (row._ct || row.broker?.ct || 100000) * 1000) / 1000; }
  paperOpen(ev, sym, reason, pend) {
    const why = this.paperAllowed(ev, sym, reason);
    if (why === 'not_qualified' || why === 'bridge_offline') return;      // shadow already records these traders
    const row = this.baseRow(ev, 'paper', {});
    row.copy_lots = this.copyLots(row.trader_lots);
    this.rows.set(`${ev.id}:paper`, row);
    if (why) { row.skip_reason = why; this.touch(row); return; }
    if (pend?.paper) {
      // the broker already holds (or held) this order since it was placed
      row.broker.key = ev.pid;
      if (pend.paper.state === 'filled') { row.copy_open = pend.paper.px; row.entry_status = 'filled'; Object.assign(row.latency, pend.paper.lat || {}); }
      else row.entry_status = 'open_order';
      this.touch(row); return;
    }
    const s = this.settings, tol = sym.tolerance_pips == null ? Number(s.entry_tolerance_pips) : Number(sym.tolerance_pips);
    row.broker.key = ev.id; row.entry_status = 'open_order';
    row.latency.hub_tx = this.now();
    this.send({ t: 'entry', id: ev.id, symbol: ev.s, side: ev.sd, units: this.units(row), limit: entryLimit(ev.sd, row.trader_open, tol, sym.pip),
      timeout_ms: Number(s.fill_timeout_ms), sl: row._sl, tp: row._tp });
    this.stats.paperSent++; this.touch(row);
  }
  paperRest(ev) {
    const sym = this.symbols.get(ev.s);
    if (!this.bridge || !sym?.enabled || this.bridge.missing?.has(ev.s)) return;
    if (this.news?.check(sym.news_currencies, this.now(), this.settings.news_window_s)) return;   // placed after the news by newsGuard
    const p = this.pend.get(ev.id); if (!p) return;
    const lots = this.copyLots(Number(ev.v));
    p.paper = { state: 'sent', lots };
    this.send({ t: 'rest', id: ev.id, symbol: ev.s, side: ev.sd, order: ev.ot, price: Number(ev.p), units: Math.round(lots * (Number(ev.ct) || 100000) * 1000) / 1000, sl: ev.sl ?? null, tp: ev.tp ?? null });
  }
  paperExit(row, x) {
    const sym = this.symbols.get(row.symbol);
    if (row._brokerExit && sym) {   // the broker's resting stop or target already closed the copy
      const b = row._brokerExit; row._brokerExit = null;
      return this.finishExit(row, sym, b.px, x.traderPx, x.reason, x.fraction);
    }
    if (row.entry_status === 'missed' || row.entry_status === 'skipped') return this.recordUncopied(row, x);
    if (!this.bridge) { row.skip_reason = (row.skip_reason ? row.skip_reason + '; ' : '') + 'exit_while_bridge_offline'; this.touch(row); return; }
    if (row.entry_status === 'open_order') { this.send({ t: 'cancel', id: row.broker.key }); }
    if (row.entry_status === 'filled' || row.entry_status === 'open_order') {
      row._pendingExit = { ...x, sentAt: this.now() };
      this.send({ t: 'exit', id: row.broker.key, fraction: x.fraction, tolerance_pips: 3 * Number(sym?.tolerance_pips ?? this.settings.entry_tolerance_pips), reason: x.reason });
    }
  }
  // Resting copies are pulled before high-impact news and put back afterwards (if the trader's order still rests).
  newsGuard() {
    if (this.mode() !== 'paper' || !this.bridge) return;
    for (const [id, p] of this.pend) {
      if (!p.paper) { if (this.qualified.has(p.ev.u)) this.paperRest(p.ev); continue; }
      const sym = this.symbols.get(p.ev.s); if (!sym || p.paper.state === 'filled') continue;
      const n = this.news?.check(sym.news_currencies, this.now(), this.settings.news_window_s);
      if (n && p.paper.state !== 'pulled') { this.send({ t: 'cancel', id }); p.paper.state = 'pulled'; this.event(id, 'pending', 'news_pulled', { news: n.title }); }
      else if (!n && p.paper.state === 'pulled') { p.paper = null; this.paperRest(p.ev); }
    }
  }
  send(msg) {
    const b = this.bridge;
    if (!b || b.ws.readyState !== 1) return false;
    b.ws.send(JSON.stringify({ ...msg, hub_ts: this.now() }));
    return true;
  }
  attachBridge(ws, hello) {
    if (hello.paper !== true || !/^D[UF]/i.test(String(hello.account || ''))) { ws.close(4403, 'paper accounts only'); return false; }
    if (this.bridge) this.bridge.ws.close(4409, 'replaced');
    this.bridge = { ws, account: String(hello.account), at: this.now(), missing: new Set() };
    const syms = [...this.symbols.values()].filter((s) => s.enabled).map((s) => ({ symbol: s.symbol, broker_symbol: s.broker_symbol, sec_type: s.broker_sec_type, exchange: s.broker_exchange, currency: s.broker_currency, pip: s.pip }));
    ws.send(JSON.stringify({ t: 'config', symbols: syms, max_units_guard: null }));
    this.event(null, 'bridge', 'connected', { account: this.bridge.account });
    return true;
  }
  detachBridge(ws) { if (this.bridge?.ws === ws) { this.bridge = null; this.event(null, 'bridge', 'disconnected', {}); } }
  rowByKey(key) {
    for (const r of this.rows.values()) if (r.mode === 'paper' && r.broker?.key === key && !r.closed_at) return r;
    return null;
  }
  onBridge(m) {
    if (!m || typeof m.t !== 'string') return;
    const now = this.now();
    if (m.t === 'q') return this.onBrokerQuote(m);
    if (m.t === 'contracts') { if (this.bridge) this.bridge.missing = new Set(m.missing || []); this.event(null, 'bridge', 'contracts', { ok: (m.ok || []).length, missing: m.missing || [] }); return; }
    const key = String(m.id || '');
    const lat = { bridge_rx: m.bridge_rx, submit: m.submit_ts, ack: m.ack_ts, fill: m.fill_ts, hub_back: now };
    if (m.t === 'rest_filled') {
      const p = this.pend.get(key);
      if (p?.paper) { p.paper.state = 'filled'; p.paper.px = Number(m.px); p.paper.lat = lat; }
      const row = this.rowByKey(key);
      if (row) { row.copy_open = Number(m.px); row.entry_status = 'filled'; Object.assign(row.latency, lat); this.touch(row); }
      this.stats.paperFilled++; return;
    }
    const row = this.rowByKey(key);
    if (!row) { this.event(UUID.test(key) ? key : null, 'bridge', m.t, { orphan: true }); return; }
    if (m.t === 'entry_filled') { row.copy_open = Number(m.px); row.entry_status = 'filled'; row.broker.qty = m.qty; Object.assign(row.latency, lat); this.stats.paperFilled++; this.afterEntry(row); }
    else if (m.t === 'entry_missed') { row.entry_status = 'missed'; row.skip_reason = String(m.reason || 'timeout').slice(0, 80); Object.assign(row.latency, lat); this.stats.paperMissed++; }
    else if (m.t === 'exit_filled') {
      const sym = this.symbols.get(row.symbol), x = row._pendingExit;
      row.latency.exit = lat;
      if (x && sym) { row._pendingExit = null; this.finishExit(row, sym, Number(m.px), x.traderPx, x.reason, x.fraction); }
      // The broker's resting stop or target closed the copy before IPFX closed the trade: settle when the trader's close arrives.
      else row._brokerExit = { px: Number(m.px), reason: String(m.reason || 'broker') };
    } else if (m.t === 'error') { this.event(row.source_trade_id, 'bridge', 'error', { msg: String(m.msg || '').slice(0, 200) }); }
    this.touch(row);
  }
  // IPFX price vs the broker's price, 5-minute buckets (the "honest simulator" check).
  onBrokerQuote(m) {
    const sym = this.symbols.get(m.s), b = Number(m.b), a = Number(m.a), ts = Number(m.ts) || this.now();
    if (!sym || !(b > 0) || !(a >= b)) return;
    this.bridgeQuotes.set(m.s, { b, a, ts });
    const q = this.quotes.get(m.s); if (!q) return;
    const gap = Math.abs((q.b + q.a) / 2 - (b + a) / 2) / sym.pip;
    const bucket = new Date(Math.floor(ts / 300_000) * 300_000).toISOString(), key = `${m.s}|${bucket}`;
    const p = this.parity.get(key) || { symbol: m.s, bucket, n: 0, sum: 0, max: 0, behind: 0 };
    p.n++; p.sum += gap; p.max = Math.max(p.max, gap); p.behind += Math.max(0, ts - (q.rt || ts));
    this.parity.set(key, p);
  }

  // ---------- persistence (batched, never in the order path) ----------
  async flush() {
    if (this.flushing || (!this.dirty.size && !this.events.length && !this.parity.size)) return;
    this.flushing = true;
    const keys = [...this.dirty].slice(0, 500), events = this.events.splice(0, 2000);
    const trades = keys.map((k) => this.rows.get(k)).filter(Boolean).map((r) => Object.fromEntries(COLS.map((c) => [c, r[c] ?? null])));
    const nowBucket = Math.floor(this.now() / 300_000) * 300_000;
    const parity = [...this.parity.values()].slice(0, 500).map((p) => ({ symbol: p.symbol, bucket: p.bucket, samples: p.n, mean_gap_pips: round(p.sum / p.n, 3), max_gap_pips: round(p.max, 3), ipfx_behind_ms: round(p.behind / p.n, 0) }));
    try {
      await this.rpc('copy_hub_save', { p_trades: trades, p_events: events, p_parity: parity });
      for (const k of keys) {
        this.dirty.delete(k);
        const r = this.rows.get(k);
        if (r?.closed_at && Date.parse(r.closed_at) < this.now() - 3_600_000) this.rows.delete(k);   // keep closed rows an hour for late broker reports
      }
      for (const [k, p] of this.parity) if (Date.parse(p.bucket) < nowBucket) this.parity.delete(k);
    } catch (e) { this.stats.saveErrors++; this.events.unshift(...events.slice(0, 5000 - this.events.length)); this.log('copier save failed', String(e).slice(0, 160)); }
    finally { this.flushing = false; }
  }

  summary() {
    return { mode: this.mode(), configAgeS: this.configAt ? Math.round((this.now() - this.configAt) / 1000) : null, configError: this.configError,
      qualified: this.qualified.size, openRows: [...this.rows.values()].filter((r) => !r.closed_at).length, waiting: this.waits.size, pending: this.pend.size,
      unsaved: this.dirty.size, bridge: this.bridge ? { connected: true, sinceS: Math.round((this.now() - this.bridge.at) / 1000), missing: [...this.bridge.missing] } : null,   // never the account number (public /health)
      news: this.news?.summary(), ...this.stats };
  }
}
