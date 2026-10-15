/* Books: A-book copying in three steps — connect your E8 account, flip Execution, put traders in A-book or B-book.
   Uses the existing ladder-admin ongoing-copy actions and team-book-connect. Every action still goes through the
   server's own checks (owner + MFA, versioned updates, capacity, broker readiness); this page only removes typing. */
(() => {
  'use strict';
  const T = window.TeamOS, { esc, usd, ukTime } = T;
  const $ = (id) => document.getElementById(id);
  let d = null, bdest = null, busy = false;

  const connected = () => (d?.connections || []).filter((c) => c.connected);
  const primary = () => connected()[0] || null;
  const capFor = (c) => (d?.capacity || []).find((l) => l.book === 'l' + c.account_id) || null;
  const eligibleAccounts = () => (d?.accounts || []).filter((a) => ['monitor', 'ladder'].includes(a.role) && a.api_env === 'demo' && !a.execution_enabled && ['funded', 'evaluation'].includes(a.status));
  // The status rows mark an A-book trader with copying_on / model AB_LIVE (live_selected only appears on action replies).
  const isA = (s) => s.enabled === true && (s.copying_on === true || s.model === 'AB_LIVE' || s.live_selected === true);

  async function run(fn, ok) {
    if (busy) return; busy = true; document.body.style.cursor = 'progress';
    try { const r = await fn(); if (ok) T.toast(ok); await load(); return r; }
    catch (e) { T.toast(e.message, true); await load(); }
    finally { busy = false; document.body.style.cursor = ''; }
  }

  // ---- A-book connection ----
  async function setUp() {
    const accounts = eligibleAccounts();
    if (!accounts.length) { T.toast('No saved E8 account yet. Add one in Treasury first.', true); return; }
    const v = await T.sheet({
      title: 'Set up A-book copying',
      text: 'I own this account and copying to it is permitted. Execution stays <b>off</b> until you switch it on.',
      fields: [
        { id: 'id', label: 'E8 account', options: accounts.map((a) => ({ value: a.id, label: `${a.label} #${a.id}` })), value: accounts[0].id },
        { id: 'lots', label: 'Lots per copied trade', type: 'number', value: '0.01', min: 0.01, max: 1, step: 0.01, hint: 'Between 0.01 and 1.00' },
        { id: 'risk', label: 'Emergency-stop limit per trade ($)', type: 'number', value: '100', min: 1, max: 100, step: 1, hint: 'Most a copy can lose if its stop fails, before fees. Up to $100.' },
      ],
      confirm: 'Connect',
      onSubmit: (x) => T.ladder('ongoing_copy_connect', { id: Number(x.id), lots: Number(x.lots), risk_usd: Number(x.risk), confirm_owned_and_permitted: true, reason: 'Owner connected A-book copying from Books' }),
    });
    if (v) { T.toast('Connected. Execution is off.'); await load(); }
  }

  async function editLimits(c) {
    const saved = capFor(c);
    const v = await T.sheet({
      title: 'Broker limits',
      text: 'Set once from your E8 account terms. Copying checks these before every order.',
      fields: [
        { id: 'positions', label: 'Maximum open positions and orders', type: 'number', value: saved?.position_limit ?? '', min: 1, step: 1 },
        { id: 'margin', label: 'Margin for one full lot ($)', type: 'number', value: saved?.margin_per_lot_usd ?? '', min: 0.01, step: 0.01 },
        { id: 'source', label: 'Where these figures come from', value: saved?.provider_evidence ?? 'E8 account specification', hint: 'At least 10 characters' },
      ],
      confirm: 'Save limits',
      onSubmit: (x) => T.ladder('capacity_set', { book: 'l' + c.account_id, position_limit: Number(x.positions), margin_per_lot_usd: Number(x.margin), provider_evidence: String(x.source).trim() }),
    });
    if (v) { T.toast('Limits saved.'); await load(); return true; }
    return false;
  }

  async function toggleExecution(c) {
    if (c.execution_on) return run(() => T.ladder('ongoing_copy_off', { id: c.id, version: c.version }), 'Execution off. Open copies stay tracked.');
    if (!c.capacity_configured && !(await editLimits(c))) return;
    const fresh = (d.connections || []).find((x) => x.id === c.id) || c;
    const n = (d.selections || []).filter((s) => s.connection_id === c.id && isA(s)).length;
    const ok = await T.sheet({
      title: 'Turn execution on?',
      text: `New trades from your <b>${n}</b> A-book trader${n === 1 ? '' : 's'} will be copied to <b>${esc(fresh.label)}</b> at <b>${esc(fresh.broker_lots)}</b> lots, with a $${esc(fresh.max_trade_risk_usd)} emergency-stop limit. Each order still passes broker and risk checks.`,
      confirm: 'Turn on',
      onSubmit: () => T.ladder('ongoing_copy_on', { id: fresh.id, version: fresh.version, confirm_funded_execution: true }),
    });
    if (ok) { T.toast('Execution on.'); await load(); }
  }

  async function disconnect(c) {
    const ok = await T.sheet({ title: 'Disconnect copying?', text: `Stops new copies to ${esc(c.label)}. Copies already open stay tracked until they close.`, confirm: 'Disconnect', danger: true,
      onSubmit: () => T.ladder('ongoing_copy_disconnect', { id: c.id, version: c.version }) });
    if (ok) { T.toast('Disconnected.'); await load(); }
  }

  // ---- traders A / B ----
  async function toA(personId, email) {
    const c = primary();
    if (!c) { T.toast('Connect your E8 account first.', true); return; }
    const ok = await T.sheet({ title: 'Move to A-book?', text: `Future Infinity trades from <b>${esc(email)}</b> will be copied to <b>${esc(c.label)}</b>${c.execution_on ? '' : ' once execution is on'}.`, confirm: 'Move to A-book',
      onSubmit: () => T.ladder('ongoing_copy_start_trader', { id: c.id, person_id: personId, version: c.version, reason: 'Owner moved trader to A-book from Books', confirm_funded_execution: true }) });
    if (ok) { T.toast(email + ' is in A-book.'); await load(); }
  }
  const toB = (s) => run(() => T.ladder('ongoing_copy_select', { id: s.connection_id, person_id: s.person_id, enabled: false, reason: 'Owner moved trader to B-book from Books' }), (s.email || 'Trader') + ' is in B-book. Open copies stay tracked.');

  async function addTrader() {
    let found = null;
    const v = await T.sheet({ title: 'Add a trader to A-book', text: 'Everyone starts in B-book. Enter the trader’s registered email.', fields: [{ id: 'email', label: 'Trader email', type: 'email', placeholder: 'name@example.com' }], confirm: 'Find trader',
      onSubmit: async (x) => { const r = await T.ladder('ongoing_copy_find', { email: String(x.email).trim() }); if (!r.accounts?.length) throw new Error('No active Infinity challenge for this email.'); found = { ...r, email: String(x.email).trim() }; return r; } });
    if (v && found) await toA(found.person_id, found.email);
  }

  // ---- B-book destination ----
  async function connectB() {
    const v = await T.sheet({ title: 'Connect B-book research account', text: 'A TradeLocker demo used only for reverse research copies. Your password is exchanged for tokens and not saved. Nothing is armed.',
      fields: [
        { id: 'email', label: 'Broker email', type: 'email' }, { id: 'password', label: 'Password', type: 'password' },
        { id: 'server', label: 'Server', value: 'HeroFX' }, { id: 'account', label: 'Account number (if several)', optional: true },
      ], confirm: 'Connect',
      onSubmit: (x) => T.book('connect', { environment: 'demo', email: String(x.email).trim(), password: x.password, server: String(x.server).trim(), account_id: String(x.account || '').trim() }) });
    if (v) { T.toast('B-book account connected for review.'); await load(); }
  }
  async function disconnectB() {
    const ok = await T.sheet({ title: 'Disconnect B-book account?', confirm: 'Disconnect', danger: true, onSubmit: () => T.book('disconnect') });
    if (ok) { T.toast('B-book account disconnected.'); await load(); }
  }

  // ---- render ----
  function aBookSection() {
    const cs = connected();
    if (!cs.length) {
      return `<div class="group"><div class="item"><div class="leadicon ic-blue"><svg viewBox="0 0 24 24"><rect x="4" y="5" width="7" height="14" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></div>
        <div class="body"><b>A-book copying isn’t set up</b><span>Copies chosen traders’ trades to your E8 account.</span></div>
        <div class="trail"><button class="btn primary" data-act="setup">Set up</button></div></div></div>`;
    }
    return cs.map((c) => {
      const limits = capFor(c), blocked = c.execution_on && c.ready === false;
      const n = (d.selections || []).filter((s) => s.connection_id === c.id && isA(s)).length;
      return `${blocked ? `<div class="banner red">New copies are blocked: check unresolved broker receipts, the connection or permission. Open copies stay tracked.<button class="btn sm" data-act="refresh">Check again</button></div>` : ''}
      <div class="group">
        <div class="item"><div class="body"><b>${esc(c.label)}</b><span>${esc(c.broker_lots)} lots per copy · $${esc(c.max_trade_risk_usd)} emergency-stop limit · ${n} trader${n === 1 ? '' : 's'}</span></div>
          <div class="trail"><span class="cap ${c.execution_on ? (blocked ? 'red' : 'green') : ''}">${c.execution_on ? (blocked ? 'Blocked' : 'Copying') : 'Off'}</span>
          <button class="switch" role="switch" aria-checked="${!!c.execution_on}" aria-label="Execution" data-act="exec" data-id="${c.id}"></button></div></div>
        <div class="item"><div class="body"><b>Broker limits</b><span>${limits ? `Up to ${esc(limits.position_limit)} positions · ${usd(limits.margin_per_lot_usd)} margin per lot` : 'Needed once before execution can turn on'}</span></div>
          <div class="trail">${limits ? '' : '<span class="cap orange">Required</span>'}<button class="btn sm" data-act="limits" data-id="${c.id}">${limits ? 'Edit' : 'Set limits'}</button></div></div>
        <div class="item"><div class="body"><span>${c.jwt_available || d.developer_configured ? 'Uses your saved E8 login. No developer key needed for one account.' : 'Developer access is needed for more than one execution account.'}</span></div>
          <div class="trail"><button class="btn sm link" data-act="disconnect" data-id="${c.id}">Disconnect</button></div></div>
      </div>`;
    }).join('');
  }

  function tradersSection() {
    // Traders you have placed stay listed after moving back to B-book, so A ↔ B is always one click.
    const rows = [...(d.selections || [])].sort((x, y) => Number(isA(y)) - Number(isA(x)));
    const hasConn = connected().length > 0;
    return `<div class="grouphead">Traders <span class="sub">Everyone not listed is in B-book</span><button class="btn sm tinted" data-act="add"${hasConn ? '' : ' disabled title="Connect your E8 account first"'}>Add trader</button></div>
      <div class="group">${rows.length ? rows.map((s) => {
        const a = isA(s), c = (d.connections || []).find((x) => x.id === s.connection_id);
        const live = a && c?.execution_on && c?.ready !== false && c?.capacity_configured;
        return `<div class="item"><div class="body"><b>${esc(s.email || s.person_id)}</b><span>${a ? (live ? 'Copying to ' + esc(c.label) : 'In A-book · copying starts when execution is on') : 'In B-book · not copied'}</span></div>
          <div class="trail"><div class="seg" role="group" aria-label="Book for ${esc(s.email || '')}">
            <button class="a" aria-pressed="${a}" data-act="toA" data-person="${esc(s.person_id)}" data-email="${esc(s.email || s.person_id)}"${a ? ' disabled' : ''}>A-book</button>
            <button class="b" aria-pressed="${!a}" data-act="toB" data-person="${esc(s.person_id)}"${a ? '' : ' disabled'}>B-book</button></div></div></div>`;
      }).join('') : `<div class="empty">No traders in A-book. ${hasConn ? 'Use Add trader to move someone in.' : 'Set up copying first, then add traders.'}</div>`}</div>`;
  }

  function bBookSection() {
    const on = bdest?.connected, dest = bdest?.destination;
    return `<div class="grouphead">B-book <span class="sub">The firm keeps B-book risk. The research account only mirrors it for review.</span></div>
      <div class="group"><div class="item"><div class="body"><b>Research account</b><span>${on ? `${esc(dest.account_name)} · ${esc(dest.server)} · #${esc(dest.account_id)} · no orders armed` : bdest === null ? 'Status unavailable' : 'Not connected'}</span></div>
        <div class="trail"><span class="cap ${on ? 'green' : ''}">${on ? 'Connected' : 'Off'}</span>${on ? '<button class="btn sm link" data-act="bdisconnect">Disconnect</button>' : '<button class="btn sm" data-act="bconnect">Connect</button>'}</div></div></div>`;
  }

  function activitySection() {
    const fails = (d.intentions || []).filter((i) => i.state === 'refused' || i.state === 'reserved' || Number(i.uncertain_events) > 0);
    const rec = d.receipts || [];
    return `<details class="more"${fails.length ? ' open' : ''}><summary>Copy activity · ${fails.length} need attention · ${rec.length} recent</summary>
      <div class="grouphead">Refused or uncertain</div>
      <div class="tablewrap"><div class="scroll"><table><thead><tr><th>When (UK)</th><th>Trade</th><th>Status</th><th>Reason</th></tr></thead><tbody>
        ${fails.map((i) => `<tr><td class="num muted">${ukTime(i.created_at)}</td><td>${esc(String(i.source_trade_id).slice(0, 8))} · ${esc(i.symbol)}</td><td>${esc(i.state)} · ${esc(i.broker_status || 'not sent')}</td><td class="muted">${esc(i.reason || 'Processing — check the broker receipt')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing needs attention.</td></tr>'}
      </tbody></table></div></div>
      <div class="grouphead">Broker receipts</div>
      <div class="tablewrap"><div class="scroll"><table><thead><tr><th>When (UK)</th><th>Trade</th><th>Order</th><th>Status</th><th class="r">Fill</th><th class="r">Gross P&amp;L</th></tr></thead><tbody>
        ${rec.map((o) => `<tr><td class="num muted">${ukTime(o.created_at)}</td><td>${esc(String(o.source_trade_id).slice(0, 8))}</td><td>${esc(o.symbol)} ${esc(o.side)} ${esc(o.qty)}</td><td>${esc(o.event)} · ${esc(o.status)}${o.error ? `<br><small class="bad">${esc(o.error)}</small>` : ''}</td><td class="r num">${esc(o.fill_price ?? '—')}</td><td class="r num">${o.pnl_usd == null ? '—' : usd(o.pnl_usd)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No broker copies yet.</td></tr>'}
      </tbody></table></div></div>
      <p class="foot">Gross figures from broker receipts. Fees and swaps are checked separately.</p></details>`;
  }

  function render() {
    if (!d) return;
    $('books').innerHTML = `<div class="grouphead" style="margin-top:0">A-book <span class="sub">Same-direction copies to your E8 account</span></div>${aBookSection()}${tradersSection()}${bBookSection()}${activitySection()}`;
  }

  async function load() {
    try {
      const [ongoing, b] = await Promise.all([T.ladder('ongoing_copy_status'), T.book('status').catch(() => null)]);
      d = ongoing; bdest = b; render();
      T.status('Updated ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } catch (e) {
      T.status(e.message);
      if (!d) $('books').innerHTML = `<div class="banner red">${esc(e.message)}<button class="btn sm" data-act="refresh">Try again</button></div>`;
    }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const c = (d?.connections || []).find((x) => String(x.id) === b.dataset.id);
    const s = (d?.selections || []).find((x) => x.person_id === b.dataset.person);
    switch (b.dataset.act) {
      case 'setup': setUp(); break;
      case 'exec': if (c) toggleExecution(c); break;
      case 'limits': if (c) editLimits(c); break;
      case 'disconnect': if (c) disconnect(c); break;
      case 'add': addTrader(); break;
      case 'toA': toA(b.dataset.person, b.dataset.email); break;
      case 'toB': if (s) toB(s); break;
      case 'bconnect': connectB(); break;
      case 'bdisconnect': disconnectB(); break;
      case 'refresh': load(); break;
    }
  });

  T.mount({ page: 'books', title: 'Books' });
  $('refreshBtn').addEventListener('click', load);
  load();
  setInterval(() => { if (!busy && !document.hidden && !document.querySelector('.os-scrim')) load(); }, 10000);
})();
