/* Overview: "is anything wrong right now?" — key numbers, what needs you, safety switches, books at a glance.
   Read-only; every action links to the page that owns it. */
(() => {
  'use strict';
  const T = window.TeamOS, { esc, usd } = T;
  const $ = (id) => document.getElementById(id);
  const ICON = {
    alert: '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.3 4l-7 12a2 2 0 0 0 1.7 3h14a2 2 0 0 0 1.7-3l-7-12a2 2 0 0 0-3.4 0z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    doc: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    cash: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const item = (icon, cls, title, sub, href, label) => `<div class="item"><div class="leadicon ${cls}">${ICON[icon]}</div><div class="body"><b>${title}</b><span>${sub}</span></div>${href ? `<div class="trail"><a class="btn sm" href="${href}">${label}</a></div>` : ''}</div>`;

  function render(o, copy, fb) {
    const f = o.firm || {}, traders = o.traders || [], payouts = o.payouts || [];
    const noGo = traders.filter((t) => (t.detector?.state) === 'RISK_NO_GO').length;
    const inProfit = traders.filter((t) => Number(t.realized_pnl) > 0).length;
    const requested = payouts.filter((p) => p.status === 'requested').length;
    const newFeedback = fb?.counts?.new ?? 0;
    const conns = (copy?.connections || []).filter((c) => c.connected);
    const execOn = conns.some((c) => c.execution_on), blocked = conns.some((c) => c.execution_on && c.ready === false);
    const aTraders = (copy?.selections || []).filter((s) => s.enabled && (s.copying_on === true || s.model === 'AB_LIVE')).length;
    const halted = !!o.platform?.trading_halted;
    T.badge('queues', requested + newFeedback);

    const attention = [];
    if (halted) attention.push(item('alert', 'ic-red', 'Trading is paused for everyone', esc(o.platform.halted_reason || 'Platform halt is on'), '/admin.html', 'Review'));
    if (blocked) attention.push(item('alert', 'ic-red', 'A-book copies are blocked', 'Check unresolved broker receipts or the connection', '/workspace/books.html', 'Open Books'));
    if (noGo) attention.push(item('alert', 'ic-red', `${noGo} trader${noGo === 1 ? '' : 's'} flagged risk no-go`, 'Review before any book change', '/admin.html', 'Review'));
    if (requested) attention.push(item('cash', 'ic-orange', `${requested} payout request${requested === 1 ? '' : 's'} waiting`, 'Approve or void each request', '/admin.html', 'Review'));
    if (newFeedback) attention.push(item('chat', 'ic-blue', `${newFeedback} new feedback message${newFeedback === 1 ? '' : 's'}`, 'Bugs, complaints and suggestions from the website', '/team-feedback.html', 'Read'));
    if (!attention.length) attention.push(item('ok', 'ic-green', 'Nothing needs you right now', 'Checked just now', '', ''));

    $('overview').innerHTML = `
      <div class="stats">
        <div class="stat"><div class="k">Traders</div><div class="v num">${esc(f.accounts_total ?? traders.length)}</div><div class="s">${esc(f.active ?? 0)} active · ${inProfit} in profit</div></div>
        <div class="stat"><div class="k">Net trader P&amp;L</div><div class="v num ${Number(f.net_trader_pnl) < 0 ? 'bad' : 'good'}">${usd(f.net_trader_pnl || 0)}</div><div class="s">${Number(f.net_trader_pnl) < 0 ? 'Traders are behind the firm' : 'Traders are ahead of the firm'}</div></div>
        <div class="stat"><div class="k">Owed to traders now</div><div class="v num">${usd(f.payout_liability || 0)}</div><div class="s">${usd(f.total_paid || 0)} paid to date</div></div>
        <div class="stat"><div class="k">A-book</div><div class="v num">${aTraders}</div><div class="s">${conns.length ? (execOn ? (blocked ? 'Execution blocked' : 'Execution on') : 'Execution off') : 'Not set up'}</div></div>
      </div>
      <div class="grouphead">Needs attention <span class="sub">${attention.length && !attention[0].includes('Nothing needs') ? attention.length + ' item' + (attention.length === 1 ? '' : 's') : ''}</span></div>
      <div class="group">${attention.join('')}</div>
      <div class="grouphead">Safety switches</div>
      <div class="group">
        <div class="item"><div class="body"><b>Trading</b><span>${halted ? 'Paused: no new positions can open' : 'Traders can open new positions'}</span></div><div class="trail"><span class="cap ${halted ? 'red' : 'green'}">${halted ? 'Paused' : 'Running'}</span></div></div>
        <div class="item"><div class="body"><b>A-book execution</b><span>${execOn ? 'Copying selected traders to the E8 account' : 'No trades are copied to a real broker'}</span></div><div class="trail"><span class="cap ${execOn ? (blocked ? 'red' : 'green') : ''}">${execOn ? (blocked ? 'Blocked' : 'On') : 'Off'}</span><a class="btn sm" href="/workspace/books.html">Books</a></div></div>
      </div>
      <div class="grouphead">Books <span class="sub"><a href="/workspace/books.html">Manage</a></span></div>
      <div class="group">
        <div class="item"><div class="body"><b>A-book</b><span>Copied to your E8 account</span></div><div class="trail"><span class="cap blue">A-book</span><b class="num">${aTraders}</b></div></div>
        <div class="item"><div class="body"><b>B-book</b><span>Everyone else · the firm keeps the risk</span></div><div class="trail"><span class="cap orange">B-book</span><b class="num">${Math.max(0, Number(f.active ?? traders.length) - aTraders)}</b></div></div>
      </div>`;
  }

  async function load() {
    try {
      const [o, copy, fb] = await Promise.all([
        T.admin('overview'),
        T.ladder('ongoing_copy_status').catch(() => null),
        T.admin('feedback_list', { status: 'new', page_size: 20 }).catch(() => null),
      ]);
      if (o.is_admin === false) { $('overview').innerHTML = '<div class="banner red">This account doesn’t have team access.</div>'; T.status('No access'); return; }
      render(o, copy, fb);
      T.status('Updated ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) { T.status(e.message); $('overview').innerHTML = `<div class="banner red">${esc(e.message)}<button class="btn sm" id="retry" type="button">Try again</button></div>`; $('retry')?.addEventListener('click', load); }
  }
  T.mount({ page: 'overview', title: 'Overview' });
  $('refreshBtn').addEventListener('click', load);
  load();
  setInterval(() => { if (!document.hidden) load(); }, 30000);
})();
