/* IPFX Markets: a challenge-ready order ticket and a first-visit tour.
   Challenge accounts require a stop-loss and cap the risk of every order. Traders kept clicking Buy without a stop (758
   rejections, 195 traders) or sized in lots and went a few cents over the risk cap. On challenge accounts this ticket:
   - always sends a stop-loss: a stop DISTANCE, placed on the correct side when Buy or Sell is clicked;
   - sizes the order from a risk amount ($1, $2.50 or the maximum allowed), kept 5% under the cap for slippage;
   - shows the checks above Buy/Sell and keeps the buttons off, with the reason, until every check passes.
   Practice and futures accounts keep the classic ticket. The tour runs once per browser and replays from the ? button.
   Uses the page's own globals (engineState, activeSym, liveQuotesBySymbol, setLots, placeOrder, ...). */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const BUFFER = 0.95, TOUR_KEY = 'ipfx-markets-tour-v1';
  let riskChoice = 'max';      // 'max' | dollars
  let stopPips = null;         // trader's stop distance in pips/points; null = suggested default
  let manualStopPrice = false; // trader typed an exact stop price in the classic field

  const acct = () => (typeof engineState !== 'undefined' && engineState && engineState.account) || null;
  const lim = () => (acct() && acct().limits) || {};
  const isFut = () => typeof futSym === 'function' && !!futSym(activeSym);
  const on = () => { const a = acct(); return !!(a && lim().require_stop_loss && !a.is_demo && a.status === 'active' && !isFut()); };
  const quote = () => liveQuotesBySymbol.get(execSymbol(activeSym)) || null;
  const mid = () => { const q = quote(); return q ? (q.bid + q.ask) / 2 : (typeof ordMidPrice === 'number' ? ordMidPrice : 0); };
  const short = () => execSymbol(activeSym).replace(/[^A-Z0-9]/g, '');
  const category = () => { const c = execSymbol(activeSym); return Object.keys(WL_DATA).find((k) => WL_DATA[k].some((i) => execSymbol(i.sym) === c)) || 'forex'; };
  // One "pip" for forex; one point (1.00) for everything else, so the number the trader sees is familiar.
  const pipSize = () => (/JPY$/.test(short()) ? 0.01 : category() === 'forex' ? 0.0001 : category() === 'crypto' ? 1 : category() === 'metals' ? 0.1 : 1);
  const unit = () => (category() === 'forex' ? 'pips' : 'points');
  const digits = () => { const q = quote(); return q && Number.isInteger(q.digits) ? q.digits : (/JPY$/.test(short()) ? 3 : category() === 'forex' ? 5 : 2); };
  const defaultDist = () => mid() * (category() === 'crypto' ? 0.008 : category() === 'metals' || category() === 'indices' ? 0.0025 : 0.002);
  const dist = () => (stopPips != null && stopPips > 0 ? stopPips * pipSize() : defaultDist());
  const perLot = (d) => { const conv = clientUsdPerQuote(symMeta(activeSym).quoteCurrency); return conv == null || !(d > 0) ? null : d * contractSizeFor(activeSym) * conv; };
  const cap = () => { const v = +lim().max_risk_per_trade_usd; return isFinite(v) && v > 0 ? v : null; };
  const budget = () => { const c = cap(); if (c == null) return null; return (riskChoice === 'max' ? c : Math.min(c, riskChoice)) * BUFFER; };
  const usd = (v) => '$' + (+v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lotsFor = (d) => { const p = perLot(d), b = budget(); return p && b ? Math.floor((b / p) * 100 + 1e-9) / 100 : null; };
  const stopFor = (side) => { const q = quote(); const entry = side === 'buy' ? (q ? q.ask : mid()) : (q ? q.bid : mid()); const s = side === 'buy' ? entry - dist() : entry + dist(); return +s.toFixed(digits()); };

  // ---- checks shown above Buy/Sell ----
  function checks() {
    const a = acct(), d = dist(), lots = lotsFor(d), p = perLot(d), c = cap();
    const out = [];
    out.push({ ok: d > 0 && d >= mid() * 0.0002, text: d > 0 ? `Stop ${(d / pipSize()).toFixed(1)} ${unit()} away` : 'Set a stop distance', why: 'Stop too close to price for the broker' });
    const risk = lots && p ? lots * p : null;
    out.push({ ok: lots != null && lots >= 0.01, text: risk != null && lots >= 0.01 ? `Risk ${usd(risk)} of ${usd(c)} · ${lots.toFixed(2)} lots` : 'Risk', why: p == null ? 'Waiting for a conversion price' : c == null ? 'Waiting for your account limits' : 'Stop too wide for your risk limit at the minimum size: move the stop closer' });
    const fresh = typeof feedFresh !== 'function' || feedFresh();
    out.push({ ok: fresh, text: 'Prices live', why: 'Prices reconnecting… orders resume automatically' });
    const capMsg = typeof dailyCapMessage === 'function' ? dailyCapMessage() : null;
    out.push({ ok: !capMsg && a && a.status === 'active', text: 'Trading open', why: capMsg || 'Account is not active' });
    return out;
  }

  // ---- ticket UI (challenge accounts only) ----
  function css() {
    if ($('gtStyle')) return;
    const s = document.createElement('style'); s.id = 'gtStyle';
    s.textContent = `.gt-card{border:1px solid var(--line,#2a2a30);border-radius:12px;padding:12px;margin:10px 0;background:rgba(255,255,255,.02)}
.gt-h{display:flex;justify-content:space-between;align-items:center;font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#9aa0aa;margin-bottom:8px}
.gt-h b{color:#10b981;font-size:.68rem;letter-spacing:.04em}
.gt-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0}
.gt-row>span{font-size:.82rem;color:#d4d4d8;font-weight:600}
.gt-step{display:flex;align-items:center;border:1px solid #2f2f36;border-radius:8px;overflow:hidden}
.gt-step button{width:30px;height:30px;border:0;background:#17171b;color:#e4e4e7;font-size:1rem;cursor:pointer}
.gt-step input{width:70px;height:30px;border:0;background:#0f0f12;color:#fff;text-align:center;font:600 .85rem 'JetBrains Mono',monospace}
.gt-sub{font-size:.72rem;color:#8b8f98;margin-top:-4px}
.gt-chips{display:flex;gap:6px}.gt-chips button{border:1px solid #2f2f36;background:#17171b;color:#cbd5e1;border-radius:999px;padding:5px 10px;font-size:.76rem;font-weight:600;cursor:pointer}
.gt-chips button.on{background:#2563eb;border-color:#2563eb;color:#fff}
.gt-checks{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:4px}
.gt-checks li{font-size:.78rem;display:flex;gap:6px;align-items:flex-start;color:#d4d4d8}.gt-checks li i{font-style:normal;font-weight:800;width:14px}
.gt-checks li.ok i{color:#10b981}.gt-checks li.no{color:#fbbf24}.gt-checks li.no i{color:#f59e0b}
body.gt-on .op-quickbar .op-quick:nth-child(1),body.gt-on .op-quickbar .op-quick:nth-child(2),body.gt-on .op-presets,body.gt-on .op-lot-minus,body.gt-on .op-lot-plus{display:none!important}
body.gt-on #ord-lots{pointer-events:none}body.gt-on .op-lot-sub::after{content:' · sized from your risk'}
.op-exec-btn.gt-off{opacity:.35;cursor:not-allowed;filter:grayscale(.4)}
.gt-help{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;border:1px solid #2f2f36;background:transparent;color:#e4e4e7;font-weight:800;cursor:pointer;margin-right:6px}
.gt-tour-scrim{position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.55)}
.gt-tour-hole{position:fixed;z-index:99991;border-radius:12px;box-shadow:0 0 0 9999px rgba(0,0,0,.55),0 0 0 3px #2563eb;pointer-events:none;transition:all .25s}
.gt-tour-card{position:fixed;z-index:99992;width:320px;background:#111114;border:1px solid #2f2f36;border-radius:14px;padding:16px;color:#fff;box-shadow:0 20px 60px rgba(0,0,0,.6);font:14px/1.5 Inter,system-ui,sans-serif}
.gt-tour-card h4{margin:0 0 6px;font-size:15px}.gt-tour-card p{margin:0 0 12px;color:#c4c4cc;font-size:13px}
.gt-tour-card .gt-tour-foot{display:flex;justify-content:space-between;align-items:center}
.gt-tour-card .gt-tour-foot span{color:#7c7c86;font-size:12px}
.gt-tour-card button{border:0;border-radius:8px;padding:7px 14px;font-weight:700;cursor:pointer}
.gt-tour-card .gt-next{background:#2563eb;color:#fff}.gt-tour-card .gt-skip{background:transparent;color:#9aa0aa;margin-right:6px}`;
    document.head.appendChild(s);
  }
  function mount() {
    if ($('gtCard')) return;
    const bar = document.querySelector('#tab-order .op-quickbar'); if (!bar) return;
    const el = document.createElement('div'); el.className = 'gt-card'; el.id = 'gtCard'; el.hidden = true;
    el.innerHTML = `<div class="gt-h">Protected order <b>Stop-loss on every trade</b></div>
      <div class="gt-row" id="gtStopRow"><span>Stop loss</span><div class="gt-step"><button type="button" data-gt="stop-" aria-label="Move stop closer">−</button><input id="gtStop" inputmode="decimal" aria-label="Stop distance"><button type="button" data-gt="stop+" aria-label="Move stop further">+</button></div></div>
      <div class="gt-sub" id="gtStopSub"></div>
      <div class="gt-row" id="gtRiskRow"><span>Risk per trade</span><div class="gt-chips" id="gtChips"></div></div>
      <ul class="gt-checks" id="gtChecks"></ul>`;
    bar.after(el);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-gt]'); if (!b) return;
      const g = b.dataset.gt;
      if (g === 'stop-' || g === 'stop+') { const cur = dist() / pipSize(); const step = cur >= 100 ? 10 : cur >= 20 ? 2 : 1; stopPips = Math.max(step, cur + (g === 'stop+' ? step : -step)); manualStopPrice = false; }
      else if (g.startsWith('risk:')) { const v = g.slice(5); riskChoice = v === 'max' ? 'max' : +v; }
      refresh();
    });
    $('gtStop').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (v > 0) { stopPips = v; manualStopPrice = false; } refresh(); });
    const sl = $('slPrice'); if (sl) sl.addEventListener('input', () => { manualStopPrice = true; });
  }
  let lastSym = null;
  function refresh() {
    const card = $('gtCard'); if (!card) return;
    // Market orders use the protected ticket; pending orders keep the classic controls (stop still required).
    const active = on() && (typeof orderType === 'undefined' || orderType === 'market');
    document.body.classList.toggle('gt-on', active);
    card.hidden = !active;
    const btns = document.querySelectorAll('#tab-order .op-exec-btn');
    if (!active) { btns.forEach((b) => { b.classList.remove('gt-off'); b.removeAttribute('title'); }); return; }
    if (lastSym !== activeSym) { lastSym = activeSym; stopPips = null; manualStopPrice = false; }
    const d = dist();
    if (document.activeElement !== $('gtStop')) $('gtStop').value = (d / pipSize()).toFixed(1);
    $('gtStopSub').textContent = `${unit()} from entry · buy stop ${stopFor('buy').toFixed(digits())} · sell stop ${stopFor('sell').toFixed(digits())}`;
    const c = cap();
    const chips = c ? [1, 2.5].filter((v) => v < c).map((v) => ({ k: String(v), t: usd(v) })).concat([{ k: 'max', t: 'Max ' + usd(c) }]) : [];
    $('gtChips').innerHTML = chips.map((x) => `<button type="button" data-gt="risk:${x.k}" class="${String(riskChoice) === x.k ? 'on' : ''}">${x.t}</button>`).join('');
    const lots = lotsFor(d);
    if (lots != null && lots >= 0.01 && Math.abs(lots - ordLots) > 1e-9) setLots(lots, null);
    const cs = checks(), bad = cs.find((x) => !x.ok);
    $('gtChecks').innerHTML = cs.map((x) => `<li class="${x.ok ? 'ok' : 'no'}"><i>${x.ok ? '✓' : '!'}</i><span>${x.ok ? x.text : x.why}</span></li>`).join('');
    btns.forEach((b) => { b.classList.toggle('gt-off', !!bad); if (bad) b.title = bad.why; else b.removeAttribute('title'); });
  }

  // ---- order hook: every challenge market order carries the stop and the risk-sized lots ----
  const original = window.placeOrder;
  window.placeOrder = async function (side) {
    if (on() && (typeof orderType === 'undefined' || orderType === 'market')) {
      const bad = checks().find((x) => !x.ok);
      if (bad) { engineMsg(bad.why); return; }
      const slField = $('slPrice');
      const typed = parseFloat(slField && slField.value);
      const typedOk = manualStopPrice && isFinite(typed) && (side === 'buy' ? typed < mid() : typed > mid());
      const stop = typedOk ? typed : stopFor(side);
      const lots = lotsFor(Math.abs((side === 'buy' ? quote()?.ask ?? mid() : quote()?.bid ?? mid()) - stop));
      if (!(lots >= 0.01)) { engineMsg('Stop too wide for your risk limit at the minimum size: move the stop closer.'); return; }
      if (!slOn) toggleSLTP('sl');
      slField.value = String(stop);
      setLots(lots, null);
    } else if (on() && !slOn) {
      engineMsg('Add a stop loss to this pending order: your challenge requires one on every order.'); return;
    }
    return original.call(this, side);
  };

  // ---- first-visit tour ----
  const STEPS = [
    { sel: '#op-sym', title: 'Pick a market', text: 'Choose what to trade here, or press / to search. The chart follows your choice.' },
    { sel: '#gtStopRow', alt: '.op-quickbar', title: 'Your stop loss is automatic', text: 'Every challenge trade needs a stop loss. Set how far away it sits; we place it on the right side when you click Buy or Sell.' },
    { sel: '#gtRiskRow', alt: '.op-lot-stack', title: 'Choose how much to risk', text: 'Pick a dollar amount. We work out the lot size so the trade never risks more than your limit.' },
    { sel: '.op-trade-row', title: 'Buy or Sell', text: 'The green ticks above must all be ticked. Then click Buy if you think price goes up, Sell if it goes down.' },
    { sel: '.btab[onclick*="challenge"]', title: 'Watch your progress', text: 'Your target, loss limits and every rule you still need to meet are in the Challenge tab.' },
  ];
  function tour(i = 0) {
    document.querySelectorAll('.gt-tour-scrim,.gt-tour-hole,.gt-tour-card').forEach((n) => n.remove());
    if (i >= STEPS.length) { try { localStorage.setItem(TOUR_KEY, '1'); } catch (_) {} return; }
    const s = STEPS[i], target = [s.sel, s.alt].map((q) => q && document.querySelector(q)).find((n) => n && !n.hidden && n.offsetParent !== null);
    if (!target) return tour(i + 1);
    const r = target.getBoundingClientRect(), pad = 6;
    const hole = document.createElement('div'); hole.className = 'gt-tour-hole';
    Object.assign(hole.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
    const card = document.createElement('div'); card.className = 'gt-tour-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', s.title);
    card.innerHTML = `<h4>${s.title}</h4><p>${s.text}</p><div class="gt-tour-foot"><span>${i + 1} of ${STEPS.length}</span><div><button class="gt-skip" type="button">Skip</button><button class="gt-next" type="button">${i + 1 === STEPS.length ? 'Start trading' : 'Next'}</button></div></div>`;
    const left = r.left - 340 > 12 ? r.left - 340 : Math.min(window.innerWidth - 332, r.right + 12);
    Object.assign(card.style, { left: Math.max(12, left) + 'px', top: Math.min(window.innerHeight - 200, Math.max(12, r.top)) + 'px' });
    const scrim = document.createElement('div'); scrim.className = 'gt-tour-scrim';
    document.body.append(scrim, hole, card);
    card.querySelector('.gt-next').onclick = () => tour(i + 1);
    card.querySelector('.gt-skip').onclick = () => tour(STEPS.length);
    card.querySelector('.gt-next').focus();
  }
  window.ipfxTour = () => tour(0);
  function helpButton() {
    if ($('gtHelp')) return;
    const fb = document.querySelector('.tb-feedback'); if (!fb) return;
    const b = document.createElement('button'); b.type = 'button'; b.id = 'gtHelp'; b.className = 'gt-help'; b.textContent = '?'; b.title = 'Show me how IPFX Markets works';
    b.onclick = () => tour(0); fb.before(b);
  }

  function start() {
    css(); mount(); helpButton();
    setInterval(refresh, 500);
    // First visit: wait until the account and prices have loaded (and the cookie choice is made) so the tour points at the real ticket.
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      let seen = false; try { seen = localStorage.getItem(TOUR_KEY) === '1'; } catch (_) {}
      if (seen || tries > 300) { clearInterval(t); return; }
      const cookie = document.querySelector('.ipfx-cookie-panel');
      if (cookie && cookie.getClientRects().length) return; // let the privacy choice go first
      if (acct() && document.querySelector('.op-trade-row') && !document.querySelector('dialog[open]')) { clearInterval(t); setTimeout(() => tour(0), 600); }
    }, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
