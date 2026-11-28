// IPFX Markets on phones (screens up to 760px wide, or a touch screen under 520px tall, i.e. a phone held sideways).
// Adds a bottom tab bar (Chart, Trade, Positions, Account), docks the desktop quick-trade bar under the chart, and adds
// an instrument button, equity and a few account shortcuts. It never places an order itself: Sell/Buy are the desktop's
// own ticket controls, so the stop-loss set-up, risk checks and fills are exactly the desktop ones. On wider screens it
// does nothing visible (the elements are hidden and assets/css/markets-phone.css is not loaded).
(function () {
  'use strict';

  // ── Early access (13 Nov 2026) ──
  // On ipfxcapital.com the phone version is switched on only for the accounts listed here (the owner's account first),
  // so every other trader keeps today's site until it is released to all. Set RELEASED_TO_EVERYONE to true for that.
  // Local previews, the Wi-Fi preview and the IPFX app always show it.
  const RELEASED_TO_EVERYONE = false;
  const EARLY_ACCESS_ACCOUNTS = ['f77286ef-8b51-47f3-b6b7-a62f541a4239']; // paulade491
  const SB_AUTH_KEY = 'sb-agulweemteoeagscmppy-auth-token';
  function signedInAccountId() {
    try {
      let raw = localStorage.getItem(SB_AUTH_KEY);
      if (raw === null) { let acc = '', i = 0, part; while ((part = localStorage.getItem(SB_AUTH_KEY + '.' + i)) !== null) { acc += part; i++; } raw = acc || null; }
      if (!raw) return null;
      if (raw.startsWith('base64-')) raw = new TextDecoder().decode(Uint8Array.from(atob(raw.slice(7)), (c) => c.charCodeAt(0)));
      const s = JSON.parse(raw), sess = s && s.user ? s : (s && s.currentSession) || null;
      return (sess && sess.user && sess.user.id) || null;
    } catch (_) { return null; }
  }
  // Once an early-access account has signed in on a phone, that phone keeps the phone version (also when signed out).
  // trading.html?phone=1 switches it on for this browser before signing in; ?phone=0 switches it off again.
  const DEVICE_KEY = 'ipfx-phone-early-access';
  function remember(on) { try { if (on) localStorage.setItem(DEVICE_KEY, '1'); else localStorage.removeItem(DEVICE_KEY); } catch (_) {} }
  function remembered() { try { return localStorage.getItem(DEVICE_KEY) === '1'; } catch (_) { return false; } }
  const flag = new URLSearchParams(location.search).get('phone');
  if (flag === '1') remember(true); else if (flag === '0') remember(false);
  // An app opened from the Home Screen (or the IPFX app) has its own storage, so it cannot see the flag above: running
  // as an installed app always means the phone version.
  const installedApp = () => { try { return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; } catch (_) { return false; } };
  function phoneVersionOn() {
    if (RELEASED_TO_EVERYONE || window.Capacitor) return true;
    if (installedApp()) { remember(true); return true; }
    if (!/(^|\.)ipfxcapital\.com$/i.test(location.hostname)) return true;
    if (EARLY_ACCESS_ACCOUNTS.includes(signedInAccountId())) { remember(true); return true; }
    // Early access claimed from the email (assets/js/phone-early-access.js asks the database once per account).
    if (!remembered() && typeof window.ipfxCheckPhoneEarlyAccess === 'function') window.ipfxCheckPhoneEarlyAccess();
    return remembered();
  }
  let started = false;
  function start() {
    if (started) return; started = true;
    const css = document.getElementById('marketsPhoneCss');
    if (css && css.dataset.phoneMedia) css.media = css.dataset.phoneMedia;
    runPhone();
  }
  // Opened from the Home Screen while signed out (25 Nov 2026): the sign-in sheet opens straight away, on Markets, so the
  // trader never lands on the homepage. After signing in they are already in Markets.
  if (installedApp() && !window.Capacitor) {
    const askSignIn = () => setTimeout(() => {
      try { if (typeof hasSession === 'function' && !hasSession() && typeof window.openDesktopAuth === 'function') window.openDesktopAuth(); } catch (_) {}
    }, 1200);
    if (document.readyState === 'complete') askSignIn(); else window.addEventListener('load', askSignIn);
  }
  if (phoneVersionOn()) start();
  else { const t = setInterval(() => { if (phoneVersionOn()) { clearInterval(t); start(); } }, 2000); } // switches on right after signing in

  function runPhone() {
  const MQ = window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-height: 520px)');
  const KEY = 'ipfx-phone-tab';
  const TABS = ['chart', 'trade', 'positions', 'challenge', 'account'];
  const ICONS = {
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg>',
    trade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16"/><path d="M3 8l4-4 4 4"/><path d="M17 20V4"/><path d="M21 16l-4 4-4-4"/></svg>',
    positions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M9 16h6"/></svg>',
    challenge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l5-5"/></svg>',
    account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  };
  const LABELS = { chart: 'Chart', trade: 'Trade', positions: 'Positions', challenge: 'Challenge', account: 'Account' };
  // Bottom-panel sections behind each bottom tab. Positions is a three-way switch; Challenge is a page of its own.
  const GROUPS = {
    positions: ['positions', 'pending', 'closed'],
    challenge: ['challenge'],
    account: ['account', 'orders', 'risk', 'journal', 'alerts', 'statement'],
  };
  const $ = (id) => document.getElementById(id);
  let built = false, current = null, lastBtab = { positions: 'positions', challenge: 'challenge', account: 'account' }, priceTimer = 0;

  // Hide the phone-only elements everywhere except in phone mode, without needing the phone stylesheet.
  const base = document.createElement('style');
  base.textContent = 'html:not(.phone) .ph-only{display:none!important}';
  document.head.appendChild(base);

  function btabId(el) { const m = /switchBtab\('([a-z]+)'/.exec(el.getAttribute('onclick') || ''); return m ? m[1] : ''; }
  function btabEl(id) { return [...document.querySelectorAll('.btab')].find((b) => btabId(b) === id) || null; }

  function build() {
    if (built) return;
    const body = document.body;
    if (!body || !$('guidePanel') || !$('btmOuter')) return;
    built = true;

    // Tab bar
    const bar = document.createElement('nav');
    bar.className = 'ph-tabbar ph-only'; bar.id = 'phTabbar'; bar.setAttribute('role', 'tablist'); bar.setAttribute('aria-label', 'Markets');
    bar.innerHTML = TABS.map((t) => `<button type="button" role="tab" data-ptab="${t}" id="phTab-${t}" aria-selected="false">${ICONS[t]}<span>${LABELS[t]}</span>${t === 'positions' ? '<b class="ph-badge" id="phPosBadge" hidden>0</b>' : ''}</button>`).join('');
    bar.addEventListener('click', (e) => { const b = e.target.closest('button[data-ptab]'); if (b) setTab(b.dataset.ptab, true); });
    body.appendChild(bar);

    // Quick-trade bar under the chart: the desktop quick ticket, docked full width. It is the
    // desktop's own remote control for the order ticket (same lots, stop, take profit, risk checks and order path), so
    // nothing about how an order is placed changes. Shown on the Chart tab; "open the full ticket" goes to Trade.
    const origShow = window.qtShouldShow, origFull = window.qtOpenFull;
    if (typeof origShow === 'function') window.qtShouldShow = () => (MQ.matches ? current === 'chart' : origShow());
    if (typeof origFull === 'function') window.qtOpenFull = () => (MQ.matches ? setTab('trade', true) : origFull());

    // Timeframes: one button showing the current one; tap it to pick another (like "5m").
    const tb = $('chartToolbar');
    if (tb) {
      tb.addEventListener('click', (e) => {
        if (!MQ.matches) return;
        const b = e.target.closest('.tf-btn, .style-btn[data-style]'); if (!b) return;
        if (!tb.classList.contains('ph-tf-open')) { e.preventDefault(); e.stopImmediatePropagation(); tb.classList.add('ph-tf-open'); b.scrollIntoView({ inline: 'center', block: 'nearest' }); return; }
        setTimeout(() => tb.classList.remove('ph-tf-open'), 0);
      }, true);
      document.addEventListener('click', (e) => { if (!e.target.closest('#chartToolbar')) tb.classList.remove('ph-tf-open'); });
      // Indicators, next to the timeframe (opens them in the Trade tab).
      const ind = document.createElement('button');
      ind.type = 'button'; ind.id = 'phInd'; ind.className = 'ph-ind ph-only'; ind.setAttribute('aria-label', 'Indicators');
      ind.innerHTML = '<i>f</i><sub>x</sub>';
      ind.addEventListener('click', () => {
        setTab('trade', true);
        const g = [...document.querySelectorAll('.gtab')].find((x) => /switchTab\('ind'/.test(x.getAttribute('onclick') || ''));
        if (g && typeof window.switchTab === 'function') window.switchTab('ind', g);
      });
      tb.appendChild(ind);
      // Chart colours (candles and background), one tap away.
      const gear = document.createElement('button');
      gear.type = 'button'; gear.id = 'phGear'; gear.className = 'ph-gear ph-only'; gear.setAttribute('aria-label', 'Chart colours');
      gear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.6-.3-1.1-.6-1.5-.3-.4-.4-.9-.4-1.5 0-1.1.9-2 2-2h2.3A2.8 2.8 0 0 0 20.5 11 9 9 0 0 0 12 3z"/><circle cx="7.5" cy="11" r="1.1"/><circle cx="10" cy="7" r="1.1"/><circle cx="15" cy="7" r="1.1"/></svg>';
      gear.addEventListener('click', () => { if (window.ipfxColors) window.ipfxColors.toggle(); });
      tb.appendChild(gear);
    }

    // Balance in the top bar once signed in (as on most trading apps).
    const feed = $('feedBadge');
    if (feed && !$('phBal')) {
      const bal = document.createElement('button');
      bal.type = 'button'; bal.id = 'phBal'; bal.className = 'ph-bal ph-only'; bal.hidden = true;
      bal.setAttribute('aria-label', 'Account equity: open the Account tab');
      bal.addEventListener('click', () => setTab('account', true));
      feed.parentNode.insertBefore(bal, feed);
    }

    // Instrument button in the top bar (same picker as the ticket's instrument name).
    const right = document.querySelector('.topbar .tb-right');
    if (right) {
      const sym = document.createElement('button');
      sym.type = 'button'; sym.className = 'ph-sym ph-only'; sym.id = 'phSym';
      sym.setAttribute('aria-label', 'Change instrument');
      sym.innerHTML = '<span id="phSymName">EUR/USD</span><svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
      sym.addEventListener('click', () => { if (typeof window.openSymbolPicker === 'function') window.openSymbolPicker(); });
      const logo = document.querySelector('.topbar .tb-logo');
      (logo && logo.nextSibling) ? logo.parentNode.insertBefore(sym, logo.nextSibling) : right.parentNode.insertBefore(sym, right);
    }

    // Account shortcuts above the account panels.
    const outer = $('btmOuter'), header = outer.querySelector('.btm-header');
    if (header) {
      const acct = document.createElement('div');
      acct.className = 'ph-acct ph-only'; acct.id = 'phAcct';
      acct.innerHTML = '<a href="/dashboard.html">Dashboard</a>'
        + '<button type="button" id="phTheme">Light / dark</button>'
        + '<button type="button" id="phOneClickToggle" role="switch" aria-checked="false">One-click trading: off</button>'
        + '<a href="/feedback.html?from=trading-phone">Feedback</a>';
      acct.querySelector('#phTheme').addEventListener('click', () => { if (typeof window.toggleTheme === 'function') window.toggleTheme(); });
      // One-click trading on/off (when off, every order asks "BUY 0.01 lots ... at Market price?" first).
      const oc = acct.querySelector('#phOneClickToggle');
      const showOc = () => { const on = !!(window.ipfxOneClick && window.ipfxOneClick.on); oc.textContent = 'One-click trading: ' + (on ? 'on' : 'off'); oc.setAttribute('aria-checked', String(on)); };
      oc.addEventListener('click', () => { if (window.ipfxOneClick) window.ipfxOneClick.set(!window.ipfxOneClick.on); showOc(); });
      showOc(); setInterval(showOc, 3000);
      // Inside the scrolling area, so they scroll away and leave the screen to the account details.
      const scroller = outer.querySelector('.btm-body') || outer;
      const more = document.createElement('div');
      more.className = 'ph-acct-more ph-only'; more.id = 'phAcctMore';
      scroller.insertBefore(more, scroller.firstChild);
      scroller.insertBefore(acct, more);
      // Account is a menu: tap a row to open that page, and the back arrow returns to the menu.
      const MENU = [['account', 'Account details'], ['orders', 'Order history'], ['risk', 'Risk calculator'], ['journal', 'Journal'], ['alerts', 'Alerts'], ['statement', 'Statement']];
      const chev = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
      const menu = document.createElement('div');
      menu.id = 'phMenu'; menu.className = 'ph-menu ph-only';
      menu.innerHTML = MENU.map(([id, label]) => `<button type="button" data-id="${id}"><span>${label}</span>${chev}</button>`).join('');
      menu.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-id]'); if (!b) return;
        const el = btabEl(b.dataset.id); if (el && typeof window.switchBtab === 'function') window.switchBtab(b.dataset.id, el);
        lastBtab.account = b.dataset.id; $('phBackTitle').textContent = b.textContent.trim();
        document.documentElement.dataset.pmenu = 'panel'; scroller.scrollTop = 0;
      });
      scroller.insertBefore(menu, acct);
      const back = document.createElement('div');
      back.id = 'phBack'; back.className = 'ph-back ph-only';
      back.innerHTML = '<button type="button" aria-label="Back to Account"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button><b id="phBackTitle"></b>';
      back.querySelector('button').addEventListener('click', () => { document.documentElement.dataset.pmenu = 'list'; scroller.scrollTop = 0; });
      scroller.insertBefore(back, scroller.firstChild);
    }

    // Sign-in sheet: phone wording, a close button and links for new or locked-out traders.
    const card = document.querySelector('#desktopAuth .desktop-auth-card');
    if (card && !$('phAuthClose') && !document.documentElement.classList.contains('desktop-app')) {
      const x = document.createElement('button');
      x.type = 'button'; x.id = 'phAuthClose'; x.className = 'ph-auth-close ph-only'; x.setAttribute('aria-label', 'Close'); x.textContent = '×';
      x.addEventListener('click', () => { if (typeof window.closeDesktopAuth === 'function') window.closeDesktopAuth(); });
      card.appendChild(x);
      const links = document.createElement('div');
      links.className = 'ph-auth-links ph-only';
      links.innerHTML = '<a href="/signup.html">Create a free account</a><a href="/reset-password.html">Forgot password?</a>';
      card.appendChild(links);
    }

    // Instrument list: a dropdown under the top bar with a "Select Instrument" header, search and one clean row per
    // instrument (name and category, no prices). Same list, search and picker as desktop.
    const sheet = document.querySelector('#symPicker .sym-sheet');
    if (sheet && !$('phSymHead')) {
      const head = document.createElement('div');
      head.id = 'phSymHead'; head.className = 'ph-sym-head ph-only';
      head.innerHTML = '<b>Select Instrument</b><button type="button" id="phSymClose" aria-label="Close">×</button>';
      head.querySelector('button').addEventListener('click', () => { if (typeof window.closeSymbolPicker === 'function') window.closeSymbolPicker(); });
      sheet.insertBefore(head, sheet.firstChild);
      const picker = $('symPicker');
      picker.addEventListener('click', (e) => { if (MQ.matches && e.target === picker && typeof window.closeSymbolPicker === 'function') window.closeSymbolPicker(); });
      const list = $('symList');
      if (list) new MutationObserver(() => {
        if (!MQ.matches) return;
        list.querySelectorAll('.sym-row .nm small').forEach((sm) => { const t = sm.textContent; const i = t.indexOf(' · '); if (i > -1) { sm.dataset.code = t.slice(0, i); sm.textContent = t.slice(i + 3); } });
      }).observe(list, { childList: true });
    }

    // The quick-trade bar is part of the screen on a phone: it cannot be dragged away.
    const handle = $('qtHandle');
    if (handle) handle.addEventListener('pointerdown', (e) => { if (MQ.matches && !e.target.closest('button')) e.stopImmediatePropagation(); }, true);
    if (handle) handle.addEventListener('dblclick', (e) => { if (MQ.matches) e.stopImmediatePropagation(); }, true);

    // Tag the bottom tabs with their phone group, and remember the last one used in each group.
    document.querySelectorAll('.btab').forEach((b) => {
      const id = btabId(b);
      const group = Object.keys(GROUPS).find((g) => GROUPS[g].includes(id)) || '';
      if (group) b.dataset.phGroup = group;
      const short = { positions: 'Open', pending: 'Pending', closed: 'Closed' }[id]; if (short) b.dataset.phLabel = short;
      b.addEventListener('click', () => { if (group) lastBtab[group] = id; });
    });

    // Tour cards: on a phone, full width and above or below the highlighted control so they never cover it.
    new MutationObserver(() => {
      if (!MQ.matches) return;
      const card = document.querySelector('.gt-tour-card'), hole = document.querySelector('.gt-tour-hole');
      if (!card || !hole || card.dataset.phPlaced) return;
      card.dataset.phPlaced = '1';
      const h = hole.getBoundingClientRect(), c = card.getBoundingClientRect(), top = 8 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ph-safe-top')) || 0);
      const below = h.bottom + 10, above = h.top - 10 - c.height;
      Object.assign(card.style, { left: '10px', right: '10px', width: 'auto', maxWidth: 'none',
        top: (h.top + h.height / 2 > innerHeight / 2 ? Math.max(top, above) : Math.min(innerHeight - c.height - 70, below)) + 'px' });
    }).observe(document.body, { childList: true });

    priceTimer = setInterval(syncLive, 400);
    syncLive();
  }

  // Top-bar buttons added by other scripts (restart, switch to v2, tour) do not fit a phone's top bar, so on phones
  // they live in the Account tab. They are the same buttons, so their own scripts keep showing and hiding them.
  const MOVABLE = ['tbRestart', 'iv2Switch', 'gtHelp'];
  const homes = new Map();
  function relocate(toPhone) {
    const box = $('phAcctMore');
    MOVABLE.forEach((id) => {
      const el = $(id); if (!el || !box) return;
      if (toPhone && el.parentNode !== box) { homes.set(id, { parent: el.parentNode, next: el.nextSibling }); box.appendChild(el); }
      else if (!toPhone && el.parentNode === box && homes.has(id)) {
        const h = homes.get(id); h.parent.insertBefore(el, h.next && h.next.parentNode === h.parent ? h.next : null);
      }
    });
  }


  // The quick ticket lives in the chart area on desktop; on a phone it sits under the chart, full width.
  let qtHome = null;
  function dockTicket(toPhone) {
    const qt = $('quickTicket'), wrap = document.querySelector('.chart-wrap'); if (!qt || !wrap) return;
    if (toPhone && qt.parentNode !== wrap) { qtHome = qtHome || qt.parentNode; wrap.appendChild(qt); }
    else if (!toPhone && qtHome && qt.parentNode !== qtHome) qtHome.appendChild(qt);
    if (typeof window.syncQuickTicketVisibility === 'function') { try { window.syncQuickTicketVisibility(); } catch (_) {} }
  }

  // Bid and Ask lines on the chart (sells fill at the bid, buys at the ask). Phones only;
  // read-only, from the same live quote the order ticket uses.
  let baSeries = null, baLines = null;
  function syncBidAsk() {
    const ch = typeof ipfxChart !== 'undefined' ? ipfxChart : null, series = ch && ch.series;
    let q = null;
    try { q = typeof liveQuotesBySymbol !== 'undefined' && typeof execSymbol === 'function' ? liveQuotesBySymbol.get(execSymbol(activeSym)) : null; } catch (_) { q = null; }
    if (baLines && baSeries !== series) baLines = null;   // the chart rebuilt its series
    const ok = MQ.matches && series && series.createPriceLine && q && Number(q.bid) > 0 && Number(q.ask) > 0;
    if (!ok) { if (baLines) { for (const l of Object.values(baLines)) { try { baSeries.removePriceLine(l); } catch (_) {} } baLines = null; } return; }
    const opts = (price, color, title) => ({ price: Number(price), color, lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title });
    if (!baLines) { baSeries = series; baLines = { ask: series.createPriceLine(opts(q.ask, '#E43C48', 'Ask')), bid: series.createPriceLine(opts(q.bid, '#2454FC', 'Bid')) }; }
    else { baLines.ask.applyOptions(opts(q.ask, '#E43C48', 'Ask')); baLines.bid.applyOptions(opts(q.bid, '#2454FC', 'Bid')); }
  }

  function syncLive() {
    if (!MQ.matches) { syncBidAsk(); return; }
    syncBidAsk();
    relocate(true);
    dockTicket(true);
    const eq = $('ps-equity'), bal = $('phBal');
    if (eq && bal) {
      const v = (eq.textContent || '').trim(), on = document.body.classList.contains('signed-in') && /\d/.test(v);
      bal.hidden = !on; if (on && bal.textContent !== v) bal.textContent = v;
    }
    const symSrc = $('op-sym'), symDst = $('phSymName');
    if (symSrc && symDst && symDst.textContent !== symSrc.textContent) symDst.textContent = symSrc.textContent;
    syncOrderType();
    const n = Number(($('posBadge') || {}).textContent || 0), badge = $('phPosBadge');
    if (badge) { badge.hidden = !(n > 0); if (badge.textContent !== String(n)) badge.textContent = String(n); }
  }

  function setTab(tab, user) {
    if (!TABS.includes(tab)) tab = 'chart';
    const prev = current; current = tab;
    document.documentElement.dataset.ptab = tab;
    document.querySelectorAll('#phTabbar button[data-ptab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.ptab === tab)));
    try { sessionStorage.setItem(KEY, tab); } catch (_) {}
    if (tab === 'trade') {
      const order = [...document.querySelectorAll('.gtab')].find((g) => /switchTab\('order'/.test(g.getAttribute('onclick') || ''));
      if (order && !order.classList.contains('active') && typeof window.switchTab === 'function' && user) window.switchTab('order', order);
    }
    if (GROUPS[tab]) {
      const active = document.querySelector('.btab.active');
      if (!active || active.dataset.phGroup !== tab) {
        const el = btabEl(lastBtab[tab]);
        if (el && typeof window.switchBtab === 'function') window.switchBtab(lastBtab[tab], el);
      }
    }
    if (tab === 'account' && prev !== 'account') document.documentElement.dataset.pmenu = 'list';
    dockTicket(true);
    // Let the chart and anything measuring the layout catch up with the new sizes.
    if (prev !== tab) requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  // Phone wording for the sign-in sheet (its desktop wording talks about the desktop app's profile).
  const AUTH_TEXT = [
    ['#desktopAuthTitle', 'Sign in to IPFX Markets'],
    ['#desktopAuth .desktop-auth-copy', 'Use the email and password of your IPFX account.'],
    ['#desktopAuth .desktop-auth-note', 'You stay signed in on this phone.'],
    ['#desktopAuthSubmit', 'Sign in'],
  ];
  const authOriginal = new Map();
  function authWording(phone) {
    if (document.documentElement.classList.contains('desktop-app')) return;
    AUTH_TEXT.forEach(([sel, text]) => {
      const el = document.querySelector(sel); if (!el) return;
      if (!authOriginal.has(sel)) authOriginal.set(sel, el.textContent);
      el.textContent = phone ? text : authOriginal.get(sel);
    });
    const submit = $('desktopAuthSubmit');
    if (submit) { if (phone) submit.dataset.label = 'Sign in'; else delete submit.dataset.label; }
  }

  // Volume bars on by default on phones (19 Nov 2026), but only for someone who has never saved their own indicator
  // choice: removing Volume saves the layout, so it is never forced back.
  function defaultVolume() {
    try {
      const p = new URLSearchParams(location.search);
      if (localStorage.getItem('ipfx_chart_layout_' + (p.get('login') || p.get('name') || 'guest')) !== null) return;
      if (typeof selectedStudies === 'undefined' || selectedStudies.size) return;
      selectedStudies.add('Volume@tv-basicstudies');
      if (typeof buildIndList === 'function') buildIndList();
      if (typeof syncNativeIndicators === 'function') syncNativeIndicators();
    } catch (_) {}
  }

  // ── Order type switch and order confirmation (19 Nov 2026) ──
  // MARKET / PENDING sits at the start of the quick-trade bar. Pending needs a trigger price, so it opens the Trade tab
  // with Pending selected. Both only press the ticket's own Market / Pending buttons.
  const ONE_CLICK_KEY = 'ipfx-one-click';
  const oneClick = () => { try { return localStorage.getItem(ONE_CLICK_KEY) === '1'; } catch (_) { return false; } };
  const isPending = () => typeof ordType !== 'undefined' && ordType === 'pending';
  function typeButton(kind) { return [...document.querySelectorAll('.op-type-btn')].find((b) => (b.getAttribute('onclick') || '').includes("'" + kind + "'")) || null; }
  function buildOrderType() {
    const head = $('qtHandle'), chips = head && head.querySelector('.qt-chips');
    if (!head || !chips || $('phOrdType')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'phOrdType'; b.className = 'ph-ot ph-only';
    b.title = 'Switch between a market order and a pending order';
    b.innerHTML = '<span>MARKET</span><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 0 1-13.7 5.7M4 12a8 8 0 0 1 13.7-5.7"/><path d="M17.5 2.5v4h-4M6.5 21.5v-4h4"/></svg>';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isPending()) { const m = typeButton('market'); if (m) m.click(); }
      else { const pb = typeButton('pending'); if (pb) pb.click(); setTab('trade', true); }
      syncOrderType();
    });
    head.insertBefore(b, chips);
  }
  function syncOrderType() {
    const b = $('phOrdType'); if (!b) return;
    const t = isPending() ? 'PENDING' : 'MARKET', sp = b.querySelector('span');
    if (sp && sp.textContent !== t) sp.textContent = t;
    b.setAttribute('aria-label', 'Order type: ' + t.toLowerCase() + '. Tap to switch');
  }

  // A "BUY 0.01 lots of EURUSD at Market price?" sheet before every order, until the trader switches on one-click trading.
  // Submit presses the same button again, so the order goes through the ticket's normal path and checks.
  let confirmPass = false;
  function confirmSheet() {
    let d = $('phConfirm');
    if (d) return d;
    d = document.createElement('div');
    d.id = 'phConfirm'; d.className = 'ph-confirm ph-only'; d.hidden = true;
    d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'phConfirmQ');
    d.innerHTML = '<div class="ph-confirm-card">'
      + '<div class="ph-confirm-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 14l4-4 4 4M12 10v8M8 7h8"/></svg></div>'
      + '<p class="ph-confirm-q" id="phConfirmQ"></p>'
      + '<label class="ph-confirm-oc"><span><b>One-click trading</b><small>Trade without this confirmation step. Turn it back off any time from the Account tab.</small></span>'
      + '<input type="checkbox" id="phOneClick" role="switch"><i aria-hidden="true"></i></label>'
      + '<div class="ph-confirm-act"><button type="button" class="ph-confirm-no">Cancel</button><button type="button" class="ph-confirm-go">Submit</button></div></div>';
    document.body.appendChild(d);
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('.ph-confirm-no')) closeConfirm(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !d.hidden) closeConfirm(); });
    return d;
  }
  let confirmTarget = null;
  function closeConfirm() { const d = $('phConfirm'); if (d) d.hidden = true; confirmTarget = null; }
  function orderText(btn) {
    const sell = btn.id === 'qtSell' || btn.classList.contains('op-exec-sell');
    const quick = btn.id === 'qtSell' || btn.id === 'qtBuy';
    const lots = (($(quick ? 'qtLots' : 'ord-lots') || {}).value || '').trim() || '—';
    const sym = (($('phSymName') || $('op-sym') || {}).textContent || '').trim().replace('/', '');
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const trig = (($('triggerPrice') || {}).value || '').trim();
    const where = !quick && isPending() ? 'as a pending order' + (trig ? ' at ' + esc(trig) : '') + '?' : 'at Market price?';
    return '<b class="' + (sell ? 'sell' : 'buy') + '">' + (sell ? 'SELL' : 'BUY') + '</b> ' + esc(lots) + ' lots of ' + esc(sym) + '<br>' + where;
  }
  function askConfirm(btn) {
    const d = confirmSheet();
    confirmTarget = btn;
    $('phConfirmQ').innerHTML = orderText(btn);
    $('phOneClick').checked = false;
    d.querySelector('.ph-confirm-go').onclick = () => {
      const target = confirmTarget;
      try { if ($('phOneClick').checked) localStorage.setItem(ONE_CLICK_KEY, '1'); } catch (_) {}
      closeConfirm();
      if (target) { confirmPass = true; try { target.click(); } finally { confirmPass = false; } }
    };
    d.hidden = false;
    d.querySelector('.ph-confirm-go').focus();
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('#qtSell,#qtBuy,.op-exec-btn');
    if (!btn || confirmPass || !MQ.matches || oneClick() || btn.disabled) return;
    if (!document.body.classList.contains('signed-in')) return;   // the ticket shows its own sign-in prompt
    e.preventDefault(); e.stopImmediatePropagation();
    askConfirm(btn);
  }, true);
  window.ipfxOneClick = { get on() { return oneClick(); }, set(on) { try { if (on) localStorage.setItem(ONE_CLICK_KEY, '1'); else localStorage.removeItem(ONE_CLICK_KEY); } catch (_) {} } };

  function apply() {
    document.documentElement.classList.toggle('phone', MQ.matches);
    const ph = $('symSearch');
    if (ph) { if (!ph.dataset.deskPlaceholder) ph.dataset.deskPlaceholder = ph.placeholder; ph.placeholder = MQ.matches ? 'Search for anything…' : ph.dataset.deskPlaceholder; }
    if (!MQ.matches) { delete document.documentElement.dataset.ptab; relocate(false); authWording(false); dockTicket(false); return; }
    build();
    buildOrderType();
    defaultVolume();
    authWording(true);
    let saved = 'chart';
    try { saved = sessionStorage.getItem(KEY) || 'chart'; } catch (_) {}
    setTab(current || saved, false);
  }

  if (MQ.addEventListener) MQ.addEventListener('change', apply); else if (MQ.addListener) MQ.addListener(apply);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
  window.ipfxPhone = { setTab: (t) => setTab(t, true), get tab() { return current; } };

  // ── Install as an app ──
  // Android (Chrome): the browser's own install prompt. iPhone (Safari): there is no prompt, so a short guide shows
  // where Add to Home Screen is. Never shown inside the installed app, the IPFX desktop app or the store app.
  const INSTALL_KEY = 'ipfx-install-hint-v1';
  let deferred = null;
  const ua = navigator.userAgent || '';
  const isIos = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = isIos && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  function installed() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true
      || !!window.Capacitor || document.documentElement.classList.contains('desktop-app');
  }
  function canOffer() { return !installed() && (deferred || isSafari); }
  function dismissed() { try { return localStorage.getItem(INSTALL_KEY) === 'no'; } catch (_) { return false; } }
  function iosGuide() {
    let d = $('phInstallGuide');
    if (!d) {
      d = document.createElement('div'); d.id = 'phInstallGuide'; d.className = 'ph-install-guide ph-only';
      d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'phInstallTitle');
      d.innerHTML = '<div class="ph-ig-card"><img src="/assets/images/app/icon-192.png" alt="" width="56" height="56">'
        + '<h2 id="phInstallTitle">Add IPFX Markets to your Home Screen</h2>'
        + '<ol><li>Tap the <b>Share</b> button <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> in Safari\'s toolbar.</li>'
        + '<li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>. IPFX Markets opens full screen from its own icon.</li></ol>'
        + '<button type="button" id="phInstallOk">Got it</button></div>';
      d.addEventListener('click', (e) => { if (e.target === d || e.target.id === 'phInstallOk') d.hidden = true; });
      document.body.appendChild(d);
    }
    d.hidden = false;
  }
  async function install() {
    if (deferred) { const p = deferred; deferred = null; p.prompt(); try { await p.userChoice; } catch (_) {} renderInstall(); return; }
    if (isSafari) iosGuide();
  }
  function renderInstall() {
    if (!built) return;
    const offer = canOffer();
    let btn = $('phInstallBtn');
    const acct = $('phAcct');
    if (acct && !btn) {
      btn = document.createElement('button'); btn.type = 'button'; btn.id = 'phInstallBtn'; btn.textContent = 'Install app';
      btn.addEventListener('click', install); acct.appendChild(btn);
    }
    if (btn) btn.hidden = !offer;
    let banner = $('phInstallBanner');
    const show = offer && !dismissed();
    if (show && !banner) {
      banner = document.createElement('div'); banner.id = 'phInstallBanner'; banner.className = 'ph-install ph-only';
      banner.innerHTML = '<img src="/assets/images/app/icon-192.png" alt="" width="36" height="36"><span><b>Get the IPFX Markets app</b>Full screen, one tap from your Home Screen.</span>'
        + '<button type="button" class="go">Install</button><button type="button" class="x" aria-label="Not now">×</button>';
      banner.querySelector('.go').addEventListener('click', () => { banner.hidden = true; install(); });
      banner.querySelector('.x').addEventListener('click', () => { banner.hidden = true; try { localStorage.setItem(INSTALL_KEY, 'no'); } catch (_) {} });
      const wrap = document.querySelector('.chart-wrap'); if (wrap) wrap.insertBefore(banner, wrap.firstChild);
    }
    if (banner) banner.hidden = !show;
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; renderInstall(); });
  window.addEventListener('appinstalled', () => { deferred = null; renderInstall(); });
  const later = () => setTimeout(renderInstall, 1500);
  if (document.readyState === 'complete') later(); else window.addEventListener('load', later);

  // Offline page for the installed app. Scope is Markets only; see /markets-sw.js.
  if ('serviceWorker' in navigator && !window.Capacitor && !document.documentElement.classList.contains('desktop-app')
      && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    const reg = () => navigator.serviceWorker.register('/markets-sw.js', { scope: '/trading.html' }).catch(() => {});
    if (document.readyState === 'complete') reg(); else window.addEventListener('load', reg);
  }
  }
})();
