// IPFX Markets challenge-ready ticket: every challenge market order carries a stop on the correct side and is sized from
// the risk budget (5% under the cap); orders are held back with a reason when a check fails; practice accounts keep the
// classic ticket; the first-visit tour is wired into trading.html.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const src = fs.readFileSync(new URL('../assets/js/markets-guided.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../trading.html', import.meta.url), 'utf8');

function page({ demo = false, status = 'active', cap = 5, fresh = true, capMsg = null, type = 'market', slOn = false, slValue = '', symbol = 'EURUSD', bid = 1.1226, ask = 1.1227, digits = 5, contract = 100000, mount = false, open = [], multiple = null, infinity = false, auto = '0', strikes = 0, rv = null } = {}) {
  const sent = [], msgs = [], ticks = [];
  const events = {}, distanceEvents = {};
  const els = { slPrice: { value: slValue, addEventListener(type, fn) { events[type] = fn; }, focus() {} }, gtCard: mount ? null : { hidden: true, classList: { toggle() {} } }, gtSum: { setAttribute() {}, addEventListener() {} }, gtSumMain: { textContent: '' }, gtSumSub: { textContent: '' }, gtSumEdit: { textContent: '' }, gtStop: { value: '', addEventListener(type,fn) { distanceEvents[type]=fn; } }, gtStopSub: { textContent: '' }, gtChips: { innerHTML: '' }, gtChecks: { innerHTML: '' }, gtLotNote: { innerHTML: '' }, gtExact: { onclick: null }, gtAuto: { hidden: true, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {} }, gtRule: { hidden: true, innerHTML: '' }, 'ord-lots': {} };
  const node = () => ({ id: '', className: '', style: {}, listeners: {}, appendChild() {}, before() {}, after() {}, addEventListener(type,fn) { this.listeners[type]=fn; }, setAttribute() {}, classList: { toggle() {}, remove() {} } });
  const bar = node(); bar.after = (el) => { els.gtCard = el; };
  const ctx = {
    document: { readyState: 'complete', head: node(), body: node(), getElementById: (id) => els[id] || null, querySelector: (sel) => mount && sel === '#tab-order .op-quickbar' ? bar : null, querySelectorAll: () => [], createElement: node, addEventListener() {} },
    localStorage: { getItem: (k) => k === 'ipfx-ticket-autostop' ? auto : '1', setItem() {} }, setInterval: (fn) => { ticks.push(fn); return 0; }, clearInterval() {}, setTimeout: () => 0,
    engineState: { account: { status, is_demo: demo, challenge_type: infinity ? 'infinity' : 'traditional', rules_version: rv, sl_strikes: strikes, sl_strikes_max: 3, limits: { require_stop_loss: true, max_risk_per_trade_usd: cap, total_open_risk_multiple: multiple, stop_loss_deadline_seconds: infinity ? 30 : null } }, open_trades: open },
    activeSym: symbol, liveQuotesBySymbol: new Map([[symbol, { bid, ask, digits }]]),
    WL_DATA: { forex: [{ sym: 'EURUSD' }], metals: [{ sym: 'XAUUSD' }] }, execSymbol: (s) => s, futSym: () => null, symMeta: () => ({ quoteCurrency: 'USD' }),
    contractSizeFor: () => contract, clientUsdPerQuote: () => 1, feedFresh: () => fresh, dailyCapMessage: () => capMsg,
    orderType: type, slOn, ordLots: 0.01, engineMsg: (m) => msgs.push(m), setLots(v) { ctx.ordLots = v; },
    toggleSLTP() { ctx.slOn = !ctx.slOn; },
  };
  ctx.window = ctx;
  ctx.placeOrder = async (side) => { sent.push({ side, sl: ctx.slOn ? +els.slPrice.value : null, lots: ctx.ordLots }); };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return { ctx, sent, msgs, els, events, distanceEvents, tick: () => ticks[0]() };   // tick = the ticket's 500ms refresh
}

