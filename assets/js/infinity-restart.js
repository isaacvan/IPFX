// Restart Infinity Challenge: a compact topbar button next to CHALLENGE / DEMO and a two-step dialog
// (what a restart does -> the Infinity v2 rules, which must be agreed). Shown only when the server says
// Infinity v2 is live (infinity_status.v2_enabled), or in preview with ?v2preview=1 (preview never restarts anything).
(function () {
  'use strict';
  const PREVIEW = (() => { try { return new URLSearchParams(location.search).has('v2preview') || localStorage.getItem('ipfx-v2-preview') === '1'; } catch (_) { return false; } })();
  const RULES_URL = 'https://ipfxcapital.com/infinity.html#v2-rules';
  const TERMS_VERSION = 'infinity_v2_2026-11';
  let status = null, statusAt = 0, busy = false, step = 1;

  const css = `
.tb-restart{height:28px;display:inline-flex;align-items:center;gap:6px;padding:0 6px 0 9px;margin-left:8px;border:1px solid rgba(37,99,235,.45);border-radius:7px;background:rgba(37,99,235,.12);color:#9dbbff;font:700 10px var(--font-ui);letter-spacing:.04em;cursor:pointer;flex-shrink:0;transition:background .15s,border-color .15s,color .15s}
.tb-restart:hover{background:rgba(37,99,235,.22);border-color:rgba(59,130,246,.75);color:#fff}
.tb-restart:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}
.tb-restart svg{width:12px;height:12px;flex-shrink:0}
.tb-restart .cnt{min-width:16px;height:16px;padding:0 5px;border-radius:999px;background:var(--cobalt);color:#fff;font:800 9px var(--font-ui);display:inline-flex;align-items:center;justify-content:center}
.tb-restart.none .cnt{background:#3a3a40;color:#a0a0a0}
body.light .tb-restart{background:rgba(37,99,235,.08);color:#1d4ed8}
.rs-dlg{position:fixed;inset:0;margin:auto;height:fit-content;border:1px solid var(--line);border-radius:14px;padding:0;width:min(470px,94vw);max-height:90vh;background:#131316;color:var(--fg);box-shadow:0 28px 90px rgba(0,0,0,.7);font-family:var(--font-ui);overflow:hidden}
.rs-dlg[open]{display:flex;flex-direction:column}
.rs-dlg::backdrop{background:rgba(0,0,0,.62);backdrop-filter:blur(4px)}
body.light .rs-dlg{background:#fff}
.rs-hd{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 12px;border-bottom:1px solid var(--line)}
.rs-ic{width:34px;height:34px;border-radius:9px;background:rgba(37,99,235,.16);color:#60a5fa;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.rs-ic svg{width:17px;height:17px}
.rs-tt{flex:1;min-width:0}
.rs-tt h2{margin:0;font-size:15px;font-weight:800;letter-spacing:-.01em}
.rs-tt p{margin:3px 0 0;font-size:11.5px;color:var(--muted);line-height:1.45}
.rs-x{background:none;border:0;color:var(--muted2);width:28px;height:28px;border-radius:7px;cursor:pointer;font-size:18px;line-height:1;flex-shrink:0}
.rs-x:hover{color:var(--fg);background:rgba(255,255,255,.06)}
.rs-steps{display:flex;gap:6px;padding:10px 18px 0}
.rs-steps i{height:3px;flex:1;border-radius:2px;background:var(--line)}
.rs-steps i.on{background:var(--cobalt)}
.rs-bd{padding:14px 18px;overflow-y:auto;font-size:12.5px;line-height:1.5}
.rs-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:rgba(37,99,235,.14);color:#93c5fd;font-weight:700;font-size:11.5px;margin-bottom:12px}
.rs-chip.none{background:rgba(245,158,11,.14);color:#fbbf24}
.rs-list{list-style:none;margin:0;padding:0;display:grid;gap:9px}
.rs-list li{display:flex;gap:10px;align-items:flex-start}
.rs-list li b{font-weight:700}
.rs-dot{width:18px;height:18px;border-radius:50%;background:rgba(37,99,235,.16);color:#60a5fa;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:10px;font-weight:800;margin-top:1px}
.rs-warn{margin-top:12px;padding:9px 11px;border-radius:9px;border:1px solid rgba(245,158,11,.35);background:rgba(245,158,11,.08);color:#fcd34d;font-size:12px}
.rs-tbl{width:100%;border-collapse:collapse;font-size:11.5px;font-variant-numeric:tabular-nums;margin:2px 0 12px}
.rs-tbl th,.rs-tbl td{padding:6px 6px;border-bottom:1px solid var(--line2);text-align:center}
.rs-tbl th{color:var(--muted);font-weight:700;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em}
.rs-tbl td:first-child,.rs-tbl th:first-child{text-align:left;color:var(--muted)}
.rs-sub{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--muted2);margin:2px 0 7px}
.rs-rules{margin:0;padding:0;list-style:none;display:grid;gap:6px}
.rs-rules li{position:relative;padding-left:14px}
.rs-rules li:before{content:"";position:absolute;left:2px;top:7px;width:5px;height:5px;border-radius:50%;background:#3b82f6}
.rs-link{color:#60a5fa;text-decoration:none;font-weight:600}
.rs-link:hover{text-decoration:underline}
.rs-agree{display:flex;gap:10px;align-items:flex-start;margin-top:13px;padding:10px 11px;border:1px solid var(--line);border-radius:9px;cursor:pointer;user-select:none}
.rs-agree input{width:16px;height:16px;margin:1px 0 0;accent-color:#2563eb;flex-shrink:0;cursor:pointer}
.rs-agree:has(input:checked){border-color:rgba(37,99,235,.6);background:rgba(37,99,235,.08)}
.rs-ft{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px 14px;border-top:1px solid var(--line)}
.rs-btn{height:32px;padding:0 14px;border-radius:8px;font:700 12px var(--font-ui);cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--fg)}
.rs-btn:hover{background:rgba(255,255,255,.05)}
.rs-btn.pri{background:var(--cobalt);border-color:var(--cobalt);color:#fff;box-shadow:0 0 14px rgba(37,99,235,.3)}
.rs-btn.pri:hover{background:var(--cobalt-h)}
.rs-btn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
.rs-btn:focus-visible,.rs-x:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}
.rs-done{text-align:center;padding:10px 0 4px}
.rs-done .ok{width:44px;height:44px;border-radius:50%;background:rgba(16,185,129,.15);color:#34d399;display:flex;align-items:center;justify-content:center;margin:0 auto 10px}
.rs-done h3{margin:0 0 4px;font-size:15px}
.rs-done p{margin:0;color:var(--muted)}
.rs-err{margin-top:10px;color:#fca5a5;font-size:12px;min-height:0}
body.light .rs-x:hover,body.light .rs-btn:hover{background:rgba(0,0,0,.05)}
body.light .rs-chip{background:rgba(37,99,235,.1);color:#1d4ed8}
body.light .rs-chip.none{background:rgba(245,158,11,.12);color:#92400e}
body.light .rs-dot,body.light .rs-ic{color:#2563eb}
body.light .rs-warn{color:#92400e}
body.light .rs-link{color:#1d4ed8}`;
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>';

  function el(tag, attrs, html) { const e = document.createElement(tag); Object.assign(e, attrs || {}); if (html != null) e.innerHTML = html; return e; }
  function nextMonthLabel() { const n = new Date(); const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1)); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }); }
  function openTrades() { try { return (typeof selectedAccountMode !== 'undefined' && selectedAccountMode === 'challenge' && engineState && Array.isArray(engineState.open_trades)) ? engineState.open_trades.length : 0; } catch (_) { return 0; } }
  function signedIn() { try { return typeof hasSession === 'function' && hasSession(); } catch (_) { return false; } }
  function isLive() { return !!(status && status.v2_enabled === true); }

  async function call(body) {
    const tok = await freshToken();
    if (!tok) throw new Error('Your session expired. Sign in again.');
    const r = await fetch(ENGINE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false, status: r.status, j };
  }
  async function loadStatus(force) {
    if (!signedIn()) return null;
    if (!force && status && Date.now() - statusAt < 300000) return status;
    try { const r = await call({ action: 'infinity_status' }); if (r.ok && r.j.infinity) { status = r.j.infinity; statusAt = Date.now(); } } catch (_) {}
    return status;
  }

  function renderButton() {
    const b = document.getElementById('tbRestart'); if (!b) return;
    const challenge = typeof selectedAccountMode === 'undefined' || selectedAccountMode === 'challenge';
    const hasInfinity = !!(status && (status.is_restart || status.has_active)) || !!(engineState && engineState.account && engineState.account.challenge_type === 'infinity');
    b.hidden = !(signedIn() && (isLive() || PREVIEW) && challenge && hasInfinity);
    const left = status ? Number(status.attempts_left || 0) : (PREVIEW ? 1 : 0);
    b.querySelector('.cnt').textContent = String(left);
    b.classList.toggle('none', left < 1);
    b.title = left > 0 ? `${left} restart${left === 1 ? '' : 's'} left this month` : `No restarts left this month. Next on ${nextMonthLabel()}`;
  }

  function stepsBar() { return `<div class="rs-steps" aria-hidden="true"><i class="${step >= 1 ? 'on' : ''}"></i><i class="${step >= 2 ? 'on' : ''}"></i></div>`; }
  function header(title, sub) {
    return `<div class="rs-hd"><div class="rs-ic">${ICON}</div><div class="rs-tt"><h2 id="rsTitle">${title}</h2><p>${sub}</p></div>
      <button class="rs-x" type="button" aria-label="Close" data-rs="close">&times;</button></div>`;
  }

  function viewInfo() {
    const left = status ? Number(status.attempts_left || 0) : (PREVIEW ? 1 : 0), cap = status ? Number(status.attempts_cap || 1) : 1;
    const open = openTrades();
    const reason = status && status.reason && !/active challenge/i.test(status.reason) ? status.reason : null;
    const can = left > 0 && open === 0 && !reason;
    return `${header('Restart Infinity Challenge', 'Start again from Stage 1 with a clean account.')}${stepsBar()}
      <div class="rs-bd">
        <div class="rs-chip ${left > 0 ? '' : 'none'}">${left > 0 ? `${left} of ${cap} restart${cap === 1 ? '' : 's'} left this month` : `No restarts left this month · next on ${nextMonthLabel()}`}</div>
        <ul class="rs-list">
          <li><span class="rs-dot">1</span><span><b>You start from zero.</b> A new $1,000 Stage 1 account with a fresh balance and limits.</span></li>
          <li><span class="rs-dot">2</span><span><b>Your current run ends.</b> It is archived and its progress does not carry over.</span></li>
          <li><span class="rs-dot">3</span><span><b>Your new run is on Infinity v2.</b> You'll see the new requirements next.</span></li>
          <li><span class="rs-dot">4</span><span><b>One restart a month.</b> Restarts reset on the 1st of each month.</span></li>
        </ul>
        ${open > 0 ? `<div class="rs-warn">Close your ${open} open trade${open === 1 ? '' : 's'} first, then restart.</div>` : ''}
        ${reason ? `<div class="rs-warn">${String(reason).replace(/</g, '&lt;')}</div>` : ''}
      </div>
      <div class="rs-ft"><button class="rs-btn" type="button" data-rs="close">Cancel</button>
        <button class="rs-btn pri" type="button" data-rs="next" ${can ? '' : 'disabled'}>Continue</button></div>`;
  }

  function viewRules() {
    return `${header('Infinity v2 challenge rules', 'Your new run will use these requirements.')}${stepsBar()}
      <div class="rs-bd">
        <table class="rs-tbl" aria-label="Infinity v2 stage requirements">
          <thead><tr><th></th><th>Stage 1</th><th>Stage 2</th><th>Stage 3</th><th>Stage 4</th></tr></thead>
          <tbody>
            <tr><td>Account</td><td>$1,000</td><td>$5,000</td><td>$10,000</td><td>$25,000</td></tr>
            <tr><td>Profit target</td><td>4%</td><td>7%</td><td>8%</td><td>—</td></tr>
            <tr><td>Counted trades</td><td>20</td><td>40</td><td>50</td><td>—</td></tr>
            <tr><td>Consistency score</td><td>0.75</td><td>1.25</td><td>2.0</td><td>—</td></tr>
            <tr><td>Daily loss / max DD</td><td>2.5% / 5%</td><td>2% / 4%</td><td>2% / 4%</td><td>2% / 4%</td></tr>
          </tbody>
        </table>
        <div class="rs-sub">Key rules</div>
        <ul class="rs-rules">
          <li>No minimum trading days. Pass on your results.</li>
          <li>Stop loss on every trade, at least 8× the spread. Tighten it or move to break-even, never further away.</li>
          <li>Hold at least 5 minutes for profit to count. Losses always count.</li>
          <li>After a stop-out, that instrument pauses for 10 minutes.</li>
          <li>Trades on the same instrument and direction within 15 minutes count as one trade.</li>
          <li>No daily profit cap, and daily loss is measured from your closed balance.</li>
        </ul>
        <p style="margin:10px 0 0"><a class="rs-link" href="${RULES_URL}" target="_blank" rel="noopener noreferrer">Read the full rules and FAQ</a></p>
        <label class="rs-agree"><input type="checkbox" id="rsAgree"><span>I have read and agree to the <b>Infinity v2</b> rules and the updated Terms.</span></label>
        <div class="rs-err" id="rsErr" role="alert"></div>
      </div>
      <div class="rs-ft"><button class="rs-btn" type="button" data-rs="back">Back</button>
        <button class="rs-btn pri" type="button" data-rs="go" id="rsGo" disabled>Agree and restart</button></div>`;
  }

  function viewDone(preview) {
    return `${header('Restart Infinity Challenge', preview ? 'Preview only: nothing was changed.' : 'Your new run is ready.')}
      <div class="rs-bd"><div class="rs-done"><div class="ok"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
        <h3>${preview ? 'Preview complete' : 'You\'re restarted'}</h3>
        <p>${preview ? 'In the live version this creates a new Stage 1 account on Infinity v2.' : 'Stage 1 · $1,000 · Infinity v2. Good trading!'}</p></div></div>
      <div class="rs-ft"><button class="rs-btn pri" type="button" data-rs="finish">${preview ? 'Close' : 'Start trading'}</button></div>`;
  }

  function render() {
    const d = document.getElementById('rsDialog');
    d.innerHTML = step === 1 ? viewInfo() : step === 2 ? viewRules() : viewDone(step === 4);
    const agree = d.querySelector('#rsAgree');
    if (agree) agree.addEventListener('change', () => { d.querySelector('#rsGo').disabled = !agree.checked; });
    const focus = d.querySelector(step === 2 ? '#rsAgree' : '.rs-btn.pri:not([disabled])') || d.querySelector('.rs-x');
    if (focus) focus.focus();
  }

  async function open() {
    const d = document.getElementById('rsDialog'); if (!d) return;
    step = 1; await loadStatus(true); render();
    if (!d.open) d.showModal();
  }
  function close() { const d = document.getElementById('rsDialog'); if (d && d.open) d.close(); }

  async function restart() {
    if (busy) return;
    const d = document.getElementById('rsDialog'); const go = d.querySelector('#rsGo'); const err = d.querySelector('#rsErr');
    if (!d.querySelector('#rsAgree')?.checked) return;
    if (PREVIEW && !isLive()) { step = 4; render(); return; }            // preview never touches an account
    busy = true; go.disabled = true; go.textContent = 'Restarting…'; err.textContent = '';
    try {
      let r = await call({ action: 'restart_infinity', rules_version: 'infinity_v2', accept_terms: true, terms_version: TERMS_VERSION, confirm_age: true });
      if (!r.ok && r.status === 400 && /unknown action/i.test(String(r.j.error || ''))) {
        // Server without the new action yet: only a run that has already ended can use the existing restart.
        if (status && status.has_active) throw new Error('Restarting an active run is not available yet. Please try again shortly.');
        r = await call({ action: 'claim_infinity', confirm_age: true });
      }
      if (!r.ok) throw new Error(r.j.error || 'The restart could not be completed. Nothing was changed.');
      status = null; step = 3; render();
      try { if (typeof selectedAccountMode !== 'undefined') { selectedAccountMode = 'challenge'; localStorage.setItem('ipfx-account-mode', 'challenge'); } } catch (_) {}
      try { if (typeof engineCall === 'function') await engineCall({ action: 'state' }); } catch (_) {}
      loadStatus(true).then(renderButton);
    } catch (e) {
      err.textContent = (e && e.message) || 'The restart could not be completed. Nothing was changed.';
      go.disabled = false; go.textContent = 'Agree and restart';
    } finally { busy = false; }
  }

  function mount() {
    if (document.getElementById('tbRestart')) return;
    const style = el('style'); style.textContent = css; document.head.appendChild(style);
    const mode = document.querySelector('.acct-mode'); if (!mode) return;
    const btn = el('button', { id: 'tbRestart', type: 'button', className: 'tb-restart', hidden: true },
      `${ICON}<span>RESTART CHALLENGE</span><span class="cnt">0</span>`);
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('click', open);
    mode.insertAdjacentElement('afterend', btn);
    const dlg = el('dialog', { id: 'rsDialog', className: 'rs-dlg' }); dlg.setAttribute('aria-labelledby', 'rsTitle');
    dlg.addEventListener('click', (ev) => {
      const a = ev.target.closest('[data-rs]'); if (!a) return;
      const k = a.dataset.rs;
      if (k === 'close' || k === 'finish') close();
      else if (k === 'next') { step = 2; render(); }
      else if (k === 'back') { step = 1; render(); }
      else if (k === 'go') restart();
    });
    document.body.appendChild(dlg);
    loadStatus(true).then(renderButton);
    setInterval(renderButton, 2000);
    setInterval(() => loadStatus(false).then(renderButton), 60000);
  }
  window.ipfxRestart = { open, refresh: () => loadStatus(true).then(renderButton) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
