// IPFX Markets on phones: how much room the order ticket takes (25 Nov 2026).
// One shared setting for the Chart and Trade tabs, remembered in this browser:
//   'min'     only the Sell / lots / Buy row; the chart fills the rest
//   'default' the ticket as it opens today
//   'full'    every ticket option (lot presets, stop loss, take profit), the chart kept at least 120px tall
// On the Chart tab a grab bar above the ticket drags the split between chart and ticket and snaps to one of the three on
// release (a tap on the bar folds or unfolds the ticket). On the Trade tab an arrow at the top folds the ticket to its
// Sell / lots / Buy row. Layout only: nothing here places, changes or closes an order. Inert on computers.
(function () {
  'use strict';
  const KEY = 'ipfx-phone-ticket';
  const STATES = ['min', 'default', 'full'];
  const CHART_MIN = 120;
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const phone = () => root.classList.contains('phone');
  const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
  const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 15 12 9 18 15"/></svg>';

  let state = 'default';
  try { const v = localStorage.getItem(KEY); if (STATES.includes(v)) state = v; } catch (_) {}

  // Keeps the ticket's own expanded flag (lot presets, SL and TP rows) in step with the shared setting.
  function syncExpanded() {
    const qt = $('quickTicket'), want = state === 'full';
    if (!qt || typeof window.qtSetExpanded !== 'function' || qt.classList.contains('expanded') === want) return;
    window.qtSetExpanded(want);
    if (typeof window.syncQuickTicket === 'function') { try { window.syncQuickTicket(); } catch (_) {} }
  }
  function syncControls() {
    const grab = $('phGrab'), fold = $('phTicketFold');
    if (grab) {
      grab.setAttribute('aria-valuenow', String(STATES.indexOf(state)));
      grab.setAttribute('aria-valuetext', { min: 'Ticket folded', default: 'Ticket', full: 'Ticket fully open' }[state]);
    }
    if (fold) {
      const folded = state === 'min';
      fold.setAttribute('aria-expanded', String(!folded));
      fold.setAttribute('aria-label', folded ? 'Show the full ticket' : 'Fold the ticket to Sell and Buy');
      fold.title = folded ? 'Show the ticket' : 'Fold the ticket';
    }
  }
  function setState(s, save) {
    if (!STATES.includes(s)) s = 'default';
    const changed = s !== state || root.dataset.pticket !== s;
    state = s; root.dataset.pticket = s;
    if (save) { try { localStorage.setItem(KEY, s); } catch (_) {} }
    if (phone()) syncExpanded();
    syncControls();
    if (changed) requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  // A short height animation (about 200ms) for a state change made with the arrow or a tap on the grab bar.
  function animate(el, change) {
    if (!el || reduced() || !el.offsetParent) { change(); return; }
    const from = el.getBoundingClientRect().height;
    change();
    const to = el.getBoundingClientRect().height;
    if (Math.abs(to - from) < 2) return;
    el.style.height = from + 'px'; el.style.overflow = 'hidden'; el.style.transition = 'height .2s ease';
    void el.offsetHeight;
    el.style.height = to + 'px';
    setTimeout(() => { el.style.height = ''; el.style.overflow = ''; el.style.transition = ''; }, 220);
  }

  // ── Chart tab: grab bar ──
  // Natural ticket height in each state, measured without saving anything.
  function measure() {
    const qt = $('quickTicket'), more = $('qtMore');
    const keep = { s: root.dataset.pticket, exp: qt.classList.contains('expanded'), hidden: more ? more.hidden : true };
    root.classList.add('ph-measure');
    const h = {};
    for (const s of STATES) {
      root.dataset.pticket = s;
      qt.classList.toggle('expanded', s === 'full'); if (more) more.hidden = s !== 'full';
      h[s] = qt.getBoundingClientRect().height;
    }
    root.dataset.pticket = keep.s; qt.classList.toggle('expanded', keep.exp); if (more) more.hidden = keep.hidden;
    root.classList.remove('ph-measure');
    return h;
  }
  let drag = null;
  function nearest(t, snaps, hi) {
    if (t >= hi - 1 && snaps.full >= hi - 1) return 'full';   // all the way up opens every option, even on a short screen
    return STATES.reduce((best, s) => (Math.abs(snaps[s] - t) < Math.abs(snaps[best] - t) ? s : best), 'min');
  }
  function onDown(e) {
    if (!phone() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const qt = $('quickTicket'), area = document.querySelector('.chart-area'); if (!qt || !area) return;
    e.preventDefault();
    const grab = e.currentTarget; try { grab.setPointerCapture(e.pointerId); } catch (_) {}
    const nat = measure(), room = qt.getBoundingClientRect().bottom - area.getBoundingClientRect().top;   // chart + ticket
    const top = Math.max(nat.min, room - CHART_MIN);
    const snaps = { min: nat.min, default: Math.min(nat.default, top), full: Math.min(nat.full, top) };
    drag = { id: e.pointerId, y: e.clientY, t0: qt.getBoundingClientRect().height, snaps, lo: nat.min, hi: top, moved: false, s: state };
    root.classList.add('ph-dragging');
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = drag.y - e.clientY;
    if (!drag.moved && Math.abs(dy) < 6) return;
    drag.moved = true;
    const t = Math.max(drag.lo, Math.min(drag.hi, drag.t0 + dy)), qt = $('quickTicket');
    qt.style.height = t + 'px';
    const s = nearest(t, drag.snaps, drag.hi);
    if (s !== drag.s) { drag.s = s; setState(s, false); }   // the content follows the finger; saved on release
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    root.classList.remove('ph-dragging');
    const qt = $('quickTicket');
    if (!d.moved) { qt.style.height = ''; tapToggle(); return; }
    const target = d.snaps[d.s], from = qt.getBoundingClientRect().height;
    setState(d.s, true);
    if (reduced() || Math.abs(target - from) < 2) { qt.style.height = ''; return; }
    qt.style.transition = 'height .2s ease'; qt.style.height = target + 'px';
    setTimeout(() => { qt.style.transition = ''; qt.style.height = ''; }, 220);
  }
  function onCancel() {
    if (!drag) return;
    drag = null; root.classList.remove('ph-dragging');
    const qt = $('quickTicket'); if (qt) qt.style.height = '';
    setState(state, false);
  }
  function tapToggle() { animate($('quickTicket'), () => setState(state === 'min' ? 'default' : 'min', true)); }
  function buildGrab() {
    const qt = $('quickTicket'); if (!qt || $('phGrab')) return;
    const g = document.createElement('div');
    g.id = 'phGrab'; g.className = 'ph-grab ph-only'; g.tabIndex = 0;
    g.setAttribute('role', 'slider'); g.setAttribute('aria-orientation', 'vertical'); g.setAttribute('aria-label', 'Ticket size: drag to resize the chart and the ticket');
    g.setAttribute('aria-valuemin', '0'); g.setAttribute('aria-valuemax', '2');
    g.innerHTML = '<i aria-hidden="true"></i>';
    g.addEventListener('pointerdown', onDown);
    g.addEventListener('pointermove', onMove);
    g.addEventListener('pointerup', onUp);
    g.addEventListener('pointercancel', onCancel);
    g.addEventListener('lostpointercapture', (e) => { if (drag && e.pointerId === drag.id) onUp(e); });
    g.addEventListener('keydown', (e) => {
      const i = STATES.indexOf(state);
      const next = e.key === 'ArrowUp' ? STATES[Math.min(2, i + 1)] : e.key === 'ArrowDown' ? STATES[Math.max(0, i - 1)] : (e.key === 'Enter' || e.key === ' ') ? (state === 'min' ? 'default' : 'min') : null;
      if (!next) return;
      e.preventDefault(); animate(qt, () => setState(next, true));
    });
    qt.insertBefore(g, qt.firstChild);
  }

  // ── Trade tab: fold arrow, top right of the Market / Pending row ──
  function placeFold() {
    const b = $('phTicketFold'), bar = document.querySelector('#tab-order .op-type-bar');
    if (!b || !bar || state === 'min' || !bar.offsetParent) return;
    const top = Math.round(bar.offsetTop + (bar.offsetHeight - b.offsetHeight) / 2) + 'px';
    if (b.style.top !== top) b.style.top = top;
  }
  function buildFold() {
    const panel = $('tab-order'); if (!panel || $('phTicketFold')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'phTicketFold'; b.className = 'ph-fold ph-only'; b.innerHTML = CHEVRON;
    b.addEventListener('click', () => {
      const guide = $('guidePanel');
      animate(guide, () => setState(state === 'min' ? 'default' : 'min', true));
      b.style.top = ''; requestAnimationFrame(placeFold);
    });
    panel.insertBefore(b, panel.firstChild);
  }

  // The ticket's own arrow (Chart tab) opens and closes the full ticket; on a phone it goes through the shared setting.
  function hookExpand() {
    const orig = window.qtToggleExpand;
    if (typeof orig !== 'function' || orig.ipfxPhone) return;
    const wrapped = function () {
      if (!phone()) return orig.apply(this, arguments);
      animate($('quickTicket'), () => setState(state === 'full' ? 'default' : 'full', true));
    };
    wrapped.ipfxPhone = true;
    window.qtToggleExpand = wrapped;
    // Other controls can open the ticket (tapping SL or TP adds its row): follow them.
    const qt = $('quickTicket');
    if (qt) new MutationObserver(() => {
      if (!phone() || drag || root.classList.contains('ph-measure')) return;
      const exp = qt.classList.contains('expanded');
      if (exp && state !== 'full') setState('full', true);
      else if (!exp && state === 'full') setState('default', true);
    }).observe(qt, { attributes: true, attributeFilter: ['class'] });
  }

  let wasPhone = false;
  function tick() {
    const on = phone();
    if (on && !wasPhone) { buildGrab(); buildFold(); hookExpand(); setState(state, false); }
    wasPhone = on;
    if (on) placeFold();
  }
  const style = document.createElement('style');
  style.textContent = 'html:not(.phone) #phGrab,html:not(.phone) #phTicketFold{display:none!important}';
  document.head.appendChild(style);
  function start() { tick(); setInterval(tick, 500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.ipfxTicket = { get state() { return state; }, set: (s) => setState(s, true) };
})();
