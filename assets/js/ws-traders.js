/* Traders: one list of every trader with filters, search and sort. Selecting a trader opens one panel with
   their record and the actions that apply to them (book, investigation hold). Replaces the trader lists on
   Operations, Brain, Analytics and the A/B-book pages. Full trade history loads only when a trader is opened. */
(() => {
  'use strict';
  const T = window.TeamOS, { esc, usd, ukTime } = T;
  const $ = (id) => document.getElementById(id);
  const DET = { RISK_NO_GO: ['Risk no-go', 'red'], HIGH_POTENTIAL: ['High potential', 'green'], PROFITABILITY_CONFIRMED: ['Confirmed', 'green'], LIVE_REVIEW_REQUIRED: ['Live review', 'blue'], OBSERVE: ['Observe', ''], INSUFFICIENT_EVIDENCE: ['Too few trades', ''] };
  const FILTERS = ['All', 'Active', 'Breached', 'A-book', 'Risk no-go', '100+ trades'];
  const DET_ORDER = ['HIGH_POTENTIAL', 'PROFITABILITY_CONFIRMED', 'LIVE_REVIEW_REQUIRED', 'OBSERVE', 'INSUFFICIENT_EVIDENCE', 'RISK_NO_GO', 'NOT_ASSESSED'];
  const detKey = (t) => (DET[t.detector?.state] ? t.detector.state : 'NOT_ASSESSED');
  let traders = [], copy = null, filter = 'All', detFilter = 'all', sortBy = 'pnl', query = '', open = null;

  // Expectancy in R (R = average loss): (1 - win rate)(profit factor - 1). Significant at 100+ closed trades.
  function expectancy(st) {
    const n = Number(st?.trades) || 0;
    if (!n || st.win_rate == null) return { t: '—', c: '', v: -Infinity };
    const w = Number(st.win_rate) / 100, sig = n >= 100, note = sig ? '' : ' <span class="muted" style="font-size:11px">n&lt;100</span>';
    if (st.profit_factor == null) return { t: (w > 0 ? '∞R' : '—') + note, c: sig && w > 0 ? 'good' : '', v: w > 0 ? 1e9 : -Infinity };
    const e = (1 - w) * (Number(st.profit_factor) - 1);
    return { t: (e >= 0 ? '+' : '') + e.toFixed(2) + 'R' + note, c: e > 0 ? (sig ? 'good' : '') : 'bad', v: e };
  }
  const selection = (t) => (copy?.selections || []).find((s) => s.email && t.email && s.email.toLowerCase() === t.email.toLowerCase());
  const inA = (t) => { const s = selection(t); return !!(s && s.enabled && (s.copying_on === true || s.model === 'AB_LIVE')); };
  const det = (t) => DET[t.detector?.state] || ['Not assessed', ''];
  const cap = (txt, cls) => `<span class="cap ${cls || ''}">${esc(txt)}</span>`;
  const statusCap = (t) => cap(t.status, t.status === 'active' ? 'green' : t.status === 'breached' ? 'red' : t.status === 'passed' ? 'blue' : '');
  const bookCap = (t) => inA(t) ? cap('A-book', 'blue') : cap('B-book', 'orange');
  const stageText = (t) => (t.phase === 'funded' ? 'Funded' : 'Stage ' + (t.stage || 1)) + (t.challenge_type && t.challenge_type !== 'infinity' ? ' · ' + t.challenge_type : '');

  function rows() {
    const q = query.trim().toLowerCase();
    let r = traders.filter((t) => {
      if (q && !`${t.full_name} ${t.email}`.toLowerCase().includes(q)) return false;
      if (detFilter !== 'all' && detKey(t) !== detFilter) return false;
      if (filter === 'Active') return t.status === 'active';
      if (filter === 'Breached') return t.status === 'breached';
      if (filter === 'A-book') return inA(t);
      if (filter === 'Risk no-go') return t.detector?.state === 'RISK_NO_GO';
      if (filter === '100+ trades') return Number(t.stats?.trades) >= 100;
      return true;
    });
    const num = (v) => (v == null || !Number.isFinite(Number(v)) ? -Infinity : Number(v));
    const key = { pnl: (t) => num(t.realized_pnl), ret: (t) => (Number(t.starting_balance) > 0 ? num(t.realized_pnl) / Number(t.starting_balance) : -Infinity),
      exp: (t) => expectancy(t.stats).v, trades: (t) => num(t.stats?.trades), bal: (t) => num(t.balance), best: (t) => num(t.stats?.consistency_pct), pf: (t) => num(t.stats?.profit_factor ?? (Number(t.stats?.win_rate) > 0 ? 1e9 : null)),
      det: (t) => -DET_ORDER.indexOf(detKey(t)), wr: (t) => num(t.stats?.win_rate), dd: (t) => num(t.stats?.max_drawdown_pct) }[sortBy];
    return r.sort((a, b) => key(b) - key(a));
  }

  function render() {
    const list = rows(), counts = {};
    for (const f of FILTERS) counts[f] = f === 'All' ? traders.length : traders.filter((t) => (f === 'Active' ? t.status === 'active' : f === 'Breached' ? t.status === 'breached' : f === 'A-book' ? inA(t) : f === 'Risk no-go' ? t.detector?.state === 'RISK_NO_GO' : Number(t.stats?.trades) >= 100)).length;
    $('filters').innerHTML = `<div class="seg">${FILTERS.map((f) => `<button type="button" data-filter="${esc(f)}" aria-pressed="${f === filter}">${esc(f)} · ${counts[f]}</button>`).join('')}</div>`;
    // Firm-wide summary and detector-state chips, as on the Operations trader list.
    const net = traders.reduce((s, t) => s + (Number(t.realized_pnl) || 0), 0), dc = {};
    for (const t of traders) dc[detKey(t)] = (dc[detKey(t)] || 0) + 1;
    const sTile = (k, v, cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v num ${cls}">${v}</div></div>`;
    $('summary').innerHTML = `<div class="stats" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">${sTile('Traders', traders.length)}${sTile('Active', traders.filter((t) => t.status === 'active').length)}
      ${sTile('In profit', traders.filter((t) => Number(t.realized_pnl) > 0).length, 'good')}${sTile('Net trader P&amp;L', usd(net), net < 0 ? 'bad' : net > 0 ? 'good' : '')}
      ${sTile('High potential', dc.HIGH_POTENTIAL || 0, 'good')}${sTile('Confirmed / live review', (dc.PROFITABILITY_CONFIRMED || 0) + (dc.LIVE_REVIEW_REQUIRED || 0), 'good')}${sTile('Risk no-go', dc.RISK_NO_GO || 0, 'bad')}</div>
      <div class="banner" style="margin:12px 0 0">Detector states run in shadow mode (uncalibrated). Treat them as “worth a look”, not a verdict. They never enable live copying or touch payouts.</div>`;
    $('detfilters').innerHTML = `<div class="seg"><button type="button" data-det="all" aria-pressed="${detFilter === 'all'}">Any detector · ${traders.length}</button>${DET_ORDER.filter((k) => dc[k]).map((k) => `<button type="button" data-det="${k}" aria-pressed="${detFilter === k}">${esc(DET[k]?.[0] || 'Not assessed')} · ${dc[k]}</button>`).join('')}</div>`;
    $('list').innerHTML = `<div class="tablewrap"><div class="scroll"><table><thead><tr><th>Trader</th><th>Stage</th><th>Status</th><th>Book</th><th class="r">P&amp;L</th><th class="r">Balance</th><th class="r">Trades</th><th class="r">Win rate</th><th class="r">Profit factor</th><th class="r">Expectancy</th><th class="r">Max DD</th><th class="r">Best trade</th><th>Detector</th></tr></thead><tbody>
      ${list.slice(0, 500).map((t) => { const e = expectancy(t.stats), st = t.stats || {}, d = det(t); return `<tr class="click" tabindex="0" data-open="${esc(t.account_id)}">
        <td><b>${esc(t.full_name || '—')}</b><br><span class="muted" style="font-size:12px">${esc(t.email || '')}</span></td>
        <td class="muted">${esc(stageText(t))}</td><td>${statusCap(t)}${t.investigation_hold ? ' ' + cap('Hold', 'red') : ''}</td><td>${bookCap(t)}</td>
        <td class="r num ${Number(t.realized_pnl) < 0 ? 'bad' : Number(t.realized_pnl) > 0 ? 'good' : ''}">${usd(t.realized_pnl || 0)}<div class="muted" style="font-size:11px">${Number(t.starting_balance) > 0 ? (Number(t.realized_pnl) >= 0 ? '+' : '') + ((Number(t.realized_pnl) / Number(t.starting_balance)) * 100).toFixed(2) + '%' : ''}</div></td>
        <td class="r num">${usd(t.balance || 0)}</td><td class="r num">${esc(st.trades ?? 0)}</td>
        <td class="r num muted">${st.win_rate == null ? '—' : Number(st.win_rate).toFixed(0) + '%'}</td>
        <td class="r num muted">${st.profit_factor == null ? '—' : Number(st.profit_factor).toFixed(2)}</td>
        <td class="r num ${e.c}">${e.t}</td>
        <td class="r num ${Number(st.max_drawdown_pct) >= 4 ? 'bad' : 'muted'}">${st.max_drawdown_pct == null ? '—' : Number(st.max_drawdown_pct).toFixed(2) + '%'}</td>
        <td class="r num ${Number(st.consistency_pct) > 50 ? 'warn' : 'muted'}">${st.consistency_pct == null ? '—' : esc(st.consistency_pct) + '%'}</td>
        <td>${cap(d[0], d[1])}</td></tr>`; }).join('') || '<tr><td colspan="13" class="muted">No traders match.</td></tr>'}
      </tbody></table></div></div><p class="foot">${list.length > 500 ? 'Showing the first 500 of ' + list.length + '. Search to narrow down. ' : ''}Expectancy turns green only when positive over 100+ closed trades.</p>`;
    if (open) renderDrawer();
  }

  // ---- detail panel: the full trader record (everything the Operations trader view showed, plus hold times) ----
  async function openTrader(accountId) {
    const t = traders.find((x) => x.account_id === accountId); if (!t) return;
    open = { t, detail: null, error: null, audit: null, allTrades: false }; renderDrawer();
    const [d, a] = await Promise.allSettled([T.admin('trader_detail', { user_id: t.user_id }), T.admin('audit_log', { user_id: t.user_id, page_size: 50 })]);
    if (!open || open.t !== t) return;
    if (d.status === 'fulfilled') open.detail = d.value; else open.error = d.reason?.message || 'Trader record unavailable';
    open.audit = a.status === 'fulfilled' ? a.value.entries || [] : [];
    renderDrawer();
  }
  function close() { open = null; $('drawerSlot').innerHTML = ''; }
  const fmtNum = (v, dp = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(dp));
  const signed = (v) => (v == null ? '—' : (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(2));
  // Hold time from open to close: 45s, 12m, 3h 20m, 2d 4h.
  function held(o, c) {
    const s = (Date.parse(c) - Date.parse(o)) / 1000; if (!Number.isFinite(s) || s < 0) return '—';
    if (s < 60) return Math.round(s) + 's'; if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd ' + Math.round((s % 86400) / 3600) + 'h';
  }
  const mins = (m) => (m == null ? '—' : m < 1 ? Math.round(m * 60) + 's' : m < 60 ? Math.round(m) + 'm' : m < 1440 ? (m / 60).toFixed(1) + 'h' : (m / 1440).toFixed(1) + 'd');
  const tile = (k, v, cls = '', sub = '') => `<div class="stat"><div class="k">${k}</div><div class="v num ${cls}" style="font-size:17px">${v}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  const head = (txt, sub = '') => `<div class="grouphead">${txt}${sub ? ` <span class="sub">${sub}</span>` : ''}</div>`;

  function profileSection(p, label) {
    if (!p || !p.trades_closed) return `${head('Strategy profile' + (label ? ' · ' + esc(label) : ''))}<div class="banner">${esc(p?.summary_text || 'No trade history yet.')}</div>`;
    const flags = [];
    if (p.sizing?.martingale_flag) flags.push(cap('Martingale sizing', 'red'));
    if (p.cadence?.revenge_flag) flags.push(cap('Revenge trading', 'red'));
    if (Number(p.consistency_pct) > 50) flags.push(cap('Win concentrated in one trade', 'orange'));
    const e = expectancy({ trades: p.trades_closed, win_rate: p.win_rate, profit_factor: p.profit_factor });
    return `${head('Strategy profile' + (label ? ' · ' + esc(label) : ''), esc(p.trades_closed) + ' closed trades')}
      <div class="group"><div class="item"><div class="body"><span style="color:var(--ink);font-size:13.5px">${esc(p.summary_text)}</span>${flags.length ? `<div class="row" style="margin-top:8px">${flags.join('')}</div>` : ''}</div></div></div>
      <div class="stats" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));margin-top:12px">
        ${tile('Win rate', fmtNum(p.win_rate, 1) + '%')}${tile('Profit factor', p.profit_factor == null ? '∞' : fmtNum(p.profit_factor))}${tile('Expectancy', e.t, e.c)}
        ${tile('Avg hold', mins(p.hold_time?.avg_minutes), '', 'Median ' + mins(p.hold_time?.median_minutes))}${tile('Style', esc(p.hold_time?.style || '—'))}${tile('Main session', esc(p.dominant_session || '—'))}
        ${tile('SL usage', fmtNum(p.sl_usage_pct, 0) + '%', '', 'Avg ' + fmtNum(p.avg_sl_distance_pct) + '% away')}${tile('TP usage', fmtNum(p.tp_usage_pct, 0) + '%', '', 'Avg ' + fmtNum(p.avg_tp_distance_pct) + '% away')}${tile('Planned R:R', p.avg_planned_rr == null ? '—' : '1:' + p.avg_planned_rr)}
        ${tile('Side bias', fmtNum(p.side_bias?.buy_pct, 0) + '% buy', '', fmtNum(p.side_bias?.sell_pct, 0) + '% sell')}${tile('Rule-based closes', fmtNum(p.discipline?.rule_based_close_pct, 0) + '%')}${tile('Avg lot size', fmtNum(p.sizing?.avg_volume))}
        ${tile('Best trade share', fmtNum(p.consistency_pct, 0) + '%', Number(p.consistency_pct) > 50 ? 'warn' : '')}${tile('Avg gap between trades', mins(p.cadence?.avg_gap_minutes))}${tile('Revenge trades', fmtNum(p.cadence?.revenge_trade_pct, 0) + '%', p.cadence?.revenge_flag ? 'bad' : '')}
      </div>
      ${(p.symbol_breakdown || []).length ? `${head('Instruments traded')}<div class="tablewrap"><div class="scroll"><table style="min-width:0"><thead><tr><th>Symbol</th><th class="r">Trades</th><th class="r">% of activity</th><th class="r">Win rate</th><th class="r">Total P&amp;L</th></tr></thead><tbody>
        ${p.symbol_breakdown.map((x) => `<tr><td><b>${esc(x.symbol)}</b></td><td class="r num">${esc(x.trades)}</td><td class="r num">${esc(x.pct)}%</td><td class="r num">${esc(x.win_rate)}%</td><td class="r num ${x.total_pnl >= 0 ? 'good' : 'bad'}">${signed(x.total_pnl)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
  }

  // Cumulative P&L with the drawdown underneath, from closed trades (inline SVG).
  function equitySection(trades) {
    const closed = (trades || []).filter((x) => x.status === 'closed' && x.pnl != null && x.closed_at).sort((a, b) => Date.parse(a.closed_at) - Date.parse(b.closed_at));
    if (closed.length < 2) return `${head('Cumulative P&amp;L')}<div class="group"><div class="empty">Not enough closed trades yet for an equity curve.</div></div>`;
    let cum = 0, peak = 0; const eq = [0], dd = [0];
    for (const x of closed) { cum += Number(x.pnl); peak = Math.max(peak, cum); eq.push(cum); dd.push(cum - peak); }
    const n = eq.length, W = 1000, H = 220, L = 54, R = 12, Tp = 14, B = 14, iw = W - L - R, ih = (H - Tp - B) * 0.68, dh = (H - Tp - B) * 0.32 - 8;
    const lo = Math.min(0, ...eq), hi = Math.max(0, ...eq), rng = hi - lo || 1, ddMin = Math.min(...dd) || -1;
    const x = (i) => L + (iw * i) / (n - 1), ye = (v) => Tp + ih - ((v - lo) / rng) * ih, yd = (v) => Tp + ih + 8 + (v / ddMin) * dh;
    const pts = (arr, y) => arr.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const up = cum >= 0, col = up ? 'var(--green)' : 'var(--red)';
    return `${head('Cumulative P&amp;L', `${n - 1} closed trades · peak-to-trough <span class="num bad">${ddMin.toFixed(2)}</span>`)}
      <div class="group" style="padding:10px"><svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-label="Cumulative P&amp;L ${cum.toFixed(2)} with drawdown">
        <line x1="${L}" y1="${ye(0).toFixed(1)}" x2="${W - R}" y2="${ye(0).toFixed(1)}" stroke="var(--hair)" stroke-width="1"/>
        <text x="${L - 6}" y="${(ye(hi) + 4).toFixed(1)}" font-size="10" fill="var(--ink3)" text-anchor="end" font-family="var(--mono)">${hi.toFixed(0)}</text>
        <text x="${L - 6}" y="${(ye(0) + 4).toFixed(1)}" font-size="10" fill="var(--ink3)" text-anchor="end" font-family="var(--mono)">0</text>
        <path d="M${x(0).toFixed(1)},${ye(0).toFixed(1)} L${pts(eq, ye)} L${x(n - 1).toFixed(1)},${ye(0).toFixed(1)} Z" fill="${up ? 'rgba(16,185,129,.14)' : 'rgba(239,68,68,.14)'}"/>
        <polyline points="${pts(eq, ye)}" fill="none" stroke="${col}" stroke-width="2"/>
        <path d="M${x(0).toFixed(1)},${yd(0).toFixed(1)} L${pts(dd, yd)} L${x(n - 1).toFixed(1)},${yd(0).toFixed(1)} Z" fill="rgba(239,68,68,.22)"/>
        <polyline points="${pts(dd, yd)}" fill="none" stroke="var(--red)" stroke-width="1.3" opacity=".85"/>
        <text x="${L}" y="${Tp + 10}" font-size="10" fill="var(--ink3)" font-family="var(--mono)">equity</text><text x="${L}" y="${(Tp + ih + 20).toFixed(1)}" font-size="10" fill="var(--ink3)" font-family="var(--mono)">drawdown</text>
      </svg></div>`;
  }

  // The boxes the trader sees on their Challenge tab: all must be ticked at once before they move up a stage.
  function stageSection(r, label) {
    if (!r || !(r.items || []).length) return '';
    const tick = (ok) => `<div class="leadicon ${ok ? 'ic-green' : 'ic-gray'}"><svg viewBox="0 0 24 24">${ok ? '<path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' : '<circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/>'}</svg></div>`;
    const left = r.items.filter((i) => !i.done).length;
    return `${head('Stage requirements' + (label ? ' · ' + esc(label) : ''), esc(r.title))}
      <div class="group"><div class="item"><div class="body"><b>${r.ready ? 'Every box ticked: can move to the next stage' : left + ' box' + (left === 1 ? '' : 'es') + ' still to tick'}</b><span>All boxes must be ticked at the same time</span></div><div class="trail">${cap(r.ready ? 'Can move up' : 'Not yet', r.ready ? 'green' : 'orange')}</div></div>
        ${r.items.map((i) => `<div class="item">${tick(i.done)}<div class="body"><b style="font-weight:600">${esc(i.text)}</b></div></div>`).join('')}</div>`;
  }
  function readinessSection(r, label) {
    if (!r) return '';
    const pct = (v) => (v == null ? '—' : Math.round(v * 1000) / 10 + '%');
    return `${head('Mirror readiness' + (label ? ' · ' + esc(label) : ''))}
      <div class="group"><div class="item"><div class="body"><b>${r.mirror_ready ? 'Ready to mirror' : 'Not ready yet'}</b><span>${esc(r.trades_closed)} closed trades over ${esc(r.days_span)} days</span></div><div class="trail">${cap(r.mirror_ready ? 'Mirror-ready' : 'Not yet', r.mirror_ready ? 'green' : 'orange')}</div></div>
        <div class="item"><div class="stats" style="grid-template-columns:repeat(3,1fr);width:100%;margin:0">${tile('Edge is real', pct(r.p_edge_real))}${tile('Passes evaluation', pct(r.prob_pass_evaluation))}${tile('Reaches first payout', pct(r.prob_first_payout))}</div></div>
        ${(r.checklist || []).map((c) => `<div class="item"><div class="leadicon ${c.pass ? 'ic-green' : 'ic-gray'}"><svg viewBox="0 0 24 24">${c.pass ? '<path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' : '<circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="2"/>'}</svg></div><div class="body"><b>${esc(c.label)}</b><span>${esc(c.detail)}</span></div></div>`).join('')}
        ${(r.reasons || []).length ? `<div class="item"><div class="body"><span style="color:#f5c473">${r.reasons.map(esc).join('<br>')}</span></div></div>` : ''}</div>`;
  }

  function identitySection(d) {
    const i = d.identity;
    if (!i) return `${head('Protected identity')}<div class="banner">No completed protected identity profile. This trader can’t start or activate another challenge.</div>`;
    let age = '—';
    if (i.date_of_birth) { const b = new Date(i.date_of_birth + 'T12:00:00'), n = new Date(); age = n.getFullYear() - b.getFullYear() - ((n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) ? 1 : 0); }
    const row = (k, v) => `<div class="item"><div class="body"><span>${k}</span><b style="font-weight:600">${v || '—'}</b></div></div>`;
    return `${head('Protected identity', 'Viewing is recorded in the audit log')}<div class="group">
      ${row('Trader ID', `<span class="num">${esc(d.user_id)}</span>`)}${row('Legal name', esc([i.legal_first_name, i.legal_middle_names, i.legal_last_name].filter(Boolean).join(' ')))}${row('Date of birth / age', esc(i.date_of_birth) + ' · ' + age)}
      ${row('Phone', esc(i.phone_e164))}${row('Country / nationality', esc(i.country_code || '—') + ' / ' + esc(i.nationality_code || '—'))}${row('Address', esc([i.address_line_1, i.address_line_2, i.city, i.region, i.postal_code].filter(Boolean).join(', ')))}</div>`;
  }

  function tradesSection(d) {
    const all = d.trades || [], limit = open.allTrades ? 2000 : 200, list = all.slice(0, limit);
    const rows = list.map((x) => { const q = (x.audit || [])[0];
      return `<tr><td class="num muted">${ukTime(x.opened_at)}</td><td class="num muted">${x.closed_at ? ukTime(x.closed_at) : '<span class="cap blue">Open</span>'}</td><td class="num">${held(x.opened_at, x.closed_at || new Date().toISOString())}</td>
        <td><b>${esc(x.symbol)}</b></td><td>${cap(String(x.side || '').toUpperCase(), x.side === 'buy' ? 'green' : 'red')}</td><td class="r num">${fmtNum(x.volume)}</td>
        <td class="num">${esc(x.open_price)}${q ? `<div class="muted" style="font-size:11px">bid ${esc(q.bid ?? '—')} / ask ${esc(q.ask ?? '—')} · spread ${esc(q.spread ?? '—')} · lat ${esc(q.latency_ms ?? '—')}ms</div>` : ''}</td>
        <td class="num">${esc(x.sl ?? '—')}</td><td class="num">${esc(x.tp ?? '—')}</td><td class="num">${esc(x.close_price ?? '—')}</td>
        <td>${cap(String(x.close_reason || x.status).replace(/_/g, ' '), x.status === 'closed' ? (x.close_reason === 'sl' ? 'red' : 'green') : 'blue')}</td>
        <td class="r num ${Number(x.pnl) > 0 ? 'good' : Number(x.pnl) < 0 ? 'bad' : ''}">${signed(x.pnl)}</td></tr>`; }).join('');
    return `${head('Trade history', `${list.length}${all.length > list.length ? ' of ' + all.length : ''} · newest first · held = open to close`)}
      <div class="tablewrap"><div class="scroll" style="max-height:560px;overflow-y:auto"><table style="min-width:1100px"><thead style="position:sticky;top:0;z-index:1"><tr><th>Opened (UK)</th><th>Closed (UK)</th><th>Held</th><th>Symbol</th><th>Side</th><th class="r">Vol</th><th>Entry (audit)</th><th>SL</th><th>TP</th><th>Exit</th><th>Closed by</th><th class="r">P&amp;L</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="12" class="muted">No trades.</td></tr>'}</tbody></table></div></div>
      ${all.length > list.length ? '<div class="row" style="margin-top:8px"><button class="btn sm" data-act="alltrades">Show all ' + all.length + ' trades</button></div>' : ''}`;
  }

  function rejectsSection(d) {
    const r = (d.reject_events || []).slice(0, 50); if (!r.length) return '';
    return `${head('Rejected orders', String(r.length))}<div class="tablewrap"><div class="scroll"><table style="min-width:0"><thead><tr><th>Time (UK)</th><th>Symbol</th><th>Side</th><th class="r">Vol</th><th>Reason</th></tr></thead><tbody>
      ${r.map((x) => `<tr><td class="num muted">${ukTime(x.server_ts)}</td><td><b>${esc(x.symbol)}</b></td><td>${esc(x.side || '—')}</td><td class="r num">${esc(x.requested_volume ?? '—')}</td><td class="bad" style="white-space:normal">${esc(x.reject_reason || '—')}</td></tr>`).join('')}</tbody></table></div></div>`;
  }

  function strategySection(d) {
    const h = d.strategy_hypotheses || [], pl = d.paper_plans || [], cl = d.chart_layout;
    if (!h.length && !pl.length && !cl) return '';
    const ev = (v) => (Array.isArray(v) ? v.join('; ') : v && typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v || '');
    return `${h.length ? `${head('Strategy hypotheses', 'Model guesses, not verdicts')}<div class="tablewrap"><div class="scroll"><table style="min-width:0"><thead><tr><th>Cut-off</th><th>Family</th><th class="r">Confidence</th><th>Evidence</th></tr></thead><tbody>
        ${h.slice(0, 10).map((x) => `<tr><td class="num muted">${esc(x.cutoff_date)}</td><td><b>${esc(String(x.family).replace(/_/g, ' '))}</b></td><td class="r num">${x.confidence == null ? '—' : Math.round(x.confidence * 100) + '%'}</td><td class="muted" style="white-space:normal;min-width:260px">${esc(ev(x.evidence))}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      ${pl.length ? `${head('Paper predictions', 'Next-day forecasts compared with what they actually did')}<div class="tablewrap"><div class="scroll"><table style="min-width:0"><thead><tr><th>Day</th><th>Family</th><th>Predicted</th><th>Status</th><th class="r">Match</th></tr></thead><tbody>
        ${pl.slice(0, 10).map((x) => `<tr><td class="num muted">${esc(x.prediction_day)}</td><td>${esc(String(x.family).replace(/_/g, ' '))}</td><td class="muted">${esc(x.predicted_symbol || '—')} ${esc(x.predicted_side || '')} · ${esc(x.predicted_trade_count ?? '—')} trades · ${esc(x.predicted_session || '—')}</td><td>${esc(x.status)}</td><td class="r num">${x.comparison_score == null ? '—' : Math.round(x.comparison_score * 100) + '%'}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      ${cl ? `<p class="foot">Chart setup: ${esc(cl.chart_style || '—')} · ${esc(cl.timeframe || '—')} · ${Array.isArray(cl.studies) ? cl.studies.length + ' indicators' : 'no indicators'}</p>` : ''}`;
  }

  function auditSection() {
    const rows = open.audit || []; if (!rows.length) return '';
    return `${head('Team actions on this trader', String(rows.length))}<div class="tablewrap"><div class="scroll"><table style="min-width:0"><thead><tr><th>Time (UK)</th><th>Action</th><th>Detail</th></tr></thead><tbody>
      ${rows.map((x) => `<tr><td class="num muted">${ukTime(x.created_at)}</td><td><b>${esc(String(x.action).replace(/_/g, ' '))}</b></td><td class="muted" style="white-space:normal;min-width:260px">${esc(JSON.stringify(x.detail || {}).slice(0, 220))}</td></tr>`).join('')}</tbody></table></div></div>`;
  }

  function renderDrawer() {
    const { t, detail, error } = open, st = t.stats || {}, e = expectancy(st), d = det(t);
    const a = inA(t), conn = (copy?.connections || []).find((c) => c.connected);
    const per = detail?.per_account_profile || [], primary = per.find((x) => x.account_id === t.account_id) || per.find((x) => x.status === 'active') || per[0];
    const scrollTop = document.querySelector('.os-drawer')?.scrollTop || 0;
    const ret = Number(t.starting_balance) > 0 ? signed((Number(t.realized_pnl) / Number(t.starting_balance)) * 100) + '%' : '';
    $('drawerSlot').innerHTML = `<div class="os-scrim os-drawer-scrim" data-close></div><aside class="os-drawer wide" role="dialog" aria-label="${esc(t.full_name || 'Trader')}">
      <div class="row" style="justify-content:space-between;align-items:flex-start"><div><h3>${esc(t.full_name || '—')}</h3><span class="muted">${esc(t.email || '')}</span></div><button class="btn sm" type="button" data-close>Done</button></div>
      <div class="row">${statusCap(t)}${bookCap(t)}${cap(d[0], d[1])}${cap(stageText(t))}${t.kyc_status ? cap('ID ' + t.kyc_status, t.kyc_status === 'verified' ? 'green' : 'orange') : ''}${t.investigation_hold ? cap('Investigation hold', 'red') : ''}</div>
      <div class="stats" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));margin:0">
        ${tile('P&amp;L', usd(t.realized_pnl || 0), Number(t.realized_pnl) < 0 ? 'bad' : Number(t.realized_pnl) > 0 ? 'good' : '', ret)}
        ${tile('Balance', usd(t.balance || 0))}${tile('Trades', esc(st.trades || 0))}${tile('Win rate', st.win_rate == null ? '—' : fmtNum(st.win_rate, 1) + '%')}
        ${tile('Profit factor', st.profit_factor == null ? '—' : fmtNum(st.profit_factor))}${tile('Expectancy', e.t, e.c)}${tile('Max drawdown', st.max_drawdown_pct == null ? '—' : fmtNum(st.max_drawdown_pct) + '%', Number(st.max_drawdown_pct) >= 4 ? 'bad' : '')}${tile('Best trade share', st.consistency_pct == null ? '—' : esc(st.consistency_pct) + '%')}
      </div>
      <div class="group"><div class="item"><div class="body"><b>${a ? 'In A-book' : 'In B-book'}</b><span>${a ? 'Trades copied to ' + esc(conn?.label || 'your E8 account') : 'The firm keeps the risk'}</span></div>
          <div class="trail"><div class="seg"><button class="a" type="button" aria-pressed="${a}" data-act="toA"${a || !conn ? ' disabled' : ''}${conn ? '' : ' title="Set up copying in Books first"'}>A-book</button><button class="b" type="button" aria-pressed="${!a}" data-act="toB"${a ? '' : ' disabled'}>B-book</button></div></div></div>
        <div class="item"><div class="body"><b>Investigation hold</b><span>${t.investigation_hold ? 'On: payouts and copying are held' : 'Off'}</span></div>
          <div class="trail"><button class="switch" role="switch" aria-checked="${!!t.investigation_hold}" aria-label="Investigation hold" data-act="hold"></button></div></div></div>
      ${error ? `<div class="banner red">${esc(error)}</div>` : !detail ? '<div class="empty">Loading the full trader record…</div>'
        : per.map((x) => stageSection(x.stage_requirements, per.length > 1 ? x.label : '')).join('') + equitySection(detail.trades) + profileSection(detail.combined_profile) + tradesSection(detail) + rejectsSection(detail) + readinessSection(primary?.readiness, per.length > 1 ? primary?.label : '')
          + (per.length > 1 ? head('Per-account breakdown', per.length + ' accounts') + per.map((x) => `<div class="row" style="margin:14px 4px 0"><b>${esc(x.label)}</b>${cap(x.status, x.status === 'active' ? 'green' : x.status === 'breached' ? 'red' : '')}</div>${x === primary ? '' : readinessSection(x.readiness)}${profileSection(x.profile, x.label)}`).join('') : '')
          + strategySection(detail) + identitySection(detail) + auditSection()}
    </aside>`;
    const dr = document.querySelector('.os-drawer'); if (dr && scrollTop) dr.scrollTop = scrollTop;
  }

  async function toA() {
    const t = open.t, conn = (copy?.connections || []).find((c) => c.connected); if (!conn) return;
    const ok = await T.sheet({ title: 'Move to A-book?', text: `Future Infinity trades from <b>${esc(t.email)}</b> will be copied to <b>${esc(conn.label)}</b>${conn.execution_on ? '' : ' once execution is on'}.`, confirm: 'Move to A-book',
      onSubmit: async () => { const f = await T.ladder('ongoing_copy_find', { email: t.email }); if (!f.accounts?.length) throw new Error('No active Infinity challenge for this trader.'); return T.ladder('ongoing_copy_start_trader', { id: conn.id, person_id: f.person_id, version: conn.version, reason: 'Owner moved trader to A-book from Traders', confirm_funded_execution: true }); } });
    if (ok) { T.toast(t.email + ' is in A-book.'); await load(); }
  }
  async function toB() {
    const t = open.t, s = selection(t); if (!s) return;
    try { await T.ladder('ongoing_copy_select', { id: s.connection_id, person_id: s.person_id, enabled: false, reason: 'Owner moved trader to B-book from Traders' }); T.toast(t.email + ' is in B-book.'); await load(); }
    catch (e) { T.toast(e.message, true); }
  }
  async function hold() {
    const t = open.t, on = !t.investigation_hold;
    const v = await T.sheet({ title: on ? 'Place an investigation hold?' : 'Remove the investigation hold?', text: on ? 'Holds payouts and copying for this account until you remove it.' : 'Payouts and copying return to normal checks.',
      fields: on ? [{ id: 'note', label: 'Private note (optional)', optional: true }] : [], confirm: on ? 'Place hold' : 'Remove hold', danger: on,
      onSubmit: (x) => T.admin('set_investigation_hold', { account_id: t.account_id, hold: on, note: x.note || null }) });
    if (v) { T.toast(on ? 'Hold placed.' : 'Hold removed.'); await load(); }
  }

  async function load() {
    try {
      const [o, c] = await Promise.all([T.admin('overview'), T.ladder('ongoing_copy_status').catch(() => null)]);
      if (o.is_admin === false) { $('list').innerHTML = '<div class="banner red">This account doesn’t have team access.</div>'; return; }
      traders = o.traders || []; copy = c;
      if (open) open.t = traders.find((x) => x.account_id === open.t.account_id) || open.t;
      render(); T.status('Updated ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) { T.status(e.message); if (!traders.length) $('list').innerHTML = `<div class="banner red">${esc(e.message)}</div>`; }
  }

  document.addEventListener('click', (e) => {
    const f = e.target.closest('[data-filter]'); if (f) { filter = f.dataset.filter; render(); return; }
    const df = e.target.closest('[data-det]'); if (df) { detFilter = df.dataset.det; render(); return; }
    if (e.target.closest('[data-close]')) { close(); return; }
    const r = e.target.closest('[data-open]'); if (r) { openTrader(r.dataset.open); return; }
    const b = e.target.closest('[data-act]'); if (!b || b.disabled || !open) return;
    ({ toA, toB, hold, alltrades: () => { open.allTrades = true; renderDrawer(); } })[b.dataset.act]?.();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open && !document.querySelector('.os-sheet')) close();
    const r = e.target.closest?.('[data-open]'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTrader(r.dataset.open); }
  });
  T.mount({ page: 'traders', title: 'Traders' });
  $('search').addEventListener('input', (e) => { query = e.target.value; render(); });
  $('sort').addEventListener('change', (e) => { sortBy = e.target.value; render(); });
  $('refreshBtn').addEventListener('click', load);
  load();
  setInterval(() => { if (!document.hidden && !document.querySelector('.os-sheet')) load(); }, 60000);
})();
