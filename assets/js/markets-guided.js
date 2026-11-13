/* IPFX Markets: a challenge-ready order ticket and a first-visit tour.
   Challenge accounts require a stop-loss and cap the risk of every order. Traders kept clicking Buy without a stop (758
   rejections, 195 traders) or sized in lots and went a few cents over the risk cap. On challenge accounts this ticket:
   - always sends a stop-loss: a stop DISTANCE, placed on the correct side when Buy or Sell is clicked;
   - sizes the order from a risk amount ($1, $2.50 or the maximum allowed), kept 5% under the cap for slippage;
   - shows the checks above Buy/Sell and keeps the buttons off, with the reason, until every check passes.
   Practice and futures accounts keep the classic ticket. The tour runs once per browser and replays from the ? button.
   November 2026 redesign: the stop is still sent on every order, but the big "Protected order" panel is now one line
   ("Stop 40.0 pips · Risk $4.00 of $5.00 · 0.01 lots  Edit"); Edit opens the full controls. Sizing now leaves room for
   risk already open on the same trade idea and in total (the two limits behind most rejections after v2 launched) and
   for half a spread of slippage. View-only markets disable Buy/Sell on every ticket, not just the challenge one.
   8 Nov 2026 (owner): on Infinity accounts the stop is no longer needed to place a trade. Buy/Sell send the order as it is
   ("Auto stop" can be switched on to keep adding one), the ticket states the 30-second stop rule in red, and after the fill
   a card that cannot be dismissed counts down the 30 seconds with an "Add stop" button (window.ipfxSuggestStop). The
   engine still closes a trade left without a stop, removes its profit and records a warning; 3 warnings end the run.
   Traditional challenges that require a stop keep the automatic stop.
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
  const OPEN_KEY = 'ipfx-ticket-stop-open';
  let expanded = false;         // full stop/risk controls shown (remembered per browser); the one-line summary otherwise
  try { expanded = localStorage.getItem(OPEN_KEY) === '1'; } catch (_) {}
  let lastChecksHtml = '';
  const AUTO_KEY = 'ipfx-ticket-autostop';
  let autoStop = false;         // Infinity: add the suggested stop to each order (off by default; remembered per browser)
  try { autoStop = localStorage.getItem(AUTO_KEY) === '1'; } catch (_) {}

  const acct = () => (typeof engineState !== 'undefined' && engineState && engineState.account) || null;
  const minLot = () => typeof window!=='undefined' && window.ipfxInfinityV2 ? window.ipfxInfinityV2.minLot() : 0.01;
  const lotDigits = () => minLot()<0.01?3:2;
  const lim = () => (acct() && acct().limits) || {};
  const isFut = () => typeof futSym === 'function' && !!futSym(activeSym);
  // Infinity runs enforce the stop with the 30-second rule, so the ticket does not have to: a stop is optional there.
  const deadline = () => { const v = +lim().stop_loss_deadline_seconds; return isFinite(v) && v > 0 ? v : null; };
  const optional = () => acct()?.challenge_type === 'infinity' && deadline() != null;
  const sending = () => !optional() || autoStop || manualStopPrice;     // does the next order carry a stop?
  const strikes = () => { const a = acct() || {}; return { n: +a.sl_strikes || 0, max: +a.sl_strikes_max || +a.infinity_v2?.rules?.sl_strikes_max || 3 }; };
  const v2 = () => acct()?.rules_version === 'infinity_v2';
  const on = () => { const a = acct(); return !!(a && lim().require_stop_loss && !a.is_demo && a.status === 'active' && !isFut()); };
  const quote = () => liveQuotesBySymbol.get(execSymbol(activeSym)) || null;
  const mid = () => { const q = quote(); return q ? (q.bid + q.ask) / 2 : (typeof ordMidPrice === 'number' ? ordMidPrice : 0); };
  const short = () => execSymbol(activeSym).replace(/[^A-Z0-9]/g, '');
  const category = () => { const c = execSymbol(activeSym); return Object.keys(WL_DATA).find((k) => WL_DATA[k].some((i) => execSymbol(i.sym) === c)) || 'forex'; };
  // One "pip" for forex; one point (1.00) for everything else, so the number the trader sees is familiar.
  const pipSize = () => (/JPY$/.test(short()) ? 0.01 : category() === 'forex' ? 0.0001 : category() === 'crypto' ? 1 : category() === 'metals' ? 0.1 : 1);
  const unit = () => (category() === 'forex' ? 'pips' : 'points');
  const digits = () => { const q = quote(); return q && Number.isInteger(q.digits) ? q.digits : (/JPY$/.test(short()) ? 3 : category() === 'forex' ? 5 : 2); };
  const minDist = () => acct()?.rules_version==='infinity_v2' ? (quote()?.spread||0)*Number(acct().infinity_v2?.rules?.stop_spread_multiple||8) : mid() * 0.0002;
  const defaultDist = () => {
    const suggested = mid() * (category() === 'crypto' ? 0.008 : category() === 'metals' || category() === 'indices' ? 0.0025 : 0.002);
    const cost = perLot(1), available = budget();
    if (!(cost > 0) || !(available > 0)) return suggested;
    // At least 0.01 lots must fit. Gold's old 0.25% suggestion could risk $10+ on a $5 Stage 1 account,
    // leaving both buttons blocked before the trader had even touched the ticket.
    const precision = 10 ** digits();
    const fitted=Math.min(suggested, Math.floor((available / (cost * minLot()) - slipPad()) * precision + 1e-9) / precision);   // sizing adds half a spread
    return acct()?.rules_version==='infinity_v2'?Math.max(minDist(),fitted):fitted;
  };
  const dist = () => (stopPips != null && stopPips > 0 ? stopPips * pipSize() : defaultDist());
  const perLot = (d) => { const conv = clientUsdPerQuote(symMeta(activeSym).quoteCurrency); return conv == null || !(d > 0) ? null : d * contractSizeFor(activeSym) * conv; };
  const cap = () => { const v = +lim().max_risk_per_trade_usd; return isFinite(v) && v > 0 ? v : null; };
  // Money already at risk if every open stop is hit, worked out the way the engine does (stops in profit count as nothing).
  const openRisk = (pick) => {
    let total = 0;
    for (const t of (typeof engineState !== 'undefined' && engineState && engineState.open_trades) || []) {
      if (!pick(t)) continue;
      if (t.sl == null) { if (v2() && cap() != null) total += cap(); continue; }   // the v2 guard counts it as a full limit
      const conv = clientUsdPerQuote(symMeta(t.symbol).quoteCurrency); if (conv == null) continue;
      const per = t.side === 'buy' ? +t.open_price - +t.sl : +t.sl - +t.open_price;
      total += Math.max(0, per) * contractSizeFor(t.symbol) * +t.volume * conv;
    }
    return total;
  };
  const multiple = () => { const m = +lim().total_open_risk_multiple; return isFinite(m) && m > 0 ? m : null; };
  const sameIdea = (side) => openRisk((t) => execSymbol(t.symbol) === execSymbol(activeSym) && t.side === side);
  // Dollars this order may risk: the chosen amount, cut to what is left of the per-trade limit on this trade idea
  // (same market and direction) and of the total open-risk limit. side=null leaves out the per-direction part.
  const room = (side = null) => {
    const c = cap(); if (c == null) return null;
    let r = riskChoice === 'max' ? c : Math.min(c, riskChoice);
    const m = multiple();
    if (m) { r = Math.min(r, c * m - openRisk(() => true)); if (side) r = Math.min(r, c - sameIdea(side)); }
    return Math.max(0, r);
  };
  const budget = (side = null) => { const r = room(side); return r == null ? null : r * BUFFER; };
  // Market orders can fill a little worse than the quote; sizing as if the stop were half a spread further keeps that
  // slippage inside the limit (it was the second most common rejection before this ticket).
  const slipPad = () => { const q = quote(); return q ? Math.max(0, q.ask - q.bid) / 2 : 0; };
  const usd = (v) => '$' + (+v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // The ticket suggests the largest size the risk limit allows, but the trader can always type a smaller one (never a larger one).
  const syncUser = () => { if (lastSet != null && Math.abs(ordLots - lastSet) > 1e-9) userLots = acct()?.rules_version==='infinity_v2'?Math.round(ordLots/minLot())*minLot():Math.round(ordLots * 100) / 100; };
  const useLots = (max) => (max == null || max < minLot() ? null : userLots != null ? Math.max(minLot(), Math.min(userLots, max)) : max);
  const lotsFor = (d, side = null) => { const p = perLot(d > 0 ? d + slipPad() : d), b = budget(side); return p && b ? +(acct()?.rules_version==='infinity_v2'?Math.floor((b/p)/minLot()+1e-9)*minLot():Math.floor((b / p) * 100 + 1e-9) / 100).toFixed(3) : null; };
  // When the limit for one trade idea or for all open trades is what stops this order, say so in plain words.
  const roomWhy = (side) => {
    const c = cap(), m = multiple(); if (c == null || !m) return null;
    const chosen = riskChoice === 'max' ? c : Math.min(c, riskChoice), total = openRisk(() => true), same = side ? sameIdea(side) : 0;
    if (side && c - same < chosen && c - same <= c * m - total) return `You already risk ${usd(same)} on ${short()} ${side === 'buy' ? 'buys' : 'sells'}, and one trade idea can risk ${usd(c)} at most. Tighten or close it first.`;
    if (c * m - total < chosen) return `Your open trades already risk ${usd(total)} of the ${usd(c * m)} total limit. Tighten or close one first.`;
    return null;
  };
  const stopFor = (side) => { const q = quote(); const entry = side === 'buy' ? (q ? q.ask : mid()) : (q ? q.bid : mid()); const s = side === 'buy' ? entry - dist() : entry + dist(); return +s.toFixed(digits()); };

  // ---- checks shown above Buy/Sell ----
  function checks(side = null) {
    const a = acct(), q = quote(), field = $('slPrice'), typed = Number(field?.value);
    const entry = side === 'buy' ? q?.ask : side === 'sell' ? q?.bid : null;
    const manual = manualStopPrice && side != null;
    const invalidInput = !!field?.validity?.badInput;
    const invalidDistance = invalidStopDistance && !manualStopPrice;
    const validSide = !manual || (Number.isFinite(typed) && typed > 0 && (side === 'buy' ? typed < entry : typed > entry));
    const noStop = !sending();
    const d = manual && validSide ? Math.abs(entry - typed) : noStop && invalidStopDistance ? defaultDist() : dist();
    const max = lotsFor(d, side), lots = useLots(max), p = perLot(d), c = cap(), full = max == null || max < minLot() ? roomWhy(side) : null;
    const out = [];
    if (noStop) {
      // No stop goes with the order. It still has to be possible to add one inside the risk limit within the deadline, or the
      // trade is a guaranteed warning; and Infinity v2 counts a trade without a stop as a full per-trade limit until it has one.
      const need = v2() && c != null && side ? Math.min(c - sameIdea(side), c * (multiple() || 1e9) - openRisk(() => true)) : null;
      out.push({ ok: need == null || need >= c - 0.01, text: 'Room for this trade', why: need != null && c - sameIdea(side) < c - 0.01
        ? `You already have an open ${short()} ${side === 'buy' ? 'buy' : 'sell'} on this trade idea. Add a stop to it (or close it) before opening another.`
        : `Your open trades already use your total risk limit. Add stops to them, tighten or close one first.` });
      out.push({ ok: !!q && max != null && max >= minLot(), text: 'Size', why: !q ? 'Waiting for a live price for this market' : p == null ? 'Waiting for a conversion price' : c == null ? 'Waiting for your account limits'
        : 'No stop would fit your risk limit at the minimum size on this market, so you could not add one in time. Try another market.' });
    } else
    out.push({ ok: !invalidInput && !invalidDistance && !!q && validSide && d > 0 && d >= minDist(), text: d > 0 ? `Stop ${(d / pipSize()).toFixed(1)} ${unit()} away` : 'Set a stop distance',
      why: invalidInput ? 'Finish entering a valid stop price before submitting.' : invalidDistance ? 'Enter a valid positive stop distance before submitting.' : !q ? 'Waiting for a live price for this market' : !validSide ? `For ${side}, set a stop on the loss side of the entry price` : defaultDist() < minDist() ? 'This market needs more than your current risk limit at the minimum 0.01 lot size. Try another market or wait for your limit to reset.' : 'Stop too close to price for the broker' });
    const risk = lots && p ? lots * p : null;
    if (!noStop) out.push({ ok: !full && max != null && max >= minLot(), text: risk != null && lots >= minLot() ? `Risk ${usd(risk)} of ${usd(c)} · ${lots.toFixed(lotDigits())} lots` : 'Risk', why: full ? full : p == null ? 'Waiting for a conversion price' : c == null ? 'Waiting for your account limits' : defaultDist() < minDist() ? 'This market needs more than your current risk limit at the minimum 0.01 lot size. Try another market or wait for your limit to reset.' : 'Stop too wide for your risk limit at the minimum size: move the stop closer' });
    const viewOnly = typeof viewOnlyReason === 'function' ? viewOnlyReason(activeSym) : null;
    if (viewOnly) out.unshift({ ok: false, text: 'View-only instrument', why: viewOnly });   // listed first so it is the reason shown
    const fresh = typeof feedFresh !== 'function' || feedFresh();
    out.push({ ok: fresh, text: 'Prices live', why: 'Prices reconnecting… orders resume automatically' });
    if(acct()?.rules_version==='infinity_v2' && window.ipfxInfinityV2){const left=window.ipfxInfinityV2.pause();out.push({ok:left===0,text:'Stop-out pause',why:left+' seconds remaining'});}
    const capMsg = typeof dailyCapMessage === 'function' ? dailyCapMessage() : null;
    out.push({ ok: !capMsg && a && a.status === 'active', text: 'Trading open', why: capMsg || 'Account is not active' });
    return out;
  }

  // ---- ticket UI (challenge accounts only) ----
  function css() {
    if ($('gtStyle')) return;
    const s = document.createElement('style'); s.id = 'gtStyle';
    s.textContent = `.gt-card{border:1px solid var(--line,#2a2a30);border-radius:12px;padding:12px;margin:10px 0;background:rgba(255,255,255,.02)}
.gt-sum{display:flex;align-items:center;gap:10px;width:100%;border:0;background:none;padding:0;color:inherit;text-align:left;cursor:pointer;font:inherit}
.gt-sum:focus-visible{outline:2px solid #3b82f6;outline-offset:4px;border-radius:8px}
.gt-sum-ic{flex:0 0 28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;background:rgba(16,185,129,.12);color:#10b981}
.gt-sum-ic svg{width:16px;height:16px}.gt-card.gt-warn .gt-sum-ic{background:rgba(245,158,11,.14);color:#f59e0b}
.gt-sum-txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.gt-sum-txt b{font-size:.84rem;color:#f4f4f5;font-weight:700;font-variant-numeric:tabular-nums}
.gt-sum-txt span{font-size:.72rem;color:#8b8f98;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gt-sum-edit{flex:0 0 auto;font-size:.76rem;font-weight:700;color:#60a5fa;padding:5px 9px;border:1px solid #2f2f36;border-radius:7px}
.gt-sum:hover .gt-sum-edit{border-color:#3b82f6;color:#93c5fd}
.gt-card:not(.gt-open) #gtMore{display:none}.gt-card.gt-open #gtMore{margin-top:10px;padding-top:4px;border-top:1px solid #23232a}
.gt-card{padding:10px 12px}.gt-checks:empty{display:none}
body.gt-on #opLimitCard{display:none!important}
/* the classic "Stop loss" tick box would read as "no stop" here: the stop is always added, and Edit > exact price opens the field */
body.gt-on .op-quickbar .op-quick:nth-child(2){display:none!important}
body.light .gt-sum-txt b{color:#111827}body.light .gt-sum-edit{border-color:#d1d5db;color:#1d4ed8}
.gt-top{display:flex;align-items:center;gap:8px}.gt-top .gt-sum{flex:1;min-width:0}
.gt-auto{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:1px solid #2f2f36;border-radius:7px;background:transparent;color:#cbd5e1;font:600 .74rem Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}
.gt-auto i{width:22px;height:12px;border-radius:999px;background:#3f3f46;position:relative;transition:background .15s}.gt-auto i::after{content:"";position:absolute;top:2px;left:2px;width:8px;height:8px;border-radius:50%;background:#e4e4e7;transition:left .15s}
.gt-auto[aria-checked="true"] i{background:#10b981}.gt-auto[aria-checked="true"] i::after{left:12px}
.gt-auto:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}.gt-auto[hidden]{display:none}
.gt-card.gt-nostop{border-color:rgba(239,68,68,.45)}.gt-card.gt-nostop .gt-sum-ic{background:rgba(239,68,68,.14);color:#ef4444}
.gt-rule{margin:8px 0 0;padding:6px 9px;border:1px solid rgba(239,68,68,.5);border-radius:8px;background:rgba(239,68,68,.08);color:#fecaca;font-size:.7rem;line-height:1.35}
.gt-rule b{display:block;color:#f87171;font-size:.72rem;letter-spacing:.02em;margin-bottom:1px}.gt-rule em{font-style:normal;font-weight:700;color:#fff}.gt-rule[hidden]{display:none}
body.light .gt-rule{color:#7f1d1d;background:#fef2f2}body.light .gt-rule b{color:#b91c1c}body.light .gt-rule em{color:#111827}body.light .gt-auto{border-color:#d1d5db;color:#374151}
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
.gt-viewonly{margin:8px 0;padding:9px 11px;border:1px solid rgba(245,158,11,.35);border-radius:9px;background:rgba(245,158,11,.08);color:#fbbf24;font-size:.78rem;line-height:1.45}.gt-viewonly[hidden]{display:none}
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
    el.innerHTML = `<div class="gt-top"><button type="button" class="gt-sum" id="gtSum" aria-expanded="false" aria-controls="gtMore" title="Your stop-loss is added to every order automatically">
        <span class="gt-sum-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></span>
        <span class="gt-sum-txt"><b id="gtSumMain">Stop-loss on every trade</b><span id="gtSumSub"></span></span><span class="gt-sum-edit" id="gtSumEdit">Edit</span></button>
      <button type="button" class="gt-auto" id="gtAuto" role="switch" aria-checked="false" hidden title="Add the suggested stop to every order">Auto stop <i aria-hidden="true"></i></button></div>
      <div class="gt-rule" id="gtRule" role="note" hidden></div>
      <div id="gtMore">
      <div class="gt-row" id="gtStopRow"><span>Stop loss</span><div class="gt-step"><button type="button" data-gt="stop-" aria-label="Move stop closer">−</button><input id="gtStop" inputmode="decimal" aria-label="Stop distance"><button type="button" data-gt="stop+" aria-label="Move stop further">+</button></div></div>
      <div class="gt-sub" id="gtStopSub"></div>
      <button type="button" class="gt-exact" id="gtExact">Set an exact stop price</button>
      <div class="gt-row" id="gtRiskRow"><span>Risk per trade</span><div class="gt-chips" id="gtChips"></div></div>
      <div class="gt-sub gt-lotnote" id="gtLotNote"></div>
      </div>
      <ul class="gt-checks" id="gtChecks" aria-live="polite"></ul>`;
    bar.after(el);
    // Sell / Order size / Buy sit above the stop-loss card, so the order buttons come first.
    const tradeRow = document.querySelector('#tab-order .op-trade-row'); if (tradeRow) { bar.after(tradeRow); const hint = $('iv2Ticket'); if (hint) tradeRow.after(hint); }
    $('gtAuto').addEventListener('click', () => { autoStop = !autoStop; try { localStorage.setItem(AUTO_KEY, autoStop ? '1' : '0'); } catch (_) {} refresh(); });
    $('gtSum').addEventListener('click', () => { expanded = !expanded; try { localStorage.setItem(OPEN_KEY, expanded ? '1' : '0'); } catch (_) {} refresh(); if (expanded) $('gtStop').focus(); });
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
    $('gtExact').onclick = () => { invalidStopDistance = false; if (!slOn) toggleSLTP('sl'); expanded = true; refresh(); $('slPrice').focus(); };
    const sl = $('slPrice'); if (sl) sl.addEventListener('input', () => { manualStopPrice = sl.value.trim() !== '' || !!sl.validity?.badInput; refresh(); });
  }
  // Stop preview on the chart (as TradeLocker draws an order preview): dashed lines at the exact buy and sell stop prices
  // the next order would carry, so the trader sees where the stop sits before clicking. Read-only; they follow the ticket.
  let previewSeries = null, previewLines = {};
  function stopPreview(levels) {
    const ch = typeof ipfxChart !== 'undefined' ? ipfxChart : null, series = ch && ch.series;
    // The IPFX chart draws them as real stop pills (lots | -$ | price on the axis, as TradeLocker does).
    if (ch && typeof ch.setPreview === 'function') {
      ch.setPreview(levels ? Object.entries(levels).map(([k, v]) => ({ key: k, label: k, price: v.price, lots: v.lots, usd: v.loss, digits: digits() })) : []);
      return;
    }
    if (previewSeries && previewSeries !== series) { previewLines = {}; previewSeries = null; }   // the chart rebuilt its series
    for (const k of Object.keys(previewLines)) if (!levels || !(k in levels)) { try { previewSeries.removePriceLine(previewLines[k].line); } catch (_) {} delete previewLines[k]; }
    if (!levels || !series || !series.createPriceLine) return;
    previewSeries = series;
    for (const [k, v] of Object.entries(levels)) {
      const price = v && v.price, title = (v && v.title) || k;
      if (!(price > 0)) continue;
      const cur = previewLines[k];
      if (cur && cur.price === price && cur.title === title) continue;
      const opts = { price, color: 'rgba(245,158,11,.85)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title };
      if (cur) { cur.line.applyOptions(opts); cur.price = price; cur.title = title; } else previewLines[k] = { line: series.createPriceLine(opts), price, title };
    }
  }
  let lastSym = typeof activeSym === 'undefined' ? null : activeSym;
  function refresh() {
    const card = $('gtCard'); if (!card) return;
    // Market orders use the protected ticket; pending orders keep the classic controls (stop still required).
    const active = on() && (typeof orderType === 'undefined' || orderType === 'market');
    document.body.classList.toggle('gt-on', active);
    card.hidden = !active;
    const btns = document.querySelectorAll('#tab-order .op-exec-btn');
    if (!active) {
      stopPreview(null);
      const viewOnly = typeof viewOnlyReason === 'function' ? viewOnlyReason(activeSym) : null;
      btns.forEach((b) => { b.classList.toggle('gt-off', !!viewOnly); b.setAttribute('aria-disabled', String(!!viewOnly)); if (viewOnly) b.title = viewOnly; else b.removeAttribute('title'); });
      viewOnlyNote(viewOnly);
      return;
    }
    viewOnlyNote(null);
    btns.forEach((b) => b.setAttribute('aria-disabled', 'false'));
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
    $('gtLotNote').innerHTML = lots == null ? (manualStopPrice ? 'Set the exact stop outside the market to size this order.' : '') : `Size ${lots.toFixed(lotDigits())} lots · up to ${max.toFixed(lotDigits())} at this stop and risk${manualSide ? ` for ${manualSide.toUpperCase()}` : ''}${userLots != null ? '<button type="button" data-gt="autolots">Use max</button>' : ''}`;
    const cs = checks(), buyBad = checks('buy').find((x) => !x.ok), sellBad = checks('sell').find((x) => !x.ok);
    const bad = buyBad || sellBad;
    // One line says what will be sent with the order; Edit (or a stop that needs fixing) opens the full controls.
    const stopProblem = invalidStopDistance || (manualStopPrice && bad && /stop/i.test(bad.why || ''));
    const open = expanded || stopProblem;
    card.classList.toggle('gt-open', open); card.classList.toggle('gt-warn', !!bad);
    $('gtSum').setAttribute('aria-expanded', String(open)); $('gtSumEdit').textContent = open ? 'Done' : 'Edit';
    const noStop = !sending(), dl = deadline(), st = strikes();
    $('gtAuto').hidden = !optional(); $('gtAuto').setAttribute('aria-checked', String(optional() && autoStop));
    card.classList.toggle('gt-nostop', noStop);
    const rule = $('gtRule');
    if (optional()) {
      // The rule in plain, strict words, always visible while orders go without a stop (and as a reminder when Auto stop is on).
      // Since 13 Nov 2026 a missing stop is added automatically at the maximum risk (no warnings, no strikes).
      const html = `<b>Stop loss within ${dl} seconds</b>${noStop ? 'Sent <em>without a stop loss</em>. ' : ''}Add your own in time, or IPFX <em>adds one automatically</em> at your <em>maximum risk per trade</em>. A tighter stop of your own risks less and scores better.`;
      if (rule.innerHTML !== html) rule.innerHTML = html;
      rule.hidden = !noStop;
    } else rule.hidden = true;
    const shownLots = useLots(max), shownRisk = shownLots != null && sizingDist != null && perLot(sizingDist) ? shownLots * perLot(sizingDist) : null;
    const riskTxt = shownRisk != null ? `${usd(shownRisk)} risk · ${shownLots.toFixed(lotDigits())} lots` : 'risk —';
    if (noStop) {
      $('gtSumMain').textContent = `No stop loss · ${shownLots != null ? shownLots.toFixed(lotDigits()) + ' lots' : 'size —'}`;
      $('gtSumSub').textContent = `Add a stop within ${dl}s of the fill · suggested ${(d / pipSize()).toFixed(1)} ${unit()} · max ${usd(c)} a trade`;
      $('gtSum').title = 'Orders are sent without a stop loss. Add one within ' + dl + ' seconds of the fill, or switch on Auto stop. Click to change the size.';
      stopPreview(null);
    } else {
    $('gtSumMain').textContent = manualStopPrice ? `Stop at ${$('slPrice').value || '—'} · ${riskTxt}` : invalidStopDistance ? 'Stop distance needed' : `${(d / pipSize()).toFixed(1)} ${unit().replace(/s$/, '')} stop · ${riskTxt}`;
    const subTxt = manualStopPrice ? 'Exact stop price, checked for Buy and Sell separately' : invalidStopDistance ? 'Enter a stop distance to trade' : `Max ${usd(c)} a trade · buy stop ${stopFor('buy').toFixed(digits())} · sell stop ${stopFor('sell').toFixed(digits())}`;
    $('gtSumSub').textContent = subTxt;
    // Each line carries the dollars lost if it is hit, as TradingView labels its stop line (e.g. "Buy stop −$4.46").
    const typedStop = Number($('slPrice')?.value);
    const sizeAt = (side, stop) => { const e = side === 'buy' ? q?.ask : q?.bid; if (!(e > 0) || !(stop > 0)) return null; const dd = Math.abs(e - stop), l = useLots(lotsFor(dd, side)), p = perLot(dd); return l != null && p ? { lots: l, loss: l * p } : null; };
    const line = (label, side, stop) => { const z = sizeAt(side, stop); return { price: stop, lots: z && z.lots, loss: z && z.loss, title: z ? `${label} −${usd(z.loss)}` : label }; };
    stopPreview(invalidStopDistance ? null : manualStopPrice ? (typedStop > 0 ? { 'Stop': line('Stop', manualSide || (q && typedStop < q.bid ? 'buy' : 'sell'), typedStop) } : null)
      : { 'Buy stop': line('Buy stop', 'buy', stopFor('buy')), 'Sell stop': line('Sell stop', 'sell', stopFor('sell')) }); $('gtSum').title = 'A stop-loss is added to every order automatically. ' + subTxt + '. Click to change.';
    }
    // Buy/Sell sits right under this card: when every check passes, one reassuring line beats four, so the trader
    // doesn't have to scroll past a wall of ticks to reach the buttons. The full list comes back the moment something
    // needs attention, so nothing diagnostic is ever hidden while a trade is actually blocked.
    // Only what is blocking is listed (the summary line already says what will be sent), and only when it changes, so
    // screen readers hear each new problem once instead of every half second.
    const why = (side, problem) => `<li class="no"><i>!</i><span>${side ? side.toUpperCase() + ': ' : ''}${problem.why}</span></li>`;
    const html = !bad ? '' : buyBad && sellBad && buyBad.why === sellBad.why ? why(null, buyBad) : (buyBad ? why('buy', buyBad) : '') + (sellBad ? why('sell', sellBad) : '');
    if (html !== lastChecksHtml) { $('gtChecks').innerHTML = html; lastChecksHtml = html; }
    btns.forEach((b) => { const problem = b.classList.contains('op-exec-buy') ? buyBad : sellBad; b.classList.toggle('gt-off', !!problem); b.setAttribute('aria-disabled', String(!!problem)); if (problem) b.title = problem.why; else b.removeAttribute('title'); });
  }
  // A plain line above Buy/Sell on the classic ticket when the market can be watched but not traded (Bitcoin), so the
  // trader learns it before clicking rather than from an error afterwards.
  function viewOnlyNote(text) {
    let n = $('gtNoTrade');
    if (!text) { if (n) n.hidden = true; return; }
    if (!n) { const row = document.querySelector('#tab-order .op-trade-row'); if (!row) return; n = document.createElement('div'); n.id = 'gtNoTrade'; n.className = 'gt-viewonly'; n.setAttribute('role', 'status'); row.before(n); }
    if (n.textContent !== text) n.textContent = text;
    n.hidden = false;
  }

  // ---- order hook: every challenge market order carries the stop and the risk-sized lots ----
  const original = window.placeOrder;
  window.placeOrder = async function (side) {
    if (on() && (typeof orderType === 'undefined' || orderType === 'market')) {
      const bad = checks(side).find((x) => !x.ok);
      if (bad) { engineMsg(bad.why); return; }
      const slField = $('slPrice');
      if (!sending()) {
        // Infinity, Auto stop off: the order goes without a stop. Lots stay sized so the suggested stop still fits the limit.
        syncUser();
        const lots = useLots(lotsFor(dist(), side));
        if (!(lots >= minLot())) { engineMsg('No stop would fit your risk limit at the minimum size on this market, so you could not add one in time.'); return; }
        if (slField) slField.value = '';
        setLots(lots, null); lastSet = ordLots;
        return original.call(this, side);
      }
      const typed = Number(slField && slField.value);
      const stop = manualStopPrice ? typed : stopFor(side);
      syncUser();
      const max = lotsFor(Math.abs((side === 'buy' ? quote()?.ask ?? mid() : quote()?.bid ?? mid()) - stop), side), lots = useLots(max);
      if (!(lots >= minLot())) { engineMsg('Stop too wide for your risk limit at the minimum size: move the stop closer.'); return; }
      if (!slOn) toggleSLTP('sl');
      slField.value = String(stop);
      setLots(lots, null); lastSet = ordLots;
    } else if (on() && !slOn && !optional()) {
      engineMsg('Add a stop loss to this pending order: your challenge requires one on every order.'); return;
    }
    return original.call(this, side);
  };

  // The stop the "Add stop" button on the 30-second card sends for an open trade: the ticket's suggested distance, cut to
  // what the risk limit allows at the trade's size (measured from entry, as the engine does), and at least the minimum
  // distance from the current price. Returns { sl, risk } or { why } when no stop can fit.
  window.ipfxSuggestStop = function (t) {
    const sym = t && t.symbol; if (!sym) return { why: 'Position not found' };
    const q = liveQuotesBySymbol.get(execSymbol(sym)); if (!q) return { why: 'Waiting for a live price' };
    const conv = clientUsdPerQuote(symMeta(sym).quoteCurrency); if (conv == null) return { why: 'Waiting for a conversion price' };
    const k = contractSizeFor(sym) * +t.volume * conv, entry = +t.open_price, buy = t.side === 'buy', mark = buy ? q.bid : q.ask;
    const c = cap(), m = multiple();
    const others = (pick) => openRisk((x) => x.id !== t.id && pick(x));
    let roomUsd = c == null ? Infinity : c - others((x) => execSymbol(x.symbol) === execSymbol(sym) && x.side === t.side);
    if (c != null && m && v2()) roomUsd = Math.min(roomUsd, c * m - others(() => true));
    const maxD = roomUsd * BUFFER / k;
    const spread = Math.max(0, q.ask - q.bid), pxMid = (q.bid + q.ask) / 2;
    const minD = v2() ? spread * Number(acct()?.infinity_v2?.rules?.stop_spread_multiple || 8) * 1.05 : pxMid * 0.0002;
    const cat = Object.keys(WL_DATA).find((key) => WL_DATA[key].some((i) => execSymbol(i.sym) === execSymbol(sym))) || 'forex';
    const suggested = pxMid * (cat === 'crypto' ? 0.008 : cat === 'metals' || cat === 'indices' ? 0.0025 : 0.002);
    const dg = Number.isInteger(q.digits) ? q.digits : (/JPY/.test(execSymbol(sym)) ? 3 : cat === 'forex' ? 5 : 2), f = 10 ** dg;
    let sl = buy ? entry - Math.min(suggested, maxD) : entry + Math.min(suggested, maxD);
    if (buy ? sl > mark - minD : sl < mark + minD) sl = buy ? mark - minD : mark + minD;   // far enough from the current price
    sl = buy ? Math.floor(sl * f + 1e-9) / f : Math.ceil(sl * f - 1e-9) / f;
    const risk = Math.abs(entry - sl) * k;
    if (!(maxD > 0) || risk > roomUsd + 0.005) return { why: `No stop fits your ${c == null ? '' : usd(Math.max(0, roomUsd)) + ' '}risk room at ${(+t.volume).toFixed(lotDigits())} lots now that price has moved. Close the trade to avoid a warning.` };
    return { sl, risk };
  };

  // ---- first-visit tour ----
  const STEPS = [
    { sel: '#op-sym', title: 'Pick a market', text: 'Choose what to trade here, or press / to search. The chart follows your choice.' },
    { sel: '#gtSum', alt: '.op-quickbar', title: 'Stop loss: within 30 seconds', text: 'Every trade has a stop loss. Add your own within 30 seconds of opening, or switch on Auto stop. If a trade still has none, IPFX adds one automatically at your maximum risk per trade. A tighter stop of your own risks less and scores better.' },
    { sel: '.op-trade-row', title: 'Buy or Sell', text: 'Click Buy if you think price goes up, Sell if it goes down. If a button is greyed out, the reason is written just above it.' },
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
