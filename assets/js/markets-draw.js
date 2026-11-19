// IPFX Markets drawing tools (phone layout, 19 Nov 2026).
// A column of tools down the left of the chart: trend line, horizontal line, vertical line, rectangle, Fibonacci
// retracement and a measure tool, plus a magnet (snaps to the candle's open, high, low or close), show/hide and delete.
// Drawings are kept per instrument in this browser. They are pictures only: nothing here touches orders, prices
// or accounts. Points are stored as (time, price), so drawings stay on their candles when the chart scrolls or zooms.
(function () {
  'use strict';
  const KEY = (sym) => 'ipfx-draw:' + sym;
  const OPT_KEY = 'ipfx-draw-options';
  const NS = 'http://www.w3.org/2000/svg';
  const BLUE = '#3861f6', FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const TOOLS = [
    ['cursor', 'Pointer', '<path d="M5 3l14 8-6 2-3 6z"/>'],
    ['trend', 'Trend line', '<circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><path d="M6.5 17.5l11-11"/>'],
    ['hline', 'Horizontal line', '<path d="M3 12h18"/><circle cx="12" cy="12" r="2"/>'],
    ['vline', 'Vertical line', '<path d="M12 3v18"/><circle cx="12" cy="12" r="2"/>'],
    ['rect', 'Rectangle', '<rect x="4" y="6" width="16" height="12" rx="1"/>'],
    ['fib', 'Fibonacci retracement', '<path d="M3 5h18M3 9.5h18M3 14h18M3 19h18"/><path d="M5 19L19 5" stroke-dasharray="2 2"/>'],
    ['measure', 'Measure', '<path d="M4 20L20 4"/><path d="M7 17l-2-2M10 14l-2-2M13 11l-2-2M16 8l-2-2"/>'],
  ];
  const TOGGLES = [
    ['magnet', 'Magnet: snap to open, high, low or close', '<path d="M6 4v7a6 6 0 0 0 12 0V4"/><path d="M6 8h4M14 8h4"/>'],
    ['eye', 'Show or hide drawings', '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'],
    ['trash', 'Delete the selected drawing (or all drawings)', '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'],
  ];
  const svgIcon = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';

  let opts = { magnet: false, hidden: false };
  try { opts = { ...opts, ...JSON.parse(localStorage.getItem(OPT_KEY) || '{}') }; } catch (_) {}
  const saveOpts = () => { try { localStorage.setItem(OPT_KEY, JSON.stringify(opts)); } catch (_) {} };

  let tool = 'cursor', drawings = [], symbol = null, selected = null, draft = null, measure = null;
  let col = null, svg = null, pad = null, hookedChart = null;

  const phone = () => document.documentElement.classList.contains('phone');
  const chartObj = () => (typeof ipfxChart !== 'undefined' ? ipfxChart : null);
  const container = () => document.getElementById('ipfx_chart_container');

  function load(sym) {
    symbol = sym; selected = null; draft = null; measure = null;
    try { const v = JSON.parse(localStorage.getItem(KEY(sym)) || '[]'); drawings = Array.isArray(v) ? v : []; } catch (_) { drawings = []; }
  }
  function save() { if (!symbol) return; try { localStorage.setItem(KEY(symbol), JSON.stringify(drawings)); } catch (_) {} }

  // ── Coordinates: (time, price) <-> screen pixels, through the chart's own bar index (logical index) ──
  function bars() { const c = chartObj(); return (c && c.bars) || []; }
  function interval(b) {
    if (b.length < 2) return 60;
    const diffs = []; for (let i = Math.max(1, b.length - 20); i < b.length; i++) diffs.push(b[i].time - b[i - 1].time);
    diffs.sort((x, y) => x - y); return diffs[diffs.length >> 1] || 60;
  }
  function timeToLogical(t) {
    const b = bars(); if (!b.length) return null;
    const step = interval(b), last = b.length - 1;
    if (t >= b[last].time) return last + (t - b[last].time) / step;
    if (t <= b[0].time) return (t - b[0].time) / step;
    let lo = 0, hi = last;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m].time <= t) lo = m; else hi = m; }
    return lo + (t - b[lo].time) / Math.max(1, b[hi].time - b[lo].time);
  }
  function logicalToTime(l) {
    const b = bars(); if (!b.length) return null;
    const step = interval(b), last = b.length - 1;
    if (l >= last) return b[last].time + (l - last) * step;
    if (l <= 0) return b[0].time + l * step;
    const i = Math.floor(l); return b[i].time + (l - i) * (b[i + 1].time - b[i].time);
  }
  function toXY(pt) {
    const c = chartObj(); if (!c || !c.series) return null;
    const x = pt.t == null ? null : c.chart.timeScale().logicalToCoordinate(timeToLogical(pt.t));
    const y = pt.p == null ? null : c.series.priceToCoordinate(pt.p);
    return { x, y };
  }
  function fromXY(x, y) {
    const c = chartObj(); if (!c || !c.series) return null;
    const l = c.chart.timeScale().coordinateToLogical(x), p = c.series.coordinateToPrice(y);
    if (l == null || p == null) return null;
    let pt = { t: logicalToTime(l), p };
    if (opts.magnet) {
      const b = bars()[Math.round(l)];
      if (b) {
        let best = null, bestD = 16;
        for (const v of [b.open, b.high, b.low, b.close]) { const d = Math.abs(c.series.priceToCoordinate(v) - y); if (d < bestD) { bestD = d; best = v; } }
        if (best != null) pt = { t: b.time, p: best };
      }
    }
    return pt;
  }

  // ── Drawing ──
  function el(name, attrs, parent) { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); (parent || svg).appendChild(e); return e; }
  function digits() { const b = bars(); const v = b.length ? b[b.length - 1].close : 1; return v >= 1000 ? 2 : v >= 10 ? 3 : 5; }
  function drawOne(d, isDraft) {
    const W = svg.clientWidth, sel = d === selected, stroke = sel ? '#93b4ff' : BLUE, sw = sel ? 2.4 : 1.6, op = isDraft ? 0.8 : 1;
    if (d.type === 'hline') {
      const a = toXY({ p: d.a.p }); if (a.y == null) return;
      el('line', { x1: 0, y1: a.y, x2: W, y2: a.y, stroke, 'stroke-width': sw, opacity: op });
      el('text', { x: W - 4, y: a.y - 4, 'text-anchor': 'end', fill: stroke, 'font-size': 11 }).textContent = d.a.p.toFixed(digits());
      return;
    }
    if (d.type === 'vline') {
      const a = toXY({ t: d.a.t }); if (a.x == null) return;
      el('line', { x1: a.x, y1: 0, x2: a.x, y2: svg.clientHeight, stroke, 'stroke-width': sw, opacity: op });
      return;
    }
    const a = toXY(d.a), b = d.b ? toXY(d.b) : null;
    if (!a || a.x == null || a.y == null || !b || b.x == null || b.y == null) return;
    if (d.type === 'trend') {
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke, 'stroke-width': sw, opacity: op });
      for (const p of [a, b]) el('circle', { cx: p.x, cy: p.y, r: sel ? 4 : 3, fill: '#010102', stroke, 'stroke-width': 1.5 });
    } else if (d.type === 'rect' || d.type === 'measure') {
      const up = d.b.p >= d.a.p, tint = d.type === 'measure' ? (up ? '0,168,132' : '228,60,72') : '56,97,246';
      el('rect', { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
        fill: `rgba(${tint},.14)`, stroke: `rgb(${tint})`, 'stroke-width': sel ? 2 : 1.2, opacity: op });
      if (d.type === 'measure') {
        const diff = d.b.p - d.a.p, pct = d.a.p ? diff / d.a.p * 100 : 0, nb = Math.round(Math.abs(timeToLogical(d.b.t) - timeToLogical(d.a.t)));
        const txt = (diff >= 0 ? '+' : '') + diff.toFixed(digits()) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%) · ' + nb + ' bars';
        const tx = (a.x + b.x) / 2, ty = Math.min(a.y, b.y) - 8;
        const t = el('text', { x: tx, y: Math.max(14, ty), 'text-anchor': 'middle', fill: '#fff', 'font-size': 12, 'font-weight': 600 });
        t.textContent = txt;
      }
    } else if (d.type === 'fib') {
      const x1 = Math.min(a.x, b.x), x2 = svg.clientWidth;
      for (const f of FIB) {
        const price = d.b.p + (d.a.p - d.b.p) * f, y = toXY({ p: price }).y; if (y == null) continue;
        el('line', { x1, y1: y, x2, y2: y, stroke: f === 0 || f === 1 ? stroke : '#8b8b93', 'stroke-width': f === 0.5 || f === 0.618 ? 1.4 : 1, opacity: op });
        el('text', { x: x1 + 4, y: y - 3, fill: '#a1a1aa', 'font-size': 10.5 }).textContent = f.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '  ' + price.toFixed(digits());
      }
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: op });
    }
  }
  function render() {
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!phone()) return;
    if (!opts.hidden) for (const d of drawings) drawOne(d, false);
    if (draft && draft.b) drawOne(draft, true);
    if (measure) drawOne(measure, false);
  }

  // ── Hit testing (to select a drawing with a tap) ──
  function distToSeg(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L)) : 0;
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }
  function hit(x, y) {
    let best = null, bestD = 14;
    for (const d of drawings) {
      let dist = Infinity;
      if (d.type === 'hline') { const a = toXY({ p: d.a.p }); if (a.y != null) dist = Math.abs(y - a.y); }
      else if (d.type === 'vline') { const a = toXY({ t: d.a.t }); if (a.x != null) dist = Math.abs(x - a.x); }
      else {
        const a = toXY(d.a), b = toXY(d.b); if (!a || !b || a.x == null || b.x == null || a.y == null || b.y == null) continue;
        if (d.type === 'trend') dist = distToSeg(x, y, a, b);
        else if (d.type === 'fib') {
          const x1 = Math.min(a.x, b.x);
          for (const f of FIB) { const yy = toXY({ p: d.b.p + (d.a.p - d.b.p) * f }).y; if (yy != null && x >= x1 - 6) dist = Math.min(dist, Math.abs(y - yy)); }
        } else {
          const l = Math.min(a.x, b.x), r = Math.max(a.x, b.x), t = Math.min(a.y, b.y), bt = Math.max(a.y, b.y);
          dist = Math.min(distToSeg(x, y, { x: l, y: t }, { x: r, y: t }), distToSeg(x, y, { x: l, y: bt }, { x: r, y: bt }),
            distToSeg(x, y, { x: l, y: t }, { x: l, y: bt }), distToSeg(x, y, { x: r, y: t }, { x: r, y: bt }));
        }
      }
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best;
  }

  // ── Input: while a drawing tool is picked, a transparent pad over the chart takes the taps ──
  function setTool(t) {
    tool = t; draft = null;
    if (t !== 'measure') measure = null;
    pad.hidden = t === 'cursor';
    for (const b of col.querySelectorAll('button[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    render();
  }
  function local(e) { const r = pad.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  let down = null;
  function onDown(e) {
    e.preventDefault(); pad.setPointerCapture(e.pointerId);
    const p = local(e), pt = fromXY(p.x, p.y); if (!pt) return;
    down = { x: p.x, y: p.y };
    if (tool === 'hline' || tool === 'vline') { draft = { type: tool, a: pt }; return; }
    if (!draft) { draft = { id: Date.now().toString(36), type: tool, a: pt, b: null, twoTap: false }; }
    else { draft.b = pt; finish(); down = null; }
  }
  function onMove(e) {
    if (!draft || draft.type === 'hline' || draft.type === 'vline') return;
    const p = local(e), pt = fromXY(p.x, p.y); if (!pt) return;
    if (down || draft.twoTap) { draft.b = pt; render(); }
  }
  function onUp(e) {
    if (!draft) return;
    const p = local(e);
    if (draft.type === 'hline' || draft.type === 'vline') { finish(); down = null; return; }
    if (down && Math.hypot(p.x - down.x, p.y - down.y) > 8) { const pt = fromXY(p.x, p.y); if (pt) draft.b = pt; finish(); }
    else if (down) { draft.twoTap = true; }   // a tap: the second tap sets the end point
    down = null;
  }
  function finish() {
    if (!draft) return;
    const d = { id: draft.id || Date.now().toString(36), type: draft.type, a: draft.a };
    if (draft.type === 'hline') d.a = { p: draft.a.p };
    else if (draft.type === 'vline') d.a = { t: draft.a.t };
    else { if (!draft.b) return; d.b = draft.b; }
    draft = null;
    if (d.type === 'measure') { measure = d; render(); return; }   // a measurement is not kept
    drawings.push(d); selected = d; save();
    setTool('cursor');
  }

  function toggle(name) {
    if (name === 'magnet') { opts.magnet = !opts.magnet; saveOpts(); }
    else if (name === 'eye') { opts.hidden = !opts.hidden; saveOpts(); }
    else if (name === 'trash') {
      if (selected) { drawings = drawings.filter((d) => d !== selected); selected = null; save(); }
      else if (drawings.length && window.confirm('Delete all ' + drawings.length + ' drawings on this instrument?')) { drawings = []; save(); }
      measure = null;
    }
    syncToggles(); render();
  }
  function syncToggles() {
    if (!col) return;
    col.querySelector('[data-toggle="magnet"]').setAttribute('aria-pressed', String(opts.magnet));
    col.querySelector('[data-toggle="eye"]').setAttribute('aria-pressed', String(opts.hidden));
    const tr = col.querySelector('[data-toggle="trash"]'); tr.disabled = !selected && !drawings.length;
    tr.title = selected ? 'Delete the selected drawing' : 'Delete all drawings on this instrument';
  }

  function build() {
    const box = container(); if (!box || document.getElementById('drawCol')) return !!box;
    col = document.createElement('div'); col.id = 'drawCol'; col.className = 'draw-col ph-only';
    col.setAttribute('role', 'toolbar'); col.setAttribute('aria-label', 'Drawing tools'); col.setAttribute('aria-orientation', 'vertical');
    col.innerHTML = TOOLS.map(([id, label, ic]) => `<button type="button" data-tool="${id}" title="${label}" aria-label="${label}" aria-pressed="${id === 'cursor'}">${svgIcon(ic)}</button>`).join('')
      + '<span class="draw-sep" aria-hidden="true"></span>'
      + TOGGLES.map(([id, label, ic]) => `<button type="button" data-toggle="${id}" title="${label}" aria-label="${label}" aria-pressed="false">${svgIcon(ic)}</button>`).join('');
    col.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.tool) setTool(b.dataset.tool === tool && tool !== 'cursor' ? 'cursor' : b.dataset.tool);
      else if (b.dataset.toggle) toggle(b.dataset.toggle);
    });
    svg = document.createElementNS(NS, 'svg'); svg.id = 'drawSvg'; svg.setAttribute('class', 'draw-svg ph-only'); svg.setAttribute('aria-hidden', 'true');
    pad = document.createElement('div'); pad.id = 'drawPad'; pad.className = 'draw-pad ph-only'; pad.hidden = true;
    pad.addEventListener('pointerdown', onDown); pad.addEventListener('pointermove', onMove); pad.addEventListener('pointerup', onUp);
    pad.addEventListener('pointercancel', () => { draft = null; down = null; render(); });
    box.appendChild(svg); box.appendChild(pad); box.appendChild(col);
    const st = document.createElement('style'); st.id = 'drawStyle';
    st.textContent = 'html:not(.phone) .draw-col,html:not(.phone) .draw-svg,html:not(.phone) .draw-pad{display:none!important}'
      + '.draw-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:4;font-family:var(--font-ui,Inter,system-ui,sans-serif)}'
      + '.draw-pad{position:absolute;inset:0;z-index:6;touch-action:none;cursor:crosshair}.draw-pad[hidden]{display:none}'
      + '.draw-col{position:absolute;left:4px;top:38px;z-index:7;display:flex;flex-direction:column;gap:2px;padding:3px;border-radius:10px;background:rgba(14,14,17,.82);backdrop-filter:blur(6px)}'
      + '.draw-col button{position:relative;width:34px;height:34px;display:grid;place-items:center;border:0;border-radius:8px;background:none;color:#a1a1aa;cursor:pointer}'
      + '.draw-col button svg{width:19px;height:19px}'
      + '.draw-col button[aria-pressed="true"]{background:rgba(56,97,246,.22);color:#9db4ff}'
      + '.draw-col button:disabled{opacity:.35;cursor:default}'
      + '.draw-col button:focus-visible{outline:2px solid #93c5fd;outline-offset:1px}'
      + '.draw-sep{height:1px;margin:3px 4px;background:rgba(255,255,255,.1)}'
      + 'body.light .draw-col{background:rgba(255,255,255,.9)}body.light .draw-col button{color:#52525b}';
    document.head.appendChild(st);
    syncToggles();
    return true;
  }

  // Taps on the chart (pointer tool) select or clear a drawing.
  function hookChart() {
    const c = chartObj(); if (!c || !c.chart || hookedChart === c) return;
    hookedChart = c;
    c.chart.subscribeClick((param) => {
      if (!phone() || tool !== 'cursor' || !param || !param.point) return;
      const h = opts.hidden ? null : hit(param.point.x, param.point.y);
      if (h !== selected || measure) { selected = h; measure = null; syncToggles(); render(); }
    });
  }

  function tick() {
    if (!phone()) { if (svg && svg.firstChild) render(); return; }
    if (!col && !build()) return;
    hookChart();
    const c = chartObj(), sym = c && c.symbol;
    if (sym && sym !== symbol) { load(sym); syncToggles(); }
    render();
  }
  function start() { setInterval(tick, 60); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.ipfxDraw = { get drawings() { return drawings.slice(); }, setTool: (t) => setTool(t), get tool() { return tool; } };
})();
