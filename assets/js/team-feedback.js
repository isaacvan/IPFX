/* Team Feedback inbox. Reads/triages website feedback via admin-console (admin + team sign-in).
   Submissions are private; this page never shows them publicly and never trades or pays. */
(() => {
  'use strict';
  const SB_URL = 'https://agulweemteoeagscmppy.supabase.co';
  const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndWx3ZWVtdGVvZWFnc2NtcHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MzU0ODIsImV4cCI6MjA4MTQxMTQ4Mn0.I70jN5DCuCn8OtISqvTRzuzGFaYd2pV8vviEED6gFlQ';
  const sb = window.supabase.createClient(SB_URL, SB_ANON);
  const FN = SB_URL + '/functions/v1/admin-console';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const CAT = { bug: '🐞 Bug', complaint: '⚠️ Complaint', suggestion: '💡 Suggestion', question: '❓ Question', praise: '⭐ Praise', other: '✉️ Other' };

  async function call(action, extra = {}) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { location.replace('team-login.html?next=' + encodeURIComponent('/team-feedback.html')); throw new Error('Sign in again'); }
    const r = await fetch(FN, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify({ action, ...extra }) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }

  async function load() {
    const status = $('fbFilter').value;
    $('status').textContent = 'Loading…';
    let j;
    try { j = await call('feedback_list', { status: status || undefined, page_size: 100 }); }
    catch (e) { $('status').textContent = String(e.message || e); return; }
    if (j.is_admin === false) {
      $('status').textContent = 'Access denied — owner or admin sign-in required.';
      $('fbRows').innerHTML = '<tr><td colspan="6" class="empty">You do not have access to the feedback inbox.</td></tr>';
      return;
    }
    const c = j.counts || {};
    $('fbCounts').innerHTML = `<div class="tile"><span>New</span><strong>${c.new || 0}</strong></div>`
      + `<div class="tile"><span>In progress</span><strong>${c.in_progress || 0}</strong></div>`
      + `<div class="tile"><span>Resolved</span><strong>${c.resolved || 0}</strong></div>`
      + `<div class="tile"><span>Dismissed</span><strong>${c.dismissed || 0}</strong></div>`;
    const rows = j.entries || [];
    $('status').textContent = rows.length ? `${rows.length} shown` : 'No feedback in this view';
    if (!rows.length) { $('fbRows').innerHTML = '<tr><td colspan="6" class="empty">Nothing here.</td></tr>'; return; }
    $('fbRows').innerHTML = rows.map((f) => `<tr>
      <td>${esc(CAT[f.category] || f.category)}</td>
      <td>${esc(f.name || '—')}<br><a href="mailto:${esc(f.email)}">${esc(f.email)}</a></td>
      <td style="max-width:440px;white-space:normal">${esc(f.message)}${f.admin_note ? `<div class="small">note: ${esc(f.admin_note)}</div>` : ''}</td>
      <td class="small">${esc(f.page || '—')}<br>${esc(new Date(f.created_at).toLocaleString('en-GB'))}</td>
      <td>${esc((f.status || '').replace('_', ' '))}</td>
      <td>${f.status !== 'in_progress' ? `<button class="button" data-id="${esc(f.id)}" data-st="in_progress">In progress</button> ` : ''}${f.status !== 'resolved' ? `<button class="button primary" data-id="${esc(f.id)}" data-st="resolved">Resolve</button> ` : ''}${f.status !== 'dismissed' ? `<button class="button" data-id="${esc(f.id)}" data-st="dismissed">Dismiss</button>` : ''}</td></tr>`).join('');
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    const st = b.dataset.st;
    let note;
    if (st === 'resolved' || st === 'dismissed') { const n = prompt('Optional internal note (leave blank to skip):', ''); if (n === null) return; note = n || undefined; }
    b.disabled = true;
    try { await call('feedback_update', { id: b.dataset.id, status: st, note }); }
    catch (err) { alert(String(err.message || err)); b.disabled = false; return; }
    load();
  });

  window.addEventListener('DOMContentLoaded', () => {
    $('refresh').addEventListener('click', load);
    $('fbFilter').addEventListener('change', load);
    load();
  });
})();
