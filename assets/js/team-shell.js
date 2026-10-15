/* IPFX Team workspace shell: one sidebar, one sign-in, one way to call the owner functions.
   Pages call TeamOS.mount(...) then use TeamOS.admin / ladder / book / population.
   No broker requests happen in the browser; every action goes through the existing server functions. */
(() => {
  'use strict';
  const SB_URL = 'https://agulweemteoeagscmppy.supabase.co';
  const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndWx3ZWVtdGVvZWFnc2NtcHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MzU0ODIsImV4cCI6MjA4MTQxMTQ4Mn0.I70jN5DCuCn8OtISqvTRzuzGFaYd2pV8vviEED6gFlQ';
  const sb = window.supabase.createClient(SB_URL, SB_ANON);

  // Destinations. "classic" = not yet rebuilt; opens the current page.
  const PAGES = [
    { id: 'overview', label: 'Overview', href: '/workspace/', icon: '<path d="M4 13h7V4H4zM13 20h7v-9h-7zM4 20h7v-4H4zM13 4v5h7V4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' },
    { id: 'traders', label: 'Traders', href: '/workspace/traders.html', icon: '<circle cx="9" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5M16 5.2a2.8 2.8 0 0 1 0 5.6M18 14.4c1.9.5 2.9 2.2 2.9 4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' },
    { id: 'books', label: 'Books', href: '/workspace/books.html', icon: '<rect x="4" y="5" width="7" height="14" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13" y="5" width="7" height="14" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"/>' },
    { id: 'queues', label: 'Queues', href: '/workspace/queues.html', icon: '<path d="M4 7h16M4 12h16M4 17h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' },
    { id: 'treasury', label: 'Treasury', href: '/workspace/treasury.html', icon: '<path d="M12 3l9 5.5H3zM5 9v8M9.5 9v8M14.5 9v8M19 9v8M3 20h18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>' },
    { id: 'costs', label: 'Costs & E8', href: '/team-e8-monitor.html', classic: true, icon: '<path d="M4 18l5-5.5 3.5 2.5L20 7M15 7h5v5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' },
    { id: 'settings', label: 'Settings', href: '/team-brain.html', classic: true, icon: '<circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M5.2 18.8l2.1-2.1M16.7 7.3l2.1-2.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' },
  ];

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const usd = (v) => (Number(v) < 0 ? '−$' : '$') + Math.abs(Number(v) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ukTime = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'short', timeStyle: 'short' }).format(t) : '—'; };

  async function token() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { location.replace('/team-login.html?next=' + encodeURIComponent(location.pathname)); throw new Error('Sign in to Team again.'); }
    return session.access_token;
  }
  async function post(fn, body, timeout = 25000) {
    const r = await fetch(SB_URL + '/functions/v1/' + fn, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token() },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (r.status === 401) { location.replace('/team-login.html?next=' + encodeURIComponent(location.pathname)); throw new Error('Session expired.'); }
    if (!r.ok || !j || j.ok === false) throw new Error((j && (j.error || j.reason)) || 'Request could not be confirmed. Refresh before retrying.');
    return j;
  }
  const admin = (action, body = {}) => post('admin-console', { action, ...body });
  const ladder = (action, body = {}, timeout) => post('ladder-admin', { action, ...body }, timeout);
  const book = (action, body = {}, mode = 'b') => post('team-book-connect', { action, book: mode, ...body });
  async function population() {
    const r = await fetch(SB_URL + '/functions/v1/team-population', { headers: { Authorization: 'Bearer ' + await token() }, cache: 'no-store' });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) throw new Error(j?.error || 'Trader list unavailable');
    return j;
  }

  function toast(text, bad = false) {
    const el = document.createElement('div');
    el.className = 'os-toast' + (bad ? ' bad' : ''); el.setAttribute('role', 'status'); el.textContent = text;
    document.body.appendChild(el); setTimeout(() => el.remove(), bad ? 4200 : 2200);
  }

  // A modal sheet. fields: [{id,label,type,value,min,max,step,options,hint}]. onSubmit(values) may throw to show an error.
  function sheet({ title, text = '', fields = [], confirm = 'Confirm', danger = false, info = false, onSubmit }) {
    return new Promise((resolve) => {
      const scrim = document.createElement('div'); scrim.className = 'os-scrim';
      scrim.innerHTML = `<form class="os-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}
        ${fields.map((f) => `<label class="field"><span>${esc(f.label)}</span>${f.options
          ? `<select class="input" name="${f.id}">${f.options.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(f.value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
          : `<input class="input num" name="${f.id}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}${f.step != null ? ` step="${f.step}"` : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}${f.type === 'password' ? ' autocomplete="new-password"' : ' autocomplete="off"'}${f.optional ? '' : ' required'}>`}
          ${f.hint ? `<small class="muted">${esc(f.hint)}</small>` : ''}</label>`).join('')}
        <div class="err" aria-live="polite"></div>
        <div class="actions">${info ? '' : '<button type="button" class="btn" data-cancel>Cancel</button>'}<button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(confirm)}</button></div></form>`;
      const form = scrim.querySelector('form'), err = scrim.querySelector('.err');
      const close = (v) => { scrim.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      scrim.addEventListener('click', (e) => { if (e.target === scrim || e.target.closest('[data-cancel]')) close(null); });
      form.addEventListener('submit', async (e) => {
        e.preventDefault(); if (form.dataset.busy) return; form.dataset.busy = '1';
        const values = Object.fromEntries(new FormData(form).entries());
        const btns = [...form.querySelectorAll('button')]; btns.forEach((b) => b.disabled = true); err.textContent = '';
        try { const out = onSubmit ? await onSubmit(values) : values; close(out ?? values); }
        catch (x) { err.textContent = x.message || String(x); btns.forEach((b) => b.disabled = false); delete form.dataset.busy; }
      });
      document.body.appendChild(scrim);
      (form.querySelector('input,select') || form.querySelector('[type=submit]')).focus();
    });
  }

  function mount({ page, title }) {
    document.title = title + ' · IPFX Team';
    const side = document.getElementById('osSide');
    side.innerHTML = `<div class="os-brand"><div class="os-logo">IP</div><div><b>IPFX Team</b><small id="osWho">Signing in…</small></div></div>
      <div class="os-label">Workspace</div>
      ${PAGES.map((p) => `<a class="os-nav" href="${p.href}"${p.id === page ? ' aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${p.icon}</svg>${p.label}${p.classic ? '<span class="classic">current view</span>' : ''}<span class="badge" data-badge="${p.id}" hidden></span></a>`).join('')}
      <div class="os-foot"><button type="button" id="osSignOut">Sign out</button></div>`;
    document.getElementById('osTitle').textContent = title;
    document.getElementById('osSignOut').addEventListener('click', async () => { await sb.auth.signOut(); location.replace('/team-login.html'); });
    sb.auth.getSession().then(({ data: { session } }) => {
      if (!session) { location.replace('/team-login.html?next=' + encodeURIComponent(location.pathname)); return; }
      document.getElementById('osWho').textContent = session.user?.email || 'Signed in';
    });
  }
  function badge(id, n) {
    const el = document.querySelector(`[data-badge="${id}"]`);
    if (el) { el.textContent = n; el.hidden = !(n > 0); }
  }
  function status(text) { const el = document.getElementById('osStatus'); if (el) el.textContent = text; }

  window.TeamOS = { sb, admin, ladder, book, population, mount, badge, status, toast, sheet, esc, usd, ukTime };
})();
