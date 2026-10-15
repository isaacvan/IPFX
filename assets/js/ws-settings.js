/* Settings: the switches and checks that apply to the whole firm. Trading on/off for everyone, whether every
   background job is running, the launch checklist, promo codes and the audit trail of recent team changes.
   Reads admin-console, brain-monitor (`pulse`, the light health read) and ladder-admin (`overview` readiness). */
(() => {
  'use strict';
  const T = window.TeamOS, { esc, ukTime } = T;
  const $ = (id) => document.getElementById(id);
  let ov = null, pulse = null, ladder = null, promos = null, audit = null, errs = {};
  const cap = (txt, cls) => `<span class="cap ${cls || ''}">${esc(txt)}</span>`;
  const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; if (!Number.isFinite(s)) return 'never'; return s < 90 ? Math.max(0, Math.round(s)) + 's ago' : s < 5400 ? Math.round(s / 60) + 'm ago' : s < 129600 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
  const WORKER = { 'ab-classifier': 'Classifier', 'brain-scan': 'Alert scan', hub: 'Live prices and position watcher', 'cost-monitor': 'Cost monitor', 'trade-lows': 'Trade low tracking', 'infinity-quote-risk': 'Infinity drawdown checks', 'infinity-freeze-fallback': 'Breach bookkeeping' };
  // Old-page links in the readiness checks point at their new home in the workspace.
  const HREF = { 'team-e8-monitor.html': '/workspace/costs.html', 'team-e8-monitor.html#settings': '/workspace/costs.html', '#accountSetup': '/workspace/treasury.html', '#ladderRows': '/workspace/treasury.html', '#reserveForm': '/workspace/treasury.html', 'team-brain.html': '/team-brain.html', 'signup.html': '/signup.html' };
  const fail = (k) => (errs[k] ? `<div class="banner red">${esc(errs[k])}<button class="btn sm" data-act="refresh">Try again</button></div>` : '');

  function tradingSection() {
    const p = ov?.platform || {}, halted = !!p.trading_halted;
    return `<div class="grouphead" style="margin-top:0">Trading</div>${fail('ov')}
      <div class="group"><div class="item"><div class="body"><b>Trading for all traders</b><span>${ov ? (halted ? 'Paused: nobody can open new positions' + (p.halted_reason ? ' · ' + esc(p.halted_reason) : '') : 'Running: traders can open new positions') : 'Loading…'}</span></div>
        <div class="trail">${ov ? cap(halted ? 'Paused' : 'Running', halted ? 'red' : 'green') : ''}<button class="switch" role="switch" aria-checked="${!halted}" aria-label="Trading for all traders" data-act="halt"${ov ? '' : ' disabled'}></button></div></div></div>
      <p class="foot">Open positions keep their stops and targets while trading is paused. Only the owner can resume.</p>`;
  }

  function healthSection() {
    const h = pulse?.health;
    if (!h) return `<div class="grouphead">Is everything running?</div>${fail('pulse') || '<div class="empty">Loading…</div>'}`;
    const rows = [];
    for (const j of h.jobs || []) rows.push([j.ok, j.title, j.age_s == null ? 'no run found' : 'ran ' + ago(new Date(Date.now() - j.age_s * 1000).toISOString())]);
    for (const b of h.heartbeats || []) {
      const ok = b.ok && Date.now() - Date.parse(b.at) < (['trade-lows', 'infinity-quote-risk'].includes(b.worker) ? 60000 : 300000);
      const extra = b.worker === 'hub' && b.detail ? ` · ${esc(b.detail.authed ?? 0)} traders connected · ${esc(b.detail.risk?.trades ?? 0)} positions watched` : !b.ok && b.detail?.error ? ' · ' + esc(b.detail.error) : '';
      rows.push([ok, esc(WORKER[b.worker] || b.worker) + extra, ago(b.at), true]);
    }
    const pAge = h.prices_at ? (Date.now() - Date.parse(h.prices_at)) / 1000 : null;
    rows.push([!h.market_open || (pAge != null && pAge < 120), 'Live prices · market ' + (h.market_open ? 'open' : 'closed'), h.prices_at ? 'newest ' + ago(h.prices_at) : 'never', true]);
    const bad = rows.filter((r) => !r[0]).length;
    return `<div class="grouphead">Is everything running? <span class="sub">${bad ? bad + (bad === 1 ? ' needs' : ' need') + ' attention' : 'All running'}</span></div>
      <div class="group">${rows.sort((a, b) => Number(a[0]) - Number(b[0])).map(([ok, title, when, html]) => `<div class="item"><div class="leadicon ${ok ? 'ic-green' : 'ic-red'}"><svg viewBox="0 0 24 24">${ok ? '<path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' : '<path d="M12 7v6M12 17h.01" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'}</svg></div>
        <div class="body"><b>${html ? title : esc(title)}</b><span>${esc(when)}</span></div><div class="trail">${cap(ok ? 'OK' : 'Check', ok ? 'green' : 'red')}</div></div>`).join('')}</div>`;
  }

  function checklistSection() {
    const r = ladder?.readiness;
    if (!r) return `<div class="grouphead">Launch checklist</div>${fail('ladder') || '<div class="empty">Loading…</div>'}`;
    const ST = { checked: ['Done', 'green'], action: ['Action needed', 'orange'], unknown: ['Unavailable', ''] };
    const todo = (r.checks || []).filter((c) => c.state !== 'checked').length;
    return `<div class="grouphead">Launch checklist <span class="sub">${todo ? todo + ' to do' : 'Everything checked'} · ${ukTime(r.as_of)} UK${r.diagnostics_complete ? '' : ' · some checks unavailable'}</span></div>
      <div class="group">${(r.checks || []).map((c) => { const s = ST[c.state] || ST.unknown, href = HREF[c.href];
        return `<div class="item"><div class="body"><b>${esc(c.title)}</b><span>${esc(c.detail)}</span></div><div class="trail">${cap(s[0], s[1])}${href && c.state !== 'checked' ? `<a class="btn sm" href="${esc(href)}">Open</a>` : ''}</div></div>`; }).join('') || '<div class="empty">No checks reported.</div>'}</div>
      <p class="foot">These read your setup. They don’t switch anything on, and a full checklist isn’t a launch approval.</p>`;
  }

  function promoSection() {
    const list = promos || [];
    return `<div class="grouphead">Promo codes <span class="sub">Free Traditional challenges</span><button class="btn sm tinted" data-act="promo-new">New code</button></div>${fail('promos')}
      <div class="group">${list.slice(0, 30).map((p) => `<div class="item"><div class="body"><b class="num">${esc(p.code)}</b><span>${esc(p.challenge_name || p.challenge_type)} · used ${esc(p.use_count ?? 0)}${p.max_uses != null ? ' of ' + esc(p.max_uses) : ''} · created ${ukTime(p.created_at)}</span></div>
        <div class="trail"><button class="switch" role="switch" aria-checked="${!!p.is_active}" aria-label="${esc(p.code)} active" data-act="promo-toggle" data-code="${esc(p.code)}"></button></div></div>`).join('') || (promos ? '<div class="empty">No promo codes yet.</div>' : '<div class="empty">Loading…</div>')}</div>`;
  }

  function auditSection() {
    const rows = audit || [];
    const detail = (d) => { if (!d || typeof d !== 'object') return ''; return Object.entries(d).filter(([k]) => !/password|token|secret|ciphertext/i.test(k)).slice(0, 4).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60)}`).join(' · '); };
    return `<details class="more"><summary>Recent team changes · ${rows.length}</summary>${fail('audit')}
      <div class="tablewrap"><div class="scroll"><table><thead><tr><th>When (UK)</th><th>Change</th><th>Details</th></tr></thead><tbody>
      ${rows.map((e) => `<tr><td class="num muted">${ukTime(e.created_at)}</td><td><b>${esc(String(e.action || '').replace(/_/g, ' '))}</b></td><td class="muted" style="white-space:normal;min-width:260px">${esc(detail(e.detail))}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No changes recorded.</td></tr>'}
      </tbody></table></div></div></details>`;
  }

  function moreSection() {
    const link = (href, title, sub) => `<a class="item" href="${href}" style="text-decoration:none;color:inherit"><div class="body"><b>${title}</b><span>${sub}</span></div><div class="trail"><span class="muted">›</span></div></a>`;
    return `<div class="grouphead">More settings</div><div class="group">
      ${link('/admin.html', 'Risk policy, challenge presets and chatbot', 'In Operations')}
      ${link('/team-treasury.html#validationPanel', 'Paper validation journal', 'Classic Treasury page')}
      ${link('/team-brain.html', 'Brain: alerts and per-trader model', 'Classic Brain page')}</div>`;
  }

  function render() {
    $('settings').innerHTML = tradingSection() + healthSection() + checklistSection() + promoSection() + moreSection() + auditSection();
  }

  // ---- actions ----
  async function halt() {
    const halting = !ov?.platform?.trading_halted;
    const v = await T.sheet(halting
      ? { title: 'Pause trading for everyone?', text: 'Nobody can open new positions until you resume. Open positions keep their stops and targets.', fields: [{ id: 'reason', label: 'Reason (shown to the team)' }], confirm: 'Pause trading', danger: true,
          onSubmit: (x) => T.admin('set_platform_halt', { halted: true, reason: String(x.reason).trim() }) }
      : { title: 'Resume trading?', text: 'Traders can open new positions again.', confirm: 'Resume', onSubmit: () => T.admin('set_platform_halt', { halted: false }) });
    if (v) { T.toast(halting ? 'Trading paused.' : 'Trading resumed.'); await load(); }
  }
  async function promoNew() {
    const v = await T.sheet({ title: 'New promo code', text: 'Gives a free Traditional challenge of the chosen size.',
      fields: [{ id: 'code', label: 'Code', placeholder: 'LAUNCH25' }, { id: 'size', label: 'Challenge size', placeholder: '25k', hint: 'Must match a Traditional challenge, e.g. 10k, 25k, 50k' }, { id: 'max', label: 'Maximum uses (optional)', type: 'number', min: 1, step: 1, optional: true }],
      confirm: 'Create', onSubmit: (x) => T.admin('promo_create', { code: String(x.code).trim().toUpperCase(), size: String(x.size).trim().toLowerCase(), max_uses: x.max === '' ? null : Number(x.max) }) });
    if (v) { T.toast('Promo code created.'); await loadPromos(); render(); }
  }
  async function promoToggle(code, el) {
    const p = (promos || []).find((x) => x.code === code); if (!p) return;
    el?.setAttribute('aria-checked', String(!p.is_active));
    try { await T.admin('promo_set_active', { code, active: !p.is_active }); T.toast(code + (p.is_active ? ' turned off.' : ' turned on.')); } catch (e) { T.toast(e.message, true); }
    await loadPromos(); render();
  }

  async function grab(key, fn) { try { const r = await fn(); delete errs[key]; return r; } catch (e) { errs[key] = e.message; return undefined; } }
  async function loadPromos() { const r = await grab('promos', () => T.admin('promo_list')); if (r) promos = r.promos || []; }
  async function load() {
    const [o, p, l, a] = await Promise.all([grab('ov', () => T.admin('overview')), grab('pulse', () => T.brain('pulse')), grab('ladder', () => T.ladder('overview')), grab('audit', () => T.admin('audit_log', { page_size: 30 })), loadPromos()]);
    if (o) ov = o; if (p) pulse = p; if (l) ladder = l; if (a) audit = a.entries || [];
    render();
    T.status(Object.keys(errs).length ? 'Some sections couldn’t load' : 'Updated ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    ({ halt, refresh: load, 'promo-new': promoNew, 'promo-toggle': () => promoToggle(b.dataset.code, b) })[b.dataset.act]?.();
  });
  T.mount({ page: 'settings', title: 'Settings' });
  $('refreshBtn').addEventListener('click', load);
  load();
  setInterval(() => { if (!document.hidden && !document.querySelector('.os-scrim')) load(); }, 60000);
})();
