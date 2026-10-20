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
  let invalidStopDistance = false;
  let manualStopPrice = false; // trader typed an exact stop price in the classic field
  let userLots = null;         // lot size the trader chose; null = use the maximum their risk limit allows
  let lastSet = null;          // the lot size this script last put in the box (anything else in the box is the trader's choice)

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
  const minDist = () => mid() * 0.0002;
  const defaultDist = () => {
    const suggested = mid() * (category() === 'crypto' ? 0.008 : category() === 'metals' || category() === 'indices' ? 0.0025 : 0.002);
    const cost = perLot(1), available = budget();
    if (!(cost > 0) || !(available > 0)) return suggested;
    // At least 0.01 lots must fit. Gold's old 0.25% suggestion could risk $10+ on a $5 Stage 1 account,
    // leaving both buttons blocked before the trader had even touched the ticket.
    const precision = 10 ** digits();
    return Math.min(suggested, Math.floor(available / (cost * 0.01) * precision + 1e-9) / precision);
  };
  const dist = () => (stopPips != null && stopPips > 0 ? stopPips * pipSize() : defaultDist());
  const perLot = (d) => { const conv = clientUsdPerQuote(symMeta(activeSym).quoteCurrency); return conv == null || !(d > 0) ? null : d * contractSizeFor(activeSym) * conv; };
  const cap = () => { const v = +lim().max_risk_per_trade_usd; return isFinite(v) && v > 0 ? v : null; };
  const budget = () => { const c = cap(); if (c == null) return null; return (riskChoice === 'max' ? c : Math.min(c, riskChoice)) * BUFFER; };
  const usd = (v) => '$' + (+v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // The ticket suggests the largest size the risk limit allows, but the trader can always type a smaller one (never a larger one).
  const syncUser = () => { if (lastSet != null && Math.abs(ordLots - lastSet) > 1e-9) userLots = Math.round(ordLots * 100) / 100; };
  const useLots = (max) => (max == null || max < 0.01 ? null : userLots != null ? Math.max(0.01, Math.min(userLots, max)) : max);
  const lotsFor = (d) => { const p = perLot(d), b = budget(); return p && b ? Math.floor((b / p) * 100 + 1e-9) / 100 : null; };
  const stopFor = (side) => { const q = quote(); const entry = side === 'buy' ? (q ? q.ask : mid()) : (q ? q.bid : mid()); const s = side === 'buy' ? entry - dist() : entry + dist(); return +s.toFixed(digits()); };

  // ---- checks shown above Buy/Sell ----
  function checks(side = null) {
    const a = acct(), q = quote(), field = $('slPrice'), typed = Number(field?.value);
    const entry = side === 'buy' ? q?.ask : side === 'sell' ? q?.bid : null;
    const manual = manualStopPrice && side != null;
    const invalidInput = !!field?.validity?.badInput;
    const invalidDistance = invalidStopDistance && !manualStopPrice;
    const validSide = !manual || (Number.isFinite(typed) && typed > 0 && (side === 'buy' ? typed < entry : typed > entry));
    const d = manual && validSide ? Math.abs(entry - typed) : dist();
    const max = lotsFor(d), lots = useLots(max), p = perLot(d), c = cap();
    const out = [];
    out.push({ ok: !invalidInput && !invalidDistance && !!q && validSide && d > 0 && d >= minDist(), text: d > 0 ? `Stop ${(d / pipSize()).toFixed(1)} ${unit()} away` : 'Set a stop distance',
      why: invalidInput ? 'Finish entering a valid stop price before submitting.' : invalidDistance ? 'Enter a valid positive stop distance before submitting.' : !q ? 'Waiting for a live price for this market' : !validSide ? `For ${side}, set a stop on the loss side of the entry price` : defaultDist() < minDist() ? 'This market needs more than your current risk limit at the minimum 0.01 lot size. Try another market or wait for your limit to reset.' : 'Stop too close to price for the broker' });
    const risk = lots && p ? lots * p : null;
    out.push({ ok: max != null && max >= 0.01, text: risk != null && lots >= 0.01 ? `Risk ${usd(risk)} of ${usd(c)} · ${lots.toFixed(2)} lots` : 'Risk', why: p == null ? 'Waiting for a conversion price' : c == null ? 'Waiting for your account limits' : defaultDist() < minDist() ? 'This market needs more than your current risk limit at the minimum 0.01 lot size. Try another market or wait for your limit to reset.' : 'Stop too wide for your risk limit at the minimum size: move the stop closer' });
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
body.gt-on #opRisk,body.gt-on .op-quickbar .op-quick:nth-child(1),body.gt-on .op-presets{display:none!important}
.gt-lotnote button{border:0;background:none;color:#60a5fa;font:inherit;cursor:pointer;text-decoration:underline;padding:0 0 0 6px}
.gt-exact{border:0;background:none;color:#60a5fa;font:600 .73rem Inter,system-ui,sans-serif;text-decoration:underline;cursor:pointer;padding:5px 0 0}
.op-exec-btn.gt-off{opacity:.35;cursor:not-allowed;filter:grayscale(.4)}
.gt-help{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 10px;border-radius:8px;border:1px solid #2f2f36;background:transparent;color:#e4e4e7;font-weight:600;font-size:12px;cursor:pointer;margin-right:6px}
.gt-tour-scrim{position:fixed;inset:0;z-index:99990;background:transparent;cursor:pointer}
.gt-tour-hole{position:fixed;z-index:99991;border-radius:12px;box-shadow:0 0 0 9999px rgba(0,0,0,.55),0 0 0 3px #2563eb;pointer-events:none;transition:all .25s}
.gt-tour-card{position:fixed;z-index:99992;width:320px;background:#111114;border:1px solid #2f2f36;border-radius:14px;padding:16px;color:#fff;box-shadow:0 20px 60px rgba(0,0,0,.6);font:14px/1.5 Inter,system-ui,sans-serif}
.gt-tour-card h4{margin:0 0 6px;font-size:15px;padding-right:22px}
.gt-tour-card .gt-x{position:absolute;top:8px;right:8px;width:28px;height:28px;padding:0;background:transparent;color:#9aa0aa;font-size:20px;line-height:1;border-radius:8px}.gt-tour-card .gt-x:hover{background:#1f1f25;color:#fff}.gt-tour-card p{margin:0 0 12px;color:#c4c4cc;font-size:13px}
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
      <button type="button" class="gt-exact" id="gtExact">Set an exact stop price</button>
      <div class="gt-row" id="gtRiskRow"><span>Risk per trade</span><div class="gt-chips" id="gtChips"></div></div>
      <div class="gt-sub gt-lotnote" id="gtLotNote"></div>
      <ul class="gt-checks" id="gtChecks"></ul>`;
    bar.after(el);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-gt]'); if (!b) return;
      const g = b.dataset.gt;
      if (g === 'stop-' || g === 'stop+') { const cur = dist() / pipSize(); const step = cur >= 100 ? 10 : cur >= 20 ? 2 : 1; stopPips = Math.max(step, cur + (g === 'stop+' ? step : -step)); invalidStopDistance = false; manualStopPrice = false; $('slPrice').value = ''; }
      else if (g.startsWith('risk:')) { const v = g.slice(5); riskChoice = v === 'max' ? 'max' : +v; userLots = null; }
      else if (g === 'autolots') { userLots = null; }
      refresh();
    });
    const editDistance = (e) => {
      const raw = e.target.value.trim(), v = Number(raw);
      invalidStopDistance = raw === '' || !Number.isFinite(v) || v <= 0;
      manualStopPrice = false;
      if (!invalidStopDistance) { stopPips = v; $('slPrice').value = ''; }
      refresh();
    };
    $('gtStop').addEventListener('input', editDistance);
    $('gtStop').addEventListener('change', editDistance);
    $('gtExact').onclick = () => { invalidStopDistance = false; if (!slOn) toggleSLTP('sl'); refresh(); $('slPrice').focus(); };
    const sl = $('slPrice'); if (sl) sl.addEventListener('input', () => { manualStopPrice = sl.value.trim() !== '' || !!sl.validity?.badInput; refresh(); });
  }
  let lastSym = typeof activeSym === 'undefined' ? null : activeSym;
  function refresh() {
    const card = $('gtCard'); if (!card) return;
    // Market orders use the protected ticket; pending orders keep the classic controls (stop still required).
    const active = on() && (typeof orderType === 'undefined' || orderType === 'market');
    document.body.classList.toggle('gt-on', active);
    card.hidden = !active;
    const btns = document.querySelectorAll('#tab-order .op-exec-btn');
    if (!active) { btns.forEach((b) => { b.classList.remove('gt-off'); b.removeAttribute('title'); }); return; }
    if (lastSym !== activeSym) { lastSym = activeSym; stopPips = null; invalidStopDistance = false; manualStopPrice = false; userLots = null; lastSet = null; $('slPrice').value = ''; }
    const d = dist();
    if (!invalidStopDistance && document.activeElement !== $('gtStop')) $('gtStop').value = (d / pipSize()).toFixed(1);
    $('gtStopSub').textContent = manualStopPrice ? 'Exact stop price selected. Buy and Sell are checked separately.' : invalidStopDistance ? 'Finish the stop distance to preview Buy and Sell stops.' : `${unit()} from entry · buy stop ${stopFor('buy').toFixed(digits())} · sell stop ${stopFor('sell').toFixed(digits())}`;
    const c = cap();
    const chips = c ? [1, 2.5].filter((v) => v < c).map((v) => ({ k: String(v), t: usd(v) })).concat([{ k: 'max', t: 'Max ' + usd(c) }]) : [];
    $('gtChips').innerHTML = chips.map((x) => `<button type="button" data-gt="risk:${x.k}" class="${String(riskChoice) === x.k ? 'on' : ''}">${x.t}</button>`).join('');
    syncUser();
    const q = quote(), typed = Number($('slPrice')?.value);
    const manualSide = manualStopPrice && q && Number.isFinite(typed) && typed > 0
      ? typed < q.bid ? 'buy' : typed > q.ask ? 'sell' : null : null;
    const sizingDist = manualStopPrice ? manualSide ? Math.abs((manualSide === 'buy' ? q.ask : q.bid) - typed) : null : d;
    const max = sizingDist == null ? null : lotsFor(sizingDist), lots = useLots(max), editing = document.activeElement === $('ord-lots');
    if (lots != null && !editing) { if (Math.abs(lots - ordLots) > 1e-9) setLots(lots, null); lastSet = ordLots; }
    $('gtLotNote').innerHTML = lots == null ? (manualStopPrice ? 'Set the exact stop outside the market to size this order.' : '') : `Size ${lots.toFixed(2)} lots · up to ${max.toFixed(2)} at this stop and risk${manualSide ? ` for ${manualSide.toUpperCase()}` : ''}${userLots != null ? '<button type="button" data-gt="autolots">Use max</button>' : ''}`;
    const cs = checks(), buyBad = checks('buy').find((x) => !x.ok), sellBad = checks('sell').find((x) => !x.ok);
    const bad = buyBad || sellBad;
    // Buy/Sell sits right under this card: when every check passes, one reassuring line beats four, so the trader
    // doesn't have to scroll past a wall of ticks to reach the buttons. The full list comes back the moment something
    // needs attention, so nothing diagnostic is ever hidden while a trade is actually blocked.
    $('gtChecks').innerHTML = bad
      ? manualStopPrice ? ['buy', 'sell'].map((side) => { const problem = side === 'buy' ? buyBad : sellBad; return `<li class="${problem ? 'no' : 'ok'}"><i>${problem ? '!' : '✓'}</i><span>${side.toUpperCase()}: ${problem ? problem.why : checks(side)[1].text}</span></li>`; }).join('')
      : cs.map((x) => `<li class="${x.ok ? 'ok' : 'no'}"><i>${x.ok ? '✓' : '!'}</i><span>${x.ok ? x.text : x.why}</span></li>`).join('')
      : `<li class="ok"><i>✓</i><span>Ready to trade — ${cs[0].text} · ${cs[1].text}</span></li>`;
    btns.forEach((b) => { const problem = b.classList.contains('op-exec-buy') ? buyBad : sellBad; b.classList.toggle('gt-off', !!problem); if (problem) b.title = problem.why; else b.removeAttribute('title'); });
  }

  // ---- order hook: every challenge market order carries the stop and the risk-sized lots ----
  const original = window.placeOrder;
  window.placeOrder = async function (side) {
    if (on() && (typeof orderType === 'undefined' || orderType === 'market')) {
      const bad = checks(side).find((x) => !x.ok);
      if (bad) { engineMsg(bad.why); return; }
      const slField = $('slPrice');
      const typed = Number(slField && slField.value);
      const stop = manualStopPrice ? typed : stopFor(side);
      syncUser();
      const max = lotsFor(Math.abs((side === 'buy' ? quote()?.ask ?? mid() : quote()?.bid ?? mid()) - stop)), lots = useLots(max);
      if (!(lots >= 0.01)) { engineMsg('Stop too wide for your risk limit at the minimum size: move the stop closer.'); return; }
      if (!slOn) toggleSLTP('sl');
      slField.value = String(stop);
      setLots(lots, null); lastSet = ordLots;
    } else if (on() && !slOn) {
      engineMsg('Add a stop loss to this pending order: your challenge requires one on every order.'); return;
    }
    return original.call(this, side);
  };

  // ---- first-visit tour ----
  const STEPS = [
    { sel: '#op-sym', title: 'Pick a market', text: 'Choose what to trade here, or press / to search. The chart follows your choice.' },
    { sel: '#gtStopRow', alt: '.op-quickbar', title: 'Your stop loss is automatic', text: 'Every challenge trade needs a stop loss. Set how far away it sits; we place it on the right side when you click Buy or Sell.' },
    { sel: '#gtRiskRow', alt: '.op-lot-stack', title: 'Choose how much to risk', text: 'Pick a dollar amount and we suggest the biggest lot size that fits. You can type a smaller size in the lot box, but never one above your limit.' },
    { sel: '.op-trade-row', title: 'Buy or Sell', text: 'The green ticks above must all be ticked. Then click Buy if you think price goes up, Sell if it goes down.' },
    { sel: '.btab[onclick*="challenge"]', title: 'Watch your progress', text: 'Your target, loss limits and every rule you still need to meet are in the Challenge tab.' },
  ];
  let tourSeen = false;
  const hasSeenTour = () => { if (tourSeen) return true; try { tourSeen = localStorage.getItem(TOUR_KEY) === '1'; } catch (_) {} return tourSeen; };
  const seenTour = () => { tourSeen = true; try { localStorage.setItem(TOUR_KEY, '1'); } catch (_) {} };
  const endTour = () => { document.querySelectorAll('.gt-tour-scrim,.gt-tour-hole,.gt-tour-card').forEach((n) => n.remove()); document.removeEventListener('keydown', tourKeys, true); };
  function tourKeys(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTour(); } }
  // Shown once: the moment it opens it counts as seen, so closing it any way (×, Esc, click outside, Skip, leaving the
  // page) means it never opens by itself again. The Tour button in the top bar replays it.
  function tour(i = 0) {
    endTour();
    if (i >= STEPS.length) return;
    seenTour();
    const s = STEPS[i], target = [s.sel, s.alt].map((q) => q && document.querySelector(q)).find((n) => n && !n.hidden && n.offsetParent !== null);
    if (!target) return tour(i + 1);
    const r = target.getBoundingClientRect(), pad = 6;
    const hole = document.createElement('div'); hole.className = 'gt-tour-hole';
    Object.assign(hole.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
    const card = document.createElement('div'); card.className = 'gt-tour-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', s.title);
    card.innerHTML = `<button class="gt-x" type="button" aria-label="Close tour" title="Close (Esc)">×</button><h4>${s.title}</h4><p>${s.text}</p><div class="gt-tour-foot"><span>${i + 1} of ${STEPS.length}</span><div><button class="gt-skip" type="button">Skip</button><button class="gt-next" type="button">${i + 1 === STEPS.length ? 'Start trading' : 'Next'}</button></div></div>`;
    const left = r.left - 340 > 12 ? r.left - 340 : Math.min(window.innerWidth - 332, r.right + 12);
    Object.assign(card.style, { left: Math.max(12, left) + 'px', top: Math.min(window.innerHeight - 200, Math.max(12, r.top)) + 'px' });
    const scrim = document.createElement('div'); scrim.className = 'gt-tour-scrim';
    document.body.append(scrim, hole, card);
    document.addEventListener('keydown', tourKeys, true);
    scrim.onclick = endTour;
    card.querySelector('.gt-x').onclick = endTour;
    card.querySelector('.gt-next').onclick = () => tour(i + 1);
    card.querySelector('.gt-skip').onclick = endTour;
    card.querySelector('.gt-next').focus();
  }
  window.ipfxTour = () => tour(0);
  function helpButton() {
    if ($('gtHelp')) return;
    const fb = document.querySelector('.tb-feedback'); if (!fb) return;
    const b = document.createElement('button'); b.type = 'button'; b.id = 'gtHelp'; b.className = 'gt-help'; b.textContent = 'Tour'; b.title = 'Show me how IPFX Markets works';
    b.onclick = () => tour(0); fb.before(b);
  }
  function start() {
    css(); mount(); helpButton();
    setInterval(refresh, 500);
    // First visit: wait until the account and prices have loaded (and the cookie choice is made) so the tour points at the real ticket.
    let tries = 0, pending = false;
    const ready = () => {
      const cookie = document.querySelector('.ipfx-cookie-panel');
      if (cookie && cookie.getClientRects().length) return false;
      const ticket = document.querySelector('.op-trade-row');
      const modal = [...document.querySelectorAll('.omdlg.open,dialog[open],[role="dialog"],[role="alertdialog"]')].some((el) => el.getClientRects().length);
      return !!(acct() && ticket && ticket.getClientRects().length && !modal);
    };
    const t = setInterval(() => {
      tries++;
      if (hasSeenTour() || tries > 300) { clearInterval(t); return; }
      if (pending || !ready()) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        // A manual replay/dismissal or a new dialog can happen during the delay.
        if (hasSeenTour() || tries > 300) { clearInterval(t); return; }
        if (!ready()) return;
        clearInterval(t); tour(0);
      }, 600);
    }, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
