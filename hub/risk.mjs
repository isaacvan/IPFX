// Tick-by-tick position watcher. It never decides a rule: when a stop, take-profit, trailing stop, pending order,
// stop-loss deadline or loss limit is crossed (or close), it asks trading-engine's enforce() to act on that account.
// Missing something is never fatal: the engine's 10s sweep and the traders' own price checks still run.
export class Risk {
  constructor({ quotes, rpc, engine, mode, log }) {
    Object.assign(this, { quotes, rpc, engine, mode, log });
    this.specs = {};
    this.accounts = new Map(); this.trades = new Map(); this.pending = new Map();
    this.bySymbol = new Map(); this.pendBySymbol = new Map(); this.accTrades = new Map();
    this.peaks = new Map(); this.cooldown = new Map(); this.queue = new Map();
    this.slDeadline = null; this.lastFull = 0; this.flushing = false;
    this.stats = { triggers: {}, enforceCalls: 0, enforcedAccounts: 0, enforceErrors: 0, refreshes: 0, refreshErrors: 0 };
  }

  async start() {
    await this.loadSpecs();
    await this.refreshAll();
    setInterval(() => this.flush(), 100).unref();
    setInterval(() => this.timeChecks(), 5_000).unref();
    setInterval(() => this.refreshAll().catch(() => {}), 30_000).unref();
    setInterval(() => this.loadSpecs().catch(() => {}), 3_600_000).unref();
  }

  async loadSpecs() {
    const r = await this.engine({ action: 'hub_specs' });
    if (r?.instruments) this.specs = r.instruments;
  }

  async refreshAll() {
    try { this.apply(await this.rpc('hub_snapshot', {}), null); this.lastFull = Date.now(); this.stats.refreshes++; }
    catch (e) { this.stats.refreshErrors++; this.log('snapshot failed', String(e)); }
  }

  async refreshAccount(id) {
    try { this.apply(await this.rpc('hub_snapshot', { p_account: id }), id); }
    catch (e) { this.stats.refreshErrors++; }
  }

  // Replace everything (full snapshot) or one account's rows (account snapshot).
  apply(snap, onlyAccount) {
    if (!snap) return;
    if (snap.sl_deadline_seconds !== undefined) this.slDeadline = snap.sl_deadline_seconds == null ? null : Number(snap.sl_deadline_seconds);
    const dropAccount = (id) => {
      for (const tid of this.accTrades.get(id) ?? []) this.removeTrade(tid);
      for (const [pid, p] of this.pending) if (p.account_id === id) this.removePending(pid);
      this.accounts.delete(id);
    };
    if (onlyAccount) dropAccount(onlyAccount);
    else { for (const id of [...this.accounts.keys()]) dropAccount(id); }
    for (const a of snap.accounts ?? []) this.accounts.set(a.id, a);
    for (const t of snap.trades ?? []) this.addTrade(t);
    for (const p of snap.pending ?? []) this.addPending(p);
  }

  addTrade(t) {
    this.trades.set(t.id, t);
    if (!this.bySymbol.has(t.symbol)) this.bySymbol.set(t.symbol, new Set());
    this.bySymbol.get(t.symbol).add(t.id);
    if (!this.accTrades.has(t.account_id)) this.accTrades.set(t.account_id, new Set());
    this.accTrades.get(t.account_id).add(t.id);
  }
  removeTrade(id) {
    const t = this.trades.get(id); if (!t) return;
    this.trades.delete(id); this.bySymbol.get(t.symbol)?.delete(id); this.accTrades.get(t.account_id)?.delete(id);
  }
  addPending(p) {
    this.pending.set(p.id, p);
    if (!this.pendBySymbol.has(p.symbol)) this.pendBySymbol.set(p.symbol, new Set());
    this.pendBySymbol.get(p.symbol).add(p.id);
  }
  removePending(id) {
    const p = this.pending.get(id); if (!p) return;
    this.pending.delete(id); this.pendBySymbol.get(p.symbol)?.delete(id);
  }

  symbols() { return [...new Set([...this.bySymbol.keys(), ...this.pendBySymbol.keys()])].filter((s) => (this.bySymbol.get(s)?.size || this.pendBySymbol.get(s)?.size)); }

  fresh(q) { return q && Date.now() - (q.at ?? 0) < 30_000; }

  // USD value of a 1.0 move in the quote currency (same table as trading-engine's usdPerQuote).
  conv(quote) {
    const mid = (s) => { const q = this.quotes.get(s); return q && q.m > 0 ? q.m : null; };
    if (quote === 'USD') return 1;
    if (quote === 'JPY') { const r = mid('USDJPY'); return r ? 1 / r : null; }
    if (quote === 'GBP') return mid('GBPUSD');
    if (quote === 'CAD') { const r = mid('USDCAD'); return r ? 1 / r : null; }
    if (quote === 'CHF') { const r = mid('USDCHF'); return r ? 1 / r : null; }
    return null;
  }

  pnl(t) {
    const q = this.quotes.get(t.symbol), spec = this.specs[t.symbol];
    if (!q || !spec) return null;
    const c = this.conv(spec.quote); if (c == null) return null;
    const mark = t.side === 'buy' ? q.b : q.a, dir = t.side === 'buy' ? 1 : -1;
    return (mark - Number(t.open_price)) * dir * spec.contract * Number(t.volume) * c;
  }

