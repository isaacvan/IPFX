// Volume-family indicators: exact results on series with a known answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const IND = require('../assets/js/ipfx-indicators.js');
require('../assets/js/ipfx-indicators-volume.js');
const { defs, ta, defaults } = IND;

const T0 = 1_700_000_000 - (1_700_000_000 % 86400);
const mk = (rows) => rows.map(([o, h, l, c, v], i) => ({ time: T0 + i * 3600, open: o, high: h, low: l, close: c, volume: v }));
const closesBars = (closes, vols, spread = 0) => closes.map((c, i) => ({ time: T0 + i * 3600, open: c, high: c + spread, low: c - spread, close: c, volume: vols ? vols[i] : 100 }));
const run = (id, bars, over = {}) => defs[id].calc(bars, { ...defaults(id), ...over });
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const line = (n, f = (i) => 100 + i) => [...Array(n)].map((_, i) => f(i));

test('Volume bars are coloured by candle direction and use their own scale', () => {
  const r = run('Volume@tv-basicstudies', mk([[10, 11, 9, 11, 500], [11, 12, 10, 10, 300]]));
  assert.deepEqual(r.volume, [500, 300]);
  assert.equal(r.colors.volume[0], '#26a69a80');
  assert.equal(r.colors.volume[1], '#ef535080');
  assert.equal(defs['Volume@tv-basicstudies'].plots[0].scale, 'volume');
});

test('OBV adds volume on up-closes and subtracts it on down-closes', () => {
  const r = run('OBV@tv-basicstudies', closesBars([10, 11, 10, 10, 12], [5, 6, 7, 8, 9]));
  assert.deepEqual(r.obv, [0, 6, -1, -1, 8]);
});

test('MFI is 100 when money only flows in, 0 when it only flows out, and undefined without volume', () => {
  near(run('MF@tv-basicstudies', closesBars(line(30), null, 0.5)).mfi[29], 100);
  near(run('MF@tv-basicstudies', closesBars(line(30, (i) => 200 - i), null, 0.5)).mfi[29], 0);
  assert.equal(run('MF@tv-basicstudies', closesBars(line(30), Array(30).fill(0), 0.5)).mfi[29], null);
});

test('Accumulation/Distribution: hand-worked candles', () => {
  // high 12, low 8, close 11, volume 100 -> ((2*11-8-12)/4)*100 = 50 each; a flat candle adds nothing
  const r = run('ACCD@tv-basicstudies', mk([[10, 12, 8, 11, 100], [10, 12, 8, 11, 100], [9, 9, 9, 9, 500]]));
  assert.deepEqual(r.ad, [50, 100, 100]);
});

test('Chaikin Money Flow is +1 when every candle closes on its high', () => {
  near(run('ChaikinMoneyFlow@tv-basicstudies', closesBars(line(40), null, 0)).cmf[39], 0); // flat candles -> 0 flow
  const bars = line(40).map((c, i) => ({ time: T0 + i * 3600, open: c - 1, high: c, low: c - 1, close: c, volume: 100 }));
  near(run('ChaikinMoneyFlow@tv-basicstudies', bars, { length: 20 }).cmf[39], 1);
});

test('Chaikin Oscillator is the fast minus slow EMA of the A/D line', () => {
  const bars = mk(line(60).map((c, i) => [c, c + 2, c - 1, c + (i % 3 === 0 ? 1.5 : -0.5), 100 + i]));
  const ad = run('ACCD@tv-basicstudies', bars).ad;
  near(run('ChaikinOscillator@tv-basicstudies', bars).cho[59], ta.ema(ad, 3)[59] - ta.ema(ad, 10)[59]);
});

test('Ease of Movement on a steady climb', () => {
  // midpoint +1 per bar, range 2, volume 100 -> 10000 * 1 * 2 / 100 = 200
  near(run('EaseOfMovement@tv-basicstudies', closesBars(line(40), null, 1), { length: 14 }).eom[39], 200);
  assert.equal(run('EaseOfMovement@tv-basicstudies', closesBars(line(40), Array(40).fill(0), 1)).eom[39], null);
});

test('Klinger is the fast minus slow EMA of signed volume', () => {
  const bars = closesBars(line(120, (i) => 100 + Math.sin(i / 4) * 5), line(120, (i) => 100 + (i % 7) * 10), 1);
  const h3 = bars.map((b) => (b.high + b.low + b.close) / 3), ch = ta.change(h3);
  const sv = bars.map((b, i) => (ch[i] == null ? null : ch[i] >= 0 ? b.volume : -b.volume));
  near(run('KlingerOscillator@tv-basicstudies', bars).kvo[110], ta.ema(sv, 34)[110] - ta.ema(sv, 55)[110]);
});

test('Net Volume and Price Volume Trend are exact', () => {
  assert.deepEqual(run('NetVolume@tv-basicstudies', closesBars([10, 11, 11, 9], [5, 6, 7, 8])).nv, [0, 6, 0, -8]);
  const r = run('PriceVolumeTrend@tv-basicstudies', closesBars([100, 110, 99], [10, 20, 30])).pvt;
  near(r[1], (10 / 100) * 20); near(r[2], (10 / 100) * 20 + (-11 / 110) * 30);
});

test('Volume Oscillator is 0 for constant volume and positive when volume expands', () => {
  near(run('VolumeOscillator@tv-basicstudies', closesBars(line(40))).vo[39], 0);
  assert.ok(run('VolumeOscillator@tv-basicstudies', closesBars(line(40), line(40, (i) => 100 + i * 10))).vo[39] > 0);
});

test('Elder Force Index is the EMA of price change times volume', () => {
  const bars = closesBars(line(60, (i) => 100 + Math.sin(i / 3) * 4), line(60, (i) => 50 + i));
  const fp = bars.map((b, i) => (i === 0 ? null : (b.close - bars[i - 1].close) * b.volume));
  near(run('EFI@tv-basicstudies', bars).efi[50], ta.ema(fp, 13)[50]);
});
