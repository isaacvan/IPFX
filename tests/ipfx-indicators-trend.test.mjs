// Trend-family indicators: exact results on series where the maths has a known answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const IND = require('../assets/js/ipfx-indicators.js');
require('../assets/js/ipfx-indicators-trend.js');
const { defs, ta, defaults } = IND;

const T0 = 1_700_000_000 - (1_700_000_000 % 86400); // a UTC midnight
const bar = (c, i, o = {}) => ({ time: T0 + i * 3600, open: o.open ?? c, high: c + (o.spread ?? 0), low: c - (o.spread ?? 0), close: c, volume: o.volume ?? 100 });
const barsOf = (closes, o) => closes.map((c, i) => bar(c, i, o));
const run = (id, bars, over = {}) => defs[id].calc(bars, { ...defaults(id), ...over });
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const line = (n, f = (i) => 100 + i) => [...Array(n)].map((_, i) => f(i));

test('DEMA and TEMA reproduce a straight line exactly (their lag cancels)', () => {
  const bars = barsOf(line(60));
  near(run('DoubleEMA@tv-basicstudies', bars, { length: 9 }).ma[59], 159);
  near(run('TripleEMA@tv-basicstudies', bars, { length: 9 }).ma[59], 159);
});

test('LSMA equals a straight line exactly; offset moves it back along the line', () => {
  const bars = barsOf(line(60));
  near(run('LinearRegression@tv-basicstudies', bars, { length: 25, offset: 0 }).ma[59], 159);
  near(run('LinearRegression@tv-basicstudies', bars, { length: 25, offset: 3 }).ma[59], 156);
});

test('WMA weights recent bars more; VWMA with equal volume is the SMA', () => {
  const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  near(run('MAWeighted@tv-basicstudies', barsOf(closes), { length: 3 }).ma[2], (1 * 1 + 2 * 2 + 3 * 3) / 6);
  const v = run('MAVolumeWeighted@tv-basicstudies', barsOf(closes), { length: 3 }).ma;
  near(v[9], ta.sma(closes, 3)[9]);
  // heavy volume on the last bar pulls it towards that bar
  const heavy = barsOf([1, 2, 3, 10]);
  heavy[3].volume = 1000;
  assert.ok(run('MAVolumeWeighted@tv-basicstudies', heavy, { length: 3 }).ma[3] > ta.sma([1, 2, 3, 10], 3)[3]);
});

test('ALMA and McGinley leave a constant series unchanged', () => {
  const flat = barsOf(Array(40).fill(50));
  near(run('ALMA@tv-basicstudies', flat).ma[39], 50);
  near(run('McGinleyDynamic@tv-basicstudies', flat).ma[39], 50);
});

test('Hull MA stays close to a straight line', () => {
  const r = run('hullMA@tv-basicstudies', barsOf(line(80)), { length: 16 }).ma;
  assert.ok(Math.abs(r[79] - 179) < 1.5, `hull ${r[79]}`);
});

test('SMMA is the Wilder average', () => {
  const closes = [10, 12, 11, 13, 12, 14, 13, 15];
  const r = run('SMMA@tv-basicstudies', barsOf(closes), { length: 3 }).ma;
  const seed = (10 + 12 + 11) / 3;
  near(r[2], seed);
  near(r[3], (seed * 2 + 13) / 3);
});

test('MA Cross marks exactly the bars where the fast line crosses the slow one', () => {
  const closes = [...line(30, (i) => 100 - i), ...line(30, (i) => 70 + i * 2)]; // down then up
  const r = run('MACross@tv-basicstudies', barsOf(closes), { short: 5, long: 12, type: 'sma' });
  const marks = r.cross.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
  assert.equal(marks.length, 1, `crossings ${marks}`);
  const i = marks[0];
  assert.ok(r.short[i] > r.long[i] && r.short[i - 1] <= r.long[i - 1]);
});

test('MA Ribbon returns eight aligned lines', () => {
  const r = run('MARibbon@tv-basicstudies', barsOf(line(200)));
  for (let k = 0; k < 8; k++) assert.equal(r['ma' + k].length, 200);
  assert.ok(r.ma0[199] > r.ma7[199]); // shortest average is closest to a rising price
});

test('Median with ATR bands: median of the last three values', () => {
  const r = run('Median@tv-basicstudies', barsOf([1, 9, 4, 6, 2]), { length: 3 });
  assert.equal(r.median[2], 4);
  assert.equal(r.median[3], 6);
  assert.equal(r.median[4], 4);
});

