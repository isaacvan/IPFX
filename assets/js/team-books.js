/* Owner-only read view. This file never submits a broker order or changes a route. */
(() => {
  'use strict';
  const SB_URL = 'https://agulweemteoeagscmppy.supabase.co';
  const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndWx3ZWVtdGVvZWFnc2NtcHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MzU0ODIsImV4cCI6MjA4MTQxMTQ4Mn0.I70jN5DCuCn8OtISqvTRzuzGFaYd2pV8vviEED6gFlQ';
  const sb = window.supabase.createClient(SB_URL, SB_ANON);
  const mode = document.body.dataset.book;
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '—').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const usd = (value) => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const state = { rows: [], loaded: false };

  // A route has to be an explicit server-side assignment. The trader detector's
  // probability and a same-direction demo mirror are not A-book assignments.
  const route = (row) => {
    const value = row.book_route;
    if (!value || value.approved !== true) return 'B';
    if (value.state === 'A' || value.state === 'SPLIT') return value.state;
    return 'B';
  };
  const probability = (row) => {
    const assessment = row.assessment;
    const n = Number(assessment?.profitability_probability);
    const t = new Date(assessment?.as_of_at || 0).getTime();
    if (assessment?.profitability_probability == null || !Number.isFinite(n) || !Number.isFinite(t) || Date.now() - t > 86400000 || t > Date.now()) return null;
    return Math.max(0, Math.min(100, n * 100));
  };
  const filtered = (rows) => {
    const q = $('search').value.trim().toLowerCase();
    return rows.filter((row) => [row.full_name, row.email, row.account_id, row.label].join(' ').toLowerCase().includes(q));
  };
  const card = (row, label) => {
    const p = row.profile || {};
    const prob = probability(row);
    const actual = row.reverse_demo_actual;
    const demo = actual?.available && Number(actual.trades) > 0 && finite(actual.total) ? usd(actual.total) : 'No verified closes';
    return `<article class="card"><h3>${escapeHtml(row.full_name)}</h3><div class="meta">${escapeHtml(row.email)} · ${escapeHtml(row.label || row.challenge_type)}<br>Account ${escapeHtml(row.account_id)}</div><span class="pill">${escapeHtml(label)}</span><div class="metrics"><div><span class="label">Closed trades</span><b>${Number(p.trades_closed) || 0}</b></div><div><span class="label">Profitability estimate</span><b>${prob == null ? 'Not calibrated' : prob.toFixed(1) + '%'}</b></div>${mode === 'b' ? `<div><span class="label">Reverse demo net</span><b>${demo}</b></div><div><span class="label">Trade direction</span><b>Opposite, if enabled</b></div>` : `<div><span class="label">Route</span><b>${escapeHtml(route(row))}</b></div><div><span class="label">Funded destination</span><b>Not verified</b></div>`}</div></article>`;
  };
  const render = () => {
    if (!state.loaded) return;
    const rows = state.rows;
    const assigned = rows.filter((row) => route(row) === 'A' || route(row) === 'SPLIT');
    const selected = mode === 'b' ? rows.filter((row) => route(row) !== 'A') : assigned;
    const visible = filtered(selected);
    $('traders').innerHTML = visible.map((row) => card(row, mode === 'b' ? (route(row) === 'SPLIT' ? 'B side of split · no reverse order implied' : 'B-book observation · no reverse order implied') : 'Explicit ' + route(row) + ' assignment')).join('') || `<div class="empty">${mode === 'a' ? 'No explicit A-book assignments are recorded in the current Team data.' : 'No accounts match this search.'}</div>`;
    if (mode === 'a') {
      const candidates = filtered(rows.filter((row) => route(row) === 'B' && (probability(row) ?? -1) >= 90));
      $('candidates').innerHTML = candidates.map((row) => card(row, 'Research candidate only')).join('') || '<div class="empty">No calibrated 90%+ candidates in this view.</div>';
      $('kpis').innerHTML = `<div class="tile"><span>Explicit A assignments</span><strong>${assigned.length}</strong></div><div class="tile"><span>Review candidates</span><strong>${rows.filter((row) => route(row) === 'B' && (probability(row) ?? -1) >= 90).length}</strong></div><div class="tile"><span>Funded destination</span><strong style="font-size:17px">Not verified</strong></div><div class="tile"><span>Real-money orders from this page</span><strong>0</strong></div>`;
      return;
    }
    const daily = [];
    for (const row of selected) {
      const actual = row.reverse_demo_actual;
      if (!actual?.available) continue;
      for (const day of actual.days || []) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day.day)) || !finite(day.pnl)) continue;
        // A 20x funded illustration needs exact 0.01-lot fills and price-only
        // P&L; net demo P&L cannot simply be multiplied by twenty.
        const verifiedFixedSize = Number(day.executed_lots) === 0.01 && Number(day.closes) === 1 && finite(day.gross_price_pnl_usd);
        const illustration = verifiedFixedSize ? usd(Number(day.gross_price_pnl_usd) * 20) + ' gross, before funded costs' : 'Unavailable — fixed-size fills not verified';
        daily.push({ day: day.day, name: row.full_name, trades: Number(day.trades) || 0, pnl: Number(day.pnl), illustration });
      }
    }
    daily.sort((a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name));
    $('daily').innerHTML = daily.map((item) => `<tr><td>${escapeHtml(item.day)}</td><td>${escapeHtml(item.name)}</td><td>${item.trades}</td><td class="${item.pnl >= 0 ? 'positive' : 'negative'}">${usd(item.pnl)}</td><td>${escapeHtml(item.illustration)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No reconciled opposite-direction HeroFX demo closes are available. No hypothetical funded P&amp;L is asserted.</td></tr>';
    $('kpis').innerHTML = `<div class="tile"><span>B-book accounts</span><strong>${selected.length}</strong></div><div class="tile"><span>Accounts with broker closes</span><strong>${selected.filter((row) => Number(row.reverse_demo_actual?.trades) > 0).length}</strong></div><div class="tile"><span>Intended demo size</span><strong>0.01 lot</strong></div><div class="tile"><span>Hypothetical size</span><strong>0.20 lot</strong></div>`;
  };
  async function load() {
    $('status').textContent = 'Loading owner-only trader data…';
    $('refresh').disabled = true;
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { location.replace('team-login.html?next=' + encodeURIComponent('/team-' + mode + '-book.html')); return; }
      const response = await fetch(SB_URL + '/functions/v1/admin-console', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify({ action: 'risk_analytics' }), cache: 'no-store' });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.error || 'Owner and MFA verification required');
      state.rows = Array.isArray(body.rows) ? body.rows : [];
      state.loaded = true;
      $('status').textContent = 'Owner-only · MFA protected · updated ' + new Date(body.calculated_at || Date.now()).toLocaleString('en-GB');
      render();
    } catch (error) {
      $('status').textContent = 'Could not load protected data';
      $('traders').innerHTML = '<div class="notice error">' + escapeHtml(error.message) + '</div>';
      if ($('daily')) $('daily').innerHTML = '<tr><td colspan="5" class="empty">No result loaded.</td></tr>';
    } finally { $('refresh').disabled = false; }
  }
  $('refresh').addEventListener('click', load);
  $('search').addEventListener('input', render);
  load();
})();
