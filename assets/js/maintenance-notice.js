// Maintenance banner for IPFX Markets: a full-width strip above the top bar.
// To change it, edit MAINTENANCE and bump the ?v= on the script tag in trading.html.
// The banner removes itself once `until` has passed. Traders can close it; it stays closed for that browser tab.
(function () {
  'use strict';
  var MAINTENANCE = {
    id: '2026-11-18-evening',
    until: '2026-11-18T20:00:00Z', // 8:00 pm UK time (GMT in November)
    title: 'Scheduled maintenance',
    text: 'IPFX Markets is under maintenance. Prices, charts and orders may be briefly unavailable or slow.'
  };
  var untilMs = Date.parse(MAINTENANCE.until);
  var KEY = 'ipfx-maintenance-closed:' + MAINTENANCE.id;
  if (!isFinite(untilMs) || Date.now() >= untilMs) return;
  try { if (sessionStorage.getItem(KEY) === '1') return; } catch (e) { /* storage blocked: still show */ }

  function localTime() {
    try {
      var d = new Date(untilMs);
      var t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      var sameDay = d.toDateString() === new Date().toDateString();
      return sameDay ? t : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + t;
    } catch (e) { return ''; }
  }

  var css = '.mt-banner{display:flex;align-items:center;gap:.65rem;padding:.5rem 1rem;flex-shrink:0;position:relative;z-index:60;' +
    'background:linear-gradient(90deg,#60a5fa 0%,#a78bfa 55%,#c084fc 100%);color:#0a0a0a;font:500 13px/1.4 var(--font-ui,Inter,system-ui,-apple-system,"Segoe UI",sans-serif);' +
    'border-bottom:1px solid #a855f7;box-shadow:0 0 14px rgba(168,85,247,.55)}' +
    '.mt-banner svg{flex:0 0 18px;width:18px;height:18px}' +
    '.mt-banner .mt-txt{flex:1;min-width:0}' +
    '.mt-banner b{font-weight:700;margin-right:.35rem}' +
    '.mt-banner .mt-when{font-weight:700;white-space:nowrap}' +
    '.mt-banner .mt-x{flex:0 0 auto;border:0;background:transparent;color:inherit;font-size:20px;line-height:1;width:28px;height:28px;border-radius:6px;cursor:pointer}' +
    '.mt-banner .mt-x:hover{background:rgba(0,0,0,.12)}' +
    '.mt-banner .mt-x:focus-visible{outline:2px solid #0a0a0a;outline-offset:1px}' +
    '.mt-banner .mt-short{display:none}' +
    'html.phone .mt-banner{font-size:12px;padding:.4rem .5rem .4rem .75rem;gap:.5rem}' +
    'html.phone .mt-banner .mt-long{display:none}html.phone .mt-banner .mt-short{display:inline}';

  function render() {
    if (document.getElementById('mtBanner')) return;
    var st = document.createElement('style'); st.id = 'mtBannerStyle'; st.textContent = css; document.head.appendChild(st);
    var el = document.createElement('div');
    el.id = 'mtBanner'; el.className = 'mt-banner'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    var local = localTime();
    el.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg>' +
      '<div class="mt-txt"><span class="mt-long"><b></b><span class="mt-msg"></span> Back to normal by <span class="mt-when">8:00 pm UK time</span>' +
      (local ? ' (' + local + ' your time)' : '') + '.</span>' +
      '<span class="mt-short"><b>Maintenance:</b> some features may be slow. Back by <span class="mt-when">' + (local ? local + ' your time' : '8:00 pm UK time') + '</span>.</span></div>' +
      '<button type="button" class="mt-x" aria-label="Close maintenance notice">&times;</button>';
    el.querySelector('.mt-long b').textContent = MAINTENANCE.title + ':';
    el.querySelector('.mt-msg').textContent = MAINTENANCE.text;
    el.querySelector('.mt-x').addEventListener('click', function () {
      try { sessionStorage.setItem(KEY, '1'); } catch (e) { /* ignore */ }
      el.remove();
    });
    var top = document.querySelector('.topbar');
    if (top && top.parentNode) top.parentNode.insertBefore(el, top);
    else document.body.insertBefore(el, document.body.firstChild);
    var timer = setInterval(function () {
      if (Date.now() >= untilMs) { clearInterval(timer); el.remove(); }
    }, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
