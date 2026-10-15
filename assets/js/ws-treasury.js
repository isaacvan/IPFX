/* Treasury: can IPFX pay what traders are likely to earn? Payout cover, the forecast, the cash that counts, graduates
   to fund, the evaluation ladder and book risk, from the ladder-admin `overview`. Every change goes through the same
   ladder-admin actions (owner + MFA, audited). Nothing here places a trade or makes a payment. */
(() => {
  'use strict';
  const T = window.TeamOS, { esc, usd, ukTime } = T;
  const $ = (id) => document.getElementById(id);
  let d = null, busy = false;
  const COVER = { healthy: ['Healthy', 'green', 'Cash covers the 90-day bad case.'], tight: ['Tight', 'orange', 'Cash only just covers the 90-day bad case.'],
    short: ['Short', 'red', 'Cash doesn’t cover the 90-day bad case.'], unknown: ['Unknown', '', 'Forecast figures are missing.'] };
  const ROLE = { ladder: 'Prop account', shadow: 'Demo copy', monitor: 'E8 monitor' };
  const STATE = { BB_DEMO: 'B-book demo', BB_LIVE: 'B-book live', AB_DEMO: 'A-book demo', AB_LIVE: 'A-book live', SUSPENDED: 'Suspended' };
  const money = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '—' : usd(v));
  const pct = (v) => (v == null ? '—' : (Number(v) * 100).toFixed(Number(v) < 0.1 ? 1 : 0) + '%');
  const cap = (txt, cls) => `<span class="cap ${cls || ''}">${esc(txt)}</span>`;
  const figures = () => d.snapshot && !d.snapshot.notes?.figures_unavailable;

  // ---- sections ----
  function cover() {
    const s = d.snapshot, set = d.settings || {}, ok = figures();
    const st = COVER[s?.status] || COVER.unknown, cash = s?.assets_usd, need = ok ? Number(s.liab_90d_p90) : null;
    const fill = cash == null || need == null ? 0 : need <= 0 ? 100 : Math.max(0, Math.min(100, (Number(cash) / need) * 100));
    const why = set.starting_reserve_usd == null ? 'Set your starting cash reserve to measure cover.'
      : s && !s.complete ? 'The last forecast was incomplete' + (s.notes?.source_error ? ` (${s.notes.source_error})` : '') + '. Don’t act on it.' : st[2];
    return `<div class="cover"><div class="row" style="justify-content:space-between;align-items:flex-start">
        <div><div class="k">Payout cover</div><div class="big"${st[1] ? ` style="color:var(--${st[1]})"` : ''}>${st[0]}</div><div class="muted">${esc(why)}</div></div>
        ${set.starting_reserve_usd == null ? '<button class="btn primary" data-act="reserve">Set reserve</button>' : ''}</div>
      <div class="meter" role="img" aria-label="Cash covers ${Math.round(fill)}% of the 90-day bad case"><i style="width:${fill}%;background:var(--${st[1] || 'ink3'})"></i></div>
      <div class="row muted" style="justify-content:space-between;font-size:12.5px"><span>Cash counted <b class="num">${money(cash)}</b></span>
        <span>90-day bad case <b class="num">${money(need)}</b>${s?.coverage_90d != null ? ` · ${Number(s.coverage_90d).toFixed(2)}× covered` : ''}</span></div></div>`;
  }

  function forecast() {
    const s = d.snapshot, ok = figures();
    const cell = (k, v, p, g) => `<div class="stat"><div class="k">${k}</div><div class="v num">${ok ? money(v) : '—'}</div><div class="s">${ok && p != null ? `Bad case ${money(p)} · ${Number(g).toFixed(1)} graduates` : '&nbsp;'}</div></div>`;
    return `<div class="grouphead">Payouts ahead <span class="sub">${s ? `Forecast ${ukTime(s.as_of)} UK · ${esc(s.open_accounts)} open accounts` : 'No forecast yet · runs every hour'}</span></div>
      <div class="stats">${cell('Next 7 days', s?.liab_7d)}${cell('Next 30 days', s?.liab_30d, s?.liab_30d_p90, s?.graduates_30d)}${cell('Next 60 days', s?.liab_60d)}${cell('Next 90 days', s?.liab_90d, s?.liab_90d_p90, s?.graduates_90d)}</div>
      <p class="foot">Expected payouts from each trader’s results so far. The bad case is the 90th percentile and treats traders as independent, so correlated losses can be worse${ok && s.notes?.dependence_stress_usd != null ? ` (if every open account graduated: ${money(s.notes.dependence_stress_usd)})` : ''}. Demo profits never count as cash.</p>`;
  }

  function cash() {
    const s = d.snapshot, set = d.settings || {}, pays = d.payouts || [];
    const fees = (d.ladder_accounts || []).reduce((a, x) => a + (Number(x.fee_usd) || 0), 0);
    const model = set.payout_model === 'sponsored_account' ? 'Funded account at Stage 4' : set.payout_model === 'cash_at_stage3' ? 'Cash at Stage 3 (current Terms)' : 'Not recorded';
    return `<div class="grouphead">Cash <span class="sub">Recorded figures, not a bank reconciliation</span></div>
      <div class="group">
        <div class="item"><div class="body"><b>Starting reserve</b><span>Cash set aside for trader payouts</span></div><div class="trail"><span class="num">${money(set.starting_reserve_usd)}</span><button class="btn sm" data-act="reserve">Edit</button></div></div>
        <div class="item"><div class="body"><b>Prop-firm payouts, less evaluation fees</b><span>${pays.length ? `Last received ${ukTime(pays[0].received_at)} UK` : 'No payouts recorded yet'} · fees paid ${money(fees)}</span></div><div class="trail"><span class="num">${money(s?.ladder_cash_usd)}</span><button class="btn sm" data-act="payout">Record payout</button></div></div>
        <div class="item"><div class="body"><b>Cash counted</b><span>As of the last forecast</span></div><div class="trail"><b class="num">${money(s?.assets_usd)}</b></div></div>
        <div class="item"><div class="body"><b>Payout model</b><span>${esc(model)}</span></div></div>
      </div>
      ${pays.length ? `<details class="more"><summary>Payouts received · ${pays.length} recent</summary><div class="tablewrap"><div class="scroll"><table><thead><tr><th>Received (UK)</th><th>From</th><th>Note</th><th class="r">Amount</th></tr></thead><tbody>
        ${pays.map((p) => { const a = (d.ladder_accounts || []).find((x) => x.id === p.ladder_account_id); return `<tr><td class="num muted">${ukTime(p.received_at)}</td><td>${a ? esc(a.label) : '<span class="muted">—</span>'}</td><td class="muted">${esc(p.note || '')}</td><td class="r num good">${money(p.amount_usd)}</td></tr>`; }).join('')}
      </tbody></table></div></div></details>` : ''}`;
  }

  function graduates() {
    const sp = [...(d.sponsorships || [])].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'));
    const n = sp.filter((p) => p.status === 'pending').length;
    return `<div class="grouphead">Graduates to fund <span class="sub">${n ? n + ' waiting · ' : ''}Buy the account in the trader’s own name, then mark it bought</span></div>
      <div class="group">${sp.slice(0, 15).map((p) => `<div class="item"><div class="body"><b>${esc(p.name || 'Trader')}</b><span>Graduated ${ukTime(p.created_at)} UK${p.fee_usd != null ? ' · fee ' + money(p.fee_usd) : ''}${p.note ? ' · ' + esc(p.note) : ''}</span></div>
        <div class="trail">${p.status === 'pending' ? `${cap('Waiting', 'orange')}<button class="btn sm primary" data-act="bought" data-id="${esc(p.id)}">Mark bought</button>` : cap(p.status === 'purchased' ? 'Bought' : p.status, p.status === 'purchased' ? 'green' : '')}</div></div>`).join('') || '<div class="empty">No graduates yet.</div>'}</div>`;
  }

  function ladder() {
    const rec = d.recommendation, la = d.ladder_accounts || [];
    const ongoing = new Map((d.ongoing_copy?.connections || []).filter((c) => c.connected !== false).map((c) => [c.account_id, c]));
    const recHead = rec ? (rec.action === 'buy' ? `Buy ${rec.accounts || 1} evaluation${rec.accounts > 1 ? 's' : ''}` : rec.action === 'stop' ? 'Stop buying evaluations' : 'Hold: don’t buy yet') : '';
    const statusCls = (s) => (s === 'funded' ? 'green' : s === 'evaluation' ? 'blue' : s === 'failed' || s === 'breached' ? 'red' : '');
    return `<div class="grouphead">Evaluation ladder <span class="sub">Prop-firm accounts IPFX has bought</span><button class="btn sm tinted" data-act="add">Add account</button></div>
      ${rec ? `<div class="banner ${rec.action === 'buy' ? 'blue' : rec.action === 'stop' ? 'red' : ''}"><div><b>${esc(recHead)}</b> · ${esc(rec.reason)}<br><span class="muted" style="font-size:12px">Budget ${money(rec.budget_usd)} · ${ukTime(rec.as_of)} UK · nothing is bought automatically</span></div></div>` : ''}
      <div class="tablewrap"><div class="scroll"><table><thead><tr><th>Account</th><th>Type</th><th class="r">Size</th><th class="r">Fee</th><th>Status</th><th>Copying</th></tr></thead><tbody>
      ${la.map((a) => {
        const oc = ongoing.get(a.id);
        const copy = oc ? `<a class="btn sm link" href="/workspace/books.html">A-book ${oc.execution_on ? 'on' : 'off'} · Books</a>`
          : a.role === 'monitor' ? '<span class="muted">Read-only</span>'
          : `<button class="switch" role="switch" aria-checked="${!!a.execution_enabled}" aria-label="Copying to ${esc(a.label)}" data-act="copy" data-id="${esc(a.id)}"></button>`;
        return `<tr><td><b>${esc(a.label)}</b> <span class="muted">#${esc(a.id)}</span></td><td>${esc(ROLE[a.role] || 'Prop account')}${a.api_env === 'live' ? ' · live' : ''}</td><td class="r num">${money(a.size_usd)}</td><td class="r num">${money(a.fee_usd)}</td><td>${cap(String(a.status || '—').replace(/^./, (c) => c.toUpperCase()), statusCls(a.status))}</td><td>${copy}</td></tr>`;
      }).join('') || '<tr><td colspan="6" class="muted">No accounts yet. Add an evaluation you’ve bought, or the E8 monitor.</td></tr>'}
      </tbody></table></div></div>`;
  }

  function bookRisk() {
    const set = d.settings || {}, halted = !!set.book_halt, open = d.open_risk || {};
    const pnl = Object.fromEntries((d.day_pnl || []).map((r) => [r.book, Number(r.pnl_usd) || 0]));
    const states = d.book_states || {}, events = d.events || [];
    return `<div class="grouphead">Book risk <span class="sub">Recorded ledger for today (UTC), not broker-reconciled</span></div>
      <div class="group">
        <div class="item"><div class="body"><b>New book risk</b><span>${halted ? 'Halted: no new A-book or B-book positions are taken' : 'Allowed, within the daily limits below'}</span></div>
          <div class="trail">${cap(halted ? 'Halted' : 'Running', halted ? 'red' : 'green')}<button class="switch" role="switch" aria-checked="${!halted}" aria-label="Allow new book risk" data-act="halt"></button></div></div>
        ${(d.limits || []).map((l) => `<div class="item"><div class="body"><b>${l.book === 'a' ? 'A-book' : 'B-book'}</b><span>Daily loss stop ${money(l.daily_loss_stop_usd)} · profit cap ${money(l.daily_profit_cap_usd)}</span></div>
          <div class="trail"><div style="text-align:right"><div class="num">${money(open[l.book] || 0)}</div><div class="muted" style="font-size:11.5px">open risk</div></div>
          <div style="text-align:right;min-width:84px"><div class="num ${(pnl[l.book] || 0) < 0 ? 'bad' : ''}">${money(pnl[l.book] || 0)}</div><div class="muted" style="font-size:11.5px">closed today</div></div></div></div>`).join('')}
      </div>
      <details class="more"><summary>Trader book states · ${events.length} recent move${events.length === 1 ? '' : 's'}</summary>
        <div class="stats" style="margin-top:8px">${Object.keys(STATE).map((k) => `<div class="stat"><div class="k">${STATE[k]}</div><div class="v num">${esc(states[k] || 0)}</div></div>`).join('')}</div>
        <div class="tablewrap"><div class="scroll"><table><thead><tr><th>When (UK)</th><th>From</th><th>To</th><th>Why</th></tr></thead><tbody>
        ${events.map((e) => `<tr><td class="num muted">${ukTime(e.created_at)}</td><td>${esc(STATE[e.from_state] || e.from_state)}</td><td>${esc(STATE[e.to_state] || e.to_state)}</td><td class="muted">${esc(e.reason)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No moves yet.</td></tr>'}
        </tbody></table></div></div></details>`;
  }

  function largest() {
    const f = d.forecasts || [];
    return `<div class="grouphead">Largest expected payouts <span class="sub">Top ${f.length} open accounts by expected payout</span></div>
      <div class="tablewrap"><div class="scroll"><table><thead><tr><th>Trader</th><th>Stage</th><th class="r">Chance of payout</th><th class="r">Expected days</th><th class="r">Payout if reached</th><th class="r">Skill estimate</th></tr></thead><tbody>
      ${f.map((x) => `<tr><td><b>${esc(x.name || 'Trader')}</b></td><td class="muted">Stage ${esc(x.stage)}</td><td class="r num">${pct(x.p_graduate)}</td><td class="r num muted">${Number(x.expected_days).toFixed(0)}</td><td class="r num">${money(x.payout_if_graduate)}</td>
        <td class="r num ${Number(x.mu_mean) > 0 ? 'good' : 'muted'}">${Number(x.mu_mean) >= 0 ? '+' : ''}${Number(x.mu_mean).toFixed(3)}R <span class="muted" style="font-size:11px">${esc(x.trades)} trades</span></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No open accounts.</td></tr>'}
      </tbody></table></div></div>
      <p class="foot">Setup checks and the paper validation journal are on the <a href="/team-treasury.html">classic Treasury page</a> until Settings is rebuilt.</p>`;
  }

  function render() {
    if (!d) return;
    $('treasury').innerHTML = cover() + forecast() + cash() + graduates() + ladder() + bookRisk() + largest();
  }

  // ---- actions (sheets disable themselves while saving) ----
  async function reserve() {
    const v = await T.sheet({ title: 'Starting cash reserve', text: 'The cash you’ve set aside to pay traders. Cover is measured against it.',
      fields: [{ id: 'usd', label: 'Reserve (USD)', type: 'number', min: 0, step: 100, value: d.settings?.starting_reserve_usd ?? '' }], confirm: 'Save',
      onSubmit: (x) => T.ladder('set_reserve', { usd: Number(x.usd) }) });
    if (v) { T.toast('Reserve saved. Cover updates with the next hourly forecast.'); await load(); }
  }
  async function payout() {
    const accounts = (d.ladder_accounts || []).filter((a) => a.role !== 'shadow');
    const v = await T.sheet({ title: 'Record a payout received', text: 'Money a prop firm has paid IPFX. It counts as cash from the next forecast.',
      fields: [{ id: 'amount', label: 'Amount received (USD)', type: 'number', min: 1, step: 0.01 },
        { id: 'from', label: 'From account', options: [{ value: '', label: 'Not linked to an account' }, ...accounts.map((a) => ({ value: a.id, label: `${a.label} #${a.id}` }))], value: '' },
        { id: 'note', label: 'Note (optional)', optional: true }], confirm: 'Record payout',
      onSubmit: (x) => T.ladder('payout_add', { amount_usd: Number(x.amount), ladder_account_id: x.from ? Number(x.from) : null, note: String(x.note || '').trim() || null }) });
    if (v) { T.toast('Payout recorded.'); await load(); }
  }
  async function bought(id) {
    const p = (d.sponsorships || []).find((x) => String(x.id) === String(id)); if (!p) return;
    const v = await T.sheet({ title: 'Mark funded account bought?', text: `For <b>${esc(p.name || 'this trader')}</b>, bought in their own name.`,
      fields: [{ id: 'fee', label: 'Fee paid (USD)', type: 'number', min: 0, step: 0.01, value: d.settings?.sponsor_fee_usd ?? '' }, { id: 'note', label: 'Order reference (optional)', optional: true }],
      confirm: 'Mark bought', onSubmit: (x) => T.ladder('sponsorship_decide', { id: p.id, status: 'purchased', fee_usd: Number(x.fee), note: String(x.note || '').trim() || null }) });
    if (v) { T.toast('Marked as bought.'); await load(); }
  }
  async function addAccount() {
    let role = 'ladder';
    const v = await T.sheet({ title: 'Add a TradeLocker account', text: 'Your password is exchanged once for encrypted tokens and isn’t saved. Copying starts <b>off</b>. Create demo copy accounts in hedging mode.',
      fields: [
        { id: 'role', label: 'What is this account?', options: [{ value: 'ladder', label: 'Prop account (receives A-book copies)' }, { value: 'shadow', label: 'Demo copy account (every trader)' }, { value: 'monitor', label: 'E8 funded account (read-only monitor)' }], value: 'ladder' },
        { id: 'label', label: 'Name', placeholder: 'E8 50k #1' },
        { id: 'size', label: 'Account size (USD)', type: 'number', min: 1000, step: 1000, value: '50000' },
        { id: 'fee', label: 'Fee paid (USD)', type: 'number', min: 0, step: 1, value: '300' },
        { id: 'email', label: 'Broker email', type: 'email' }, { id: 'password', label: 'Broker password', type: 'password' },
        { id: 'server', label: 'Server' }, { id: 'account', label: 'Account number (if several)', optional: true },
        { id: 'all', label: 'Accounts on this login', options: [{ value: '', label: 'Only this one' }, { value: '1', label: 'All of them (demo copy only)' }], value: '' },
      ], confirm: 'Add account',
      onSubmit: (x) => { role = x.role; return T.ladder('ladder_add', { role: x.role, label: String(x.label).trim(), size_usd: Number(x.size), fee_usd: Number(x.fee), signal_group: 0,
        email: String(x.email).trim(), password: x.password, server: String(x.server).trim(), account_id: String(x.account || '').trim(), all: x.all === '1' }, 45000); } });
    if (v) { T.toast(v.added > 1 ? `${v.added} demo accounts added with copying off.` : role === 'monitor' ? 'E8 monitor saved. Start sampling in Costs & E8.' : 'Account saved with copying off.'); await load(); }
  }
  async function copy(id) {
    const a = (d.ladder_accounts || []).find((x) => String(x.id) === String(id)); if (!a) return;
    if (a.execution_enabled) { document.querySelector(`[data-act="copy"][data-id="${a.id}"]`)?.setAttribute('aria-checked', 'false'); return run(() => T.ladder('ladder_update', { id: a.id, execution_enabled: false }), 'Copying to ' + a.label + ' stopped.'); }
    const v = await T.sheet({ title: `Start copying to ${esc(a.label)}?`, text: 'New A-book trades will be sent to this account. Check its documented capacity first. Each order still passes the broker and risk checks.',
      confirm: 'Start copying', onSubmit: () => T.ladder('ladder_update', { id: a.id, execution_enabled: true }) });
    if (v) { T.toast('Copying started.'); await load(); }
  }
  async function halt() {
    const on = !d.settings?.book_halt;
    const v = await T.sheet({ title: on ? 'Halt all new book risk?' : 'Resume new book risk?', text: on ? 'No new A-book or B-book positions will be taken. Open positions stay tracked.' : 'New positions are taken again, within the daily limits.',
      confirm: on ? 'Halt' : 'Resume', danger: on, onSubmit: () => T.ladder('halt', { on }) });
    if (v) { T.toast(on ? 'New book risk halted.' : 'New book risk resumed.'); await load(); }
  }
  async function run(fn, ok) {
    if (busy) return; busy = true;
    try { await fn(); T.toast(ok); } catch (e) { T.toast(e.message, true); } finally { busy = false; await load(); }
  }

  async function load() {
    try {
      d = await T.ladder('overview'); render();
      T.status('Updated ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      T.status(e.message);
      if (!d) $('treasury').innerHTML = `<div class="banner red">${esc(e.message)}<button class="btn sm" data-act="refresh">Try again</button></div>`;
      else T.toast('Couldn’t refresh. Figures shown may be out of date.', true);
    }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled || (!d && b.dataset.act !== 'refresh')) return;
    ({ reserve, payout, add: addAccount, halt, refresh: load, bought: () => bought(b.dataset.id), copy: () => copy(b.dataset.id) })[b.dataset.act]?.();
  });
  T.mount({ page: 'treasury', title: 'Treasury' });
  $('refreshBtn').addEventListener('click', load);
  load();
  setInterval(() => { if (!busy && !document.hidden && !document.querySelector('.os-scrim')) load(); }, 60000);
})();