test('a trader can type a smaller lot size than the risk limit suggests, and it is kept (a 0.01 on gold was being overridden)', async () => {
  const { ctx, sent, els, tick } = page();
  tick();                                              // ticket suggests the maximum: 0.02 lots
  assert.equal(ctx.ordLots, 0.02); assert.match(els.gtLotNote.innerHTML, /Size 0\.02 lots · up to 0\.02/); assert.ok(!/autolots/.test(els.gtLotNote.innerHTML));
  ctx.ordLots = 0.01;                                  // the trader types 0.01 in the lot box
  tick(); tick();                                      // later refreshes must not put 0.02 back
  assert.equal(ctx.ordLots, 0.01); assert.match(els.gtLotNote.innerHTML, /Size 0\.01 lots · up to 0\.02/); assert.match(els.gtLotNote.innerHTML, /Use max/);
  assert.match(els.gtSumMain.textContent, /^22\.5 pip stop · \$2\.25 risk · 0\.01 lots$/, 'the one-line summary follows the chosen size');
  await ctx.window.placeOrder('buy');
  assert.equal(sent[0].lots, 0.01); assert.equal(sent[0].sl, 1.12045, 'the stop is still added');
});

test('a size is applied even if the trader clicks Buy before the next refresh, and a size above the limit is cut back', async () => {
  const { ctx, sent, tick } = page();
  tick(); ctx.ordLots = 0.01; await ctx.window.placeOrder('sell');      // no refresh in between
  assert.equal(sent[0].lots, 0.01);
  ctx.ordLots = 0.5; tick(); assert.equal(ctx.ordLots, 0.02, 'never above what the risk limit allows');
  await ctx.window.placeOrder('buy'); assert.equal(sent[1].lots, 0.02);
});

test('with no choice made the ticket still suggests the maximum size', async () => {
  const { ctx, sent, tick } = page(); tick(); tick();
  assert.equal(ctx.ordLots, 0.02); await ctx.window.placeOrder('buy'); assert.equal(sent[0].lots, 0.02);
});

test('the lot box stays editable on challenge accounts', () => {
  assert.ok(!/ord-lots\{pointer-events:none\}/.test(src), 'lot box is no longer locked');
  assert.ok(!/\.op-lot-minus[^}]*display:none/.test(src) && !/\.op-lot-plus[^}]*display:none/.test(src), '+ and − are visible again');
});

test('challenge market orders always carry a stop on the correct side and risk-sized lots under the cap', async () => {
  const { ctx, sent } = page();
  await ctx.window.placeOrder('buy'); await ctx.window.placeOrder('sell');
  // Default stop 0.2% of price ≈ 22.5 pips; $5 cap × 0.95 = $4.75 → 0.02 lots ($4.50 at risk).
  assert.equal(sent[0].side, 'buy'); assert.ok(sent[0].sl < 1.1227); assert.equal(sent[0].sl, 1.12045); assert.equal(sent[0].lots, 0.02);
  assert.equal(sent[1].side, 'sell'); assert.ok(sent[1].sl > 1.1226); assert.equal(sent[1].sl, 1.12485); assert.equal(sent[1].lots, 0.02);
  for (const o of sent) assert.ok(Math.abs((o.side === 'buy' ? 1.1227 : 1.1226) - o.sl) * 100000 * o.lots <= 5 * 0.95 + 1e-9);
});

test('gold with a $5 Stage 1 cap has a usable default stop at the 0.01 lot minimum', async () => {
  const { ctx, sent, els, tick } = page({ symbol: 'XAUUSD', bid: 4299.7, ask: 4300, digits: 2, contract: 100 });
  tick();
  assert.equal(els.gtChecks.innerHTML, '', 'nothing is blocking, so no warning lines');
  assert.match(els.gtSumMain.textContent, /^[\d.]+ point stop · \$[\d.]+ risk · 0\.01 lots$/); assert.match(els.gtSumSub.textContent, /^Max \$5\.00 a trade · buy stop /);
  await ctx.window.placeOrder('buy');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].lots, 0.01);
  assert.ok(sent[0].sl < 4300);
  assert.ok((4300 - sent[0].sl) * 100 * sent[0].lots <= 4.75 + 0.001);
});

