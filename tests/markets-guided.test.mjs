// IPFX Markets challenge-ready ticket: every challenge market order carries a stop on the correct side and is sized from
// the risk budget (5% under the cap); orders are held back with a reason when a check fails; practice accounts keep the
// classic ticket; the first-visit tour is wired into trading.html.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const src = fs.readFileSync(new URL('../assets/js/markets-guided.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../trading.html', import.meta.url), 'utf8');

function page({ demo = false, status = 'active', cap = 5, fresh = true, capMsg = null, type = 'market', slOn = false, slValue = '', symbol = 'EURUSD', bid = 1.1226, ask = 1.1227, digits = 5, contract = 100000, mount = false } = {}) {
  const sent = [], msgs = [], ticks = [];
  const events = {};
  const els = { slPrice: { value: slValue, addEventListener(type, fn) { events[type] = fn; }, focus() {} }, gtCard: mount ? null : { hidden: true }, gtStop: { value: '', addEventListener() {} }, gtStopSub: { textContent: '' }, gtChips: { innerHTML: '' }, gtChecks: { innerHTML: '' }, gtLotNote: { innerHTML: '' }, gtExact: { onclick: null }, 'ord-lots': {} };
  const node = () => ({ id: '', className: '', style: {}, appendChild() {}, before() {}, after() {}, addEventListener() {}, setAttribute() {}, classList: { toggle() {}, remove() {} } });
  const bar = node(); bar.after = (el) => { els.gtCard = el; };
  const ctx = {
    document: { readyState: 'complete', head: node(), body: node(), getElementById: (id) => els[id] || null, querySelector: (sel) => mount && sel === '#tab-order .op-quickbar' ? bar : null, querySelectorAll: () => [], createElement: node, addEventListener() {} },
    localStorage: { getItem: () => '1', setItem() {} }, setInterval: (fn) => { ticks.push(fn); return 0; }, clearInterval() {}, setTimeout: () => 0,
    engineState: { account: { status, is_demo: demo, limits: { require_stop_loss: true, max_risk_per_trade_usd: cap } } },
    activeSym: symbol, liveQuotesBySymbol: new Map([[symbol, { bid, ask, digits }]]),
    WL_DATA: { forex: [{ sym: 'EURUSD' }], metals: [{ sym: 'XAUUSD' }] }, execSymbol: (s) => s, futSym: () => null, symMeta: () => ({ quoteCurrency: 'USD' }),
    contractSizeFor: () => contract, clientUsdPerQuote: () => 1, feedFresh: () => fresh, dailyCapMessage: () => capMsg,
    orderType: type, slOn, ordLots: 0.01, engineMsg: (m) => msgs.push(m), setLots(v) { ctx.ordLots = v; },
    toggleSLTP() { ctx.slOn = !ctx.slOn; },
  };
  ctx.window = ctx;
  ctx.placeOrder = async (side) => { sent.push({ side, sl: ctx.slOn ? +els.slPrice.value : null, lots: ctx.ordLots }); };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return { ctx, sent, msgs, els, events, tick: () => ticks[0]() };   // tick = the ticket's 500ms refresh
}

test('a trader can type a smaller lot size than the risk limit suggests, and it is kept (a 0.01 on gold was being overridden)', async () => {
  const { ctx, sent, els, tick } = page();
  tick();                                              // ticket suggests the maximum: 0.02 lots
  assert.equal(ctx.ordLots, 0.02); assert.match(els.gtLotNote.innerHTML, /Size 0\.02 lots · up to 0\.02/); assert.ok(!/autolots/.test(els.gtLotNote.innerHTML));
  ctx.ordLots = 0.01;                                  // the trader types 0.01 in the lot box
  tick(); tick();                                      // later refreshes must not put 0.02 back
  assert.equal(ctx.ordLots, 0.01); assert.match(els.gtLotNote.innerHTML, /Size 0\.01 lots · up to 0\.02/); assert.match(els.gtLotNote.innerHTML, /Use max/);
  assert.match(els.gtChecks.innerHTML, /Risk \$2\.25 of \$5\.00 · 0\.01 lots/, 'the shown risk follows the chosen size');
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
  assert.match(els.gtChecks.innerHTML, /Ready to trade/);
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
  assert.match(els.gtChecks.innerHTML, /BUY: Risk/);
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

test('Buy/Sell moves higher: the checks collapse to one line when ready, and the Stage pass checklist moves below the trade row', () => {
  assert.match(src, /: cs\.map/, 'the full list only renders when a check fails');
  assert.match(src, /Ready to trade — \$\{cs\[0\]\.text\} · \$\{cs\[1\]\.text\}/);
  const tradeRowAt = html.indexOf('class="op-trade-row"');
  const checklistAt = html.indexOf('id="stageChecklist"');
  const dailyCapAt = html.indexOf('id="dailyCapNotice"');
  assert.ok(tradeRowAt > 0 && checklistAt > 0 && dailyCapAt > 0);
  assert.ok(dailyCapAt < tradeRowAt, 'the "can\'t trade right now" notice still sits right above the buttons');
  assert.ok(checklistAt > tradeRowAt, 'the stage pass checklist (progress tracking, not a pre-trade gate) moved below Buy/Sell');
});
