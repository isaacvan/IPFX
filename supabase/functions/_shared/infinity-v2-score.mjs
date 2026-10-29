// Pure scoring kernel. All policy values come from the saved version snapshot.
// This module has no trading, broker, network or account mutation side effects.
const time = value => { const n = Date.parse(value); if (!Number.isFinite(n)) throw new Error('INVALID_TRADE_TIME'); return n; };
const number = value => { const n = Number(value); if (value == null || !Number.isFinite(n)) throw new Error('INVALID_TRADE_NUMBER'); return n; };

export function groupCountedTrades(trades, rules, since = null) {
  const start = since == null ? -Infinity : time(since);
  const gap = number(rules.group_gap_minutes) * 60000;
  const hold = number(rules.min_hold_seconds) * 1000;
  const cap = number(rules.score_r_cap);
  const streams = new Map(), groups = [];
  const seen = new Set();
  for (const t of [...trades].sort((a,b) => time(a.opened_at)-time(b.opened_at) || String(a.id).localeCompare(String(b.id)))) {
    if (seen.has(t.id)) throw new Error('DUPLICATE_TRADE_ID');
    seen.add(t.id);
    const opened = time(t.opened_at);
    if (opened < start) continue;
    const closed = t.status === 'closed' ? time(t.closed_at) : Infinity;
    if (closed < opened) throw new Error('INVALID_TRADE_INTERVAL');
    const key = JSON.stringify([t.account_id, t.symbol, t.side]);
    let g = streams.get(key);
    // Keep the maximum close of the entire group; an early-closing later leg
    // must not hide an older overlapping position. Interleaved symbols are independent.
    if (!g || !(opened < g.lastClose || opened - g.lastEntry <= gap)) {
      g = { key, ids: [], lastEntry: opened, lastClose: closed, pnl: 0, eligiblePnl: 0, risk: 0, validRisk: true, unexpectedRisk: false, closed: true };
      groups.push(g); streams.set(key, g);
    }
    g.ids.push(t.id); g.lastEntry = opened; g.lastClose = Math.max(g.lastClose, closed);
    g.closed &&= closed !== Infinity;
    const risk = Number(t.initial_risk_usd);
    if (t.initial_risk_usd == null || !Number.isFinite(risk) || risk <= 0) { g.validRisk = false; if(t.close_reason!=='no_stop_loss')g.unexpectedRisk=true; }
    else g.risk += risk;
    if (closed !== Infinity) {
      const pnl = number(t.pnl);
      g.pnl += pnl;
      g.eligiblePnl += pnl > 0 && closed-opened < hold ? 0 : pnl;
    }
  }
  return groups.map(g => ({ ...g, r: g.closed && g.validRisk ? Math.max(-cap,Math.min(cap,g.pnl/g.risk)) : null }));
}

export function consistencyScore(groups, rules) {
  const rs = groups.filter(g=>g.closed && g.validRisk).map(g=>number(g.r));
  if (!rs.length) return { n: 0, mean: 0, sd: 0, score: 0 };
  const mean = rs.reduce((a,b)=>a+b,0)/rs.length;
  // Sample standard deviation (n-1); n=1 uses the configured floor.
  const sd = rs.length > 1 ? Math.sqrt(rs.reduce((s,r)=>s+(r-mean)**2,0)/(rs.length-1)) : 0;
  return { n: rs.length, mean, sd, score: mean*Math.sqrt(rs.length)/Math.max(sd,number(rules.sd_floor)) };
}

export function evaluateStage({ account, trades, lineageTrades = [], rules, since = null, pendingCount = 0, integrityHold = false }) {
  const groups = groupCountedTrades(trades,rules,since);
  const stats = consistencyScore(groups,rules);
  const combined = consistencyScore([...groupCountedTrades(lineageTrades,rules),...groups],rules);
  const days = new Map();
  for (const t of trades) {
    if (t.status !== 'closed') continue;
    const p = number(t.pnl), held=time(t.closed_at)-time(t.opened_at);
    const eligibilityHold=since && time(t.opened_at)<time(since)?60:number(rules.min_hold_seconds);
    const eligible = p>0 && held<eligibilityHold*1000 ? 0 : p;
    const day = new Date(time(t.closed_at)).toISOString().slice(0,10);
    days.set(day,(days.get(day)||0)+eligible);
  }
  const profit=[...days.values()].reduce((a,b)=>a+b,0);
  // Spec says total profit, not the sum of winning days (the old v1 rule).
  const bestDay=Math.max(0,...days.values()), share=profit>0 ? bestDay/profit : null;
  const target=number(account.starting_balance)*number(rules.target_pct)/100;
  const unmet=[];
  if (trades.some(t=>t.status==='open') || pendingCount>0) unmet.push('NOT_FLAT');
  if (groups.some(g=>g.unexpectedRisk)) unmet.push('OPENING_RISK_UNAVAILABLE');
  if (profit+1e-8<target) unmet.push('PROFIT_TARGET');
  if (number(account.balance)+1e-8<number(account.starting_balance)+target) unmet.push('BALANCE_TARGET');
  if (stats.n<number(rules.min_counted_trades)) unmet.push('COUNTED_TRADES');
  if (rules.stage_score!=null && stats.score<number(rules.stage_score)) unmet.push('STAGE_SCORE');
  if (rules.combined_score!=null && combined.score<number(rules.combined_score)) unmet.push('COMBINED_SCORE');
  if (rules.best_day_share!=null && (share==null || share>number(rules.best_day_share)+1e-12)) unmet.push('BEST_DAY');
  if (integrityHold) unmet.push('INTEGRITY_REVIEW');
  let performanceBreach=false;
  if (rules.performance_window!=null) {
    const closed=groups.filter(g=>g.closed && g.validRisk).sort((a,b)=>a.lastClose-b.lastClose);
    const window=number(rules.performance_window), loss=number(account.starting_balance)*number(rules.performance_loss_pct)/100;
    for(let i=window;i<=closed.length;i++) if(closed.slice(i-window,i).reduce((s,g)=>s+g.pnl,0)<=-loss+1e-8) performanceBreach=true;
  }
  if(performanceBreach) unmet.push('PERFORMANCE_BREACH');
  return { eligible: unmet.length===0, unmet, stats, combined, profit, target, bestDayShare: share, performanceBreach, groups };
}
