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
  const cap = (txt, cls) => `<span class="cap ${cls || ''}">${esc(txt)}</span>`;
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

  // ---- owner limits: default lots, per-position loss cap, daily loss limit (apply to new copies; execution can stay on) ----
  const limitsOf = (c) => ({ lots: Number(c.broker_lots), posOn: !!c.position_loss_cap_on, posUsd: c.position_loss_cap_usd == null ? null : Number(c.position_loss_cap_usd), dayOn: !!c.daily_loss_on, dayUsd: c.daily_loss_usd == null ? null : Number(c.daily_loss_usd) });
  const saveLimits = (c, x, why) => T.ladder('ongoing_copy_limits', { id: c.id, version: c.version, lots: x.lots, position_loss_cap_on: x.posOn, position_loss_cap_usd: x.posUsd, daily_loss_on: x.dayOn, daily_loss_usd: x.dayUsd, reason: why });
  async function editLots(c) {
    const cur = limitsOf(c);
    const v = await T.sheet({ title: 'Lot size per copy', text: 'Used for every A-book trader without their own lot size. Applies to new copies; open copies keep their size.',
      fields: [{ id: 'lots', label: 'Lots per copied trade', type: 'number', value: cur.lots, min: 0.01, max: 1, step: 0.01, hint: 'Between 0.01 and 1.00' }], confirm: 'Save',
      onSubmit: (x) => saveLimits(c, { ...cur, lots: Number(x.lots) }, 'Owner changed default copy lots from Books') });
    if (v) { T.toast('Lot size saved.'); await load(); }
  }
  async function editPositionCap(c, turnOn = false) {
    const cur = limitsOf(c);
    const v = await T.sheet({ title: 'Max loss per position', text: 'Each copy is sent to E8 with a stop at the price where it loses this much, so E8 closes it automatically. Applies to new copies.',
      fields: [{ id: 'usd', label: 'Maximum loss per position ($)', type: 'number', value: cur.posUsd ?? 25, min: 1, max: 1000, step: 1, hint: 'If the 3x backstop on the trader’s own stop is closer, that is used. Very small amounts on large lots are refused rather than sent.' }],
      confirm: turnOn || cur.posOn ? 'Save and turn on' : 'Save',
      onSubmit: (x) => saveLimits(c, { ...cur, posOn: turnOn || cur.posOn, posUsd: Number(x.usd) }, 'Owner set the per-position loss cap from Books') });
    if (v) { T.toast('Max loss per position saved.'); await load(); }
  }
  async function editDailyCap(c, turnOn = false) {
    const cur = limitsOf(c);
    const v = await T.sheet({ title: 'Max daily loss', text: 'No new copy is sent once today’s closed loss plus the risk on open copies plus the new copy would pass this amount. Resets at midnight UTC.',
      fields: [{ id: 'usd', label: 'Maximum daily loss ($)', type: 'number', value: cur.dayUsd ?? 250, min: 1, max: 50000, step: 1, hint: 'Keep it below E8’s own daily loss limit for this account.' }],
      confirm: turnOn || cur.dayOn ? 'Save and turn on' : 'Save',
      onSubmit: (x) => saveLimits(c, { ...cur, dayOn: turnOn || cur.dayOn, dayUsd: Number(x.usd) }, 'Owner set the daily loss limit from Books') });
    if (v) { T.toast('Max daily loss saved.'); await load(); }
  }
  async function toggleLimit(c, which, el) {
    const cur = limitsOf(c), on = which === 'pos' ? cur.posOn : cur.dayOn;
    if (!on) return which === 'pos' ? editPositionCap(c, true) : editDailyCap(c, true);
    el?.setAttribute('aria-checked', 'false');
    return run(() => saveLimits(c, which === 'pos' ? { ...cur, posOn: false } : { ...cur, dayOn: false }, which === 'pos' ? 'Owner turned off the per-position loss cap' : 'Owner turned off the daily loss limit'),
      which === 'pos' ? 'Max loss per position off. New copies use the 3x backstop.' : 'Max daily loss off. The 2% default applies.');
  }
  // ---- risk plan: one set of rules for the whole A-book, plus the equity guard (kill switch) ----
  // Recommended plan for a $50k E8 account with a $1,000 daily loss limit (from replaying real trader-days): $50 per copy
  // sized from the trader's stop, broker stop at 1.5x, max 3 open copies per trader, a trader paused after -$200 in a day,
  // no new copies once the day reaches -$600 including open risk, and everything closed at -$750 on the broker's day P&L.
  const RECOMMENDED = { size_mode: 'risk', risk_per_trade_usd: 50, stop_multiple: 1.5, lots: 1, trader_max_open: 3, trader_daily_cut_usd: 200, daily_loss_on: true, daily_loss_usd: 600, kill_switch_on: true, kill_day_loss_usd: 750 };
  const planOf = (c) => ({ size_mode: c.size_mode || 'fixed', risk_per_trade_usd: c.risk_per_trade_usd, stop_multiple: c.stop_multiple ?? 1.5, lots: c.broker_lots, trader_max_open: c.trader_max_open,
    trader_daily_cut_usd: c.trader_daily_cut_usd, daily_loss_on: !!c.daily_loss_on, daily_loss_usd: c.daily_loss_usd, kill_switch_on: !!c.kill_switch_on, kill_day_loss_usd: c.kill_day_loss_usd, equity_floor_usd: c.equity_floor_usd });
  const savePlan = (c, plan, why) => T.ladder('ongoing_copy_risk_plan', { id: c.id, version: c.version, plan, reason: why });
  const guardOf = (c) => (d?.guard || []).find((g) => Number(g.account_id) === Number(c.account_id)) || null;
  async function editPlan(c, start = null) {
    const p = { ...planOf(c), ...(start || {}) };
    const v = await T.sheet({ title: start ? 'Apply the recommended risk plan' : 'Risk plan',
      text: 'One set of rules for every A-book trader. Saved immediately; applies to new copies while execution stays on.',
      fields: [
        { id: 'mode', label: 'Copy size', options: [{ value: 'risk', label: 'By risk: lots worked out from the trader’s stop (recommended)' }, { value: 'fixed', label: 'Fixed lots for every copy' }], value: p.size_mode },
        { id: 'risk', label: 'Risk per copy ($)', type: 'number', min: 1, max: 1000, step: 1, value: p.risk_per_trade_usd ?? 50, hint: 'What one copy loses if its broker stop is hit.' },
        { id: 'mult', label: 'Broker stop at × the trader’s stop', type: 'number', min: 1, max: 3, step: 0.1, value: p.stop_multiple ?? 1.5, hint: 'Room for the trader’s stop to slip; the copy still never loses more than the risk per copy.' },
        { id: 'lots', label: 'Maximum lots per copy', type: 'number', min: 0.01, max: 1, step: 0.01, value: p.lots ?? 1 },
        { id: 'tmax', label: 'Max open copies per trader', type: 'number', min: 1, max: 50, step: 1, value: p.trader_max_open ?? '', optional: true },
        { id: 'tcut', label: 'Pause a trader for the day after their copies lose ($)', type: 'number', min: 1, step: 1, value: p.trader_daily_cut_usd ?? '', optional: true },
        { id: 'day', label: 'Stop new copies when today’s loss + open risk reaches ($)', type: 'number', min: 1, step: 1, value: p.daily_loss_on ? p.daily_loss_usd : (p.daily_loss_usd ?? ''), optional: true, hint: 'Leave empty for the 2% default.' },
        { id: 'kill', label: 'Kill switch: close everything when the E8 day P&L reaches −($)', type: 'number', min: 1, step: 1, value: p.kill_switch_on ? p.kill_day_loss_usd : (p.kill_day_loss_usd ?? ''), optional: true, hint: 'Must be above the new-copy limit and below E8’s own daily loss limit. Leave empty to switch it off.' },
        { id: 'floor', label: 'Also close everything if equity falls to ($)', type: 'number', min: 1, step: 1, value: p.equity_floor_usd ?? '', optional: true, hint: 'Set just above E8’s maximum-loss level for this account.' },
      ],
      confirm: start ? 'Apply plan' : 'Save plan',
      onSubmit: (x) => {
        const n = (v) => (v === '' || v == null ? null : Number(v));
        if (x.mode === 'risk' && !n(x.risk)) throw new Error('Enter the risk per copy.');
        if (n(x.day) && n(x.kill) && n(x.day) >= n(x.kill)) throw new Error('The new-copy limit must be smaller than the kill switch amount.');
        return savePlan(c, { size_mode: x.mode, risk_per_trade_usd: n(x.risk), stop_multiple: n(x.mult), lots: n(x.lots), trader_max_open: n(x.tmax), trader_daily_cut_usd: n(x.tcut),
          daily_loss_on: n(x.day) != null, daily_loss_usd: n(x.day), kill_switch_on: n(x.kill) != null, kill_day_loss_usd: n(x.kill), equity_floor_usd: n(x.floor) }, start ? 'Owner applied the recommended A-book risk plan' : 'Owner edited the A-book risk plan');
      } });
    if (v) { T.toast('Risk plan saved.'); await load(); }
  }
  async function toggleKill(c, el) {
    const p = planOf(c);
    if (!p.kill_switch_on) return editPlan(c, { kill_switch_on: true, kill_day_loss_usd: p.kill_day_loss_usd ?? 750 });
    const ok = await T.sheet({ title: 'Switch the kill switch off?', text: 'Nothing will close positions automatically if the day’s loss keeps growing. The daily new-copy limit still applies.', confirm: 'Switch off', danger: true,
      onSubmit: () => savePlan(c, { ...p, kill_switch_on: false }, 'Owner switched the kill switch off') });
    if (ok) { T.toast('Kill switch off.'); await load(); } else el?.setAttribute('aria-checked', 'true');
  }
  function riskPlanSection(c) {
    const p = planOf(c), g = guardOf(c), age = g ? (Date.now() - Date.parse(g.read_at)) / 1000 : null, fresh = age != null && age < 60 && !g.error;
    const day = g?.day_pnl == null ? null : Number(g.day_pnl), limitE8 = 1000, killAt = p.kill_switch_on ? Number(p.kill_day_loss_usd) : null, stopAt = p.daily_loss_on ? Number(p.daily_loss_usd) : null;
    const pct = (v) => Math.max(0, Math.min(100, (v / limitE8) * 100));
    const tripped = c.kill_tripped_at && !c.execution_on;
    const isRecommended = Object.entries(RECOMMENDED).every(([k, v]) => String(p[k] ?? '') === String(v));
    const gauge = `<div class="item" style="display:block"><div class="row" style="justify-content:space-between"><div><b>Today on E8</b> <span class="muted" style="font-size:12px">broker day · closed + open</span></div>
        <div class="row">${cap(!g ? 'Guard not running yet' : g.error ? 'Read failed: ' + g.error : fresh ? 'Guard live · ' + Math.round(age) + 's ago' : 'Stale · ' + Math.round(age) + 's ago', !g || g.error || !fresh ? 'orange' : 'green')}
        <b class="num ${day < 0 ? 'bad' : day > 0 ? 'good' : ''}" style="font-size:20px">${day == null ? '—' : (day >= 0 ? '+' : '−') + usd(Math.abs(day)).replace(/^[−-]/, '')}</b></div></div>
      <div style="position:relative;height:10px;border-radius:99px;background:var(--sel);margin:12px 0 6px;overflow:visible">
        <i style="position:absolute;left:0;top:0;bottom:0;width:${day != null && day < 0 ? pct(-day) : 0}%;border-radius:99px;background:${killAt && day <= -killAt ? 'var(--red)' : stopAt && day <= -stopAt ? 'var(--orange)' : 'var(--accent)'}"></i>
        ${stopAt ? `<span title="New copies stop" style="position:absolute;left:${pct(stopAt)}%;top:-4px;bottom:-4px;width:2px;background:var(--orange)"></span>` : ''}
        ${killAt ? `<span title="Kill switch" style="position:absolute;left:${pct(killAt)}%;top:-4px;bottom:-4px;width:2px;background:var(--red)"></span>` : ''}
        <span title="E8 daily loss limit" style="position:absolute;right:0;top:-4px;bottom:-4px;width:2px;background:var(--ink3)"></span></div>
      <div class="row muted" style="justify-content:space-between;font-size:11.5px"><span>$0</span>${stopAt ? `<span style="color:var(--orange)">new copies stop −${usd(stopAt)}</span>` : ''}${killAt ? `<span style="color:var(--red)">close everything −${usd(killAt)}</span>` : ''}<span>E8 limit −$1,000</span></div>
      ${g ? `<div class="muted" style="font-size:12px;margin-top:6px">Balance ${usd(g.balance)} · equity ${usd(g.equity)} · ${esc(g.positions ?? 0)} open position${g.positions === 1 ? '' : 's'}</div>` : ''}</div>`;
    return `<div class="grouphead">Risk plan <span class="sub">Same rules for every A-book trader</span>${isRecommended ? cap('Recommended plan', 'green') : `<button class="btn sm primary" data-act="planrec" data-id="${c.id}">Apply recommended plan</button>`}</div>
      ${tripped ? `<div class="banner red"><div><b>Kill switch tripped ${ukTime(c.kill_tripped_at)} UK.</b> ${esc(c.kill_reason || '')}. Execution is off and positions were closed${g?.last_flatten ? ` (${esc(g.last_flatten.owned_closed ?? 0)} copies, ${esc(g.last_flatten.other_closed ?? 0)} other)` : ''}. Turn execution back on in the card above when you’re ready.</div></div>` : ''}
      <div class="group">${gauge}
        <div class="item"><div class="body"><b>Copy size</b><span>${p.size_mode === 'risk' ? `By risk: <b class="num">${usd(p.risk_per_trade_usd)}</b> per copy, broker stop at ${esc(p.stop_multiple)}× the trader’s stop, up to ${Number(p.lots).toFixed(2)} lots` : `Fixed ${Number(p.lots).toFixed(2)} lots per copy`}</span></div>
          <div class="trail"><button class="btn sm" data-act="plan" data-id="${c.id}">Edit</button></div></div>
        <div class="item"><div class="body"><b>Per trader</b><span>${p.trader_max_open ? `Max ${esc(p.trader_max_open)} open copies` : 'No open-copy limit'} · ${p.trader_daily_cut_usd ? `paused for the day after −${usd(p.trader_daily_cut_usd)}` : 'never paused for the day'}</span></div>
          <div class="trail"><button class="btn sm" data-act="plan" data-id="${c.id}">Edit</button></div></div>
        <div class="item"><div class="body"><b>Kill switch</b><span>${p.kill_switch_on ? `Closes every position on the account and switches execution off when the E8 day P&L reaches <b class="num bad">−${usd(p.kill_day_loss_usd)}</b>${p.equity_floor_usd ? ` or equity falls to ${usd(p.equity_floor_usd)}` : ''}. Checked every 10 seconds.` : 'Off · nothing closes positions automatically'}</span></div>
          <div class="trail">${cap(p.kill_switch_on ? 'Armed' : 'Off', p.kill_switch_on ? 'green' : 'red')}<button class="switch" role="switch" aria-checked="${p.kill_switch_on}" aria-label="Kill switch" data-act="killswitch" data-id="${c.id}"></button></div></div>
      </div>`;
  }

  async function editTraderLots(s) {
    const c = (d.connections || []).find((x) => x.id === s.connection_id);
    const v = await T.sheet({ title: 'Lot size for ' + (s.email || 'this trader'), text: 'Their next copies use this size. Leave empty to use the default (' + (c ? c.broker_lots : '—') + ' lots).',
      fields: [{ id: 'lots', label: 'Lots per copied trade', type: 'number', value: s.lots ?? '', min: 0.01, max: 1, step: 0.01, optional: true }], confirm: 'Save',
      onSubmit: (x) => T.ladder('ongoing_copy_trader_lots', { id: s.connection_id, person_id: s.person_id, lots: x.lots === '' ? null : Number(x.lots), reason: 'Owner set trader copy lots from Books' }) });
    if (v) { T.toast('Lot size saved.'); await load(); }
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
        <div class="item"><div class="body"><b>${esc(c.label)}</b><span>${n} trader${n === 1 ? '' : 's'} · ${c.execution_on ? 'new trades are copied' : 'nothing is copied while off'}</span></div>
          <div class="trail"><span class="cap ${c.execution_on ? (blocked ? 'red' : 'green') : ''}">${c.execution_on ? (blocked ? 'Blocked' : 'Copying') : 'Off'}</span>
          <button class="switch" role="switch" aria-checked="${!!c.execution_on}" aria-label="Execution" data-act="exec" data-id="${c.id}"></button></div></div>
        <div class="item"><div class="body"><b>Lot size per copy</b><span>${esc(c.broker_lots)} lots for every trader without their own size</span></div>
          <div class="trail"><button class="btn sm" data-act="lots" data-id="${c.id}">Edit</button></div></div>
        <div class="item"><div class="body"><b>Max loss per position</b><span>${c.position_loss_cap_on ? `E8 closes each new copy automatically at <b class="num bad">−${usd(c.position_loss_cap_usd)}</b>` : `Off · stop at 3x the trader’s stop; copies risking over ${usd(c.max_trade_risk_usd)} are refused`}</span></div>
          <div class="trail">${c.position_loss_cap_usd != null ? `<button class="btn sm" data-act="poscap" data-id="${c.id}">Edit</button>` : ''}<button class="switch" role="switch" aria-checked="${!!c.position_loss_cap_on}" aria-label="Max loss per position" data-act="posswitch" data-id="${c.id}"></button></div></div>
        <div class="item"><div class="body"><b>Max daily loss</b><span>${c.daily_loss_on ? `No new copies once today’s loss + open risk would pass <b class="num bad">−${usd(c.daily_loss_usd)}</b> (UTC day)` : 'Off · default limit of 2% of the account size'}</span></div>
          <div class="trail">${c.daily_loss_usd != null ? `<button class="btn sm" data-act="daycap" data-id="${c.id}">Edit</button>` : ''}<button class="switch" role="switch" aria-checked="${!!c.daily_loss_on}" aria-label="Max daily loss" data-act="dayswitch" data-id="${c.id}"></button></div></div>
        <div class="item"><div class="body"><b>Broker limits</b><span>${limits ? `Up to ${esc(limits.position_limit)} positions · ${usd(limits.margin_per_lot_usd)} margin per lot` : 'Needed once before execution can turn on'}</span></div>
          <div class="trail">${limits ? '' : '<span class="cap orange">Required</span>'}<button class="btn sm" data-act="limits" data-id="${c.id}">${limits ? 'Edit' : 'Set limits'}</button></div></div>
        <div class="item"><div class="body"><span>${c.jwt_available || d.developer_configured ? 'Uses your saved E8 login. No developer key needed for one account.' : 'Developer access is needed for more than one execution account.'}</span></div>
          <div class="trail"><button class="btn sm link" data-act="disconnect" data-id="${c.id}">Disconnect</button></div></div>
      </div>${riskPlanSection(c)}`;
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
        return `<div class="item"><div class="body"><b>${esc(s.email || s.person_id)}</b><span>${a ? (live ? 'Copying to ' + esc(c.label) : 'In A-book · copying starts when execution is on') : 'In B-book · not copied'} · ${s.lots != null ? `<b class="num">${esc(s.lots)} lots</b> (own size)` : c?.size_mode === 'risk' ? `sized by risk (${usd(c.risk_per_trade_usd)} per copy)` : `default ${esc(c?.broker_lots ?? '—')} lots`}</span></div>
          <div class="trail"><button class="btn sm" data-act="tlots" data-person="${esc(s.person_id)}">Lot size</button><div class="seg" role="group" aria-label="Book for ${esc(s.email || '')}">
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
      case 'lots': if (c) editLots(c); break;
      case 'poscap': if (c) editPositionCap(c); break;
      case 'daycap': if (c) editDailyCap(c); break;
      case 'posswitch': if (c) toggleLimit(c, 'pos', b); break;
      case 'dayswitch': if (c) toggleLimit(c, 'day', b); break;
      case 'tlots': if (s) editTraderLots(s); break;
      case 'plan': if (c) editPlan(c); break;
      case 'planrec': if (c) editPlan(c, RECOMMENDED); break;
      case 'killswitch': if (c) toggleKill(c, b); break;
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
