// Native IPFX chart indicators: maths checked against known values
// (StockCharts' published RSI worked example) and against exact results on
// simple series. Every indicator in the registry must also pass the generic
// shape checks, so a new definition can't ship without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const IND = require('../assets/js/ipfx-indicators.js');
const { defs, ta, defaults, cleanInputs, label } = IND;

const bar = (c, i, spread = 0) => ({ time: 1_700_000_000 + i * 60, open: c, high: c + spread, low: c - spread, close: c, volume: 100 });
const barsOf = (closes, spread = 0) => closes.map((c, i) => bar(c, i, spread));
const near = (a, b, eps = 1e-6, msg) => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);

test('sma / ema / wma on 1..10', () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(ta.sma(x, 3), [null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
  // EMA seeded with the SMA; on a straight line it lags by (n-1)/2 bars
  assert.deepEqual(ta.ema(x, 3), [null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
  near(ta.wma(x, 3)[2], (1 * 1 + 2 * 2 + 3 * 3) / 6);
});

test('RSI matches the StockCharts worked example (Wilder smoothing)', () => {
  const closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.2778, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826,
    45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222];
  const { rsi } = defs['RSI@tv-basicstudies'].calc(barsOf(closes), { length: 14, source: 'close' });
  assert.equal(rsi[13], null);
  near(rsi[14], 70.53, 0.02, 'first RSI');
  near(rsi[15], 66.32, 0.02, 'second RSI');
  near(rsi[16], 66.55, 0.02, 'third RSI');
  near(rsi[17], 69.41, 0.02, 'fourth RSI');
});

test('RSI is 100 on a rising series and 0 on a falling one', () => {
  const up = defs['RSI@tv-basicstudies'].calc(barsOf([...Array(30)].map((_, i) => 100 + i)), { length: 14, source: 'close' }).rsi;
  const dn = defs['RSI@tv-basicstudies'].calc(barsOf([...Array(30)].map((_, i) => 100 - i)), { length: 14, source: 'close' }).rsi;
  assert.equal(up.at(-1), 100);
  assert.equal(dn.at(-1), 0);
});

test('Bollinger Bands: symmetric around the SMA, zero width on a flat series', () => {
  const closes = [...Array(40)].map((_, i) => 100 + Math.sin(i / 3) * 5);
  const r = defs['BB@tv-basicstudies'].calc(barsOf(closes), { length: 20, source: 'close', mult: 2 });
  const i = 39;
  near(r.basis[i], ta.sma(closes, 20)[i]);
  near(r.upper[i] - r.basis[i], r.basis[i] - r.lower[i]);
  const flat = defs['BB@tv-basicstudies'].calc(barsOf(Array(25).fill(5)), { length: 20, source: 'close', mult: 2 });
  near(flat.upper[24], 5); near(flat.lower[24], 5);
});

test('MACD histogram is MACD minus signal', () => {
  const closes = [...Array(80)].map((_, i) => 100 + i * 0.3 + Math.cos(i / 4) * 2);
  const r = defs['MACD@tv-basicstudies'].calc(barsOf(closes), { fast: 12, slow: 26, source: 'close', signal: 9 });
  assert.equal(r.macd[24], null);
  assert.notEqual(r.macd[25], null);
  near(r.hist[79], r.macd[79] - r.signal[79]);
});

test('Stochastic is 100 when price closes at the high of the range', () => {
  const closes = [...Array(20)].map((_, i) => 100 + i);
  const r = defs['Stochastic@tv-basicstudies'].calc(barsOf(closes), { k: 14, kSmooth: 1, d: 3 });
  near(r.k[19], 100);
  near(r.d[19], 100);
});

test('ATR equals the constant true range of a steady series', () => {
  const bars = barsOf(Array(30).fill(10), 0.5); // every bar: high-low = 1, no gaps
  near(defs['ATR@tv-basicstudies'].calc(bars, { length: 14 }).atr[29], 1);
});

test('CCI is 0 on a flat series and positive after a jump up', () => {
  const flat = defs['CCI@tv-basicstudies'].calc(barsOf(Array(30).fill(7)), { length: 20, source: 'hlc3' }).cci;
  assert.equal(flat[29], 0);
  const jump = defs['CCI@tv-basicstudies'].calc(barsOf([...Array(29).fill(7), 9]), { length: 20, source: 'hlc3' }).cci;
  assert.ok(jump[29] > 100);
});

test('every registered indicator is well formed and returns aligned plots', () => {
  const closes = [...Array(300)].map((_, i) => 100 + Math.sin(i / 7) * 4 + i * 0.02);
  const bars = barsOf(closes, 0.4);
  for (const [id, d] of Object.entries(defs)) {
    assert.match(id, /^[A-Za-z0-9_]+@tv-basicstudies$/, `${id}: TradingView study id`);
    assert.ok(d.name && ['overlay', 'separate'].includes(d.pane), `${id}: name and pane`);
    assert.ok(Array.isArray(d.inputs) && Array.isArray(d.plots) && d.plots.length, `${id}: inputs and plots`);
    const out = d.calc(bars, defaults(id));
    for (const p of d.plots) {
      assert.ok(Array.isArray(out[p.key]), `${id}: returns plot ${p.key}`);
      assert.equal(out[p.key].length, bars.length, `${id}: plot ${p.key} aligned to bars`);
      const last = out[p.key].at(-1);
      assert.ok(last === null || Number.isFinite(last), `${id}: plot ${p.key} last value is a number`);
      assert.ok(out[p.key].some((v) => v != null), `${id}: plot ${p.key} produces values on 300 bars`);
    }
  }
});

test('inputs are clamped and typed; labels show the key numbers', () => {
  assert.deepEqual(cleanInputs('MAExp@tv-basicstudies', { length: '20.6', source: 'hl2' }), { length: 21, source: 'hl2' });
  assert.deepEqual(cleanInputs('MAExp@tv-basicstudies', { length: -5, source: 'bogus' }), { length: 1, source: 'close' });
  assert.equal(label('BB@tv-basicstudies', defaults('BB@tv-basicstudies')), 'BB 20 2');
});