  // Equity and the nearest loss floor, mirroring enforce()'s formulas. Demo accounts have no loss limits.
  limits(a) {
    if (a.status !== 'active' || a.revoked || (a.venue && a.venue !== 'ipfx') || a.challenge_type === 'demo') return null;
    let floating = 0;
    for (const tid of this.accTrades.get(a.id) ?? []) { const p = this.pnl(this.trades.get(tid)); if (p == null) return null; floating += p; }
    const equity = Number(a.balance) + floating, start = Number(a.starting_balance);
    const ddAmount = start * Number(a.max_drawdown_pct) / 100, paid = Number(a.total_paid_out ?? 0);
    const mode = a.drawdown_mode ?? 'static';
    let ddFloor;
    if (mode === 'trailing_intraday') {
      const peak = Math.max(Number(a.trailing_peak ?? start), this.peaks.get(a.id) ?? 0, equity);
      this.peaks.set(a.id, peak);
      ddFloor = peak - ddAmount - paid;
    } else if (mode === 'trailing_eod') ddFloor = Number(a.trailing_peak ?? start) - ddAmount - paid;
    else ddFloor = start * (1 - Number(a.max_drawdown_pct) / 100) - paid;
    const today = new Date().toISOString().slice(0, 10);
    const dailyFloor = a.day_start_date === today ? Number(a.day_start_equity) - start * Number(a.daily_loss_pct) / 100 : -Infinity;
    const band = Math.max(1, 0.05 * start * Number(a.daily_loss_pct) / 100);
    return { equity, floor: Math.max(ddFloor, dailyFloor), band };
  }

  onQuote(q) {
    const touched = new Set();
    const ex = (side) => (side === 'buy' ? q.b : q.a);
    for (const tid of this.bySymbol.get(q.s) ?? []) {
      const t = this.trades.get(tid); if (!t) continue;
      touched.add(t.account_id);
      const px = ex(t.side), sl = t.sl == null ? null : Number(t.sl), tp = t.tp == null ? null : Number(t.tp);
      if (t.side === 'buy') {
        if (sl != null && px <= sl) this.flag(t.account_id, 'stop_loss');
        else if (tp != null && px >= tp) this.flag(t.account_id, 'take_profit');
      } else {
        if (sl != null && px >= sl) this.flag(t.account_id, 'stop_loss');
        else if (tp != null && px <= tp) this.flag(t.account_id, 'take_profit');
      }
      const trail = t.trail_distance == null ? 0 : Number(t.trail_distance);
      if (trail > 0) {
        const step = Math.pow(10, -(this.specs[t.symbol]?.digits ?? 5)) * 5;
        const cand = t.side === 'buy' ? px - trail : px + trail;
        if (sl == null || (t.side === 'buy' ? cand > sl + step : cand < sl - step)) this.flag(t.account_id, 'trailing_stop');
      }
    }
    for (const pid of this.pendBySymbol.get(q.s) ?? []) {
      const o = this.pending.get(pid); if (!o) continue;
      const trig = Number(o.trigger_price), isBuy = o.side === 'buy', px = isBuy ? q.a : q.b;
      const hit = o.order_type === 'limit' ? (isBuy ? px <= trig : px >= trig) : (isBuy ? px >= trig : px <= trig);
      if (hit) this.flag(o.account_id, 'pending_order');
    }
    for (const id of touched) {
      const a = this.accounts.get(id); if (!a) continue;
      const l = this.limits(a);
      if (l && l.equity <= l.floor + l.band) this.flag(id, 'loss_limit');
    }
  }

  timeChecks() {
    const now = Date.now();
    if (this.slDeadline != null) {
      for (const t of this.trades.values()) {
        if (t.sl == null && now - Date.parse(t.opened_at) > this.slDeadline * 1000) this.flag(t.account_id, 'no_stop_loss');
      }
    }
    for (const o of this.pending.values()) if (o.expires_at && Date.parse(o.expires_at) < now) this.flag(o.account_id, 'order_expiry');
    for (const [id, until] of this.cooldown) if (until < now - 60_000) this.cooldown.delete(id);
  }

  flag(accountId, reason) {
    const now = Date.now();
    if ((this.cooldown.get(accountId) ?? 0) > now || this.queue.has(accountId)) return;
    this.cooldown.set(accountId, now + 2_000);
    this.queue.set(accountId, reason);
    this.stats.triggers[reason] = (this.stats.triggers[reason] ?? 0) + 1;
  }

  async flush() {
    if (this.flushing || !this.queue.size) return;
    const batch = [...this.queue.keys()].slice(0, 25);
    for (const id of batch) this.queue.delete(id);
    if (this.mode !== 'active') return;                          // shadow: count only, never act
    this.flushing = true;
    try {
      const r = await this.engine({ action: 'hub_enforce', account_ids: batch });
      this.stats.enforceCalls++; this.stats.enforcedAccounts += batch.length;
      if (!r?.ok) this.stats.enforceErrors++;
      await Promise.all(batch.map((id) => this.refreshAccount(id)));
    } catch (e) { this.stats.enforceErrors++; this.log('enforce failed', String(e)); }
    finally { this.flushing = false; }
  }

  healthy() { return Date.now() - this.lastFull < 90_000 && Object.keys(this.specs).length > 0; }

  summary() {
    return { mode: this.mode, healthy: this.healthy(), accounts: this.accounts.size, trades: this.trades.size, pending: this.pending.size,
      lastFullAgoS: this.lastFull ? Math.round((Date.now() - this.lastFull) / 1000) : null, ...this.stats };
  }
}

