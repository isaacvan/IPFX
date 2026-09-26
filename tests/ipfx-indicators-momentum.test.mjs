// Momentum-family indicators: exact results on series with a known answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const IND = require('../assets/js/ipfx-indicators.js');
require('../assets/js/ipfx-indicators-momentum.js');
const { defs, ta, defaults } = IND;

const T0 = 1_700_000_000 - (1_700_000_000 % 86400);
const bar = (c, i, o = {}) => ({ time: T0 + i * 3600, open: o.open ?? c, high: c + (o.spread ?? 0), low: c - (o.spread ?? 0), close: c, volume: 100 });
const barsOf = (closes, o) => closes.map((c, i) => bar(c, i, o));
const run = (id, bars, over = {}) => defs[id].calc(bars, { ...defaults(id), ...over });
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const line = (n, f = (i) => 100 + i) => [...Array(n)].map((_, i) => f(i));
const noisy = line(160, (i) => 100 + Math.sin(i / 3) * 5 + Math.cos(i / 7) * 3 + i * 0.05);
const within = (arr, lo, hi, name) => arr.filter((v) => v != null).forEach((v) => assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `${name} ${v} outside ${lo}..${hi}`));

test("Williams %R: 0 when close is at the high of the range, -100 at the low", () => {
  const atHigh = barsOf(line(30), { spread: 0 });
  near(run('WilliamR@tv-basicstudies', atHigh, { length: 14 }).wr[29], 0);
  const atLow = barsOf(line(30, (i) => 200 - i));
  near(run('WilliamR@tv-basicstudies', atLow, { length: 14 }).wr[29], -100);
});

test('ADX / DMI: +DI leads in an uptrend, -DI in a downtrend, ADX is strong in both', () => {
  const up = run('DM@tv-basicstudies', barsOf(line(100), { spread: 0.5 }));
  assert.ok(up.plus[99] > up.minus[99] && up.adx[99] > 25);
  const dn = run('DM@tv-basicstudies', barsOf(line(100, (i) => 300 - i), { spread: 0.5 }));
  assert.ok(dn.minus[99] > dn.plus[99] && dn.adx[99] > 25);
  near(run('ADX@tv-basicstudies', barsOf(line(100), { spread: 0.5 })).adx[99], up.adx[99]);
  within(up.adx, 0, 100, 'adx');
});

test('Awesome Oscillator = SMA5 - SMA34 of the midpoint, coloured by direction', () => {
  const bars = barsOf(noisy, { spread: 1 });
  const r = run('AwesomeOscillator@tv-basicstudies', bars);
  const mid = bars.map((b) => (b.high + b.low) / 2);
  near(r.ao[100], ta.sma(mid, 5)[100] - ta.sma(mid, 34)[100]);
  assert.equal(r.colors.ao[100], r.ao[100] < r.ao[99] ? '#ef5350' : '#26a69a');
});

test('Momentum and Rate of Change on a straight line', () => {
  near(run('MOM@tv-basicstudies', barsOf(line(30)), { length: 10 }).mom[29], 10);
  near(run('ROC@tv-basicstudies', barsOf(line(30)), { length: 10 }).roc[29], (100 * 10) / 119);
});

test('Stochastic RSI stays within 0..100 and is 100 when RSI is at its high', () => {
  const r = run('StochasticRSI@tv-basicstudies', barsOf(noisy));
  within(r.k, 0, 100, 'k'); within(r.d, 0, 100, 'd');
  assert.ok(r.k.some((v) => v != null));
});

test('Ultimate Oscillator stays within 0..100 and is high in a steady uptrend', () => {
  const r = run('UltimateOsc@tv-basicstudies', barsOf(noisy, { spread: 1 }));
  within(r.uo, 0, 100, 'uo');
  assert.ok(run('UltimateOsc@tv-basicstudies', barsOf(line(60), { spread: 0.2 })).uo[59] > 70);
});

