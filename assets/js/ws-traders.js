/* Traders: one list of every trader with filters, search and sort. Selecting a trader opens one panel with
   their record and the actions that apply to them (book, investigation hold). Replaces the trader lists on
   Operations, Brain, Analytics and the A/B-book pages. Full trade history loads only when a trader is opened. */
(() => {
  'use strict';
  const T = window.TeamOS, { esc, usd, ukTime } = T;
  const $ = (id) => document.getElementById(id);
  const DET = { RISK_NO_GO: ['Risk no-go', 'red'], HIGH_POTENTIAL: ['High potential', 'green'], PROFITABILITY_CONFIRMED: ['Confirmed', 'green'], LIVE_REVIEW_REQUIRED: ['Live review', 'blue'], OBSERVE: ['Observe', ''], INSUFFICIENT_EVIDENCE: ['Too few trades', ''] };
  const FILTERS = ['All', 'Active', 'Breached', 'A-book', 'Risk no-go', '100+ trades'];
  let traders = [], copy = null, filter = 'All', sortBy = 'pnl', query = '', open = null;

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
      if (filter === 'Active') return t.status === 'active';
      if (filter === 'Breached') return t.status === 'breached';
      if (filter === 'A-book') return inA(t);
      if (filter === 'Risk no-go') return t.detector?.state === 'RISK_NO_GO';
      if (filter === '100+ trades') return Number(t.stats?.trades) >= 100;
      return true;
    });
    const num = (v) => (v == null || !Number.isFinite(Number(v)) ? -Infinity : Number(v));
    const key = { pnl: (t) => num(t.realized_pnl), ret: (t) => (Number(t.starting_balance) > 0 ? num(t.realized_pnl) / Number(t.starting_balance) : -Infinity),
      exp: (t) => expectancy(t.stats).v, trades: (t) => num(t.stats?.trades), wr: (t) => num(t.stats?.win_rate), dd: (t) => num(t.stats?.max_drawdown_pct) }[sortBy];
    return r.sort((a, b) => key(b) - key(a));
  }

  function render() {
    const list = rows(), counts = {};
    for (const f of FILTERS) counts[f] = f === 'All' ? traders.length : traders.filter((t) => (f === 'Active' ? t.status === 'active' : f === 'Breached' ? t.status === 'breached' : f === 'A-book' ? inA(t) : f === 'Risk no-go' ? t.detector?.state === 'RISK_NO_GO' : Number(t.stats?.trades) >= 100)).length;
    $('filters').innerHTML = `<div class="seg">${FILTERS.map((f) => `<button type="button" data-filter="${esc(f)}" aria-pressed="${f === filter}">${esc(f)} · ${counts[f]}</button>`).join('')}</div>`;
    $('list').innerHTML = `<div class="tablewrap"><div class="scroll"><table><thead><tr><th>Trader</th><th>Stage</th><th>Status</th><th>Book</th><th class="r">P&amp;L</th><th class="r">Win rate</th><th class="r">Profit factor</th><th class="r">Expectancy</th><th class="r">Max DD</th><th>Detector</th></tr></thead><tbody>
      ${list.slice(0, 500).map((t) => { const e = expectancy(t.stats), st = t.stats || {}, d = det(t); return `<tr class="click" tabindex="0" data-open="${esc(t.account_id)}">
        <td><b>${esc(t.full_name || '—')}</b><br><span class="muted" style="font-size:12px">${esc(t.email || '')}</span></td>
        <td class="muted">${esc(stageText(t))}</td><td>${statusCap(t)}${t.investigation_hold ? ' ' + cap('Hold', 'red') : ''}</td><td>${bookCap(t)}</td>
        <td class="r num ${Number(t.realized_pnl) < 0 ? 'bad' : ''}">${usd(t.realized_pnl || 0)}</td>
        <td class="r num muted">${st.win_rate == null ? '—' : Number(st.win_rate).toFixed(0) + '%'}</td>
        <td class="r num muted">${st.profit_factor == null ? '—' : Number(st.profit_factor).toFixed(2)}</td>
        <td class="r num ${e.c}">${e.t}</td>
        <td class="r num ${Number(st.max_drawdown_pct) >= 4 ? 'bad' : 'muted'}">${st.max_drawdown_pct == null ? '—' : Number(st.max_drawdown_pct).toFixed(2) + '%'}</td>
        <td>${cap(d[0], d[1])}</td></tr>`; }).join('') || '<tr><td colspan="10" class="muted">No traders match.</td></tr>'}
      </tbody></table></div></div><p class="foot">${list.length > 500 ? 'Showing the first 500 of ' + list.length + '. Search to narrow down. ' : ''}Expectancy turns green only when positive over 100+ closed trades.</p>`;
    if (open) renderDrawer();
  }

  // ---- detail panel ----
  async function openTrader(accountId) {
    const t = traders.find((x) => x.account_id === accountId); if (!t) return;
    open = { t, detail: null, error: null }; renderDrawer();
    try { open.detail = await T.admin('trader_detail', { user_id: t.user_id }); } catch (e) { open.error = e.message; }
    if (open && open.t === t) renderDrawer();
  }
  function close() { open = null; $('drawerSlot').innerHTML = ''; }
  function renderDrawer() {
    const { t, detail, error } = open, st = t.stats || {}, e = expectancy(st), d = det(t);
    const trades = (detail?.trades || []).filter((x) => x.account_id === t.account_id && x.status === 'closed').slice(0, 15);
    const summary = detail?.combined_profile?.summary_text;
    const a = inA(t), conn = (copy?.connections || []).find((c) => c.connected);
    $('drawerSlot').innerHTML = `<div class="os-scrim os-drawer-scrim" data-close></div><aside class="os-drawer" role="dialog" aria-label="${esc(t.full_name || 'Trader')}">
      <div class="row" style="justify-content:space-between;align-items:flex-start"><div><h3>${esc(t.full_name || '—')}</h3><span class="muted">${esc(t.email || '')}</span></div><button class="btn sm" type="button" data-close>Done</button></div>
      <div class="row">${statusCap(t)}${bookCap(t)}${cap(d[0], d[1])}${cap(stageText(t))}${t.kyc_status ? cap('ID ' + t.kyc_status, t.kyc_status === 'verified' ? 'green' : 'orange') : ''}</div>
      <div class="stats" style="grid-template-columns:1fr 1fr;margin:0">
        <div class="stat"><div class="k">P&amp;L</div><div class="v num ${Number(t.realized_pnl) < 0 ? 'bad' : ''}" style="font-size:20px">${usd(t.realized_pnl || 0)}</div><div class="s">Balance ${usd(t.balance || 0)}</div></div>
        <div class="stat"><div class="k">Closed trades</div><div class="v num" style="font-size:20px">${esc(st.trades || 0)}</div><div class="s">Win rate ${st.win_rate == null ? '—' : Number(st.win_rate).toFixed(1) + '%'}</div></div>
        <div class="stat"><div class="k">Expectancy</div><div class="v num ${e.c}" style="font-size:20px">${e.t}</div><div class="s">${Number(st.trades) >= 100 ? 'Significant sample' : 'Needs ' + Math.max(0, 100 - Number(st.trades || 0)) + ' more trades'}</div></div>
        <div class="stat"><div class="k">Max drawdown</div><div class="v num" style="font-size:20px">${st.max_drawdown_pct == null ? '—' : Number(st.max_drawdown_pct).toFixed(2) + '%'}</div><div class="s">Best trade share ${st.consistency_pct == null ? '—' : esc(st.consistency_pct) + '%'}</div></div>
      </div>
      ${summary ? `<p style="margin:0;color:var(--ink2);font-size:13px">${esc(summary)}</p>` : ''}
      <div class="grouphead" style="margin:6px 4px 0">Book</div>
      <div class="group"><div class="item"><div class="body"><b>${a ? 'In A-book' : 'In B-book'}</b><span>${a ? 'Trades copied to ' + esc(conn?.label || 'your E8 account') : 'The firm keeps the risk'}</span></div>
        <div class="trail"><div class="seg"><button class="a" type="button" aria-pressed="${a}" data-act="toA"${a || !conn ? ' disabled' : ''}${conn ? '' : ' title="Set up copying in Books first"'}>A-book</button><button class="b" type="button" aria-pressed="${!a}" data-act="toB"${a ? '' : ' disabled'}>B-book</button></div></div></div></div>
      <div class="grouphead" style="margin:6px 4px 0">Account</div>
      <div class="group"><div class="item"><div class="body"><b>Investigation hold</b><span>${t.investigation_hold ? 'On: payouts and copying are held' : 'Off'}</span></div>
        <div class="trail"><button class="switch" role="switch" aria-checked="${!!t.investigation_hold}" aria-label="Investigation hold" data-act="hold"></button></div></div></div>
      <div class="grouphead" style="margin:6px 4px 0">Recent closed trades</div>
      <div class="tablewrap"><div class="scroll"><table style="min-width:0"><thead><tr><th>Closed (UK)</th><th>Trade</th><th class="r">P&amp;L</th></tr></thead><tbody>
        ${error ? `<tr><td colspan="3" class="bad">${esc(error)}</td></tr>` : !detail ? '<tr><td colspan="3" class="muted">Loading…</td></tr>' : trades.map((x) => `<tr><td class="num muted">${ukTime(x.closed_at)}</td><td>${esc(x.side)} ${esc(x.volume)} ${esc(x.symbol)}</td><td class="r num ${Number(x.pnl) < 0 ? 'bad' : 'good'}">${usd(x.pnl || 0)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No closed trades yet.</td></tr>'}
      </tbody></table></div></div>
    </aside>`;
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
    if (e.target.closest('[data-close]')) { close(); return; }
    const r = e.target.closest('[data-open]'); if (r) { openTrader(r.dataset.open); return; }
    const b = e.target.closest('[data-act]'); if (!b || b.disabled || !open) return;
    ({ toA, toB, hold })[b.dataset.act]?.();
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