test('a manually entered stop is validated for each side and never silently replaced', async () => {
  const { ctx, sent, msgs, els, events, tick } = page({ mount: true });
  tick();
  els.gtExact.onclick();
  assert.equal(ctx.slOn, true, 'exact stop control reveals the native stop field');
  els.slPrice.value = '1.12100';
  events.input();
  assert.doesNotMatch(els.gtChecks.innerHTML, /BUY:/, 'only the side that is blocked is listed');
  assert.match(els.gtChecks.innerHTML, /SELL: For sell, set a stop on the loss side/);
  await ctx.window.placeOrder('sell');
  assert.equal(sent.length, 0);
  assert.match(msgs.at(-1), /loss side/);
  await ctx.window.placeOrder('buy');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sl, 1.121);
  assert.ok(sent[0].lots * (1.1227 - 1.121) * 100000 <= 4.75 + 0.001);
});

test('an active challenge waits for a quote for the selected market', async () => {
  const { ctx, sent, msgs } = page();
  ctx.liveQuotesBySymbol.clear();
  await ctx.window.placeOrder('buy');
  assert.equal(sent.length, 0);
  assert.match(msgs.at(-1), /live price for this market/);
});

test('an incomplete exact stop cannot fall back to an automatic stop and place a trade',async()=>{
 const f=page({mount:true});f.tick();f.els.gtExact.onclick();f.els.slPrice.value='';f.els.slPrice.validity={badInput:true};f.events.input();
 await f.ctx.placeOrder('buy');assert.equal(f.sent.length,0);assert.match(f.msgs.at(-1),/valid|finish|stop/i);
 f.els.slPrice.validity.badInput=false;f.els.slPrice.value='1.121';f.events.input();await f.ctx.placeOrder('buy');
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].sl,1.121);
});

test('invalid stop-distance text cannot silently fall back to a different executable stop',async()=>{
 for(const value of ['20e','20suffix','','-5','0','Infinity','NaN']){
  const f=page({mount:true});f.tick();f.els.gtStop.value=value;f.distanceEvents.change({target:f.els.gtStop});f.tick();
  await f.ctx.placeOrder('buy');assert.equal(f.sent.length,0,value);assert.match(f.msgs.at(-1),/valid|positive|finish/i);assert.equal(f.els.gtStop.value,value,'keep the rejected text for correction');
  f.els.gtStop.value='25';f.distanceEvents.change({target:f.els.gtStop});await f.ctx.placeOrder('buy');assert.equal(f.sent.length,1);assert.equal(f.sent[0].sl,1.1202);
 }
});
test('an explicit distance step or exact-price choice recovers from rejected distance text',async()=>{
 for(const exact of [false,true]){
  const f=page({mount:true});f.tick();f.els.gtStop.value='20e';f.distanceEvents.change({target:f.els.gtStop});await f.ctx.placeOrder('buy');assert.equal(f.sent.length,0);
  if(exact){f.els.gtExact.onclick();f.els.slPrice.value='1.121';f.events.input();}
  else f.els.gtCard.listeners.click({target:{closest:()=>({dataset:{gt:'stop+'}})}});
  await f.ctx.placeOrder('buy');assert.equal(f.sent.length,1);if(exact)assert.equal(f.sent[0].sl,1.121);
 }
});

test('orders are held back with the reason when a check fails', async () => {
  for (const [opts, why] of [[{ fresh: false }, /Prices reconnecting/], [{ capMsg: 'Daily profit cap reached' }, /Daily profit cap/], [{ cap: 0.2 }, /needs more than your current risk limit/]]) {
    const { ctx, sent, msgs } = page(opts);
    await ctx.window.placeOrder('buy');
    assert.equal(sent.length, 0, JSON.stringify(opts)); assert.match(msgs.at(-1), why);
  }
});

test('pending challenge orders need a stop; practice accounts keep the classic ticket untouched', async () => {
  const p = page({ type: 'limit' }); await p.ctx.window.placeOrder('buy');
  assert.equal(p.sent.length, 0); assert.match(p.msgs.at(-1), /Add a stop loss/);
  const ok = page({ type: 'limit', slOn: true, slValue: '1.1200' }); await ok.ctx.window.placeOrder('buy');
  assert.equal(ok.sent.length, 1); assert.equal(ok.sent[0].sl, 1.12);
  const demo = page({ demo: true }); await demo.ctx.window.placeOrder('buy');
  assert.deepEqual(demo.sent, [{ side: 'buy', sl: null, lots: 0.01 }]);
});