test('Parabolic SAR trails below a rising market and above a falling one', () => {
  const up = run('PSAR@tv-basicstudies', barsOf(line(60), { spread: 0.5 }));
  assert.ok(up.up[59] != null && up.down[59] == null);
  assert.ok(up.up[59] < 159 - 0.5);
  const dn = run('PSAR@tv-basicstudies', barsOf(line(60, (i) => 200 - i), { spread: 0.5 }));
  assert.ok(dn.down[59] != null && dn.up[59] == null);
  assert.ok(dn.down[59] > 141 + 0.5);
});

test('Parabolic SAR starting values match Pine (bar 1 rising: SAR starts at the previous low)', () => {
  const bars = barsOf([10, 11, 12], { spread: 1 });
  const r = run('PSAR@tv-basicstudies', bars);
  // second bar closes above the first -> below-price SAR seeded with previous low (9), then one accel step towards the new high (12)
  near(r.up[1], Math.min(9 + 0.02 * (12 - 9), bars[0].low));
});

test('Supertrend: below price and green in an uptrend, above and red in a downtrend, flips on a reversal', () => {
  const up = run('Supertrend@tv-basicstudies', barsOf(line(60), { spread: 0.5 }));
  assert.ok(up.up[59] != null && up.down[59] == null && up.up[59] < 159);
  const dn = run('Supertrend@tv-basicstudies', barsOf(line(60, (i) => 200 - i), { spread: 0.5 }));
  assert.ok(dn.down[59] != null && dn.up[59] == null && dn.down[59] > 141);
  const flip = run('Supertrend@tv-basicstudies', barsOf([...line(40), ...line(30, (i) => 139 - i * 3)], { spread: 0.5 }));
  assert.ok(flip.up[39] != null, 'up before the reversal');
  assert.ok(flip.down[69] != null && flip.up[69] == null, 'down after the reversal');
});

test('Volatility Stop flips from long to short when price falls through the stop', () => {
  const r = run('VolatilityStop@tv-basicstudies', barsOf([...line(40), ...line(30, (i) => 139 - i * 3)], { spread: 0.5 }));
  assert.ok(r.up[39] != null && r.up[39] < 139);
  assert.ok(r.down[69] != null && r.up[69] == null);
});

test('Ichimoku: conversion line is the midpoint of the 9-bar range; spans are shifted ahead, lagging line back', () => {
  const bars = barsOf(line(80), { spread: 1 });
  const r = run('IchimokuCloud@tv-basicstudies', bars);
  const hi = Math.max(...bars.slice(71, 80).map((b) => b.high)), lo = Math.min(...bars.slice(71, 80).map((b) => b.low));
  near(r.tenkan[79], (hi + lo) / 2);
  near(r.spanA[79], (r.tenkan[79] + r.kijun[79]) / 2);
  const plots = Object.fromEntries(defs['IchimokuCloud@tv-basicstudies'].plots.map((p) => [p.key, p]));
  assert.equal(plots.spanA.shiftInput, 'displacement');
  assert.equal(plots.spanA.shiftSign, 1);
  assert.equal(plots.chikou.shiftSign, -1);
});

test('VWAP resets each UTC day and falls back to equal weights when there is no volume', () => {
  const bars = [];
  for (let i = 0; i < 48; i++) bars.push({ time: T0 + i * 3600, open: 0, high: 0, low: 0, close: 0, volume: 0 });
  bars.forEach((b, i) => { b.high = b.low = b.close = b.open = 100 + i; });
  const r = run('VWAP@tv-basicstudies', bars, { anchor: 'day', source: 'close' }).vwap;
  near(r[0], 100);
  near(r[23], (100 + 123) / 2);
  near(r[24], 124); // new day starts fresh
  const weighted = bars.map((b, i) => ({ ...b, volume: i === 1 ? 1000 : 1 }));
  assert.ok(run('VWAP@tv-basicstudies', weighted, { anchor: 'day', source: 'close' }).vwap[2] > 100.9);
});

test('Alligator lines are drawn ahead of price by 8, 5 and 3 bars', () => {
  const shifts = Object.fromEntries(defs['WilliamsAlligator@tv-basicstudies'].plots.map((p) => [p.key, p.shift]));
  assert.deepEqual(shifts, { jaw: 8, teeth: 5, lips: 3 });
});
