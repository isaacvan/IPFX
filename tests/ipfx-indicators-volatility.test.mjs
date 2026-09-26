// Volatility-family indicators: exact results on series with a known answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const IND = require('../assets/js/ipfx-indicators.js');
require('../assets/js/ipfx-indicators-volatility.js');
const { defs, ta, defaults } = IND;

const T0 = 1_700_000_000 - (1_700_000_000 % 86400);
const bar = (c, i, spread = 0, step = 3600) => ({ time: T0 + i * step, open: c, high: c + spread, low: c - spread, close: c, volume: 100 });
const barsOf = (closes, spread = 0, step) => closes.map((c, i) => bar(c, i, spread, step));
const run = (id, bars, over = {}) => defs[id].calc(bars, { ...defaults(id), ...over });
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const line = (n, f = (i) => 100 + i) => [...Array(n)].map((_, i) => f(i));
const noisy = line(120, (i) => 100 + Math.sin(i / 3) * 5 + Math.cos(i / 7) * 3);

// Bollinger values from the reference set, to check the derived indicators against
require('../assets/js/ipfx-indicators.js');
const BB = (bars, over) => IND.defs['BB@tv-basicstudies'].calc(bars, { ...IND.defaults('BB@tv-basicstudies'), ...over });

test('%B and Bollinger Width agree with the bands they are made from', () => {
  const bars = barsOf(noisy), bb = BB(bars, {});
  const i = 100;
  near(run('BollingerBandsR@tv-basicstudies', bars).pctb[i], (noisy[i] - bb.lower[i]) / (bb.upper[i] - bb.lower[i]));
  near(run('BollingerBandsWidth@tv-basicstudies', bars).bbw[i], (bb.upper[i] - bb.lower[i]) / bb.basis[i]);
  // a flat series has no width, so %B is undefined rather than NaN
  assert.equal(run('BollingerBandsR@tv-basicstudies', barsOf(Array(40).fill(5))).pctb[39], null);
});

test('Keltner: basis is the EMA and the bands are mult x ATR away', () => {
  const bars = barsOf(noisy, 0.7);
  const r = run('KLTNR@tv-basicstudies', bars, { length: 20, mult: 2, atrLength: 10 });
  const atr = ta.rma(ta.trueRange(bars), 10);
  near(r.basis[100], ta.ema(noisy, 20)[100]);
  near(r.upper[100] - r.basis[100], 2 * atr[100]);
  near(r.basis[100] - r.lower[100], 2 * atr[100]);
});

test('Donchian: highest high, lowest low and their midpoint', () => {
  const bars = barsOf(line(30, (i) => 100 + (i % 7)), 1);
  const r = run('DONCH@tv-basicstudies', bars, { length: 10 });
  const hi = Math.max(...bars.slice(20, 30).map((b) => b.high)), lo = Math.min(...bars.slice(20, 30).map((b) => b.low));
  near(r.upper[29], hi); near(r.lower[29], lo); near(r.basis[29], (hi + lo) / 2);
});

test('Envelope is exactly the percentage either side of the average', () => {
  const r = run('ENV@tv-basicstudies', barsOf(noisy), { length: 20, percent: 10 });
  near(r.upper[60], r.basis[60] * 1.1); near(r.lower[60], r.basis[60] * 0.9);
});

test('Linear regression channel: zero width on a straight line, symmetric otherwise', () => {
  const straight = run('LinearRegressionChannel@tv-basicstudies', barsOf(line(150)), { length: 50 });
  near(straight.middle[149], 249); near(straight.upper[149], 249, 1e-6); near(straight.lower[149], 249, 1e-6);
  const r = run('LinearRegressionChannel@tv-basicstudies', barsOf(noisy), { length: 50, mult: 2 });
  near(r.upper[100] - r.middle[100], r.middle[100] - r.lower[100]);
  assert.ok(r.upper[100] > r.middle[100]);
});

test('Chande Kroll Stop on a flat range with 1-point candles', () => {
  const r = run('ChandeKrollStop@tv-basicstudies', barsOf(Array(40).fill(50), 1), { period: 10, mult: 1, stop: 9 });
  // ATR = 2; first high stop = 51 - 2 = 49; first low stop = 49 + 2 = 51
  near(r.short[39], 49); near(r.long[39], 51);
});

test('Historical volatility: zero for steady growth, and scaled by the timeframe', () => {
  const growth = barsOf(line(60, (i) => 100 * Math.pow(1.001, i)));
  near(run('HistoricalVolatility@tv-basicstudies', growth, { length: 10 }).hv[59], 0, 1e-6);
  const a = 0.01, alt = barsOf(line(60, (i) => (i % 2 ? 100 * Math.exp(a) : 100)));
  near(run('HistoricalVolatility@tv-basicstudies', alt, { length: 10 }).hv[59], 100 * a * Math.sqrt((365 * 86400) / 3600), 1e-6);
  // daily bars annualise with 365
  const daily = barsOf(line(60, (i) => (i % 2 ? 100 * Math.exp(a) : 100)), 0, 86400);
  near(run('HistoricalVolatility@tv-basicstudies', daily, { length: 10 }).hv[59], 100 * a * Math.sqrt(365), 1e-6);
});

test('Average range is the simple average of high minus low', () => {
  const r = run('AverageDayRange@tv-basicstudies', barsOf(line(30), 1.5), { length: 14 });
  near(r.adr[29], 3);
});

test('BBTrend is positive when the short bands expand upward past the long bands', () => {
  const rising = barsOf(line(200, (i) => 100 + i * 0.5 + Math.sin(i / 2) * 3));
  const r = run('BBTrend@tv-basicstudies', rising);
  assert.ok(Number.isFinite(r.bbt[199]));
  const manual = (() => {
    const s = BB(rising, { length: 20 }), l = BB(rising, { length: 50 }), i = 199;
    return ((Math.abs(s.lower[i] - l.lower[i]) - Math.abs(s.upper[i] - l.upper[i])) / s.basis[i]) * 100;
  })();
  near(r.bbt[199], manual);
});

test('Choppiness: low on a clean trend, high when price goes sideways', () => {
  const trend = run('ChoppinessIndex@tv-basicstudies', barsOf(line(60), 0.1)).chop[59];
  const side = run('ChoppinessIndex@tv-basicstudies', barsOf(line(60, (i) => (i % 2 ? 101 : 100)), 0.5)).chop[59];
  assert.ok(trend < 38.2, `trend ${trend}`);
  assert.ok(side > 61.8, `sideways ${side}`);
});

test('Mass Index is 25 when every candle has the same range', () => {
  near(run('MassIndex@tv-basicstudies', barsOf(line(120), 1), { length: 25 }).mass[119], 25, 1e-9);
});