test('trading.html loads the guided ticket after the order code, and the tour is replayable and skippable', () => {
  const at = html.indexOf('/assets/js/markets-guided.js'); assert.ok(at > 0);
  assert.ok(at > html.indexOf('function placeOrder'), 'must load after placeOrder is defined');
  assert.match(src, /window\.ipfxTour = /); assert.match(src, /gt-skip/); assert.match(src, /ipfx-markets-tour-v1/);
  assert.match(src, /ipfx-cookie-panel/, 'tour waits for the privacy choice');
});

test('the tour counts as seen the moment it opens and closes instantly with ×, Esc, Skip or a click outside', () => {
  const tour = src.slice(src.indexOf('function tour('), src.indexOf('window.ipfxTour'));
  assert.ok(tour.indexOf('seenTour()') < tour.indexOf('document.body.append'), 'saved before it is shown');
  for (const close of ["'.gt-x').onclick = endTour", "'.gt-skip').onclick = endTour", 'scrim.onclick = endTour']) assert.ok(tour.includes(close), close);
  assert.match(src, /e\.key === 'Escape'[^\n]*endTour\(\)/);
  assert.match(src, /b\.textContent = 'Tour'/);
});

test('the Simple/Pro view switch was reverted: nothing is hidden by a gt-simple class', () => {
  assert.ok(!/gt-simple|SIMPLE_HIDE|gtView/.test(src), 'the full layout (all timeframes, side tabs, bottom tabs) stays as-is, undoing the earlier Simple default');
});

test('Buy/Sell moves higher: nothing is listed when ready, and the Stage pass checklist lives in the Challenge tab, not the order ticket', () => {
  assert.match(src, /const html = !bad \? '' :/, 'nothing is listed when every check passes; only blocking reasons when one fails');
  assert.match(src, /id="gtSum"/, 'a one-line summary replaces the large Protected order panel');
  const orderTab = html.slice(html.indexOf('id="tab-order"'), html.indexOf('<!-- INDICATORS TAB') > 0 ? html.indexOf('<!-- INDICATORS TAB') : html.indexOf('id="tab-indicators"'));
  assert.ok(!orderTab.includes('id="stageChecklist"'), 'the checklist is no longer in the order ticket');
  const ch = html.indexOf('id="ch-note"'), list = html.indexOf('id="stageChecklist"');
  assert.ok(ch > 0 && list > ch && list - ch < 400, 'it sits with the Challenge requirements');
  assert.ok(html.indexOf('id="dailyCapNotice"') < html.indexOf('class="op-trade-row"'), 'the cannot-trade-now notice still sits right above the buttons');
});

