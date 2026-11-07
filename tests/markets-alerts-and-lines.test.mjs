// IPFX Markets (Nov 2026): every alert is a TradeLocker-style card (title, what happened, details, close), and stop / take-profit
// lines use TradeLocker's layout (outlined pill "lots | money | ×", price boxed on the axis), including the order-ticket preview.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('trading.html'), chart = read('assets/js/ipfx-chart.js'), guided = read('assets/js/markets-guided.js');

const fn = html.slice(html.indexOf('function alertParts('), html.indexOf('function engineMsg('));
const ctx = {}; vm.createContext(ctx); vm.runInContext(fn + '\nglobalThis.alertParts = alertParts;', ctx);
const parts = (...a) => JSON.parse(JSON.stringify(ctx.alertParts(...a)));

test('a fill reads like TradeLocker: Position opened / Market order filled / Buy 0.01 EURUSD @ price', () => {
  assert.deepEqual(parts('BUY 0.01 EURUSD filled @ 1.11420', true), { title: 'Position opened', sub: 'Market order filled', detail: 'Buy 0.01 EURUSD @ 1.11420' });
  assert.deepEqual(parts('SELL 0.10 XAUUSD filled', true), { title: 'Position opened', sub: 'Market order filled', detail: 'Sell 0.10 XAUUSD' });
});
test('closes, stop/target hits, updates and warnings get a short title and the details underneath', () => {
  assert.equal(parts('EURUSD position closed at 1.1150 (+$2.10)', true).title, 'Position closed');
  assert.deepEqual(parts('Stop loss hit — Sell 0.01 EURUSD @ 1.11200 (−$4.00)', false), { title: 'Stop loss hit', sub: '', detail: 'Sell 0.01 EURUSD @ 1.11200 (−$4.00)' });
  assert.equal(parts('EURUSD updated — SL 1.112 · TP 1.118', true).title, 'EURUSD updated');
  assert.equal(parts('Stop-loss warning 1 of 3: your EURUSD trade had no stop loss after 30 seconds and was closed.', false).title, 'Stop-loss warning 1 of 3');
  assert.deepEqual(parts('Order cancelled', true), { title: 'Order cancelled', sub: '', detail: '' });
});
test('a rejection says the order was not placed and gives the engine reason in full', () => {
  const p = parts('Risk on this order is $5.20, above your current $5.00 limit (base cap 0.5%). Reduce size or tighten the stop.', false);
  assert.equal(p.title, 'Order not placed'); assert.match(p.detail, /Reduce size or tighten the stop/);
  assert.equal(parts('The classic chart could not load — check your connection or ad blocker.', false).title, 'The classic chart could not load');
});
test('the card: icon, title, lines, close button; stacks newest first, at most four; errors announced as alerts and kept longer', () => {
  const body = html.slice(html.indexOf('function engineMsg('), html.indexOf('let prevOpenTradeIds'));
  assert.match(body, /box\.prepend\(card\)/); assert.match(body, /while\(box\.children\.length>4\)/);
  assert.match(body, /setAttribute\('role',tone==='err'\?'alert':'status'\)/);
  assert.match(body, /setAttribute\('aria-label','Dismiss'\)/);
  assert.match(body, /card\.onmouseenter=\(\)=>clearTimeout\(timer\)/, 'pauses while hovered');
  assert.match(body, /tone==='ok'\?5000:tone==='warn'\?7000:8000/);
  assert.match(body, /prefers-reduced-motion:reduce/);
});
test('stop / take-profit lines: outlined pill "lots | money | ×" and the price in an outlined box on the axis', () => {
  assert.match(chart, /<span class="ipc-seg ipc-lots">\$\{Number\(t\.volume\)\.toFixed\(2\)\}<\/span><span class="ipc-seg ipc-val"><\/span>/);
  assert.match(chart, /class="ipc-x ipc-seg"/); assert.match(chart, /<div class="ipc-axis"><span class="ipc-px"><\/span><\/div>/);
  assert.match(html, /\.ipc-sl,\.ipc-tp\{border-top-style:solid;\}/); assert.match(html, /\.ipc-axis\{position:absolute;left:var\(--pane-w,100%\)/);
  assert.match(chart, /if \(over\) note = `Over your/, 'the risk-limit warning moved to the tooltip; the pill still glows when over');
});
test('the ticket draws its buy and sell stops with the same pill on a dashed line before the order is placed', () => {
  assert.match(chart, /setPreview,/); assert.match(chart, /class="ipc-line ipc-sl ipc-preview"/); assert.match(html, /\.ipc-preview\{border-top-style:dashed;\}/);
  assert.match(guided, /ch\.setPreview\(levels \? Object\.entries\(levels\)\.map/);
  assert.match(html, /ipfx-chart\.js\?v=20261107a/);
});
