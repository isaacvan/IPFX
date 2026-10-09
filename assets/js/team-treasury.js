/* Owner-only Treasury page. Reads and records through ladder-admin (owner + MFA). Never trades or pays. */
(() => {
  'use strict';
  const SB_URL = 'https://agulweemteoeagscmppy.supabase.co';
  const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndWx3ZWVtdGVvZWFnc2NtcHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MzU0ODIsImV4cCI6MjA4MTQxMTQ4Mn0.I70jN5DCuCn8OtISqvTRzuzGFaYd2pV8vviEED6gFlQ';
  const sb = window.supabase.createClient(SB_URL, SB_ANON);
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const usd = (v) => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const pct = (v) => v == null ? '—' : (Number(v) * 100).toFixed(1) + '%';
  const when = (v) => v ? new Date(v).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const STATE_LABEL = { BB_DEMO: 'B-book demo', BB_LIVE: 'B-book live', AB_DEMO: 'A-book demo', AB_LIVE: 'A-book live', SUSPENDED: 'Suspended' };
  let last = null, busy = false;

  async function call(action, extra = {}) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { location.replace('team-login.html?next=' + encodeURIComponent('/team-treasury.html')); throw new Error('Sign in again'); }
    const r = await fetch(SB_URL + '/functions/v1/ladder-admin', { method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify({ action, ...extra }) });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body?.ok) throw new Error(body?.error || 'Owner and MFA verification required');
    return body;
  }

  function render(d) {
    const s = d.snapshot, set = d.settings || {};
    const statusText = { unknown: 'Unknown: check reserve / data', healthy: 'Healthy', tight: 'Tight', short: 'Short' }[s?.status || 'unknown'];
    $('kpis').innerHTML = [
      ['Payout cover', statusText], ['Expected payouts, 30 days', usd(s?.notes?.figures_unavailable ? null : s?.liab_30d)], ['Model estimate, 90 days', usd(s?.notes?.figures_unavailable ? null : s?.liab_90d_p90)], ['All graduates stress (not a forecast)', usd(s?.notes?.dependence_stress_usd)],
      ['Cash counted', usd(s?.assets_usd)], ['Payout model', set.payout_model === 'sponsored_account' ? 'Funded account at Stage 4' : 'Cash at Stage 3 (current Terms)'],
      ['New book risk', set.book_halt ? 'HALTED' : 'Allowed'],
    ].map(([k, v]) => `<div class="tile"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
    $('modelNote').textContent = s ? `Forecast at ${when(s.as_of)} for ${s.open_accounts} open Infinity accounts. ${s.complete ? 'Complete model inputs' : 'INCOMPLETE — check data before acting'}${s.notes?.source_error ? ' · '+s.notes.source_error : ''}. Cash is an unreconciled estimate from recorded reserve, receipts and fees. Demo profits are excluded. The 90-day model assumes independent outcomes; correlated trader risk can be much higher.` : 'No forecast yet (runs every hour).';
    $('horizons').innerHTML = s ? [['7 days', s.liab_7d, null, null], ['30 days', s.liab_30d, s.liab_30d_p90, s.graduates_30d], ['60 days', s.liab_60d, null, null], ['90 days', s.liab_90d, s.liab_90d_p90, s.graduates_90d]]
      .map(([h, e, p, g]) => `<tr><td>${h}</td><td>${usd(e)}</td><td>${p == null ? '—' : usd(p)}</td><td>${g == null ? '—' : Number(g).toFixed(1)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No forecast yet.</td></tr>';
    if (set.starting_reserve_usd != null && document.activeElement !== $('reserveUsd')) $('reserveUsd').value = set.starting_reserve_usd;

    const rec = d.recommendation;
    $('ladderRec').innerHTML = rec ? `<b>${esc(rec.action.toUpperCase())}${rec.accounts ? ' ' + rec.accounts + ' evaluation' + (rec.accounts > 1 ? 's' : '') : ''}</b> · ${esc(rec.reason)} · budget ${usd(rec.budget_usd)} · ${when(rec.as_of)}` : 'No recommendation yet (runs every hour).';
    const la = d.ladder_accounts || [];
    const ROLE = { ladder: 'Prop (A-book)', shadow: 'Demo copy', monitor: 'E8 monitor (read-only)' };
    $('ladderRows').innerHTML = la.length ? la.map((a) => `<tr><td>${esc(a.label)} #${esc(a.id)}</td><td>${esc(ROLE[a.role] || a.role || 'Prop (A-book)')}${a.api_env === 'live' ? ' · live' : ''}</td><td>${usd(a.size_usd)}</td><td>${usd(a.fee_usd)}</td><td>${esc(a.status)}</td><td>${esc(a.signal_group)}</td><td>${a.execution_enabled ? 'ON' : 'off'}</td>
      <td>${a.role === 'monitor' ? '<span class="small">Read-only</span>' : `<button class="button" data-capacity="${a.role==='shadow'?'s':'l'}${a.id}" type="button">Set verified capacity</button> <button class="button" data-la="${a.id}" data-on="${a.execution_enabled ? '0' : '1'}" type="button">${a.execution_enabled ? 'Stop copying' : 'Start copying'}</button>`}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">No accounts yet.</td></tr>';

    const st = d.book_states || {};
    $('bookStates').innerHTML = Object.keys(STATE_LABEL).map((k) => `<div class="tile"><span>${STATE_LABEL[k]}</span><strong>${st[k] || 0}</strong></div>`).join('');
    const pnl = Object.fromEntries((d.day_pnl || []).map((r) => [r.book, r.pnl_usd]));
    $('bookRows').innerHTML = (d.limits || []).map((l) => `<tr><td>${l.book === 'a' ? 'A-book (copy)' : 'B-book (reverse)'}</td><td>${usd((d.open_risk || {})[l.book] || 0)}</td><td>${usd(pnl[l.book] || 0)}</td><td>${usd(l.daily_loss_stop_usd)}</td><td>${usd(l.daily_profit_cap_usd)}</td></tr>`).join('');
    $('haltBtn').textContent = set.book_halt ? 'Resume new book risk' : 'Halt all new book risk';
    $('events').innerHTML = (d.events || []).length ? d.events.map((e) => `<tr><td>${when(e.created_at)}</td><td>${esc(STATE_LABEL[e.from_state] || e.from_state)}</td><td>${esc(STATE_LABEL[e.to_state] || e.to_state)}</td><td>${esc(e.reason)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No moves yet.</td></tr>';
    $('spons').innerHTML = (d.sponsorships || []).length ? d.sponsorships.map((p) => `<tr><td>${esc(p.name || p.user_id)}</td><td>${when(p.created_at)}</td><td>${esc(p.status)}</td><td>${p.status === 'pending' ? `<button class="button" data-sp="${p.id}" type="button">Mark bought</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No graduates yet.</td></tr>';
    $('forecasts').innerHTML = (d.forecasts || []).length ? d.forecasts.map((f) => `<tr><td>${esc(f.name || f.person_id)}</td><td>${esc(f.stage)}</td><td>${pct(f.p_graduate)}</td><td>${Number(f.expected_days).toFixed(0)}</td><td>${usd(f.payout_if_graduate)}</td><td>${Number(f.mu_mean) >= 0 ? '+' : ''}${Number(f.mu_mean).toFixed(3)}R (${f.trades} trades)</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No open accounts.</td></tr>';
  }

  async function load() {
    if (busy) return; busy = true; $('refresh').disabled = true; $('status').textContent = 'Loading…';
    try { last = await call('overview'); render(last); $('status').textContent = 'Owner-only · MFA protected · updated ' + new Date().toLocaleTimeString('en-GB'); }
    catch (e) { $('status').textContent = e.message; }
    finally { busy = false; $('refresh').disabled = false; }
  }
  async function act(action, extra, okMsg) {
    try { await call(action, extra); $('status').textContent = okMsg; await load(); } catch (e) { $('status').textContent = e.message; }
  }
  $('refresh').addEventListener('click', load);
  $('reserveForm').addEventListener('submit', (e) => { e.preventDefault(); act('set_reserve', { usd: Number($('reserveUsd').value) }, 'Reserve saved'); });
  $('payoutForm').addEventListener('submit', (e) => { e.preventDefault(); act('payout_add', { amount_usd: Number($('poAmount').value), ladder_account_id: $('poAccount').value ? Number($('poAccount').value) : null }, 'Payout recorded'); $('poAmount').value = ''; });
  $('haltBtn').addEventListener('click', () => act('halt', { on: !(last?.settings?.book_halt) }, 'Saved'));
  $('ladderAdd').addEventListener('submit', async (e) => {
    e.preventDefault(); $('laSubmit').disabled = true;
    try {
      const added = await call('ladder_add', { role: $('laRole').value, label: $('laLabel').value, size_usd: Number($('laSize').value), fee_usd: Number($('laFee').value), signal_group: Number($('laGroup').value || 0),
        email: $('laEmail').value.trim(), password: $('laPassword').value, server: $('laServer').value.trim(), account_id: $('laAccount').value.trim(), all: $('laAll').value === '1' });
      $('status').textContent = $('laRole').value === 'monitor' ? 'E8 account connected read-only: the cost monitor starts within a minute' : (added && added.added > 1 ? added.added + ' demo accounts added with copying OFF' + (added.skipped ? ' (' + added.skipped + ' were already connected)' : '') : 'Account added with copying OFF'); await load();
    } catch (err) { $('status').textContent = err.message; }
    finally { $('laPassword').value = ''; $('laSubmit').disabled = false; }
  });
  document.addEventListener('click', (e) => {
    const capacity=e.target.closest('[data-capacity]');
    if(capacity){
      const limit=prompt('Maximum simultaneous positions plus pending orders, confirmed by this demo provider:');if(limit===null)return;
      const margin=prompt('Conservative USD margin needed per lot across the instruments you will copy:');if(margin===null)return;
      const evidence=prompt('Provider document/reference confirming these limits and permitted copying:');if(evidence===null)return;
      act('capacity_set',{book:capacity.dataset.capacity,position_limit:Number(limit),margin_per_lot_usd:Number(margin),provider_evidence:evidence},'Capacity saved. Copying enablement was not changed.');return;
    }
    const la = e.target.closest('[data-la]'); if (la) act('ladder_update', { id: Number(la.dataset.la), execution_enabled: la.dataset.on === '1' }, 'Saved');
    const sp = e.target.closest('[data-sp]'); if (sp) act('sponsorship_decide', { id: Number(sp.dataset.sp), status: 'purchased' }, 'Marked as bought');
  });
  load();
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60000);
})();
