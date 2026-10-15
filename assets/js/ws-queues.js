/* Queues: everything waiting on a decision, in one inbox — applications, identity checks, payouts,
   feedback and trade flags. Same admin-console actions as the Operations page; identity documents and
   full personal details are still opened one at a time, owner + MFA, and every view is logged server-side. */
(() => {
  'use strict';
  const T = window.TeamOS, { esc, usd, ukTime } = T;
  const $ = (id) => document.getElementById(id);
  const TABS = [
    { id: 'applications', label: 'Applications' }, { id: 'kyc', label: 'Identity checks' }, { id: 'payouts', label: 'Payouts' },
    { id: 'feedback', label: 'Feedback' }, { id: 'flags', label: 'Trade flags' },
  ];
  const DOC = { id_front: 'ID front', id_back: 'ID back', proof_of_address: 'Proof of address', selfie: 'Selfie', passport: 'Passport' };
  const FB = { bug: 'Bug', complaint: 'Complaint', suggestion: 'Suggestion', question: 'Question', praise: 'Praise', other: 'Other' };
  const FLAG = { REQUIRED_STOP_MISSING: 'Stop-loss missing', ACCOUNT_STOP_RISK_LIMIT: 'Risk over the account limit', DRAWDOWN_SWING: 'Large drawdown swing', CAP_HUGGING: 'Trading right at the limit' };
  let tab = 'applications', appStatus = 'pending', appPage = 0, fbStatus = 'new', flagStatus = 'open';
  const counts = {}; let data = {}, overview = null, busy = false;

  const tabFromHash = () => { const h = location.hash.slice(1); if (TABS.some((t) => t.id === h)) tab = h; };
  const name = (row) => {
    const i = row.identity || {};
    return esc([i.legal_first_name, i.legal_last_name].filter(Boolean).join(' ') || row.full_name || row.email || 'Unknown');
  };
  const who = (i) => i ? `Age ${esc(i.age ?? '—')} · ${esc([i.city, i.country_code].filter(Boolean).join(', ') || '—')} · ${esc(i.phone_hint || 'no phone')}` : 'Profile incomplete';
  const docs = (list) => (list || []).map((d) => `<button class="btn sm" type="button" data-act="doc" data-id="${esc(d.id)}">${esc(DOC[d.doc_type] || d.doc_type)}</button>`).join('');
  const traderName = (userId) => { const t = (overview?.traders || []).find((x) => x.user_id === userId); return esc(t?.full_name || t?.email || String(userId).slice(0, 8)); };

  async function act(fn, ok) {
    if (busy) return; busy = true;
    try { await fn(); if (ok) T.toast(ok); await load(); }
    catch (e) { T.toast(e.message, true); }
    finally { busy = false; }
  }

  // ---- renderers ----
  function applications() {
    const r = data.applications; if (!r) return '<div class="empty">Loading…</div>';
    const seg = `<div class="row" style="margin-bottom:12px"><div class="seg">${['pending', 'approved', 'denied'].map((s) => `<button type="button" data-app-status="${s}" aria-pressed="${s === appStatus}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
      <span class="muted" style="font-size:12.5px">${r.total == null ? '' : esc(r.total) + ' ' + esc(appStatus)}</span>
      <span style="margin-left:auto" class="row"><button class="btn sm" type="button" data-act="appPrev"${appPage ? '' : ' disabled'}>Previous</button><button class="btn sm" type="button" data-act="appNext"${r.has_more ? '' : ' disabled'}>Next</button></span></div>`;
    if (!r.applications.length) return seg + `<div class="group"><div class="empty">No ${esc(appStatus)} applications.</div></div>`;
    return seg + `<div class="group">${r.applications.map((a) => {
      const det = a.application_details || {}, kyc = a.kyc?.status || 'unverified';
      return `<div class="item" style="align-items:flex-start"><div class="body">
          <b>${name(a)}</b><span>${esc(a.email || '')}</span>
          <span>${esc(a.preset?.label || a.challenge_type)} · submitted ${ukTime(a.created_at)}</span>
          <span>${who(a.identity)}${det.purpose ? ' · ' + esc(String(det.purpose).replace(/_/g, ' ')) : ''}${det.pep === true ? ' · <b class="bad">PEP</b>' : ''}</span>
          <div class="row" style="margin-top:8px">${docs(a.documents)}<button class="btn sm link" type="button" data-act="reveal" data-user="${esc(a.user_id)}">Show full details</button></div>
          ${a.decision_note ? `<span style="margin-top:6px">Note: ${esc(a.decision_note)}</span>` : ''}
        </div>
        <div class="trail" style="flex-direction:column;align-items:flex-end;gap:8px">
          <span class="cap ${kyc === 'verified' ? 'green' : kyc === 'rejected' ? 'red' : 'orange'}">ID ${esc(kyc)}</span>
          ${appStatus === 'pending' ? `<div class="row"><button class="btn sm primary" type="button" data-act="appYes" data-id="${esc(a.id)}">Approve</button><button class="btn sm" type="button" data-act="appNo" data-id="${esc(a.id)}">Deny</button></div>` : `<span class="cap ${a.status === 'approved' ? 'green' : 'red'}">${esc(a.status)}</span>`}
        </div></div>`;
    }).join('')}</div>`;
  }

  function kyc() {
    const q = data.kyc; if (!q) return '<div class="empty">Loading…</div>';
    if (!q.length) return '<div class="group"><div class="empty">Nobody is waiting for an identity check.</div></div>';
    return `<div class="group">${q.map((k) => `<div class="item" style="align-items:flex-start"><div class="body">
        <b>${name(k)}</b><span>${esc(k.email || '')} · submitted ${ukTime(k.submitted_at)}</span><span>${who(k.identity)}</span>
        <div class="row" style="margin-top:8px">${docs(k.documents) || '<span class="muted">No documents</span>'}<button class="btn sm link" type="button" data-act="reveal" data-user="${esc(k.user_id)}">Show full details</button></div></div>
      <div class="trail"><button class="btn sm primary" type="button" data-act="kycYes" data-user="${esc(k.user_id)}">Verify</button><button class="btn sm" type="button" data-act="kycNo" data-user="${esc(k.user_id)}">Reject</button></div></div>`).join('')}</div>
      <p class="foot">Documents open one at a time; each link lasts 60 seconds and every view is logged.</p>`;
  }

  function payouts() {
    const rows = (overview?.payouts || []).filter((p) => p.status === 'requested' || p.status === 'approved');
    if (!overview) return '<div class="empty">Loading…</div>';
    if (!rows.length) return '<div class="group"><div class="empty">No payouts waiting. Requests appear here until they are paid or voided.</div></div>';
    return `<div class="group">${rows.map((p) => `<div class="item"><div class="body">
        <b>${traderName(p.user_id)} · <span class="num">${usd(p.trader_share)}</span></b>
        <span>${esc(String(p.programme_event || 'Payout').replace(/_/g, ' ').toLowerCase())} · requested ${ukTime(p.created_at)} · gross ${usd(p.gross_profit)}</span>
        ${p.note ? `<span>${esc(p.note)}</span>` : ''}</div>
      <div class="trail"><span class="cap ${p.status === 'approved' ? 'blue' : 'orange'}">${p.status === 'approved' ? 'Approved · to pay' : 'Requested'}</span>
        ${p.status === 'requested' ? `<button class="btn sm primary" type="button" data-act="payApprove" data-id="${esc(p.id)}">Approve</button>` : `<button class="btn sm primary" type="button" data-act="payPaid" data-id="${esc(p.id)}">Mark paid</button>`}
        <button class="btn sm" type="button" data-act="payVoid" data-id="${esc(p.id)}">Void</button></div></div>`).join('')}</div>
      <p class="foot">Approving never sends money. Pay manually, then mark it paid with the transfer reference.</p>`;
  }

  function feedback() {
    const r = data.feedback; if (!r) return '<div class="empty">Loading…</div>';
    const seg = `<div class="row" style="margin-bottom:12px"><div class="seg">${[['new', 'New'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed']].map(([s, l]) => `<button type="button" data-fb-status="${s}" aria-pressed="${s === fbStatus}">${l}${r.counts?.[s] ? ' · ' + r.counts[s] : ''}</button>`).join('')}</div></div>`;
    if (!r.entries.length) return seg + '<div class="group"><div class="empty">Nothing here.</div></div>';
    return seg + `<div class="group">${r.entries.map((f) => `<div class="item" style="align-items:flex-start"><div class="body">
        <b>${esc(FB[f.category] || f.category)}</b><span style="color:var(--ink);white-space:pre-wrap">${esc(f.message)}</span>
        <span>${esc(f.name || '—')} · ${esc(f.email)} · ${esc(f.page || '—')} · ${ukTime(f.created_at)}</span>${f.admin_note ? `<span>Note: ${esc(f.admin_note)}</span>` : ''}</div>
      <div class="trail">${f.status !== 'in_progress' ? `<button class="btn sm" type="button" data-act="fb" data-st="in_progress" data-id="${esc(f.id)}">In progress</button>` : ''}${f.status !== 'resolved' ? `<button class="btn sm primary" type="button" data-act="fb" data-st="resolved" data-id="${esc(f.id)}">Resolve</button>` : ''}${f.status !== 'dismissed' ? `<button class="btn sm" type="button" data-act="fb" data-st="dismissed" data-id="${esc(f.id)}">Dismiss</button>` : ''}</div></div>`).join('')}</div>`;
  }

  function flags() {
    const r = data.flags; if (!r) return '<div class="empty">Loading…</div>';
    const seg = `<div class="row" style="margin-bottom:12px"><div class="seg">${[['open', 'Open'], ['reviewed', 'Reviewed'], ['dismissed', 'Dismissed']].map(([s, l]) => `<button type="button" data-flag-status="${s}" aria-pressed="${s === flagStatus}">${l}</button>`).join('')}</div></div>`;
    if (!r.flags.length) return seg + `<div class="group"><div class="empty">No ${esc(flagStatus)} trade flags.</div></div>`;
    return seg + `<div class="group">${r.flags.map((f) => {
      const ev = f.evidence || {}, detail = [ev.symbol, ev.volume != null ? ev.volume + ' lots' : null, ev.risk_usd != null ? usd(ev.risk_usd) + ' risk' : null].filter(Boolean).join(' · ');
      return `<div class="item"><div class="leadicon ic-red"><svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.3 4l-7 12a2 2 0 0 0 1.7 3h14a2 2 0 0 0 1.7-3l-7-12a2 2 0 0 0-3.4 0z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
        <div class="body"><b>${esc(FLAG[f.reason] || String(f.reason).replace(/_/g, ' ').toLowerCase())}</b><span>${esc(f.full_name || '—')}${detail ? ' · ' + esc(detail) : ''} · ${ukTime(f.created_at)}</span></div>
        <div class="trail">${f.status !== 'reviewed' ? `<button class="btn sm primary" type="button" data-act="flag" data-st="reviewed" data-id="${esc(f.id)}">Reviewed</button>` : ''}${f.status !== 'dismissed' ? `<button class="btn sm" type="button" data-act="flag" data-st="dismissed" data-id="${esc(f.id)}">Dismiss</button>` : ''}</div></div>`;
    }).join('')}</div>`;
  }

  function render() {
    const total = (counts.applications || 0) + (counts.kyc || 0) + (counts.payouts || 0) + (counts.feedback || 0) + (counts.flags || 0);
    T.badge('queues', total);
    $('tabs').innerHTML = TABS.map((t) => `<button type="button" role="tab" data-tab="${t.id}" aria-selected="${t.id === tab}">${t.label}${counts[t.id] ? `<span class="count">${counts[t.id]}</span>` : ''}</button>`).join('');
    $('panel').innerHTML = { applications, kyc, payouts, feedback, flags }[tab]();
  }

  // ---- data ----
  async function loadTab(which) {
    if (which === 'applications') { data.applications = await T.admin('application_queue', { status: appStatus, page: appPage }); if (appStatus === 'pending') counts.applications = data.applications.total ?? data.applications.applications.length; }
    if (which === 'kyc') { data.kyc = (await T.admin('kyc_queue')).queue || []; counts.kyc = data.kyc.length; }
    if (which === 'feedback') { data.feedback = await T.admin('feedback_list', { status: fbStatus, page_size: 100 }); counts.feedback = data.feedback.counts?.new ?? 0; }
    if (which === 'flags') { data.flags = await T.admin('trade_safety_review', { status: flagStatus, page_size: 100 }); if (flagStatus === 'open') counts.flags = data.flags.flags.length; }
  }
  async function load() {
    try {
      // Cheap counts first (no personal data); the open tab loads its full list.
      const [ov, fb, fl] = await Promise.all([
        T.admin('overview'),
        tab === 'feedback' ? null : T.admin('feedback_list', { status: 'new', page_size: 20 }).catch(() => null),
        tab === 'flags' ? null : T.admin('trade_safety_review', { status: 'open', page_size: 100 }).catch(() => null),
      ]);
      overview = ov;
      counts.payouts = (ov.payouts || []).filter((p) => p.status === 'requested' || p.status === 'approved').length;
      if (fb) counts.feedback = fb.counts?.new ?? 0;
      if (fl) counts.flags = fl.flags.length;
      if (tab !== 'payouts') await loadTab(tab);
      render();
      T.status('Updated ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) { T.status(e.message); $('panel').innerHTML = `<div class="banner red">${esc(e.message)}<button class="btn sm" type="button" data-act="retry">Try again</button></div>`; }
  }

  // ---- actions ----
  async function openDoc(id) {
    const w = window.open('about:blank', '_blank');
    if (!w) { T.toast('Allow pop-ups for this site to open documents.', true); return; }
    try { w.document.title = 'Secure document'; w.document.body.textContent = 'Opening secure document…'; } catch (_) { /* cross-origin later */ }
    try { const r = await T.admin('kyc_document_url', { document_id: id }); try { w.opener = null; } catch (_) {} w.location.replace(r.url); }
    catch (e) { try { w.close(); } catch (_) {} T.toast(e.message, true); }
  }
  async function reveal(userId) {
    try {
      const f = (await T.admin('kyc_identity_reveal', { user_id: userId })).identity;
      await T.sheet({ title: 'Full details', text: `<b>${esc([f.legal_first_name, f.legal_middle_names, f.legal_last_name].filter(Boolean).join(' '))}</b><br>Born ${esc(f.date_of_birth)} · ${esc(f.phone_e164)}<br>${esc([f.address_line_1, f.address_line_2, f.city, f.region, f.postal_code, f.country_code].filter(Boolean).join(', '))}<br>Nationality ${esc(f.nationality_code || '—')}<br><br><small>This view was logged. Close when done.</small>`, confirm: 'Done', info: true });
    } catch (e) { T.toast(e.message, true); }
  }

  document.addEventListener('click', async (e) => {
    const tb = e.target.closest('[data-tab]');
    if (tb) { tab = tb.dataset.tab; history.replaceState(null, '', '#' + tab); render(); if (tab !== 'payouts' && !data[tab]) { try { await loadTab(tab); render(); } catch (x) { T.toast(x.message, true); } } return; }
    const as = e.target.closest('[data-app-status]'); if (as) { appStatus = as.dataset.appStatus; appPage = 0; data.applications = null; render(); await loadTab('applications').catch((x) => T.toast(x.message, true)); render(); return; }
    const fs = e.target.closest('[data-fb-status]'); if (fs) { fbStatus = fs.dataset.fbStatus; data.feedback = null; render(); await loadTab('feedback').catch((x) => T.toast(x.message, true)); render(); return; }
    const flS = e.target.closest('[data-flag-status]'); if (flS) { flagStatus = flS.dataset.flagStatus; data.flags = null; render(); await loadTab('flags').catch((x) => T.toast(x.message, true)); render(); return; }
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const id = b.dataset.id, user = b.dataset.user;
    switch (b.dataset.act) {
      case 'retry': load(); break;
      case 'doc': openDoc(id); break;
      case 'reveal': reveal(user); break;
      case 'appPrev': appPage = Math.max(0, appPage - 1); data.applications = null; render(); await loadTab('applications').catch((x) => T.toast(x.message, true)); render(); break;
      case 'appNext': appPage++; data.applications = null; render(); await loadTab('applications').catch((x) => T.toast(x.message, true)); render(); break;
      case 'appYes': if (await T.sheet({ title: 'Approve this application?', text: 'The trader gets their Infinity account and can start trading.', confirm: 'Approve', onSubmit: () => T.admin('application_decide', { application_id: id, status: 'approved' }) })) { T.toast('Approved.'); data.applications = null; load(); } break;
      case 'appNo': if (await T.sheet({ title: 'Deny this application?', fields: [{ id: 'note', label: 'Reason (optional, kept on record)', optional: true }], confirm: 'Deny', danger: true, onSubmit: (v) => T.admin('application_decide', { application_id: id, status: 'denied', note: v.note || null }) })) { T.toast('Denied.'); data.applications = null; load(); } break;
      case 'kycYes': act(() => T.admin('set_kyc_status', { user_id: user, status: 'verified', note: null }), 'Identity verified.'); break;
      case 'kycNo': if (await T.sheet({ title: 'Reject identity check?', text: 'The trader is emailed this reason so they can fix it.', fields: [{ id: 'note', label: 'Reason shown to the trader', placeholder: 'e.g. The photo is blurry' }], confirm: 'Reject', danger: true, onSubmit: (v) => T.admin('set_kyc_status', { user_id: user, status: 'rejected', note: String(v.note).trim() }) })) { T.toast('Rejected — trader emailed.'); data.kyc = null; load(); } break;
      case 'payApprove': if (await T.sheet({ title: 'Approve this payout?', text: 'This does not send money. Check the trader, amount and identity first.', confirm: 'Approve', onSubmit: () => T.admin('payout_approve', { payout_id: id }) })) { T.toast('Approved for manual payment.'); load(); } break;
      case 'payPaid': if (await T.sheet({ title: 'Mark as paid', text: 'Only after the transfer has gone out.', fields: [{ id: 'ref', label: 'Transfer reference', placeholder: 'At least 4 characters' }], confirm: 'Mark paid', onSubmit: (v) => T.admin('payout_mark_paid', { payout_id: id, external_reference: String(v.ref).trim() }) })) { T.toast('Marked paid.'); load(); } break;
      case 'payVoid': if (await T.sheet({ title: 'Void this payout?', fields: [{ id: 'reason', label: 'Reason' }], confirm: 'Void', danger: true, onSubmit: (v) => T.admin('payout_void', { payout_id: id, reason: String(v.reason).trim() }) })) { T.toast('Payout voided.'); load(); } break;
      case 'fb': {
        const st = b.dataset.st; let note;
        if (st === 'resolved' || st === 'dismissed') { const v = await T.sheet({ title: st === 'resolved' ? 'Resolve feedback' : 'Dismiss feedback', fields: [{ id: 'note', label: 'Private note (optional)', optional: true }], confirm: st === 'resolved' ? 'Resolve' : 'Dismiss' }); if (!v) return; note = v.note || undefined; }
        data.feedback = null; act(() => T.admin('feedback_update', { id, status: st, note }), 'Feedback updated.'); break;
      }
      case 'flag': data.flags = null; act(() => T.admin('trade_safety_mark', { flag_id: id, status: b.dataset.st }), b.dataset.st === 'reviewed' ? 'Marked reviewed.' : 'Dismissed.'); break;
    }
  });

  T.mount({ page: 'queues', title: 'Queues' });
  tabFromHash();
  $('refreshBtn').addEventListener('click', () => { data = {}; load(); });
  load();
  setInterval(() => { if (!busy && !document.hidden && !document.querySelector('.os-scrim')) load(); }, 30000);
})();