// November 2026 redesign: the ticket sizes inside the room left by open positions (same trade idea, and all open trades), the
// two limits behind most rejections after Infinity v2 launched, and leaves half a spread for slippage.
test('an open buy on the same market leaves less room: the next buy is sized into what is left, a sell is not affected', async () => {
  // $2.00 already at risk on EURUSD buys (10 pips x 0.02 lots), $5 per-idea limit, $15 total.
  const { ctx, sent, els, tick } = page({ multiple: 3, open: [{ symbol: 'EURUSD', side: 'buy', open_price: 1.1227, sl: 1.1217, volume: 0.02 }] });
  tick();
  await ctx.window.placeOrder('buy');
  await ctx.window.placeOrder('sell');
  const buy = sent.find((o) => o.side === 'buy'), sell = sent.find((o) => o.side === 'sell');
  assert.ok(buy, 'a smaller buy still fits'); assert.ok(sell);
  assert.ok((1.1227 - buy.sl) * 100000 * buy.lots + 2 <= 5 + 1e-9, 'existing $2 plus the new buy stays inside the $5 per-idea limit');
  assert.ok(buy.lots < sell.lots, 'only the buy side is cut');
});
test('when the same idea is already at its limit, Buy is held back with a plain reason and Sell still works', async () => {
  const { ctx, sent, msgs, els, tick } = page({ multiple: 3, open: [{ symbol: 'EURUSD', side: 'buy', open_price: 1.1227, sl: 1.1222, volume: 0.1 }] });   // $5.00 at risk
  tick();
  assert.match(els.gtChecks.innerHTML, /BUY: You already risk \$5\.00 on EURUSD buys, and one trade idea can risk \$5\.00 at most/);
  await ctx.window.placeOrder('buy'); assert.equal(sent.length, 0); assert.match(msgs.at(-1), /already risk \$5\.00 on EURUSD buys/);
  await ctx.window.placeOrder('sell'); assert.equal(sent.length, 1);
});
test('the total open-risk limit holds back both sides with its own reason', async () => {
  const open = [['GBPUSD', 1.30, 1.295], ['AUDUSD', 0.66, 0.655], ['NZDUSD', 0.6, 0.595]].map(([symbol, o, sl]) => ({ symbol, side: 'buy', open_price: o, sl, volume: 0.01 }));   // 3 x $5 = $15
  const { ctx, sent, els, tick } = page({ multiple: 3, open });
  tick();
  assert.match(els.gtChecks.innerHTML, /Your open trades already risk \$15\.00 of the \$15\.00 total limit/);
  await ctx.window.placeOrder('sell'); assert.equal(sent.length, 0);
});
test('sizing leaves half a spread for slippage: a wide spread gives a smaller size than a tight one', () => {
  const tight = page({ multiple: 3 }), wide = page({ multiple: 3, bid: 1.1220, ask: 1.1227 });
  tight.tick(); wide.tick();
  assert.ok(wide.ctx.ordLots <= tight.ctx.ordLots);
  assert.match(src, /const slipPad = \(\) =>/); assert.match(src, /perLot\(d > 0 \? d \+ slipPad\(\) : d\)/);
});
test('the stop panel is one line by default; Edit opens the full controls and the choice is remembered', () => {
  assert.match(src, /'ipfx-ticket-stop-open'/);
  assert.match(src, /\.gt-card:not\(\.gt-open\) #gtMore\{display:none\}/);
  assert.match(src, /aria-expanded/); assert.match(src, /\$\('gtSumEdit'\)\.textContent = open \? 'Done' : 'Edit'/);
  assert.match(src, /const open = expanded \|\| stopProblem/, 'a stop that needs fixing opens the controls by itself');
});
test('practice and pending tickets: a view-only market greys out Buy and Sell and says why before the click', () => {
  const { ctx, tick } = page({ demo: true, symbol: 'BTCUSD', bid: 75000, ask: 75020 });
  const btn = (cls) => ({ cls: new Set(['op-exec-btn', cls]), attrs: {}, classList: { toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });
  const buy = btn('op-exec-buy'), sell = btn('op-exec-sell'); buy.classList._s = buy.cls; sell.classList._s = sell.cls;
  let note = null;
  ctx.viewOnlyReason = () => 'Bitcoin is view-only on IPFX Markets.';
  ctx.document.querySelectorAll = (sel) => (sel === '#tab-order .op-exec-btn' ? [buy, sell] : []);
  ctx.document.querySelector = (sel) => (sel === '#tab-order .op-trade-row' ? { before(n) { note = n; } } : null);
  ctx.document.createElement = () => ({ setAttribute() {}, hidden: true, textContent: '' });
  ctx.document.getElementById = ((orig) => (id) => (id === 'gtNoTrade' ? note : orig(id)))(ctx.document.getElementById);
  tick();
  assert.ok(buy.cls.has('gt-off') && sell.cls.has('gt-off')); assert.equal(buy.attrs['aria-disabled'], 'true');
  assert.equal(note.textContent, 'Bitcoin is view-only on IPFX Markets.'); assert.equal(note.hidden, false);
});
test('trading.html: changing instrument clears stop, take-profit and trigger prices; hidden header buttons and the empty limit card stay hidden', () => {
  assert.match(html, /function clearTicketLevels\(\)\{\s*\['slPrice','tpPrice','triggerPrice'\]/);
  assert.match(html, /if\(sym!==activeSym\)\{clearOrdPrices\(\);clearTicketLevels\(\);\}/);
  assert.match(html, /\.op-limit-card\[hidden\]\{display:none!important\}/);
  assert.match(fs.readFileSync(new URL('../assets/js/infinity-restart.js', import.meta.url), 'utf8'), /\.tb-restart\[hidden\]\{display:none!important\}/);
  assert.match(html, /markets-guided\.js\?v=20261108a/);
});
test('the chart shows dashed buy-stop and sell-stop preview lines at the prices the next order would carry', () => {
  const { ctx, tick } = page({ multiple: 3 });
  const lines = [];
  ctx.ipfxChart = { series: { createPriceLine(o) { const l = { o, applyOptions(n) { this.o = n; } }; lines.push(l); return l; }, removePriceLine(l) { lines.splice(lines.indexOf(l), 1); } } };
  tick();
  assert.deepEqual(lines.map((l) => l.o.title).sort(), ['Buy stop −$4.50', 'Sell stop −$4.50'], 'each line says the dollars lost if it is hit');
  assert.equal(lines.find((l) => /^Buy stop/.test(l.o.title)).o.price, 1.12045); assert.equal(lines.find((l) => /^Sell stop/.test(l.o.title)).o.price, 1.12485);
  tick(); assert.equal(lines.length, 2, 'refreshing does not stack duplicate lines');
  ctx.engineState.account.is_demo = true; tick(); assert.equal(lines.length, 0, 'gone when the protected ticket is not in use');
});

// 8 Nov 2026 (owner): Infinity trades no longer need a stop before they are placed; the 30-second rule is stated strictly instead.
test('Infinity: Buy goes through without a stop, sized so the suggested stop still fits, and the rule is shown in red', async () => {
  const { ctx, sent, msgs, els, tick } = page({ infinity: true, strikes: 1 });
  tick();
  assert.equal(els.gtAuto.hidden, false, 'Auto stop switch is offered on Infinity');
  assert.equal(els.gtAuto.attrs['aria-checked'], 'false', 'and is off by default');
  assert.match(els.gtSumMain.textContent, /^No stop loss · 0\.02 lots$/);
  assert.match(els.gtSumSub.textContent, /^Add a stop within 30s of the fill/);
  assert.equal(els.gtRule.hidden, false);
  assert.match(els.gtRule.innerHTML, /Challenge rule: stop loss within 30 seconds/);
  assert.match(els.gtRule.innerHTML, /without a stop loss/); assert.match(els.gtRule.innerHTML, /closed automatically/); assert.match(els.gtRule.innerHTML, /removed/);
  assert.match(els.gtRule.innerHTML, /Warnings: <em>1 of 3<\/em>/);
  els.slPrice.value = '1.1';                      // a stop left in the field from an earlier order must not be sent
  ctx.slOn = true;
  await ctx.window.placeOrder('buy');
  assert.equal(msgs.length, 0, 'no "stop required" message');
  assert.equal(sent.length, 1); assert.equal(els.slPrice.value, ''); assert.ok(!(sent[0].sl > 0), 'sent without a stop'); assert.equal(sent[0].lots, 0.02);
});

test('Infinity: one warning left says the next one ends the run', () => {
  const { els, tick } = page({ infinity: true, strikes: 2 }); tick();
  assert.match(els.gtRule.innerHTML, /2 of 3<\/em> — <em>one more ends this run<\/em>/);
});

test('Infinity with Auto stop on keeps adding the stop; traditional challenges always do', async () => {
  const a = page({ infinity: true, auto: '1' }); a.tick();
  assert.equal(a.els.gtAuto.attrs['aria-checked'], 'true');
  await a.ctx.window.placeOrder('buy'); assert.equal(a.sent[0].sl, 1.12045);
  const t = page(); t.tick(); assert.equal(t.els.gtAuto.hidden, true, 'no switch on a traditional challenge');
  await t.ctx.window.placeOrder('buy'); assert.equal(t.sent[0].sl, 1.12045);
});

test('Infinity v2: a trade without a stop counts as a full limit, so a second one on the same idea is held back with the reason', async () => {
  const open = [{ id: 'x', symbol: 'EURUSD', side: 'buy', open_price: 1.1226, sl: null, volume: 0.02 }];
  const { ctx, sent, msgs, tick } = page({ infinity: true, rv: 'infinity_v2', multiple: 3, open });
  tick();
  await ctx.window.placeOrder('buy');
  assert.equal(sent.length, 0); assert.match(msgs[0], /already have an open EURUSD buy on this trade idea\. Add a stop to it/);
  await ctx.window.placeOrder('sell'); assert.equal(sent.length, 1, 'the other direction is a different idea');
});

test('suggested stop for the 30-second card fits the risk limit and sits on the loss side', () => {
  const { ctx } = page({ infinity: true, rv: 'infinity_v2', multiple: 3 });
  const s = ctx.window.ipfxSuggestStop({ id: 't', symbol: 'EURUSD', side: 'buy', open_price: 1.1227, volume: 0.02, sl: null });
  assert.ok(s.sl < 1.1226 && !s.why, JSON.stringify(s)); assert.ok(s.risk <= 5 * 0.95 + 1e-9);
  const big = ctx.window.ipfxSuggestStop({ id: 't', symbol: 'EURUSD', side: 'sell', open_price: 1.1226, volume: 50, sl: null });
  assert.match(big.why, /No stop fits/);
});

test('trading.html: a red 30-second card for every Infinity trade without a stop, with Add stop, that the 10-second pop-up does not cover', () => {
  assert.match(html, /function stopRuleAlerts\(state\)/);
  assert.match(html, /try\{stopRuleAlerts\(state\);\}/);
  assert.match(html, /<button type="button" class="rule-add">Add stop<\/button>/);
  assert.match(html, /Challenge rule: add a stop loss within '\+dl\+' seconds or this trade is /);
  assert.match(html, /w\.code!=='missing-stop'/); assert.match(html, /box\.insertBefore\(card,\[\.\.\.box\.children\]\.find\(c=>!c\.classList\.contains\('rule'\)\)\|\|null\)/, 'stop cards stay on top');
  assert.match(html, /!c\.classList\.contains\('rule'\)/, 'ordinary alerts never push the rule card out of the stack');
});

test('engine: Infinity orders may open without a stop; traditional challenges that require one still refuse', () => {
  const eng = fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts', import.meta.url), 'utf8');
  assert.equal((eng.match(/challenge_type !== "infinity" && \(?(acct|A)( as Acct\))?\)?\.require_stop_loss && sl === null/g) || []).length, 3);
  assert.doesNotMatch(eng, /rules_version !== "infinity_v2" && \(?(acct|A)( as Acct\))?\)?\.require_stop_loss && sl === null/);
});

// Supabase usage (8 Nov 2026): the 10 s backup sweep and the quote warm-up were most of the project's egress.
test('engine: quote reads fetch only fresh rows and the columns used; the backup sweep defers to a healthy hub', () => {
  const eng = fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts', import.meta.url), 'utf8');
  assert.match(eng, /const QUOTE_COLS = "symbol,mid,bid,ask,spread,provider_ts,received_at,feed_ts,source";/);
  assert.doesNotMatch(eng, /from\("live_quotes"\)\.select\("\*"\)/, 'no full-row live_quotes reads left');
  assert.match(eng, /\.select\(QUOTE_COLS\)\s*\n?\s*\.gte\("received_at"/);
  const sweep = eng.slice(eng.indexOf('if (body.action === "sweep") {'), eng.indexOf('// privileged client for writes'));
  assert.match(sweep, /const hubCovering=await hubRiskCovering\(\);/);
  assert.match(sweep, /if\(!passIds\.has\(String\(id\)\)\)ids\.delete\(id\)/, 'pass candidates are still checked every 10 s');
  assert.match(sweep, /db\.rpc\("engine_sweep_full_due",\{p_seconds:FULL_SWEEP_WITH_HUB_S\}\);fullDue=r\.error\?true:r\.data!==false;/, 'last full pass is kept in the database; errors mean a full pass');
  assert.doesNotMatch(sweep, /select\("status"\)/, 'no second account read per account');
  const hub = eng.slice(eng.indexOf('async function hubRiskCovering'), eng.indexOf('// Marks positions, applies SL/TP'));
  assert.match(hub, /k\?\.mode === "active" && k\?\.healthy === true/); assert.match(hub, /catch \(_\) \{ return false; \}/);
  assert.match(eng, /const FULL_SWEEP_WITH_HUB_S = 28;/);
  assert.match(fs.readFileSync(new URL('../supabase/migrations/20261108150000_engine_sweep_full_due.sql', import.meta.url), 'utf8'), /grant execute on function public\.engine_sweep_full_due\(integer\) to service_role;/);
  const mig = fs.readFileSync(new URL('../supabase/migrations/20261108140000_venue_sync_only_when_connected.sql', import.meta.url), 'utf8');
  assert.match(mig, /where exists \(select 1 from public\.venue_connections where status in \(''connected'',''error''\)\)/);
});
