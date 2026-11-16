// IPFX Markets chart colours: candle colours and the chart background, on the phone and the computer version.
// A palette button (phone: in the chart toolbar; computer: in the top bar) opens a small panel with presets,
// any custom up/down colour and three backgrounds. The choice is remembered in this browser. Nothing here touches
// orders, prices or accounts: it only calls the chart's colour hook (ipfxChart.setColors) and sets the chart background.
(function () {
  'use strict';
  const KEY = 'ipfx-chart-colors', OLD_KEY = 'ipfx-phone-chart-colors';
  // Default: IPFX Neon candles on a near-black chart. "Classic" + "Dark" restores the look before 16 Nov 2026.
  const DEFAULTS = { up: '#4FAF91', down: '#D9545B', bg: '#010102' };
  const PRESETS = [
    { name: 'IPFX Neon', up: '#4FAF91', down: '#D9545B' },
    { name: 'Bright neon', up: '#00E5A0', down: '#FF4D6A' },
    { name: 'Classic', up: '#10B981', down: '#EF4444' },
    { name: 'Blue / Orange', up: '#3B82F6', down: '#F59E0B' },
    { name: 'White / Grey', up: '#E5E7EB', down: '#6B7280' },
  ];
  const BGS = [{ name: 'Black', c: '#010102' }, { name: 'Dark', c: '#0a0a0c' }, { name: 'Slate', c: '#17171c' }];
  const $ = (id) => document.getElementById(id);
  const isHex = (v) => /^#[0-9a-f]{6}$/i.test(String(v));
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  let colors = (() => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY) || 'null');
      if (v && isHex(v.up) && isHex(v.down) && isHex(v.bg)) return { up: v.up, down: v.down, bg: v.bg };
    } catch (_) {}
    return { ...DEFAULTS };
  })();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(colors)); } catch (_) {} }

  // Applies the colours. Cheap enough to run every tick: it only touches the chart when something differs, which also
  // covers a rebuilt chart and the light/dark switch resetting the chart background.
  let paintedChart = null, paintedKey = '';
  const phoneLayout = () => document.documentElement.classList.contains('phone');
  function paint() {
    const ch = typeof ipfxChart !== 'undefined' ? ipfxChart : null;
    if (!ch || typeof ch.setColors !== 'function' || !ch.chart) return;
    const light = document.body.classList.contains('light');
    const chrome = phoneLayout() && !light;   // on the phone layout the whole screen follows the background colour
    const key = [colors.up, colors.down, colors.bg, light, chrome].join();
    let bgNow = ''; try { bgNow = ch.chart.options().layout.background.color; } catch (_) {}
    const bgWant = light ? '#ffffff' : colors.bg;
    if (paintedChart === ch && paintedKey === key && bgNow === bgWant) return;
    paintedChart = ch; paintedKey = key;
    ch.setColors(colors.up, colors.down);
    if (!light) { try { ch.chart.applyOptions({ layout: { background: { type: 'solid', color: colors.bg } } }); } catch (_) {} }
    if (chrome) document.documentElement.style.setProperty('--bg', colors.bg); else document.documentElement.style.removeProperty('--bg');
  }

  function build() {
    if ($('icColors')) return;
    const d = document.createElement('div');
    d.id = 'icColors'; d.className = 'ic-sheet'; d.hidden = true;
    d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Chart colours');
    d.innerHTML = '<div class="ic-card"><div class="ic-head"><b>Chart colours</b><button type="button" id="icX" aria-label="Close">×</button></div>'
      + '<div class="ic-sec">Candles</div><div class="ic-presets" id="icPresets"></div>'
      + '<div class="ic-custom"><label><span>Up candles</span><input type="color" id="icUp" aria-label="Colour of up candles"></label>'
      + '<label><span>Down candles</span><input type="color" id="icDown" aria-label="Colour of down candles"></label></div>'
      + '<div class="ic-sec">Background</div><div class="ic-bgs" id="icBgs"></div>'
      + '<button type="button" id="icReset" class="ic-reset">Reset to default</button></div>';
    document.body.appendChild(d);
    const up = $('icUp'), down = $('icDown');
    let raf = 0;
    const live = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { colors.up = up.value.toUpperCase(); colors.down = down.value.toUpperCase(); save(); paint(); render(false); }); };
    up.addEventListener('input', live); down.addEventListener('input', live);
    $('icReset').addEventListener('click', () => { colors = { ...DEFAULTS }; save(); paint(); render(true); });
    $('icPresets').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]'); if (!b) return; const p = PRESETS[+b.dataset.i];
      colors.up = p.up; colors.down = p.down; save(); paint(); render(true);
    });
    $('icBgs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]'); if (!b) return; colors.bg = BGS[+b.dataset.i].c; save(); paint(); render(true);
    });
    d.addEventListener('click', (e) => { if (e.target === d || e.target.id === 'icX') close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !d.hidden) close(); });
    // On the computer the panel floats beside the chart (so you see the change as you pick it); a click elsewhere closes it.
    document.addEventListener('pointerdown', (e) => {
      if (d.hidden || e.target.closest('.ic-card') || e.target.closest('#chartColorsBtn,#phGear')) return;
      if (window.matchMedia('(min-width: 761px)').matches) close();
    });
  }
  function render(inputs) {
    const d = $('icColors'); if (!d) return;
    $('icPresets').innerHTML = PRESETS.map((p, i) =>
      `<button type="button" data-i="${i}" aria-pressed="${same(p.up, colors.up) && same(p.down, colors.down)}"><span class="ic-candles" aria-hidden="true"><i style="background:${p.up}"></i><i style="background:${p.down}"></i><i style="background:${p.up}"></i></span><span>${p.name}</span></button>`).join('');
    $('icBgs').innerHTML = BGS.map((b, i) =>
      `<button type="button" data-i="${i}" aria-pressed="${same(b.c, colors.bg)}"><i style="background:${b.c}"></i><span>${b.name}</span></button>`).join('');
    if (inputs !== false) { $('icUp').value = colors.up.toLowerCase(); $('icDown').value = colors.down.toLowerCase(); }
  }
  function open() { build(); render(true); $('icColors').hidden = false; }
  function close() { const d = $('icColors'); if (d) d.hidden = true; }
  function toggle() { const d = $('icColors'); if (d && !d.hidden) close(); else open(); }

  // The computer version's button, in the top bar beside the light/dark switch (the phone layout has its own palette button).
  function addDesktopButton() {
    const tools = document.querySelector('.tb-tool-grp');
    if (!tools || $('chartColorsBtn')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'chartColorsBtn'; b.className = 'tb-tool-btn'; b.title = 'Chart colours: candles and background';
    b.setAttribute('aria-label', 'Chart colours');
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="17" height="17" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.6-.3-1.1-.6-1.5-.3-.4-.4-.9-.4-1.5 0-1.1.9-2 2-2h2.3A2.8 2.8 0 0 0 20.5 11 9 9 0 0 0 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/></svg>';
    b.addEventListener('click', toggle);
    tools.insertBefore(b, tools.firstChild);
  }

  function start() { addDesktopButton(); paint(); setInterval(paint, 400); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.ipfxColors = { open, close, toggle, paint, get colors() { return { ...colors }; }, presets: PRESETS, defaults: DEFAULTS };
})();
