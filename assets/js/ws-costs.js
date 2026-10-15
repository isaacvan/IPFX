/* Costs & E8: what trading really costs on the E8 funded account compared with IPFX, and what copied trades would
   have made at funded size. Joins the read-only E8 monitor (e8-monitor-admin) with the Brain's cost and shadow-copy
   panels (brain-monitor). Nothing here places an order: the E8 connection on this page is read-only. */
(() => {
  'use strict';
  const T = window.TeamOS, { esc, usd, ukTime } = T;
  const $ = (id) => document.getElementById(id);
  let mon = null, brain = null, monErr = null, brainErr = null, loadedAt = 0;
  const fin = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  const money = (v) => (fin(v) ? usd(v) : '—');
  const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; if (!Number.isFinite(s)) return 'never'; return s < 90 ? Math.max(0, Math.round(s)) + 's ago' : s < 5400 ? Math.round(s / 60) + 'm ago' : s < 129600 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
  const cap = (txt, cls) => `<span class="cap ${cls || ''}">${esc(txt)}</span>`;
  const STATUS = { AWAITING_FIRST_SAMPLE: ['Waiting for first quote', 'orange'], PAUSED: ['Paused', ''], OK: ['Sampling', 'green'], SAMPLING: ['Sampling', 'green'] };

  // ---- E8 account (read-only monitor) ----
  function e8Section() {
    if (monErr && !mon) return `<div class="banner red">E8 monitor unavailable: ${esc(monErr)}</div>`;
    const accounts = mon?.accounts || [], profiles = mon?.summary?.accounts || [];
    if (!accounts.length) {
      return `<div class="group"><div class="item"><div class="leadicon ic-blue"><svg viewBox="0 0 24 24"><path d="M4 18l5-5.5 3.5 2.5L20 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></div>
        <div class="body"><b>Connect your E8 funded account</b><span>Read-only: it samples E8 prices and fees so costs can be compared. It never places orders.</span></div>
        <div class="trail"><button class="btn primary" data-act="connect">Connect</button></div></div></div>`;
    }
    return `<div class="group">${accounts.map((a) => {
      const p = profiles.find((x) => Number(x.id) === Number(a.id));
      const fresh = p?.last_quote_at && Date.now() - Date.parse(p.last_quote_at) < 120000;
      const st = !p ? ['Not sampling', ''] : !p.enabled ? ['Paused', ''] : p.error_code ? ['Error', 'red'] : fresh ? ['Sampling', 'green'] : STATUS[p.status] || [String(p.status || 'Unknown').replace(/_/g, ' ').toLowerCase(), 'orange'];
      return `<div class="item"><div class="body"><b>${esc(a.label)} <span class="muted">#${esc(a.account_id)}</span></b>
          <span>${esc(a.server)}${a.api_env === 'live' ? ' · live login' : ' · demo login'} · ${p ? `${esc((p.symbols || []).join(', '))} every ${Math.round(Number(p.interval_ms) / 1000)}s` : 'Sampling not set up'}</span>
          <span>Last quote ${p?.last_quote_at ? ago(p.last_quote_at) : 'never'} · last fee history ${p?.last_history_at ? ago(p.last_history_at) : 'never'}${p?.error_code ? ` · <b class="bad">${esc(p.error_code)}</b>` : ''}${p?.history_error_code ? ` · history: ${esc(p.history_error_code)}` : ''}</span></div>
        <div class="trail">${cap(st[0], st[1])}<button class="btn sm" data-act="sampling" data-id="${esc(a.id)}">Edit</button>
          <button class="switch" role="switch" aria-checked="${!!p?.enabled}" aria-label="Sampling for ${esc(a.label)}" data-act="toggle" data-id="${esc(a.id)}"></button></div></div>`;
    }).join('')}
      <div class="item"><div class="body"><span>${esc(mon.summary?.fills ?? 0)} broker fills kept · ${esc(mon.summary?.fee_complete_fills ?? 0)} with every fee field · missing fees stay unknown, never zero</span></div>
        <div class="trail"><button class="btn sm link" data-act="connect">Add another</button></div></div></div>`;
  }

  function totalsSection() {
    const rows = mon?.summary?.account_totals || brain?.e8_totals;
    if (!Array.isArray(rows) || !rows.length) return '';
    const REC = { INCOMPLETE: ['Fee fields incomplete', 'orange'], CONSISTENT_POSITIVE_FEE: ['Gross, net and fees agree', 'green'], CONSISTENT_SIGNED_FEE: ['Gross, net and fees agree', 'green'], ZERO_REPORTED_DIFFERENCE: ['No gross-to-net difference', ''], UNATTRIBUTED_DIFFERENCE: ['Unexplained difference: review', 'red'] };
    return rows.map((r) => {
      const a = r.amounts || {}, age = (Date.now() - Date.parse(r.received_at)) / 1000, fresh = r.fresh === true && age >= 0 && age < 180;
      const rec = REC[r.reconciliation?.status] || ['Reconciliation unavailable', ''];
      const cell = (k, v) => `<div class="stat"><div class="k">${k}</div><div class="v num ${fin(v) && Number(v) < 0 ? 'bad' : ''}" style="font-size:21px">${money(v)}</div></div>`;
      return `<div class="grouphead">${esc(r.label || 'E8 account')} today <span class="sub">${fresh ? 'Live' : 'Stale'} broker snapshot · ${Number.isFinite(age) ? ago(r.received_at) : 'age unknown'} · ${esc(r.currency || 'currency not supplied')}</span></div>
        <div class="stats">${cell('Closed gross', a.todayGross)}${cell('Closed net', a.todayNet)}${cell('Fees reported', a.todayFees)}${cell('Open gross', a.openGrossPnL)}${cell('Open net', a.openNetPnL)}</div>
        <p class="foot">${cap(rec[0], rec[1])} Whole-account figures reported by the broker. “Today” follows the broker’s day boundary; fees aren’t split across trades.</p>`;
    }).join('');
  }

  // ---- costs: IPFX vs E8 ----
  function costsSection() {
    if (brainErr && !brain) return `<div class="grouphead">Trading costs</div><div class="banner red">Cost comparison unavailable: ${esc(brainErr)}</div>`;
    const c = brain?.costs, rows = c?.spreads || [];
    const allin = new Map((c?.allin || []).map((r) => [r.symbol, r]));
    const hasDemo = rows.some((r) => fin(r.demo));
    const px = (v) => (fin(v) ? String(Number(Number(v).toPrecision(3))) : '—');
    const off = rows.filter((r) => { const x = allin.get(r.symbol); return x && fin(x.ratio) && (x.ratio > 1.25 || x.ratio < 0.8); }).length;
    return `<div class="grouphead">Trading costs: IPFX vs E8 <span class="sub">Last 7 days · sampled at the same moment · target 80–125% of E8</span></div>
      ${off ? `<div class="banner">${off} instrument${off === 1 ? ' is' : 's are'} outside 80–125% of E8’s all-in cost. Adjust the spread or commission in symbol settings.</div>` : ''}
      <div class="tablewrap"><div class="scroll"><table><thead><tr><th>Instrument</th><th class="r">E8 spread</th>${hasDemo ? '<th class="r">Demo spread</th>' : ''}<th class="r">IPFX spread</th><th class="r">E8 all-in / lot</th><th class="r">IPFX all-in / lot</th><th class="r">IPFX vs E8</th><th class="r">Samples</th></tr></thead><tbody>
      ${rows.map((r) => { const a = allin.get(r.symbol), ratio = a && fin(a.ratio) ? Number(a.ratio) : null, bad = ratio != null && (ratio > 1.25 || ratio < 0.8);
        return `<tr><td><b>${esc(r.symbol)}</b></td><td class="r num">${px(r.e8)}</td>${hasDemo ? `<td class="r num muted">${px(r.demo)}</td>` : ''}<td class="r num">${px(r.ipfx)}</td>
          <td class="r num">${fin(a?.e8_usd) ? money(a.e8_usd) : '<span class="muted">Fee unknown</span>'}</td><td class="r num">${money(a?.ipfx_usd)}</td>
          <td class="r">${ratio == null ? '—' : cap(Math.round(ratio * 100) + '%', bad ? 'red' : 'green')}</td><td class="r num muted">${esc(r.samples)}</td></tr>`; }).join('')
        || `<tr><td colspan="${hasDemo ? 8 : 7}" class="muted">${(c?.accounts || []).length ? 'No samples yet. The first arrive within a minute of connecting.' : 'Connect the E8 account above to start comparing costs.'}</td></tr>`}
      </tbody></table></div></div>
      <p class="foot">All-in = spread plus commission for one standard lot (median of paired samples). E8 commission is an estimate from E8’s published raw-spread schedule and isn’t confirmed for your account. Swap and slippage aren’t included.</p>`;
  }

  // ---- funded-size estimate from demo copies ----
  function shadowSection() {
    const x = brain?.shadow;
    if (!brain) return '';
    if (!x || !x.coverage?.accounts) return `<div class="grouphead">At funded size</div><div class="group"><div class="item"><div class="body"><b>No demo copy accounts connected</b><span>Add demo copy accounts in Treasury. Every trader is then copied at minimum size and scaled here to a funded account.</span></div><div class="trail"><a class="btn sm" href="/workspace/treasury.html">Treasury</a></div></div></div>`;
    const nm = new Map((brain.traders || []).map((t) => [t.person_id, t.name]));
    const whole = (v) => (fin(v) ? (v < 0 ? '−$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-GB') : '—');
    const cls = (v) => (!fin(v) || Number(v) === 0 ? '' : Number(v) < 0 ? 'bad' : 'good');
    const cov = x.coverage;
    return `<div class="grouphead">At funded size <span class="sub">Last 7 days · every trade copied at minimum size on demo, scaled to ${whole(x.funded_size)}</span></div>
      <div class="stats">
        <div class="stat"><div class="k">IPFX result, scaled</div><div class="v num ${cls(x.ipfx_scaled)}">${whole(x.ipfx_scaled)}</div><div class="s">What traders made, at funded size</div></div>
        <div class="stat"><div class="k">Demo copies, scaled</div><div class="v num ${cls(x.copy_scaled)}">${whole(x.copy_scaled)}</div><div class="s">Gross, from demo broker prices</div></div>
        <div class="stat"><div class="k">Copied trades</div><div class="v num">${esc(x.trades)}</div><div class="s">${esc(cov.traders)} traders · ${esc(cov.accounts)} demo accounts</div></div>
        <div class="stat"><div class="k">Failed copies</div><div class="v num ${cov.failed ? 'bad' : ''}">${esc(cov.failed || 0)}</div><div class="s">E8 net stays unverified</div></div></div>
      ${(x.people || []).length ? `<details class="more"><summary>By trader · ${(x.people || []).length}</summary><div class="tablewrap"><div class="scroll"><table><thead><tr><th>Trader</th><th>Model</th><th class="r">Trades</th><th class="r">IPFX scaled</th><th class="r">Demo copy scaled</th></tr></thead><tbody>
        ${x.people.map((r) => `<tr><td><b>${esc(nm.get(r.person_id) || 'Trader ' + String(r.person_id).slice(0, 6))}</b></td><td class="muted">${r.model === 'a' ? 'A · same direction' : r.model === 'b' ? 'B · reverse' : 'Not recorded'}</td><td class="r num">${esc(r.trades)}</td><td class="r num ${cls(r.ipfx_scaled)}">${whole(r.ipfx_scaled)}</td><td class="r num ${cls(r.copy_scaled)}">${whole(r.copy_scaled)}</td></tr>`).join('')}
      </tbody></table></div></div></details>` : ''}
      <p class="foot">Contract size, currency conversion and small-lot scaling are assumptions${x.incomplete ? `; ${esc(x.incomplete)} trade(s) left out because exits or prices are incomplete` : ''}. Unknown fees never count as zero.</p>`;
  }

  // ---- live quotes and tracked trades ----
  function detailSection() {
    const quotes = mon?.summary?.quotes || [], sim = mon?.simulation;
    const elapsed = Date.now() - loadedAt;
    return `<details class="more"><summary>Latest E8 quotes · ${quotes.length}</summary><div class="tablewrap"><div class="scroll"><table><thead><tr><th>Symbol</th><th class="r">Bid</th><th class="r">Ask</th><th class="r">Spread</th><th>Received</th></tr></thead><tbody>
        ${quotes.map((q) => { const age = Number(q.age_ms) + elapsed, ok = q.fresh && age <= Number(q.max_quote_age_ms ?? 15000);
          return `<tr><td><b>${esc(q.symbol)}</b></td><td class="r num">${esc(q.bid)}</td><td class="r num">${esc(q.ask)}</td><td class="r num">${fin(q.spread) ? String(Number(Number(q.spread).toPrecision(3))) : '—'}</td><td>${cap(Number.isFinite(age) ? Math.round(age / 1000) + 's old' : 'age unknown', ok ? 'green' : 'orange')}</td></tr>`; }).join('') || '<tr><td colspan="5" class="muted">No quotes yet.</td></tr>'}
      </tbody></table></div></div></details>
      <details class="more"><summary>Tracked IPFX trades at E8 prices · ${esc(sim?.positions ?? 0)}</summary><div class="tablewrap"><div class="scroll"><table><thead><tr><th>Trade</th><th>Trader → IPFX</th><th class="r">Lots closed</th><th>Status</th><th class="r">E8 sampled gross</th><th class="r">IPFX gross</th></tr></thead><tbody>
        ${(sim?.recent || []).map((t) => { const rev = t.selected_book === 'b', side = rev ? (t.trader_side === 'buy' ? 'sell' : 'buy') : t.trader_side;
          return `<tr><td>${esc(String(t.trade_id).slice(0, 8))} · <b>${esc(t.symbol)}</b>${t.is_practice ? ' <span class="muted">practice</span>' : ''}</td><td class="muted">${esc(t.trader_side)} → ${esc(side)} (${rev ? 'B' : 'A'})</td><td class="r num">${esc(t.exited_lots ?? 0)} / ${esc(t.original_lots)}</td><td class="muted">${esc(String(t.status).replace(/_/g, ' '))}</td><td class="r num">${money(t.selected_gross_usd)}</td><td class="r num">${money(t.decision_gross_usd)}</td></tr>`; }).join('') || '<tr><td colspan="6" class="muted">No tracked trades yet.</td></tr>'}
      </tbody></table></div></div><p class="foot">Estimates from sampled E8 prices, not E8 fills. ${esc(sim?.pending_active ?? 0)} resting orders tracked.</p></details>
      <p class="foot">The single-trade cost calculator is on the <a href="/team-e8-monitor.html">classic E8 page</a>.</p>`;
  }

  function render() {
    $('costs').innerHTML = `<div class="grouphead" style="margin-top:0">E8 account <span class="sub">Read-only connection · never places orders</span></div>${e8Section()}${totalsSection()}${costsSection()}${shadowSection()}${detailSection()}`;
  }

  // ---- actions ----
  async function connect() {
    const v = await T.sheet({ title: 'Connect your E8 account (read-only)', text: 'Type your E8 TradeLocker login. It’s exchanged once for encrypted tokens and the password isn’t saved. This connection only reads prices and fees.',
      fields: [{ id: 'label', label: 'Name', value: 'E8 funded' }, { id: 'size', label: 'Account size (USD)', type: 'number', min: 1000, step: 1000, value: '50000' },
        { id: 'account', label: 'Account number (after #)' }, { id: 'email', label: 'Broker email', type: 'email' }, { id: 'password', label: 'Broker password', type: 'password' }, { id: 'server', label: 'Exact server' }],
      confirm: 'Connect', onSubmit: (x) => T.ladder('ladder_add', { role: 'monitor', label: String(x.label).trim(), size_usd: Number(x.size), fee_usd: 0, signal_group: 0,
        email: String(x.email).trim(), password: x.password, server: String(x.server).trim(), account_id: String(x.account).trim() }, 45000) });
    if (!v) return;
    await load();
    const id = v.id ?? (mon?.accounts || []).slice(-1)[0]?.id;
    if (id) { try { await configure(id, { enabled: true }); T.toast('Connected. Sampling starts within a minute.'); } catch (e) { T.toast('Connected, but sampling didn’t start: ' + e.message, true); } }
  }
  function profileOf(id) { return (mon?.summary?.accounts || []).find((p) => Number(p.id) === Number(id)); }
  async function configure(id, patch) {
    const p = profileOf(id) || {};
    await T.e8('configure', { account_id: Number(id), symbols: patch.symbols || p.symbols || ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD'], interval_ms: patch.interval_ms || Number(p.interval_ms) || 10000, max_quote_age_ms: 15000, enabled: patch.enabled ?? !!p.enabled });
    await load();
  }
  async function editSampling(id) {
    const p = profileOf(id) || {};
    const v = await T.sheet({ title: 'E8 sampling', text: 'Which instruments to sample and how often. Requests share the broker’s rate limit.',
      fields: [{ id: 'symbols', label: 'Instruments (comma-separated, up to 12)', value: (p.symbols || ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD']).join(', ') },
        { id: 'interval', label: 'Every', options: [{ value: 10000, label: '10 seconds' }, { value: 30000, label: '30 seconds' }, { value: 60000, label: '60 seconds' }], value: p.interval_ms || 10000 }],
      confirm: 'Save', onSubmit: async (x) => { const symbols = String(x.symbols).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean); if (!symbols.length || symbols.length > 12) throw new Error('Enter between 1 and 12 instruments.'); await configure(id, { symbols, interval_ms: Number(x.interval), enabled: p.enabled ?? true }); return true; } });
    if (v) T.toast('Sampling saved.');
  }
  async function toggle(id, el) {
    const on = !profileOf(id)?.enabled; el?.setAttribute('aria-checked', String(on));
    try { await configure(id, { enabled: on }); T.toast(on ? 'Sampling on.' : 'Sampling paused.'); } catch (e) { T.toast(e.message, true); await load(); }
  }

  async function load() {
    const [m, b] = await Promise.allSettled([T.e8('overview'), T.brain('overview')]);
    if (m.status === 'fulfilled') { mon = m.value; monErr = null; loadedAt = Date.now(); } else monErr = m.reason?.message || 'unavailable';
    if (b.status === 'fulfilled') { brain = b.value; brainErr = null; } else brainErr = b.reason?.message || 'unavailable';
    render();
    T.status(monErr && brainErr ? 'Couldn’t load' : 'Updated ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    ({ connect, refresh: load, sampling: () => editSampling(b.dataset.id), toggle: () => toggle(b.dataset.id, b) })[b.dataset.act]?.();
  });
  T.mount({ page: 'costs', title: 'Costs & E8' });
  $('refreshBtn').addEventListener('click', load);
  load();
  setInterval(() => { if (!document.hidden && !document.querySelector('.os-scrim')) load(); }, 30000);
})();
