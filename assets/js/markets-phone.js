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
  function phoneVersionOn() {
    if (RELEASED_TO_EVERYONE || window.Capacitor) return true;
    if (!/(^|\.)ipfxcapital\.com$/i.test(location.hostname)) return true;
    if (EARLY_ACCESS_ACCOUNTS.includes(signedInAccountId())) { remember(true); return true; }
    return remembered();
  }
  let started = false;
  function start() {
    if (started) return; started = true;
    const css = document.getElementById('marketsPhoneCss');
    if (css && css.dataset.phoneMedia) css.media = css.dataset.phoneMedia;
    const manifest = document.getElementById('appManifest');
    if (manifest) manifest.href = '/markets.webmanifest';
    runPhone();
  }
  if (phoneVersionOn()) start();
  else { const t = setInterval(() => { if (phoneVersionOn()) { clearInterval(t); start(); } }, 2000); } // switches on right after signing in

  function runPhone() {
  const MQ = window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-height: 520px)');
  const KEY = 'ipfx-phone-tab';
  const TABS = ['chart', 'trade', 'positions', 'account'];
  const ICONS = {
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg>',
    trade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16"/><path d="M3 8l4-4 4 4"/><path d="M17 20V4"/><path d="M21 16l-4 4-4-4"/></svg>',
    positions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M9 16h6"/></svg>',
    account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  };
  const LABELS = { chart: 'Chart', trade: 'Trade', positions: 'Positions', account: 'Account' };
  // Bottom-panel tabs shown under Positions and under Account.
  const GROUPS = {
    positions: ['positions', 'pending', 'closed', 'orders', 'journal', 'alerts'],
    account: ['challenge', 'account', 'risk', 'statement'],
  };
  const $ = (id) => document.getElementById(id);
  let built = false, current = null, lastBtab = { positions: 'positions', account: 'challenge' }, priceTimer = 0;

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

    // Quick-trade bar under the chart (like TradeLocker's): the desktop quick ticket, docked full width. It is the
    // desktop's own remote control for the order ticket (same lots, stop, take profit, risk checks and order path), so
    // nothing about how an order is placed changes. Shown on the Chart tab; "open the full ticket" goes to Trade.
    const origShow = window.qtShouldShow, origFull = window.qtOpenFull;
    if (typeof origShow === 'function') window.qtShouldShow = () => (MQ.matches ? current === 'chart' : origShow());
    if (typeof origFull === 'function') window.qtOpenFull = () => (MQ.matches ? setTab('trade', true) : origFull());

    // Timeframes: one button showing the current one; tap it to pick another (like TradeLocker's "5m").
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
    }

    // Balance in the top bar once signed in (TradeLocker shows it there too).
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
        + '<a href="/feedback.html?from=trading-phone">Feedback</a>';
      acct.querySelector('#phTheme').addEventListener('click', () => { if (typeof window.toggleTheme === 'function') window.toggleTheme(); });
      // Inside the scrolling area, so they scroll away and leave the screen to the account details.
      const scroller = outer.querySelector('.btm-body') || outer;
      const more = document.createElement('div');
      more.className = 'ph-acct-more ph-only'; more.id = 'phAcctMore';
      scroller.insertBefore(more, scroller.firstChild);
      scroller.insertBefore(acct, more);
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

    // A Cancel button for the full-screen instrument list (desktop closes it with Esc or a click outside).
    const search = document.querySelector('#symPicker .sym-search');
    if (search && !$('phSymClose')) {
      const x = document.createElement('button');
      x.type = 'button'; x.id = 'phSymClose'; x.className = 'ph-sym-close ph-only'; x.textContent = 'Cancel';
      x.addEventListener('click', () => { if (typeof window.closeSymbolPicker === 'function') window.closeSymbolPicker(); });
      search.appendChild(x);
    }

    // Tag the bottom tabs with their phone group, and remember the last one used in each group.
    document.querySelectorAll('.btab').forEach((b) => {
      const id = btabId(b);
      const group = GROUPS.positions.includes(id) ? 'positions' : GROUPS.account.includes(id) ? 'account' : '';
      if (group) b.dataset.phGroup = group;
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

  function syncLive() {
    if (!MQ.matches) return;
    relocate(true);
    dockTicket(true);
    const eq = $('ps-equity'), bal = $('phBal');
    if (eq && bal) {
      const v = (eq.textContent || '').trim(), on = document.body.classList.contains('signed-in') && /\d/.test(v);
      bal.hidden = !on; if (on && bal.textContent !== v) bal.textContent = v;
    }
    const symSrc = $('op-sym'), symDst = $('phSymName');
    if (symSrc && symDst && symDst.textContent !== symSrc.textContent) symDst.textContent = symSrc.textContent;
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
    if (tab === 'positions' || tab === 'account') {
      const active = document.querySelector('.btab.active');
      if (!active || active.dataset.phGroup !== tab) {
        const el = btabEl(lastBtab[tab]);
        if (el && typeof window.switchBtab === 'function') window.switchBtab(lastBtab[tab], el);
      }
    }
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

  function apply() {
    document.documentElement.classList.toggle('phone', MQ.matches);
    if (!MQ.matches) { delete document.documentElement.dataset.ptab; relocate(false); authWording(false); dockTicket(false); return; }
    build();
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