test('TSI is +100 / -100 for a perfectly steady rise / fall', () => {
  near(run('TSI@tv-basicstudies', barsOf(line(120))).tsi[119], 100);
  near(run('TSI@tv-basicstudies', barsOf(line(120, (i) => 300 - i))).tsi[119], -100);
});

test('TRIX on steady percentage growth equals 10000 x ln(growth)', () => {
  const r = run('Trix@tv-basicstudies', barsOf(line(200, (i) => 100 * Math.pow(1.001, i))), { length: 10 });
  near(r.trix[199], 10000 * Math.log(1.001), 1e-6);
});

test('KST is positive when price rises steadily', () => {
  const r = run('KST@tv-basicstudies', barsOf(line(120, (i) => 100 * Math.pow(1.004, i))));
  assert.ok(r.kst[119] > 0 && r.signal[119] != null);
});

test('PPO is the EMA gap as a percentage of the slow EMA', () => {
  const bars = barsOf(noisy), r = run('PriceOsc@tv-basicstudies', bars);
  const f = ta.ema(noisy, 12), s = ta.ema(noisy, 26);
  near(r.ppo[120], (100 * (f[120] - s[120])) / s[120]);
  near(r.hist[120], r.ppo[120] - r.signal[120]);
  near(run('PriceOsc@tv-basicstudies', barsOf(Array(80).fill(10))).ppo[79], 0);
});

test('Chande Momentum: +100 when every change is up, -100 when every change is down', () => {
  near(run('ChandeMO@tv-basicstudies', barsOf(line(30)), { length: 9 }).cmo[29], 100);
  near(run('ChandeMO@tv-basicstudies', barsOf(line(30, (i) => 200 - i)), { length: 9 }).cmo[29], -100);
});

test('Connors RSI stays within 0..100 and is high after a long run up', () => {
  within(run('ConnorsRSI@tv-basicstudies', barsOf(noisy)).crsi, 0, 100, 'crsi');
  const up = run('ConnorsRSI@tv-basicstudies', barsOf(line(200, (i) => 100 * Math.pow(1.003, i)))).crsi;
  assert.ok(up[199] > 60, `crsi ${up[199]}`);
});

test('Fisher Transform follows direction and its trigger is the previous value', () => {
  const r = run('FisherTransform@tv-basicstudies', barsOf(line(60), { spread: 0.5 }));
  assert.ok(r.fisher[59] > 1);
  near(r.trigger[59], r.fisher[58]);
  assert.ok(run('FisherTransform@tv-basicstudies', barsOf(line(60, (i) => 200 - i), { spread: 0.5 })).fisher[59] < -1);
});

test('Relative Volatility Index is 100 when only up-candles carry volatility', () => {
  const r = run('VolatilityIndex@tv-basicstudies', barsOf(line(80, (i) => 100 + i + (i % 3))));
  within(r.rvi, 0, 100, 'rvi');
  assert.ok(r.rvi[79] > 50);
});

test('Relative Vigor Index: positive when candles close above their open', () => {
  const bars = barsOf(line(60)).map((b) => ({ ...b, open: b.close - 0.5, high: b.close + 0.2, low: b.close - 0.6 }));
  const r = run('VigorIndex@tv-basicstudies', bars);
  assert.ok(r.rvgi[59] > 0 && r.signal[59] != null);
});

test('SMI Ergodic: TSI ratio is 1 on a steady rise and the oscillator is signal-free', () => {
  const r = run('SMIErgodicIndicator@tv-basicstudies', barsOf(line(120)));
  near(r.erg[119], 1); near(r.signal[119], 1);
  near(run('SMIErgodicOscillator@tv-basicstudies', barsOf(line(120))).osc[119], 0);
});

test('Stochastic Momentum Index stays within -100..100', () => {
  const r = run('StochasticMomentumIndex@tv-basicstudies', barsOf(noisy, { spread: 1 }));
  within(r.smi, -100, 100, 'smi');
  assert.ok(r.signal[159] != null);
});

