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
  const when = (v) => v ? new Date(v).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/London' }) : '—';
  const STATE_LABEL = { BB_DEMO: 'B-book demo', BB_LIVE: 'B-book live', AB_DEMO: 'A-book demo', AB_LIVE: 'A-book live', SUSPENDED: 'Suspended' };
  let last = null, busy = false, acting = false, lastLoadedAt = null;
  const htmlCache = new Map();
  let validationModeVersion=null,validationPersonVersion=null,validationDataCurrent=false;
  function setHtml(id, html) { if(htmlCache.get(id)!==html){ $(id).innerHTML=html; htmlCache.set(id,html); } }

  async function call(action, extra = {}) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { location.replace('team-login.html?next=' + encodeURIComponent('/team-treasury.html')); throw new Error('Sign in again'); }
    const r = await fetch(SB_URL + '/functions/v1/ladder-admin', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(action === 'ladder_add' ? 45000 : 15000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify({ action, ...extra }) });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body?.ok) throw new Error(body?.error || ([401,403].includes(r.status) ? 'Owner and MFA verification required' : 'Treasury request failed; current data is unavailable'));
    return body;
  }

  function render(d) {
    renderValidation(d.validation,d.validation_error);
    const readiness = d.readiness;
    $('setupStatus').textContent = readiness ? (readiness.diagnostics_complete ? 'Current setup checks · ' : 'Some setup checks unavailable · ') + when(readiness.as_of) + ' UK time. Configuration checks are not a launch approval.' : 'Setup diagnostics unavailable. Refresh after the backend update; no readiness has been assumed.';
    const links = new Set(['team-e8-monitor.html','team-e8-monitor.html#settings','team-brain.html','signup.html','#accountSetup','#ladderRows','#reserveForm']);
    setHtml('setupRows', readiness ? readiness.checks.map(c => `<tr><td>${esc(c.title)}</td><td>${esc({checked:'Checked configuration / data',action:'Action needed',unknown:'Unavailable'}[c.state] || 'Unavailable')}</td><td>${esc(c.detail)}</td><td>${links.has(c.href) ? `<a class="button" href="${esc(c.href)}">Open next step</a>` : 'Review setup'}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No current setup diagnostics.</td></tr>');
    const s = d.snapshot, set = d.settings || {};
    const statusText = { unknown: 'Unknown: check reserve / data', healthy: 'Healthy', tight: 'Tight', short: 'Short' }[s?.status || 'unknown'];
    $('kpis').innerHTML = [
      ['Payout cover', statusText], ['Expected payouts, 30 days', usd(s?.notes?.figures_unavailable ? null : s?.liab_30d)], ['Model estimate, 90 days', usd(s?.notes?.figures_unavailable ? null : s?.liab_90d_p90)], ['All graduates stress (not a forecast)', usd(s?.notes?.dependence_stress_usd)],
      ['Cash counted', usd(s?.assets_usd)], ['Payout model', set.payout_model === 'sponsored_account' ? 'Funded account at Stage 4' : set.payout_model === 'cash_at_stage3' ? 'Cash at Stage 3 (current Terms)' : 'Not recorded'],
      ['New book risk', set.book_halt ? 'HALTED' : 'Not halted · readiness still applies'],
    ].map(([k, v]) => `<div class="tile"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
    $('modelNote').textContent = s ? `Forecast at ${when(s.as_of)} for ${s.open_accounts} open Infinity accounts. ${s.complete ? 'Complete model inputs' : 'INCOMPLETE — check data before acting'}${s.notes?.source_error ? ' · '+s.notes.source_error : ''}. Cash is an unreconciled estimate from recorded reserve, receipts and fees. Demo profits are excluded. The 90-day model assumes independent outcomes; correlated trader risk can be much higher.` : 'No forecast yet (runs every hour).';
    $('horizons').innerHTML = s ? [['7 days', s.liab_7d, null, null], ['30 days', s.liab_30d, s.liab_30d_p90, s.graduates_30d], ['60 days', s.liab_60d, null, null], ['90 days', s.liab_90d, s.liab_90d_p90, s.graduates_90d]]
      .map(([h, e, p, g]) => `<tr><td>${h}</td><td>${usd(e)}</td><td>${p == null ? '—' : usd(p)}</td><td>${g == null ? '—' : Number(g).toFixed(1)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No forecast yet.</td></tr>';
    if (set.starting_reserve_usd != null && document.activeElement !== $('reserveUsd')) $('reserveUsd').value = set.starting_reserve_usd;

    const rec = d.recommendation;
    $('ladderRec').innerHTML = rec ? `<b>${esc(rec.action.toUpperCase())}${rec.accounts ? ' ' + rec.accounts + ' evaluation' + (rec.accounts > 1 ? 's' : '') : ''}</b> · ${esc(rec.reason)} · budget ${usd(rec.budget_usd)} · ${when(rec.as_of)}` : 'No recommendation yet (runs every hour).';
    const la = d.ladder_accounts || [];
    const ongoing=new Map((d.ongoing_copy?.connections||[]).map(c=>[c.account_id,c]));
    const ROLE = { ladder: 'Prop (A-book)', shadow: 'Demo copy', monitor: 'E8 monitor (read-only)' };
    $('ladderRows').innerHTML = la.length ? la.map((a) => `<tr><td>${esc(a.label)} #${esc(a.id)}</td><td>${esc(ROLE[a.role] || a.role || 'Prop (A-book)')}${a.api_env === 'live' ? ' · live' : ''}</td><td>${usd(a.size_usd)}</td><td>${usd(a.fee_usd)}</td><td>${esc(a.status)}</td><td>${esc(a.signal_group)}</td><td>${ongoing.has(a.id)?'Ongoing '+(ongoing.get(a.id).execution_on?'ON':'OFF'):a.execution_enabled?'ON':'off'}</td>
      <td>${a.role === 'monitor' ? (ongoing.has(a.id)?`<span class="small">Monitoring service stays read-only</span> <button class="button" data-capacity="l${a.id}" type="button">Set verified capacity</button> <a class="button" href="team-a-book.html">Execution controls</a>`:'<span class="small">Read-only</span>') : `<button class="button" data-capacity="${a.role==='shadow'?'s':'l'}${a.id}" type="button">Set verified capacity</button> <button class="button" data-la="${a.id}" data-on="${a.execution_enabled ? '0' : '1'}" type="button">${a.execution_enabled ? 'Stop copying' : 'Start copying'}</button>`}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">No accounts yet.</td></tr>';

    const st = d.book_states || {};
    $('bookStates').innerHTML = Object.keys(STATE_LABEL).map((k) => `<div class="tile"><span>${STATE_LABEL[k]}</span><strong>${st[k] || 0}</strong></div>`).join('');
    const pnl = Object.fromEntries((d.day_pnl || []).map((r) => [r.book, r.pnl_usd]));
    $('bookRows').innerHTML = (d.limits || []).map((l) => {
      const connected=(d.review_destinations || []).some(x=>x.book===l.book && x.environment==='demo' && x.status==='connected');
      return `<tr><td>${l.book === 'a' ? 'A-book (copy)' : 'B-book (reverse)'}</td><td>${usd((d.open_risk || {})[l.book] || 0)}</td><td>${usd(pnl[l.book] || 0)}</td><td>${usd(l.daily_loss_stop_usd)}</td><td>${usd(l.daily_profit_cap_usd)}</td><td>${connected?'Saved · execution unverified':'Not connected'}</td><td>${connected?`<button class="button" data-capacity="${esc(l.book)}" type="button">Set verified capacity</button>`:`<a class="button" href="${l.book==='a'?'team-a-book.html':'team-b-book.html'}">Connect review demo</a>`}</td></tr>`;
    }).join('');
    $('haltBtn').textContent = set.book_halt ? 'Resume new book risk' : 'Halt all new book risk';
    $('events').innerHTML = (d.events || []).length ? d.events.map((e) => `<tr><td>${when(e.created_at)}</td><td>${esc(STATE_LABEL[e.from_state] || e.from_state)}</td><td>${esc(STATE_LABEL[e.to_state] || e.to_state)}</td><td>${esc(e.reason)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No moves yet.</td></tr>';
    $('spons').innerHTML = (d.sponsorships || []).length ? d.sponsorships.map((p) => `<tr><td>${esc(p.name || p.user_id)}</td><td>${when(p.created_at)}</td><td>${esc(p.status)}</td><td>${p.status === 'pending' ? `<button class="button" data-sp="${p.id}" type="button">Mark bought</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No graduates yet.</td></tr>';
    $('forecasts').innerHTML = (d.forecasts || []).length ? d.forecasts.map((f) => `<tr><td>${esc(f.name || f.person_id)}</td><td>${esc(f.stage)}</td><td>${pct(f.p_graduate)}</td><td>${Number(f.expected_days).toFixed(0)}</td><td>${usd(f.payout_if_graduate)}</td><td>${Number(f.mu_mean) >= 0 ? '+' : ''}${Number(f.mu_mean).toFixed(3)}R (${f.trades} trades)</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No open accounts.</td></tr>';
  }

  async function load() {
    if (busy) return; busy = true; $('refresh').disabled = true; $('status').textContent = 'Loading…';
    try { last = await call('overview'); render(last); lastLoadedAt = new Date().toISOString(); $('status').textContent = 'Owner-only · MFA protected · updated ' + when(lastLoadedAt) + ' UK time'; }
    catch (e) { $('status').textContent = (e.name === 'TimeoutError' ? 'Treasury request timed out.' : e.message) + (lastLoadedAt ? ' Last successful refresh: ' + when(lastLoadedAt) + ' UK time. Displayed figures may be stale.' : ''); $('setupStatus').textContent = 'Current setup status unavailable. Any earlier checks below are stale; do not use them to enable copying.'; validationDataCurrent=false;$('validationModeSave').disabled=true;$('validationPersonSave').disabled=true;$('validationStatus').textContent='Validation settings unavailable or stale. Refresh before saving.'; }
    finally { busy = false; $('refresh').disabled = false; }
  }
  async function act(action, extra, okMsg) {
    if (acting) return false; acting = true;
    const buttons=[...document.querySelectorAll('form button[type="submit"],#haltBtn,[data-la],[data-sp],[data-capacity]')]; buttons.forEach(b=>b.disabled=true);
    try { await call(action, extra); $('status').textContent = okMsg; await load(); return true; } catch (e) { $('status').textContent = (e.name === 'TimeoutError' ? 'Save timed out. Refresh and check before retrying.' : e.message); return false; }
    finally { acting=false; buttons.forEach(b=>b.disabled=false); if(!validationDataCurrent){$('validationModeSave').disabled=true;$('validationPersonSave').disabled=true;} }
  }
  $('refresh').addEventListener('click', load);
  function renderValidation(v,error){
    const current=v?.settings;
    validationDataCurrent=!!current&&['off','paper'].includes(current.mode)&&Number.isSafeInteger(Number(current.version));
    $('validationModeSave').disabled=!validationDataCurrent;$('validationPersonSave').disabled=!validationDataCurrent;
    if(!validationDataCurrent){$('validationStatus').textContent=error||'Validation journal unavailable or mode unsupported. No recording or execution has been assumed.';$('validationStats').textContent='';return;}
    if(validationModeVersion===null)$('validationMode').value=current.mode;
    const stale=[validationModeVersion,validationPersonVersion].some(x=>x!==null&&x!==Number(current.version));
    $('validationStatus').textContent=(current.mode==='off'?'OFF · no new streams':'PAPER · source observations only')+' · '+(stale?'Settings changed while editing. Reload before saving. ': '')+(v.capture_failure_recorded?'Capture failed: evidence coverage is unconfirmed. ':'')+'Broker dispatch and net verification are unavailable.';
    const counts=v.work_states||{};
    setHtml('validationStats',[['Selected people',v.enabled_enrolments],['Recorded streams',v.streams],['Source events',v.events],['Paper intentions',v.paper_intentions],['Uncertain work',counts.unknown??0],['Oldest pending',v.oldest_pending_at?when(v.oldest_pending_at)+' UK':'None recorded']].map(([label,value])=>`<div class="tile"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join(''));
  }
  const draftMode=()=>{if(validationModeVersion===null)validationModeVersion=Number(last?.validation?.settings?.version)};
  const draftPerson=()=>{if(validationPersonVersion===null)validationPersonVersion=Number(last?.validation?.settings?.version)};
  for(const id of ['validationMode','validationModeReason'])$(id).addEventListener('input',draftMode);
  for(const id of ['validationEnabled','validationSelection','validationPersonReason'])$(id).addEventListener('input',draftPerson);
  $('validationReload').addEventListener('click',()=>{validationModeVersion=null;validationPersonVersion=null;load();});
  $('validationModeForm').addEventListener('submit',async e=>{e.preventDefault();const version=validationModeVersion??Number(last?.validation?.settings?.version);if(await act('validation_mode',{mode:$('validationMode').value,reason:$('validationModeReason').value.trim(),expected_version:version},'Paper recording mode saved; broker execution unchanged.')){if(validationDataCurrent){validationModeVersion=null;renderValidation(last?.validation);}}});
  $('validationFindForm').addEventListener('submit',async e=>{e.preventDefault();$('validationFind').disabled=true;try{const r=await call('validation_find',{query:$('validationName').value.trim()});setHtml('validationMatches',(r.results||[]).map(p=>`<p><button class="button" type="button" data-validation-person="${esc(p.user_id)}" data-validation-name="${esc(p.full_name||'Registered trader')}">Choose ${esc(p.full_name||'registered trader')}</button></p>`).join('')||'<p>No matching registered trader.</p>');}catch(error){$('validationMatches').textContent=error.message;}finally{$('validationFind').disabled=false;}});
  $('validationMatches').addEventListener('click',e=>{const b=e.target.closest('[data-validation-person]');if(!b)return;$('validationPersonId').value=b.dataset.validationPerson;$('validationPersonName').value=b.dataset.validationName;draftPerson();});
  $('validationPersonForm').addEventListener('submit',async e=>{e.preventDefault();if(!$('validationPersonId').value){$('validationStatus').textContent='Find and choose a registered trader first.';return;}const version=validationPersonVersion??Number(last?.validation?.settings?.version);if(await act('validation_enrol',{person_id:$('validationPersonId').value,enabled:$('validationEnabled').value==='true',selection:$('validationSelection').value,reason:$('validationPersonReason').value.trim(),expected_version:version},'Future-stream selection saved; live model unchanged.')){if(validationDataCurrent){validationPersonVersion=null;renderValidation(last?.validation);}}});
  $('reserveForm').addEventListener('submit', (e) => { e.preventDefault(); act('set_reserve', { usd: Number($('reserveUsd').value) }, 'Reserve saved'); });
  $('payoutForm').addEventListener('submit', async (e) => { e.preventDefault(); if(await act('payout_add', { amount_usd: Number($('poAmount').value), ladder_account_id: $('poAccount').value ? Number($('poAccount').value) : null }, 'Payout recorded')) $('poAmount').value = ''; });
  $('haltBtn').addEventListener('click', () => act('halt', { on: !(last?.settings?.book_halt) }, 'Saved'));
  $('ladderAdd').addEventListener('submit', async (e) => {
    e.preventDefault(); $('laSubmit').disabled = true;
    try {
      const added = await call('ladder_add', { role: $('laRole').value, label: $('laLabel').value, size_usd: Number($('laSize').value), fee_usd: Number($('laFee').value), signal_group: Number($('laGroup').value || 0),
        email: $('laEmail').value.trim(), password: $('laPassword').value, server: $('laServer').value.trim(), account_id: $('laAccount').value.trim(), all: $('laAll').value === '1' });
      await load(); $('status').textContent = $('laRole').value === 'monitor' ? 'E8 read-only connection saved. Open E8 monitor, start sampling, and confirm a recent quote.' : (added && added.added > 1 ? added.added + ' demo accounts added with copying OFF' + (added.skipped ? ' (' + added.skipped + ' were already connected)' : '') : 'Account saved with copying OFF. Check documented capacity before enabling.');
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
  document.addEventListener('click', (e) => { if(e.target.closest('a[href="#accountSetup"]')) $('accountSetup').open=true; });
  setInterval(() => { if (document.visibilityState === 'visible' && !acting) load(); }, 10000);
})();
