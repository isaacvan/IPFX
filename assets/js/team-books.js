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
  const state = { rows: [], loaded: false, registeredUsers: null, noAccount: 0, accountCounts: {} };
  let loading = false;

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
  async function callBook(action, extra = {}) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error('Sign in to Team again');
    const response = await fetch(SB_URL + '/functions/v1/team-book-connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ action, book: mode, ...extra }), cache: 'no-store',
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) throw new Error(body?.error || 'TradeLocker connection unavailable');
    return body;
  }
  async function callPopulation(session) {
    const response = await fetch(SB_URL + '/functions/v1/team-population', {
      method: 'GET', headers: { Authorization: 'Bearer ' + session.access_token }, cache: 'no-store',
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) throw new Error(body?.error || 'Population unavailable');
    return body;
  }
  async function loadDestination() {
    try {
      const result = await callBook('status');
      const dest = result.destination;
      $('bookDestinationStatus').textContent = result.connected
        ? `CONNECTED FOR REVIEW · ${dest.account_name} · ${dest.server} · account #${dest.account_id} · no orders armed`
        : 'No separate TradeLocker destination connected. No orders armed.';
    } catch (error) { $('bookDestinationStatus').textContent = error.message; }
  }
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
      $('kpis').innerHTML = `<div class="tile"><span>Registered users</span><strong>${state.registeredUsers ?? '—'}</strong></div><div class="tile"><span>All trading accounts</span><strong>${state.accountCounts.all ?? '—'}</strong></div><div class="tile"><span>Explicit A assignments</span><strong>${assigned.length}</strong></div><div class="tile"><span>Review candidates</span><strong>${rows.filter((row) => route(row) === 'B' && (probability(row) ?? -1) >= 90).length}</strong></div>`;
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
    $('kpis').innerHTML = `<div class="tile"><span>Registered users</span><strong>${state.registeredUsers ?? '—'}</strong></div><div class="tile"><span>Trading accounts in B review</span><strong>${selected.length}</strong></div><div class="tile"><span>Demo / challenge</span><strong>${state.accountCounts.demo ?? '—'} / ${state.accountCounts.challenge ?? '—'}</strong></div><div class="tile"><span>Registered, no account</span><strong>${state.registeredUsers == null ? '—' : state.noAccount}</strong></div><div class="tile"><span>Accounts with reverse closes</span><strong>${selected.filter((row) => Number(row.reverse_demo_actual?.trades) > 0).length}</strong></div>`;
  };
  async function load() {
    if (loading) return;
    loading = true;
    $('status').textContent = 'Loading owner-only trader data…';
    $('refresh').disabled = true;
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { location.replace('team-login.html?next=' + encodeURIComponent('/team-' + mode + '-book.html')); return; }
      const response = await fetch(SB_URL + '/functions/v1/admin-console', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify({ action: 'risk_analytics' }), cache: 'no-store' });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.error || 'Owner and MFA verification required');
      state.rows = Array.isArray(body.rows) ? body.rows : [];
      let populationUnavailable = false;
      try {
        const population = await callPopulation(session);
        state.registeredUsers = population.registered_users_count;
        state.noAccount = population.registered_without_account.length;
        state.accountCounts = population.account_counts;
        if (mode === 'b') {
          const present = new Set(state.rows.map((row) => String(row.account_id)));
          for (const account of population.demo_accounts || []) {
            if (!account?.id || present.has(String(account.id))) continue;
            state.rows.push({ account_id: account.id, user_id: account.user_id,
              full_name: account.full_name, email: account.email, label: account.label || 'Demo account',
              challenge_type: 'Demo', profile: { trades_closed: 0 }, phase: 'demo' });
            present.add(String(account.id));
          }
        }
      } catch (_) {
        populationUnavailable = true;
        state.registeredUsers = null;
        state.noAccount = 0;
        state.accountCounts = {};
      }
      state.loaded = true;
      $('status').textContent = 'Owner-only · MFA protected · updated ' + new Date(body.calculated_at || Date.now()).toLocaleString('en-GB') + (populationUnavailable ? ' · registration counts unavailable' : '');
      render();
    } catch (error) {
      $('status').textContent = 'Could not load protected data';
      $('traders').innerHTML = '<div class="notice error">' + escapeHtml(error.message) + '</div>';
      if ($('daily')) $('daily').innerHTML = '<tr><td colspan="5" class="empty">No result loaded.</td></tr>';
    } finally { $('refresh').disabled = false; loading = false; }
  }
  $('refresh').addEventListener('click', load);
  $('search').addEventListener('input', render);
  $('bookLogin').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('bookConnect');
    button.disabled = true;
    $('bookDestinationStatus').textContent = 'Validating the broker demo account…';
    try {
      const result = await callBook('connect', { environment: 'demo', email: $('bookEmail').value.trim(),
        password: $('bookPassword').value, server: $('bookServer').value.trim(), account_id: $('bookAccount').value.trim() });
      $('bookDestinationStatus').textContent = `${result.account_name} connected for review · ${result.instrument_count} instruments · no trades armed`;
    } catch (error) { $('bookDestinationStatus').textContent = error.message; }
    finally { $('bookPassword').value = ''; button.disabled = false; }
  });
  $('bookDisconnect').addEventListener('click', async () => {
    if (!window.confirm('Disconnect this separate book destination?')) return;
    $('bookDisconnect').disabled = true;
    try { await callBook('disconnect'); $('bookDestinationStatus').textContent = 'Destination disconnected. No orders armed.'; }
    catch (error) { $('bookDestinationStatus').textContent = error.message; }
    finally { $('bookDisconnect').disabled = false; }
  });
  load();
  loadDestination();
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
})();