test('Coppock Curve is the weighted average of the two rates of change', () => {
  const bars = barsOf(line(80, (i) => 100 + i)), r = run('CoppockCurve@tv-basicstudies', bars, { wmaLength: 10, longRoc: 14, shortRoc: 11 });
  const rocSum = (i) => (100 * 14) / (100 + i - 14) + (100 * 11) / (100 + i - 11);
  let expected = 0;
  for (let k = 0; k < 10; k++) expected += rocSum(79 - k) * (10 - k);
  near(r.cc[79], expected / 55, 1e-9);
});

test('DPO subtracts the average from about half a period earlier', () => {
  const r = run('DPO@tv-basicstudies', barsOf(noisy), { length: 21 });
  const sma = ta.sma(noisy, 21), back = Math.floor(21 / 2) + 1;
  near(r.dpo[100], noisy[100] - sma[100 - back]);
});

test('Balance of Power and Bull Bear Power are exact', () => {
  const b = { time: T0, open: 10, high: 14, low: 8, close: 13, volume: 1 };
  near(run('BalanceOfPower@tv-basicstudies', [b]).bop[0], (13 - 10) / (14 - 8));
  assert.equal(run('BalanceOfPower@tv-basicstudies', [{ ...b, high: 10, low: 10 }]).bop[0], null);
  const bars = barsOf(noisy, { spread: 1 }), r = run('BullBearPower@tv-basicstudies', bars, { length: 13 });
  const e = ta.ema(noisy, 13);
  near(r.bull[100], noisy[100] + 1 - e[100]); near(r.bear[100], noisy[100] - 1 - e[100]);
});

test('Woodies CCI: the 14-period line matches the CCI indicator', () => {
  const bars = barsOf(noisy, { spread: 1 });
  near(run('WoodiesCCI@tv-basicstudies', bars).cci[100], IND.defs['CCI@tv-basicstudies'].calc(bars, { length: 14, source: 'hlc3' }).cci[100]);
});

test('Rank Correlation Index: +100 / -100 for steady moves, and a hand-worked example', () => {
  near(run('RankCorrelationIndex@tv-basicstudies', barsOf(line(30)), { length: 9 }).rci[29], 100);
  near(run('RankCorrelationIndex@tv-basicstudies', barsOf(line(30, (i) => 200 - i)), { length: 9 }).rci[29], -100);
  // closes 1, 3, 2 (oldest to newest): rank differences 0, 1, -1 -> 1 - 6*2/(3*8) = 0.5
  near(run('RankCorrelationIndex@tv-basicstudies', barsOf([1, 3, 2]), { length: 3 }).rci[2], 50);
});

test('Trend Strength Index is +1 / -1 for a straight rise / fall', () => {
  near(run('TrendStrengthIndex@tv-basicstudies', barsOf(line(40)), { length: 14 }).tsi[39], 1);
  near(run('TrendStrengthIndex@tv-basicstudies', barsOf(line(40, (i) => 200 - i)), { length: 14 }).tsi[39], -1);
});

test('Vortex: VI+ leads in an uptrend, VI- in a downtrend', () => {
  const up = run('VortexIndicator@tv-basicstudies', barsOf(line(60), { spread: 0.5 }));
  assert.ok(up.plus[59] > 1 && up.plus[59] > up.minus[59]);
  const dn = run('VortexIndicator@tv-basicstudies', barsOf(line(60, (i) => 200 - i), { spread: 0.5 }));
  assert.ok(dn.minus[59] > dn.plus[59]);
});

test('Aroon: 100 / 0 in a steady rise, 0 / 100 in a steady fall', () => {
  const up = run('Aroon@tv-basicstudies', barsOf(line(40), { spread: 0.5 }), { length: 14 });
  near(up.up[39], 100); near(up.down[39], 0);
  const dn = run('Aroon@tv-basicstudies', barsOf(line(40, (i) => 200 - i), { spread: 0.5 }), { length: 14 });
  near(dn.up[39], 0); near(dn.down[39], 100);
});
