/* Owner-only Brain control room. Reads through brain-monitor (owner + MFA). Never trades, sizes or routes. */
(() => {
  'use strict';
  const SB_URL = 'https://agulweemteoeagscmppy.supabase.co';
  const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndWx3ZWVtdGVvZWFnc2NtcHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MzU0ODIsImV4cCI6MjA4MTQxMTQ4Mn0.I70jN5DCuCn8OtISqvTRzuzGFaYd2pV8vviEED6gFlQ';
  // Local design check only: http://localhost:<port>/team-brain.html?fixture loads made-up data from tests/fixtures.
  const FIXTURE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has('fixture');
  const sb = FIXTURE ? null : window.supabase.createClient(SB_URL, SB_ANON);
  const REFRESH_MS = 30000;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fin = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  const usd = (v, signed = false) => !fin(v) ? '—' : (signed && Number(v) > 0 ? '+' : '') + Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const rr = (v, d = 2) => !fin(v) ? '—' : (Number(v) > 0 ? '+' : '') + Number(v).toFixed(d) + 'R';
  const pct = (v) => !fin(v) ? '—' : Math.round(Number(v) * 100) + '%';
  const signCls = (v) => !fin(v) || Number(v) === 0 ? '' : Number(v) > 0 ? 'pos' : 'neg';
  const ago = (t) => { if (!t) return 'never'; const s = Math.max(0, (Date.now() - Date.parse(t)) / 1000); return s < 90 ? Math.round(s) + 's ago' : s < 5400 ? Math.round(s / 60) + 'm ago' : s < 172800 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
  const dur = (t) => { if (!t) return ''; const s = (Date.now() - Date.parse(t)) / 1000; return s < 5400 ? Math.max(1, Math.round(s / 60)) + ' min' : s < 172800 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' days'; };
  const store = { get(k, d) { try { const v = localStorage.getItem('brain.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } }, set(k, v) { try { localStorage.setItem('brain.' + k, JSON.stringify(v)); } catch (_) {} } };

  const STATES = {
    AB_LIVE: { tiny: 'A live', label: 'A-book live', short: 'A live', why: 'Being copied into prop accounts' },
    AB_DEMO: { tiny: 'A test', label: 'A-book demo', short: 'A demo', why: 'On test: copies go to the demo account' },
    BB_LIVE: { tiny: 'B live', label: 'B-book live', short: 'B live', why: 'IPFX bets against them' },
    BB_DEMO: { tiny: 'Watch', label: 'B-book demo', short: 'Watching', why: 'Watched only, not enough proof yet' },
    SUSPENDED: { tiny: 'Susp.', label: 'Suspended', short: 'Suspended', why: 'Integrity problem; only a person can release' },
  };
  const TAGS = {
    STAR: { label: 'Proven skill', sev: 'good', why: 'Copying them makes money after costs, with statistical proof' },
    EARNER: { label: 'B-book earner', sev: 'good', why: 'Betting against them makes money, with proof' },
    RINSE: { label: 'Could cost you', sev: 'warning', why: 'Likely to reach a payout and not being copied' },
    FADING: { label: 'Getting worse', sev: 'warning', why: 'Recent copy results turned negative' },
    TURNING: { label: 'Turning good', sev: 'warning', why: 'Recent reverse results turned negative' },
    SUSPENDED: { tiny: 'Susp.', label: 'Suspended', sev: 'critical', why: 'Integrity problem' },
    HOLD: { label: 'Investigation', sev: 'critical', why: 'An account is on investigation hold' },
    FLAG: { label: 'Safety flag', sev: 'critical', why: 'Open trade-safety flag (tampering, cross-account hedge or stale-feed exploit)' },
    SPEED: { label: 'Price-delay pattern', sev: 'critical', why: 'Wins on IPFX prices but copies would not' },
    BREACHED: { label: 'Broke a rule', sev: 'critical', why: 'An account breached a rule in the last 7 days' },
    BIG_LOSS: { label: 'Oversized loss', sev: 'warning', why: 'Lost 3R or more on one trade in the last 30 days' },
    NO_SL: { label: 'No stop loss', sev: 'warning', why: 'Most trades in the last 30 days had no stop loss' },
    FAST: { label: 'Under a minute', sev: 'warning', why: 'Most trades held under 60 seconds' },
    HERD: { label: 'Herd', sev: 'warning', why: 'Keeps opening the same trades as 2+ other people' },
    NEW: { label: 'New', sev: 'info', why: 'Fewer than 10 trades' },
  };
  const SEV = { critical: { icon: '!', word: 'Urgent' }, warning: { icon: '!', word: 'Watch' }, good: { icon: '✓', word: 'Good' }, info: { icon: 'i', word: 'Info' } };
  const HELP = [
    ['The five boxes', 'Every trader is in one box. Watching (B-book demo) is where everyone starts. A-book = IPFX copies them. B-book live = IPFX bets against them. Suspended = integrity problem.'],
    ['R (risk unit)', 'Results measured in "how many times what they risked". +1R = won what they risked; -1R = lost it. Lets you compare a $1K account with a $100K one.'],
    ['Avg R', 'Average result per trade, in R. Above 0 = winning on average.'],
    ['Copy edge', 'What IPFX would make per trade by COPYING them, after real spreads and commission, replayed on saved prices.'],
    ['Reverse edge', 'What IPFX would make per trade by BETTING AGAINST them, after costs. Copy and reverse can both be negative: costs are paid both ways.'],
    ['Proof', 'How sure the maths is that the edge is real, not luck. 10 = proven. It can only go up with a long run of results; a lucky week is not enough.'],
    ['Max fall', 'Biggest drop from a high point to a low point, in R. Big falls mean a bumpy ride even for good traders.'],
    ['Likely payout', 'Chance of reaching a payout × payout size, from the hourly treasury forecast. This is what a trader is likely to cost you.'],
    ['Real money ($) vs Replay (R)', 'Real money = actual broker results on connected accounts. Replay = what the books would have made, worked out from saved prices.'],
    ['Alerts', 'Red = act now. Amber = keep an eye on it. Green = good news. Alerts close themselves when the problem stops; "Seen" just dims them.'],
    ['Tags', 'Proven skill, B-book earner (good) · Could cost you, Getting worse, Turning good (money risk) · Broke a rule, Safety flag, No stop loss, Under a minute, Price-delay pattern, Herd (rules).'],
    ['Updating', 'This page refreshes every 30 seconds. The brain re-checks every trader every 5 minutes and the payout forecast runs hourly.'],
  ];

  let data = null, busy = false, filter = 'action', tab = 'ALL', sortKey = store.get('sort', 'last'), sortDir = store.get('dir', 'desc'), shown = 100;
  let mode = store.get('mode', 'live'), range = store.get('range', 30), knownAlerts = null, lastLoad = 0;

  async function call(action, extra = {}) {
    if (FIXTURE) {
      const f = action === 'trader' ? 'brain-trader.json' : 'brain-overview.json';
      if (action === 'ack') return { ok: true };
      const r = await fetch('/tests/fixtures/' + f, { cache: 'no-store' }); return r.json();
    }
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { location.replace('team-login.html?next=' + encodeURIComponent('/team-brain.html')); throw new Error('Sign in again'); }
    const r = await fetch(SB_URL + '/functions/v1/brain-monitor', { method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify({ action, ...extra }) });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body?.ok) throw new Error(body?.error || 'Owner and MFA verification required');
    return body;
  }

  // ---------- tooltip ----------
  const tip = $('tip');
  function showTip(x, y, head, rows) {
    tip.replaceChildren();
    if (head) { const h = document.createElement('div'); h.className = 'h'; h.textContent = head; tip.append(h); }
    for (const [color, value, name] of rows) {
      const r = document.createElement('div'); r.className = 'r';
      const l = document.createElement('span'); if (color) { const i = document.createElement('i'); i.style.background = color; l.append(i, ' '); }
      l.append(document.createTextNode(name)); const b = document.createElement('b'); b.textContent = value; r.append(b, l); tip.append(r);
    }
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(innerWidth - w - 8, x + 14) + 'px'; tip.style.top = Math.max(8, y - h - 10) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- line chart (one axis, cumulative series, crosshair) ----------
  function niceTicks(lo, hi, n = 4) {
    if (lo === hi) { lo -= 1; hi += 1; }
    const step0 = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(step0)), step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
    const start = Math.floor(lo / step) * step, out = [];
    for (let v = start; v <= hi + step * 0.5; v += step) out.push(Math.round(v / step) * step);
    return out;
  }
  function lineChart(el, xs, series, fmt, xfmt) {
    el.replaceChildren();
    const W = Math.max(280, el.clientWidth), H = el.clientHeight || 220, P = { l: 52, r: 96, t: 10, b: 24 };
    const all = series.flatMap((s) => s.values).concat(0), ticks = niceTicks(Math.min(...all), Math.max(...all));
    const y0 = ticks[0], y1 = ticks[ticks.length - 1], n = xs.length;
    const X = (i) => P.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - P.l - P.r)), Y = (v) => P.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - P.t - P.b);
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const add = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.append(e); return e; };
    for (const t of ticks) { add('line', { x1: P.l, x2: W - P.r, y1: Y(t), y2: Y(t), class: t === 0 ? 'base' : 'gl' }); add('text', { x: P.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }, fmt(t, true)); }
    const step = Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i += step) add('text', { x: X(i), y: H - 6, 'text-anchor': 'middle' }, xfmt(xs[i]));
    const labels = [];
    for (const s of series) {
      add('path', { d: s.values.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' '), class: 'ln', stroke: s.color, 'stroke-dasharray': s.dash || '' });
      const last = s.values[s.values.length - 1]; labels.push({ y: Y(last), text: s.name + ' ' + fmt(last), color: s.color });
    }
    labels.sort((a, b) => a.y - b.y); for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
    for (const l of labels) { const t = add('text', { x: W - P.r + 8, y: l.y + 4 }, l.text); t.style.fill = '#c3cad6'; }
    const hair = add('line', { x1: 0, x2: 0, y1: P.t, y2: H - P.b, class: 'hair', visibility: 'hidden' });
    const dots = series.map((s) => add('circle', { r: 4, fill: s.color, stroke: '#121722', 'stroke-width': 2, visibility: 'hidden' }));
    const hit = add('rect', { x: P.l, y: 0, width: Math.max(1, W - P.l - P.r), height: H, fill: 'transparent', tabindex: 0 });
    const at = (i, cx, cy) => {
      hair.setAttribute('x1', X(i)); hair.setAttribute('x2', X(i)); hair.setAttribute('visibility', 'visible');
      series.forEach((s, k) => { dots[k].setAttribute('cx', X(i)); dots[k].setAttribute('cy', Y(s.values[i])); dots[k].setAttribute('visibility', 'visible'); });
      showTip(cx, cy, xfmt(xs[i], true), series.map((s) => [s.color, fmt(s.values[i]), s.name]));
    };
    const leave = () => { hair.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); hideTip(); };
    hit.addEventListener('pointermove', (e) => { const r = svg.getBoundingClientRect(); const x = (e.clientX - r.left) * (W / r.width); at(Math.max(0, Math.min(n - 1, Math.round((x - P.l) / ((W - P.l - P.r) / Math.max(1, n - 1))))), e.clientX, e.clientY); });
    hit.addEventListener('pointerleave', leave); hit.addEventListener('blur', leave);
    hit.addEventListener('focus', () => { const r = svg.getBoundingClientRect(); at(n - 1, r.right - 120, r.top + 40); });
    el.append(svg);
  }
  function spark(values) {
    if (!values || values.length < 2) return '<span class="small">—</span>';
    const W = 90, H = 24, lo = Math.min(0, ...values), hi = Math.max(0, ...values), sp = hi - lo || 1;
    const pts = values.map((v, i) => `${(i / (values.length - 1) * W).toFixed(1)},${(H - 2 - (v - lo) / sp * (H - 4)).toFixed(1)}`).join(' ');
    const zy = (H - 2 - (0 - lo) / sp * (H - 4)).toFixed(1), last = values[values.length - 1];
    return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-label="Cumulative ${last.toFixed(1)}R"><line x1="0" x2="${W}" y1="${zy}" y2="${zy}" stroke="#3a4558" stroke-width="1"/><polyline points="${pts}" fill="none" stroke="#3987e5" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  }
  function meter(e) {
    if (!fin(e)) return '<span class="small">—</span>';
    const v = Number(e), frac = Math.max(0, Math.min(1, Math.log10(Math.max(1, v))));
    return `<span class="meter" title="Proof ${v >= 10 ? 'reached' : v.toFixed(1) + ' of 10'}"><span style="width:${(frac * 100).toFixed(0)}%"></span></span><span class="meter-l">${v >= 10 ? 'Proven' : v < 1 ? 'none' : v.toFixed(1)}</span>`;
  }
  const tagChips = (tags) => (tags || []).filter((t) => TAGS[t]).map((t) => `<span class="tag ${TAGS[t].sev}" title="${esc(TAGS[t].why)}">${esc(TAGS[t].label)}</span>`).join('');

  // ---------- sections ----------
  function renderHero() {
    const open = data.alerts.filter((a) => !a.acknowledged_at);
    const crit = open.filter((a) => a.severity === 'critical').length, warn = open.filter((a) => a.severity === 'warning').length;
    const level = crit ? 'critical' : warn ? 'warning' : 'good';
    $('hero').dataset.level = level;
    $('heroIcon').textContent = crit || warn ? '!' : '✓';
    $('heroTitle').textContent = crit ? `${crit} urgent problem${crit > 1 ? 's' : ''}${warn ? ` and ${warn} thing${warn > 1 ? 's' : ''} to watch` : ''}`
      : warn ? `${warn} thing${warn > 1 ? 's' : ''} to keep an eye on` : 'All clear: nothing needs you right now';
    const pol = data.policy ? `policy v${data.policy.version}` : 'no active policy';
    $('heroSub').textContent = `Updated ${new Date(data.generated_at).toLocaleTimeString('en-GB')} · refreshes every 30s · ${pol} · market ${data.health.market_open ? 'open' : 'closed'}${data.settings?.book_halt ? ' · BOOKS HALTED' : ''}`;
    document.title = (crit + warn ? `(${crit + warn}) ` : '') + 'Brain · IPFX Team';
  }

  function bookTile(book, title) {
    const lim = (data.books.limits || []).find((l) => l.book === book) || {};
    const today = new Date().toISOString().slice(0, 10);
    const pnl = Number((data.books.live_daily || []).find((d) => d.book === book && d.day === today)?.pnl_usd ?? 0);
    const stop = Number(lim.daily_loss_stop_usd || 1000), cap = Number(lim.daily_profit_cap_usd || 1000);
    const left = stop / (stop + cap) * 100, w = Math.min(Math.abs(pnl) / (pnl < 0 ? stop : cap), 1) * (pnl < 0 ? left : 100 - left);
    const fill = pnl < 0 ? `left:${(left - w).toFixed(1)}%;width:${w.toFixed(1)}%;background:var(--loss)` : `left:${left.toFixed(1)}%;width:${w.toFixed(1)}%;background:var(--gain)`;
    const st = pnl <= -stop ? ['critical', 'Stopped for today'] : pnl <= -stop / 2 ? ['warning', 'Past half the stop'] : pnl >= cap ? ['good', 'Profit cap reached'] : ['good', 'Normal'];
    const risk = Number(data.books.open_risk?.[book] || 0), riskMax = Number(lim.open_risk_max_usd || 0);
    return `<div class="tile"><span>${title} today</span><strong class="${signCls(pnl)}">${usd(pnl, true)}</strong>
      <div class="bullet" title="From -${usd(stop)} stop to +${usd(cap)} cap"><span class="zero" style="left:${left.toFixed(1)}%"></span><span class="fill" style="${fill}"></span></div>
      <div class="sub2">Open risk ${usd(risk)}${riskMax ? ' of ' + usd(riskMax) : ''} · stop −${usd(stop)}</div>
      <div class="state sev ${st[0]}"><i>${SEV[st[0]].icon}</i>${st[1]}</div></div>`;
  }
  function renderTiles() {
    const c = data.counts || {}, t = data.treasury, jobs = data.health.jobs || [], beats = data.health.heartbeats || [];
    const down = jobs.filter((j) => !j.ok).length + beats.filter((b) => !b.ok || Date.now() - Date.parse(b.at) > 15 * 60000).length;
    const total = jobs.length + beats.length;
    const tStatus = { healthy: ['good', 'Healthy'], tight: ['warning', 'Tight'], short: ['critical', 'Short'], unknown: ['info', 'Reserve not entered'] }[t?.status || 'unknown'];
    const lad = data.books.ladder || { accounts: 0, copying: 0 };
    $('tiles').innerHTML = bookTile('a', 'A-book') + bookTile('b', 'B-book') +
      `<div class="tile"><span>Prop accounts</span><strong>${lad.copying} of ${lad.accounts}</strong><div class="sub2">copying now · open risk ${usd(data.books.open_risk?.ladder || 0)}</div><div class="sub2">30d result ${usd(data.books.execution?.ladder?.pnl ?? 0, true)}</div></div>` +
      `<div class="tile"><span>Payout cover</span><strong>${esc(tStatus[1])}</strong><div class="sub2">Bad case 90d ${usd(t?.liab_90d_p90)} · cash ${usd(t?.assets_usd)}</div><div class="state sev ${tStatus[0]}"><i>${SEV[tStatus[0]].icon}</i>${t ? 'forecast ' + ago(t.as_of) : 'no forecast yet'}</div></div>` +
      `<div class="tile"><span>Traders by box</span><div class="counts">${['AB_LIVE', 'AB_DEMO', 'BB_LIVE', 'BB_DEMO', 'SUSPENDED'].map((k) => `<div title="${STATES[k].label}"><b>${c[k] || 0}</b><small>${STATES[k].tiny}</small></div>`).join('')}</div></div>` +
      `<div class="tile"><span>Brain health</span><strong>${down ? down + ' stopped' : 'All running'}</strong><div class="sub2">${total - down} of ${total} parts OK</div><div class="state sev ${down ? 'critical' : 'good'}"><i>${down ? '!' : '✓'}</i>${down ? 'See "Is the brain running?"' : 'Checked ' + ago(data.generated_at)}</div></div>`;
  }

  function alertRow(a, resolved) {
    const s = SEV[a.severity] || SEV.info;
    return `<article class="alert ${a.severity}${a.acknowledged_at ? ' seen' : ''}">
      <span class="sev ${a.severity}"><i>${s.icon}</i>${s.word}</span>
      <div><h3>${esc(a.title)}</h3>${a.detail ? `<p>${esc(a.detail)}</p>` : ''}
        <div class="meta"><span>${resolved ? 'Resolved ' + ago(a.resolved_at) : 'For ' + dur(a.first_seen)}</span><span>${esc(a.category)}</span>${a.acknowledged_at ? '<span>Seen</span>' : ''}</div></div>
      <div class="acts">${a.person_id ? `<button class="button small-btn" data-person="${esc(a.person_id)}" type="button">Open trader</button>` : ''}${!resolved && !a.acknowledged_at ? `<button class="button small-btn" data-ack="${a.id}" type="button">Seen</button>` : ''}</div></article>`;
  }
  function filteredAlerts() {
    if (filter === 'resolved') return data.resolved || [];
    return data.alerts.filter((a) => filter === 'open' ? true : filter === 'good' ? a.severity === 'good' : (a.severity === 'critical' || a.severity === 'warning'));
  }
  function renderAlerts() {
    const open = data.alerts;
    $('nAction').textContent = open.filter((a) => (a.severity === 'critical' || a.severity === 'warning') && !a.acknowledged_at).length;
    $('nGood').textContent = open.filter((a) => a.severity === 'good').length;
    $('nOpen').textContent = open.length; $('nResolved').textContent = (data.resolved || []).length;
    const list = filteredAlerts().slice().sort((a, b) => (a.acknowledged_at ? 1 : 0) - (b.acknowledged_at ? 1 : 0));
    $('alerts').innerHTML = list.length ? list.map((a) => alertRow(a, filter === 'resolved')).join('')
      : `<div class="empty-ok">${filter === 'action' ? '✓ Nothing needs your attention.' : 'Nothing here.'}</div>`;
    $('ackAll').hidden = filter === 'resolved' || !list.some((a) => !a.acknowledged_at);
  }

  function seriesFor(book, days) {
    const src = mode === 'live' ? data.books.live_daily || [] : data.books.paper_daily || [];
    const key = mode === 'live' ? 'pnl_usd' : 'r_sum', by = new Map();
    for (const d of src) if (d.book === book) by.set(String(d.day).slice(0, 10), Number(d[key] || 0));
    let cum = 0; return days.map((d) => (cum += by.get(d) ?? 0));
  }
  function renderBooks() {
    document.querySelectorAll('#bookMode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === mode)));
    document.querySelectorAll('#bookRange button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.d) === range)));
    const days = []; for (let i = range - 1; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    const fmt = mode === 'live' ? (v, axis) => axis ? usd(v) : usd(v, true) : (v) => rr(v, 1);
    const src = mode === 'live' ? data.books.live_daily || [] : data.books.paper_daily || [];
    const has = src.some((d) => days.includes(String(d.day).slice(0, 10)));
    $('bookModeNote').textContent = mode === 'live' ? 'Actual closed results on the connected A-book and B-book accounts, added up day by day.'
      : 'What copying A-book traders and reversing B-book live traders would have made, from saved prices (in R per trade added up).';
    const series = [{ name: 'A-book', color: '#3987e5', values: seriesFor('a', days) }, { name: 'B-book', color: '#d95926', values: seriesFor('b', days) }];
    $('bookLegend').innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('');
    const el = $('bookChart');
    if (!has) {
      el.innerHTML = `<div class="empty-ok">${mode === 'live' ? 'No real-money book trades yet. They start once the A-book / B-book accounts are connected and a trader is promoted.' : 'No replays yet. Replays need prices saved around each trade; they build up from the first trades after the market opens.'}</div>`;
    } else lineChart(el, days, series, fmt, (d, long) => { const x = new Date(d + 'T12:00:00Z'); return x.toLocaleDateString('en-GB', long ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' }); });

    const ex = data.books.execution || {}, paper = data.books.paper_daily || [];
    const stat = (book, title, color) => {
      const e = ex[book] || {}, p = paper.filter((d) => d.book === book && days.includes(String(d.day).slice(0, 10)));
      const pt = p.reduce((a, d) => a + Number(d.trades), 0), pr = p.reduce((a, d) => a + Number(d.r_sum), 0);
      const cum = seriesFor(book, days); let peak = 0, dd = 0; for (const v of cum) { peak = Math.max(peak, v); dd = Math.max(dd, peak - v); }
      return `<div class="bstat"><h3><i style="width:14px;height:2px;background:${color};display:inline-block"></i>${title}</h3><dl>
        <dt>Real trades closed (30d)</dt><dd>${e.closed ?? 0}</dd><dt>Win rate</dt><dd>${e.closed ? pct(e.wins / e.closed) : '—'}</dd>
        <dt>Real result (30d)</dt><dd class="${signCls(e.pnl)}">${usd(e.pnl ?? 0, true)}</dd><dt>Broken orders</dt><dd>${e.errors ?? 0}</dd>
        <dt>Order speed (typical / slow)</dt><dd>${fin(e.p50_latency_ms) ? Math.round(e.p50_latency_ms) + ' / ' + Math.round(e.p95_latency_ms) + ' ms' : '—'}</dd>
        <dt>Replay trades (${range}d)</dt><dd>${pt}</dd><dt>Replay avg per trade</dt><dd class="${signCls(pr)}">${pt ? rr(pr / pt) : '—'}</dd>
        <dt>Biggest fall (${mode === 'live' ? '$' : 'R'})</dt><dd>${mode === 'live' ? usd(-dd) : rr(-dd, 1)}</dd></dl></div>`;
    };
    $('bookStats').innerHTML = stat('a', 'A-book (copy)', '#3987e5') + stat('b', 'B-book (reverse)', '#d95926');
    const sk = data.books.skips || [], max = Math.max(1, ...sk.map((s) => s.n));
    $('skips').innerHTML = sk.length ? sk.slice(0, 8).map((s) => `<div class="skip"><span title="${esc(s.reason)}">${esc(plainReason(s.reason))} <span class="small">· ${s.book === 'ladder' ? 'prop' : s.book.toUpperCase() + '-book'}</span></span><span class="bar"><span style="width:${(s.n / max * 100).toFixed(0)}%"></span></span><b class="num">${s.n}</b></div>`).join('')
      : '<div class="small">None in the last 24 hours.</div>';
  }

  const REASONS = [[/crowded/, 'Too many copies of the same trade (crowding cap)'], [/no stop loss/, 'Trader used no stop loss'], [/daily loss stop/, 'Daily loss stop reached'],
    [/profit cap/, 'Daily profit cap reached'], [/no connected destination|destination not connected/, 'No account connected'], [/treasury short/, 'B-book paused: payout cover short'],
    [/open risk/, 'Open-risk limit reached'], [/per trader|per-trader/, 'Per-trader limit reached'], [/symbol|lots/, 'Instrument size limit reached'], [/below broker minimum/, 'Too small for the broker'],
    [/instrument not available/, 'Instrument not on that account'], [/route changed/, 'Trader changed box before the copy'], [/halt/, 'Books halted']];
  const plainReason = (r) => (REASONS.find(([re]) => re.test(String(r).toLowerCase())) || [null, String(r).replace(/^risk: /, '')])[1];
  const traderById = () => new Map(data.traders.map((t) => [t.person_id, t]));
  function wlItem(t, why, val, cls = '') {
    return `<li tabindex="0" data-person="${esc(t.person_id)}"><div><b>${esc(t.name)}</b><div class="why">${esc(why)} · ${esc(STATES[t.book_state]?.label || t.book_state)}</div></div><span class="val ${cls}">${esc(val)}</span></li>`;
  }
  function renderWatch() {
    const has = (t, tag) => (t.metrics?.tags || []).includes(tag);
    const good = data.traders.filter((t) => has(t, 'STAR') || has(t, 'EARNER')).sort((a, b) => Number(b.metrics.proof_copy || 0) - Number(a.metrics.proof_copy || 0));
    $('wlGood').innerHTML = good.length ? good.map((t) => has(t, 'STAR') ? wlItem(t, 'Proven copy edge', rr(t.metrics.copy_r) + '/trade', 'pos') : wlItem(t, 'Proven B-book earner', rr(t.metrics.reverse_r) + '/trade', 'pos')).join('')
      : '<li class="empty-ok" style="cursor:default">No one has proven skill yet. Proof needs 40+ replayed trades over 20+ days per trader.</li>';
    const risk = [];
    for (const t of data.traders) {
      if (has(t, 'RINSE')) risk.push([0, -Number(t.metrics.expected_payout || 0), wlItem(t, `Likely payout (${pct(t.metrics.p_graduate)} chance), not copied`, usd(t.metrics.expected_payout), 'neg')]);
      if (has(t, 'FADING')) risk.push([1, Number(t.metrics.ewma_copy || 0), wlItem(t, 'Copied, getting worse', rr(t.metrics.ewma_copy) + ' recent', 'neg')]);
      if (has(t, 'TURNING')) risk.push([1, Number(t.metrics.ewma_reverse || 0), wlItem(t, 'B-book live, turning profitable', rr(t.metrics.ewma_reverse) + ' recent', 'neg')]);
    }
    risk.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    $('wlRisk').innerHTML = risk.length ? risk.map((r) => r[2]).join('') : '<li class="empty-ok" style="cursor:default">No money risks flagged.</li>';
    const order = ['SUSPENDED', 'HOLD', 'FLAG', 'SPEED', 'BREACHED', 'BIG_LOSS', 'NO_SL', 'FAST', 'HERD'], rules = [];
    for (const t of data.traders) { const hit = order.filter((k) => has(t, k)); if (hit.length) rules.push([order.indexOf(hit[0]), wlItem(t, hit.map((k) => TAGS[k].label).join(', '), TAGS[hit[0]].sev === 'critical' ? 'Urgent' : 'Watch', TAGS[hit[0]].sev === 'critical' ? 'neg' : '')]); }
    rules.sort((a, b) => a[0] - b[0]);
    $('wlRules').innerHTML = rules.length ? rules.map((r) => r[1]).join('') : '<li class="empty-ok" style="cursor:default">No rule problems.</li>';
  }

  const SORTERS = {
    name: (t) => (t.name || '').toLowerCase(), box: (t) => ['AB_LIVE', 'AB_DEMO', 'BB_LIVE', 'BB_DEMO', 'SUSPENDED'].indexOf(t.book_state),
    trades: (t) => t.metrics?.trades ?? -1, win_rate: (t) => t.metrics?.win_rate ?? -1, pnl_usd: (t) => t.metrics?.pnl_usd ?? -1e12, avg_r: (t) => t.metrics?.avg_r ?? -1e9,
    copy_r: (t) => t.metrics?.copy_r ?? -1e9, reverse_r: (t) => t.metrics?.reverse_r ?? -1e9, proof: (t) => proofOf(t) ?? -1, max_dd_r: (t) => t.metrics?.max_dd_r ?? -1,
    expected_payout: (t) => t.metrics?.expected_payout ?? -1, last: (t) => Date.parse(t.metrics?.last_trade_at || t.last_trade_at || 0) || 0,
  };
  const proofOf = (t) => t.book_state === 'BB_LIVE' ? t.metrics?.proof_reverse : t.metrics?.proof_copy;
  function boardRows() {
    const q = $('search').value.trim().toLowerCase(), tg = $('tagFilter').value;
    const rows = data.traders.filter((t) => (tab === 'ALL' || t.book_state === tab) && (!tg || (t.metrics?.tags || []).includes(tg))
      && (!q || (t.name || '').toLowerCase().includes(q) || t.person_id.startsWith(q)));
    const f = SORTERS[sortKey] || SORTERS.last, dir = sortDir === 'asc' ? 1 : -1;
    return rows.sort((a, b) => { const x = f(a), y = f(b); return x < y ? -dir : x > y ? dir : 0; });
  }
  function renderBoard() {
    const c = data.counts || {};
    $('boxTabs').innerHTML = [['ALL', 'All', data.traders.length], ...Object.keys(STATES).map((k) => [k, STATES[k].label, c[k] || 0])]
      .map(([k, l, n]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${esc(l)} <b>${n}</b></button>`).join('');
    const tags = new Set(data.traders.flatMap((t) => t.metrics?.tags || [])), cur = $('tagFilter').value;
    $('tagFilter').innerHTML = '<option value="">Any tag</option>' + Object.keys(TAGS).filter((k) => tags.has(k)).map((k) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(TAGS[k].label)}</option>`).join('');
    document.querySelectorAll('#board th[data-k]').forEach((th) => { if (th.dataset.k === sortKey) th.dataset.sort = sortDir; else delete th.dataset.sort; });
    const rows = boardRows();
    $('boardBody').innerHTML = rows.length ? rows.slice(0, shown).map((t) => {
      const m = t.metrics || {}, rev = t.book_state === 'BB_LIVE';
      return `<tr tabindex="0" data-person="${esc(t.person_id)}"><td class="who"><b>${esc(t.name)}</b><div class="tags">${tagChips(m.tags)}</div></td>
        <td class="box">${esc(STATES[t.book_state]?.label || t.book_state)}<small>${t.state_since ? 'for ' + dur(t.state_since) : ''}</small></td>
        <td class="num">${m.trades ?? 0}<div class="small">${m.trades_30d ?? 0} in 30d</div></td><td class="num">${pct(m.win_rate)}</td>
        <td class="num ${signCls(m.pnl_usd)}">${usd(m.pnl_usd, true)}</td><td class="num ${signCls(m.avg_r)}">${rr(m.avg_r)}</td><td>${spark(m.curve)}</td>
        <td class="num ${signCls(m.copy_r)}">${rr(m.copy_r)}</td><td class="num ${signCls(m.reverse_r)}">${rr(m.reverse_r)}</td>
        <td class="proof">${meter(proofOf(t))}<div class="small">${rev ? 'reverse' : 'copy'} · ${m.replayed ?? 0} replays</div></td>
        <td class="num">${fin(m.max_dd_r) ? '−' + Number(m.max_dd_r).toFixed(1) + 'R' : '—'}</td><td class="num">${fin(m.expected_payout) && m.expected_payout > 0 ? usd(m.expected_payout) : '—'}</td>
        <td class="num">${ago(m.last_trade_at || t.last_trade_at)}</td></tr>`;
    }).join('') : '<tr><td colspan="13" class="empty">No traders match.</td></tr>';
    $('boardCount').textContent = `Showing ${Math.min(shown, rows.length)} of ${rows.length} traders`;
    $('more').hidden = rows.length <= shown;
  }

  function renderMoves() {
    const ev = data.events || [];
    $('moves').innerHTML = ev.length ? ev.map((e) => `<li><time datetime="${esc(e.created_at)}">${esc(new Date(e.created_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }))}</time>
      <div><b data-person="${esc(e.person_id)}" style="cursor:pointer">${esc(e.name)}</b>: ${esc(STATES[e.from_state]?.label || e.from_state)} → <b>${esc(STATES[e.to_state]?.label || e.to_state)}</b><div class="small">${esc(e.reason)}${e.policy_version ? ' · policy v' + e.policy_version : ''}</div></div></li>`).join('')
      : '<li class="empty-ok">No moves yet. Everyone starts on B-book demo (watching).</li>';
  }
  function renderHealth() {
    const h = data.health, beatName = { 'ab-classifier': 'Classifier (moves traders between boxes)', 'brain-scan': 'Alert scan (this page)' };
    const rows = h.jobs.map((j) => `<div class="health-row"><span class="sev ${j.ok ? 'good' : 'critical'}"><i>${j.ok ? '✓' : '!'}</i></span><span>${esc(j.title)}</span><span class="small">${j.age_s == null ? 'no run found' : 'ran ' + ago(new Date(Date.now() - j.age_s * 1000).toISOString())}</span></div>`);
    for (const b of h.heartbeats || []) {
      const ok = b.ok && Date.now() - Date.parse(b.at) < 15 * 60000;
      rows.push(`<div class="health-row"><span class="sev ${ok ? 'good' : 'critical'}"><i>${ok ? '✓' : '!'}</i></span><span>${esc(beatName[b.worker] || b.worker)}${!b.ok && b.detail?.error ? ' · ' + esc(b.detail.error) : ''}</span><span class="small">${ago(b.at)}</span></div>`);
    }
    const pAge = h.prices_at ? (Date.now() - Date.parse(h.prices_at)) / 1000 : null, pOk = !h.market_open || (pAge != null && pAge < 120);
    rows.push(`<div class="health-row"><span class="sev ${pOk ? 'good' : 'critical'}"><i>${pOk ? '✓' : '!'}</i></span><span>Live prices · market ${h.market_open ? 'open' : 'closed'}</span><span class="small">newest ${h.prices_at ? ago(h.prices_at) : 'never'}</span></div>`);
    $('health').innerHTML = rows.join('');
  }

  function render() {
    renderHero(); renderTiles(); renderAlerts(); renderBooks(); renderWatch(); renderBoard(); renderMoves(); renderHealth();
  }

  // ---------- notifications ----------
  function notifyNew() {
    const open = data.alerts.filter((a) => !a.acknowledged_at);
    const ids = new Set(open.map((a) => a.id));
    if (knownAlerts) {
      const fresh = open.filter((a) => !knownAlerts.has(a.id) && a.severity !== 'info');
      const urgent = fresh.filter((a) => a.severity === 'critical');
      if (fresh.length && 'Notification' in window && Notification.permission === 'granted') {
        for (const a of fresh.slice(0, 3)) try { new Notification((a.severity === 'critical' ? 'URGENT · ' : a.severity === 'good' ? 'Good news · ' : 'Watch · ') + a.title, { body: a.detail || '', tag: 'brain-' + a.id }); } catch (_) {}
        if (fresh.length > 3) try { new Notification(`IPFX Brain: ${fresh.length - 3} more new alerts`); } catch (_) {}
      }
      if (urgent.length && $('soundToggle').checked) beep();
    }
    knownAlerts = ids;
  }
  function beep() {
    try { const ctx = new (window.AudioContext || window.webkitAudioContext)(); const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.35); } catch (_) {}
  }
  function syncNotifyBtn() {
    const b = $('notifyBtn');
    if (!('Notification' in window)) { b.hidden = true; return; }
    b.textContent = Notification.permission === 'granted' ? 'Desktop alerts on' : Notification.permission === 'denied' ? 'Desktop alerts blocked' : 'Turn on desktop alerts';
    b.disabled = Notification.permission !== 'default';
  }

  // ---------- drawer ----------
  async function openTrader(id) {
    const t = traderById().get(id); const drawer = $('drawer');
    $('dName').textContent = t?.name || 'Trader ' + id.slice(0, 6); $('dBox').textContent = STATES[t?.book_state]?.label || ''; $('dTags').innerHTML = tagChips(t?.metrics?.tags);
    $('dBody').innerHTML = '<p class="muted">Loading…</p>';
    drawer.setAttribute('aria-hidden', 'false'); $('scrim').hidden = false; $('dClose').focus();
    try { renderTrader(t, await call('trader', { person_id: id })); } catch (e) { $('dBody').innerHTML = `<p class="negative">${esc(e.message)}</p>`; }
  }
  function closeDrawer() { $('drawer').setAttribute('aria-hidden', 'true'); $('scrim').hidden = true; hideTip(); }
  function renderTrader(t, d) {
    const m = d.metrics || t?.metrics || {}, p = d.profile || {};
    const kv = [['Trades', m.trades ?? 0], ['Win rate', pct(m.win_rate)], ['P&L on IPFX', usd(m.pnl_usd, true)], ['Avg per trade', rr(m.avg_r)],
      ['Profit factor', fin(m.profit_factor) ? Number(m.profit_factor).toFixed(2) : '—'], ['Biggest fall', fin(m.max_dd_r) ? '−' + Number(m.max_dd_r).toFixed(1) + 'R' : '—'],
      ['Copy edge', rr(m.copy_r)], ['Reverse edge', rr(m.reverse_r)], ['Proof (copy)', fin(m.proof_copy) ? (m.proof_copy >= 10 ? 'Proven' : Number(m.proof_copy).toFixed(1) + ' / 10') : '—'],
      ['Proof (reverse)', fin(m.proof_reverse) ? (m.proof_reverse >= 10 ? 'Proven' : Number(m.proof_reverse).toFixed(1) + ' / 10') : '—'],
      ['IPFX vs copy gap', rr(m.copy_gap)], ['Trades under 60s', pct(m.under_60s_share)], ['No stop loss', pct(m.no_sl_share)], ['Biggest single win share', pct(m.best_share)],
      ['Likely payout', fin(m.expected_payout) ? usd(m.expected_payout) : '—'], ['Chance of payout', pct(m.p_graduate)]];
    const trades = d.trades || [];
    const tradeRows = trades.slice(0, 25).map((x) => `<tr><td>${esc(new Date(x.closed_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }))}</td><td>${esc(x.symbol)} ${esc(x.side)}</td><td class="num">${esc(x.volume)}</td>
      <td class="num ${signCls(x.trader_pnl_usd)}">${usd(x.trader_pnl_usd, true)}</td><td class="num">${rr(x.trader_r)}</td><td class="num">${rr(x.same_r)}</td><td class="num">${rr(x.reverse_r)}</td>
      <td>${x.risk_basis === 'STOP_LOSS' ? 'Stop loss' : '<span class="tag warning">No SL</span>'}</td><td class="num">${fin(x.hold_seconds) ? (x.hold_seconds < 120 ? Math.round(x.hold_seconds) + 's' : Math.round(x.hold_seconds / 60) + 'm') : '—'}</td></tr>`).join('');
    $('dBody').innerHTML = `
      <div class="why-box"><b>${esc(STATES[p.book_state]?.label || '')}</b> since ${p.state_since ? esc(new Date(p.state_since).toLocaleDateString('en-GB')) : '—'} · ${esc(STATES[p.book_state]?.why || '')}<br><span class="small">Why: ${esc(p.state_reason || 'Everyone starts here')}</span></div>
      <div class="kv">${kv.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
      <div class="two"><div><h3>Running total of results (R), last ${(m.curve || []).length} trades</h3><div class="chart" id="dCurve"></div></div><div><h3>Wins and losses by size</h3><div class="chart" id="dHist"></div></div></div>
      ${(d.alerts || []).length ? `<h3>Alerts</h3>${d.alerts.map((a) => alertRow(a, !!a.resolved_at)).join('')}` : ''}
      <h3>Accounts</h3><table><thead><tr><th>Account</th><th>Type</th><th>Status</th><th class="num">Balance</th><th>Rule issue</th></tr></thead><tbody>${(d.accounts || []).map((a) => `<tr><td>${esc(a.label || String(a.id).slice(0, 8))}</td><td>${esc(a.challenge_type)}${a.stage ? ' · stage ' + esc(a.stage) : ''}</td><td>${esc(a.status)}${a.investigation_hold ? ' · <span class="tag critical">hold</span>' : ''}${a.access_revoked_at ? ' · revoked' : ''}</td><td class="num">${usd(a.balance)} <span class="small">of ${usd(a.starting_balance)}</span></td><td>${a.breach_reason ? `<span class="tag critical">${esc(a.breach_reason)}</span> ${esc(new Date(a.breached_at).toLocaleDateString('en-GB'))}` : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No accounts.</td></tr>'}</tbody></table>
      <h3>Recent trades</h3><div class="table-wrap" style="max-height:360px"><table><thead><tr><th>Closed</th><th>Trade</th><th class="num">Lots</th><th class="num">P&amp;L</th><th class="num">R</th><th class="num">Copy</th><th class="num">Reverse</th><th>Risk</th><th class="num">Held</th></tr></thead><tbody>${tradeRows || '<tr><td colspan="9" class="empty">No closed trades.</td></tr>'}</tbody></table></div>
      <h3>Moves</h3><ol class="moves">${(d.events || []).map((e) => `<li><time>${esc(new Date(e.at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }))}</time><div>${esc(STATES[e.from]?.label || e.from)} → <b>${esc(STATES[e.to]?.label || e.to)}</b><div class="small">${esc(e.reason)}</div></div></li>`).join('') || '<li class="small">No moves yet.</li>'}</ol>
      ${(d.book_orders || []).length ? `<h3>Book orders</h3><table><thead><tr><th>When</th><th>Book</th><th>Order</th><th>Status</th><th class="num">Result</th></tr></thead><tbody>${d.book_orders.map((o) => `<tr><td>${esc(new Date(o.created_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }))}</td><td>${esc(o.book)}</td><td>${esc(o.event)} ${esc(o.symbol)} ${esc(o.side)} ${esc(o.qty)}</td><td>${esc(o.status)}${o.error ? ' · ' + esc(o.error) : ''}</td><td class="num">${usd(o.pnl_usd, true)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${(d.skips || []).length ? `<h3>Copies that did not happen</h3><ul class="small">${d.skips.map((s) => `<li>${esc(new Date(s.at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }))} · ${esc(s.book)} · ${esc(plainReason(s.reason))}</li>`).join('')}</ul>` : ''}`;
    const curve = m.curve || [];
    if (curve.length > 1) lineChart($('dCurve'), curve.map((_, i) => i + 1), [{ name: 'Total', color: '#3987e5', values: curve }], (v) => rr(v, 1), (i, long) => long ? 'Trade ' + i : String(i));
    else $('dCurve').innerHTML = '<div class="empty-ok">Needs 2+ trades with a measurable risk.</div>';
    histogram($('dHist'), trades.map((x) => Number(x.trader_r)).filter(Number.isFinite));
  }
  function histogram(el, rs) {
    if (!rs.length) { el.innerHTML = '<div class="empty-ok">No measurable trades.</div>'; return; }
    const bins = [['≤−3', -Infinity, -3], ['−3…−2', -3, -2], ['−2…−1', -2, -1], ['−1…0', -1, 0], ['0…1', 0, 1], ['1…2', 1, 2], ['2…3', 2, 3], ['≥3', 3, Infinity]]
      .map(([l, a, b]) => ({ l, loss: b <= 0, n: rs.filter((x) => x >= a && x < b).length }));
    const W = Math.max(220, el.clientWidth), H = el.clientHeight || 200, P = { l: 8, r: 8, t: 14, b: 22 }, max = Math.max(...bins.map((b) => b.n)), bw = (W - P.l - P.r) / bins.length;
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const add = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.append(e); return e; };
    add('line', { x1: P.l, x2: W - P.r, y1: H - P.b, y2: H - P.b, class: 'base' });
    bins.forEach((b, i) => {
      const h = max ? (b.n / max) * (H - P.t - P.b) : 0, x = P.l + i * bw + 2, y = H - P.b - h;
      if (b.n) { const r = add('path', { d: `M${x} ${H - P.b} V${y + 4} Q${x} ${y} ${x + 4} ${y} H${x + bw - 8} Q${x + bw - 4} ${y} ${x + bw - 4} ${y + 4} V${H - P.b} Z`, fill: b.loss ? '#e66767' : '#3987e5' });
        r.addEventListener('pointermove', (e) => showTip(e.clientX, e.clientY, b.l + 'R', [[b.loss ? '#e66767' : '#3987e5', String(b.n), b.n === 1 ? 'trade' : 'trades']])); r.addEventListener('pointerleave', hideTip);
        add('text', { x: x + (bw - 4) / 2, y: y - 3, 'text-anchor': 'middle' }, String(b.n)); }
    });
    [-3, -2, -1, 0, 1, 2, 3].forEach((v, i) => add('text', { x: P.l + (i + 1) * bw, y: H - 6, 'text-anchor': 'middle' }, (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + 'R'));
    el.replaceChildren(svg);
  }

  // ---------- load loop ----------
  async function load() {
    if (busy) return; busy = true; $('refresh').disabled = true; document.querySelector('main').classList.add('loading');
    try {
      data = await call('overview'); lastLoad = Date.now(); render(); notifyNew();
      $('status').textContent = (FIXTURE ? 'DESIGN PREVIEW · made-up data · ' : 'Owner-only · MFA protected · ') + 'updated ' + new Date().toLocaleTimeString('en-GB');
    } catch (e) { $('status').textContent = e.message; }
    finally { busy = false; $('refresh').disabled = false; document.querySelector('main').classList.remove('loading'); }
  }

  $('refresh').addEventListener('click', load);
  $('notifyBtn').addEventListener('click', async () => { try { await Notification.requestPermission(); } catch (_) {} syncNotifyBtn(); });
  $('soundToggle').checked = store.get('sound', false); $('soundToggle').addEventListener('change', (e) => store.set('sound', e.target.checked));
  $('helpBtn').addEventListener('click', () => { $('helpBody').innerHTML = HELP.map(([k, v]) => `<div><b>${esc(k)}</b><p>${esc(v)}</p></div>`).join(''); $('help').showModal(); });
  $('alertFilter').addEventListener('click', (e) => { const b = e.target.closest('button[data-f]'); if (!b) return; filter = b.dataset.f; document.querySelectorAll('#alertFilter button').forEach((x) => x.setAttribute('aria-selected', String(x === b))); renderAlerts(); });
  $('bookMode').addEventListener('click', (e) => { const b = e.target.closest('button[data-m]'); if (!b || !data) return; mode = b.dataset.m; store.set('mode', mode); renderBooks(); });
  $('bookRange').addEventListener('click', (e) => { const b = e.target.closest('button[data-d]'); if (!b || !data) return; range = Number(b.dataset.d); store.set('range', range); renderBooks(); });
  $('boxTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (!b) return; tab = b.dataset.tab; shown = 100; renderBoard(); });
  $('search').addEventListener('input', () => { shown = 100; if (data) renderBoard(); });
  $('tagFilter').addEventListener('change', () => { shown = 100; if (data) renderBoard(); });
  $('more').addEventListener('click', () => { shown += 100; renderBoard(); });
  document.querySelector('#board thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-k]'); if (!th || !data) return;
    sortDir = sortKey === th.dataset.k && sortDir === 'desc' ? 'asc' : 'desc'; sortKey = th.dataset.k; store.set('sort', sortKey); store.set('dir', sortDir); renderBoard();
  });
  $('ackAll').addEventListener('click', async () => {
    const ids = filteredAlerts().filter((a) => !a.acknowledged_at).map((a) => a.id); if (!ids.length) return;
    try { await call('ack', { ids }); for (const a of data.alerts) if (ids.includes(a.id)) a.acknowledged_at = new Date().toISOString(); renderHero(); renderAlerts(); } catch (err) { $('status').textContent = err.message; }
  });
  document.addEventListener('click', async (e) => {
    const ack = e.target.closest('[data-ack]');
    if (ack) { const id = Number(ack.dataset.ack); try { await call('ack', { id }); const a = data.alerts.find((x) => x.id === id); if (a) a.acknowledged_at = new Date().toISOString(); renderHero(); renderAlerts(); } catch (err) { $('status').textContent = err.message; } return; }
    const p = e.target.closest('[data-person]'); if (p && data) openTrader(p.dataset.person);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('drawer').getAttribute('aria-hidden') === 'false') closeDrawer();
    if (e.key === 'Enter' && e.target.matches('tr[data-person],li[data-person]')) openTrader(e.target.dataset.person);
  });
  $('dClose').addEventListener('click', closeDrawer); $('scrim').addEventListener('click', closeDrawer);
  addEventListener('resize', () => { if (data) renderBooks(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastLoad > 10000) load(); });
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
  syncNotifyBtn(); load();
})();
