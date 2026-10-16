// IPFX Markets challenge-ready ticket: every challenge market order carries a stop on the correct side and is sized from
// the risk budget (5% under the cap); orders are held back with a reason when a check fails; practice accounts keep the
// classic ticket; the first-visit tour is wired into trading.html.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const src = fs.readFileSync(new URL('../assets/js/markets-guided.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../trading.html', import.meta.url), 'utf8');

function page({ demo = false, status = 'active', cap = 5, fresh = true, capMsg = null, type = 'market', slOn = false, slValue = '' } = {}) {
  const sent = [], msgs = [], els = { slPrice: { value: slValue, addEventListener() {} } };
  const node = () => ({ id: '', className: '', style: {}, appendChild() {}, before() {}, after() {}, addEventListener() {}, setAttribute() {}, classList: { toggle() {}, remove() {} } });
  const ctx = {
    document: { readyState: 'complete', head: node(), body: node(), getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [], createElement: node, addEventListener() {} },
    localStorage: { getItem: () => '1', setItem() {} }, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    engineState: { account: { status, is_demo: demo, limits: { require_stop_loss: true, max_risk_per_trade_usd: cap } } },
    activeSym: 'EURUSD', liveQuotesBySymbol: new Map([['EURUSD', { bid: 1.1226, ask: 1.1227, digits: 5 }]]),
    WL_DATA: { forex: [{ sym: 'EURUSD' }] }, execSymbol: (s) => s, futSym: () => null, symMeta: () => ({ quoteCurrency: 'USD' }),
    contractSizeFor: () => 100000, clientUsdPerQuote: () => 1, feedFresh: () => fresh, dailyCapMessage: () => capMsg,
    orderType: type, slOn, ordLots: 0.01, engineMsg: (m) => msgs.push(m), setLots(v) { ctx.ordLots = v; },
    toggleSLTP() { ctx.slOn = !ctx.slOn; },
  };
  ctx.window = ctx;
  ctx.placeOrder = async (side) => { sent.push({ side, sl: ctx.slOn ? +els.slPrice.value : null, lots: ctx.ordLots }); };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return { ctx, sent, msgs, els };
}

test('challenge market orders always carry a stop on the correct side and risk-sized lots under the cap', async () => {
  const { ctx, sent } = page();
  await ctx.window.placeOrder('buy'); await ctx.window.placeOrder('sell');
  // Default stop 0.2% of price ≈ 22.5 pips; $5 cap × 0.95 = $4.75 → 0.02 lots ($4.50 at risk).
  assert.equal(sent[0].side, 'buy'); assert.ok(sent[0].sl < 1.1227); assert.equal(sent[0].sl, 1.12045); assert.equal(sent[0].lots, 0.02);
  assert.equal(sent[1].side, 'sell'); assert.ok(sent[1].sl > 1.1226); assert.equal(sent[1].sl, 1.12485); assert.equal(sent[1].lots, 0.02);
  for (const o of sent) assert.ok(Math.abs((o.side === 'buy' ? 1.1227 : 1.1226) - o.sl) * 100000 * o.lots <= 5 * 0.95 + 1e-9);
});

test('orders are held back with the reason when a check fails', async () => {
  for (const [opts, why] of [[{ fresh: false }, /Prices reconnecting/], [{ capMsg: 'Daily profit cap reached' }, /Daily profit cap/], [{ cap: 0.2 }, /Stop too wide/]]) {
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
