// Structure indicators: pivot maths, swing detection and zig-zag on hand-built series.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const IND = require('../assets/js/ipfx-indicators.js');
require('../assets/js/ipfx-indicators-structure.js');
const { defs, defaults } = IND;

const T0 = 1_700_000_000 - (1_700_000_000 % 86400);
const run = (id, bars, over = {}) => defs[id].calc(bars, { ...defaults(id), ...over });
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const zero = (c, i, step = 3600) => ({ time: T0 + i * step, open: c, high: c, low: c, close: c, volume: 1 });

// Day 1 (24 hourly bars): open 102, high 110, low 100, close 105. Day 2: a few bars.
function twoDays() {
  const bars = [];
  for (let i = 0; i < 24; i++) bars.push({ time: T0 + i * 3600, open: 103, high: 104, low: 101, close: 103, volume: 1 });
  bars[0] = { ...bars[0], open: 102 };
  bars[5] = { ...bars[5], high: 110 };
  bars[9] = { ...bars[9], low: 100 };
  bars[23] = { ...bars[23], close: 105 };
  for (let i = 24; i < 30; i++) bars.push({ time: T0 + i * 3600, open: 106, high: 107, low: 105, close: 106, volume: 1 });
  return bars;
}

test('Traditional pivots from the previous day (H 110, L 100, C 105)', () => {
  const r = run('PivotPointsStandard@tv-basicstudies', twoDays(), { kind: 'traditional', period: 'day' });
  assert.equal(r.pp[10], null, 'no levels on the first day (no previous period)');
  near(r.pp[25], 105); near(r.r1[25], 110); near(r.s1[25], 100);
  near(r.r2[25], 115); near(r.s2[25], 95); near(r.r3[25], 120); near(r.s3[25], 90);
});

test('Fibonacci, classic, camarilla, woodie and DeMark pivots', () => {
  const at = (kind) => run('PivotPointsStandard@tv-basicstudies', twoDays(), { kind, period: 'day' });
  const f = at('fibonacci'); near(f.r1[25], 105 + 0.382 * 10); near(f.s1[25], 105 - 3.82); near(f.r3[25], 115); near(f.s3[25], 95);
  const c = at('classic'); near(c.r3[25], 125); near(c.s3[25], 85);
  const cam = at('camarilla'); near(cam.r1[25], 105 + (10 * 1.1) / 12); near(cam.s3[25], 105 - (10 * 1.1) / 4);
  const w = at('woodie'); near(w.pp[25], (110 + 100 + 210) / 4); assert.equal(w.r3[25], null);
  // close (105) > open (102): X = 2H + L + C = 425
  const dm = at('dm'); near(dm.pp[25], 425 / 4); near(dm.r1[25], 425 / 2 - 100); near(dm.s1[25], 425 / 2 - 110); assert.equal(dm.r2[25], null);
});

test('Auto period: daily bars use the previous week, intraday bars the previous day', () => {
  const monday = Date.UTC(2024, 0, 1) / 1000; // a Monday
  const daily = [];
  for (let i = 0; i < 21; i++) daily.push({ time: monday + i * 86400, open: 50, high: 60 + (i === 2 ? 10 : 0), low: 40, close: 55, volume: 1 });
  const r = run('PivotPointsStandard@tv-basicstudies', daily, { kind: 'traditional', period: 'auto' });
  assert.equal(r.pp[3], null);                       // first week: nothing before it
  near(r.pp[10], (70 + 40 + 55) / 3);                // second week uses week one (high 70, low 40, close 55)
});

test('Swing high / low dots appear only on a real peak and trough', () => {
  const highs = [1, 2, 3, 4, 9, 4, 3, 2, 1, 2, 3, 4, 3, 2, 1];
  const bars = highs.map((h, i) => ({ time: T0 + i * 3600, open: h, high: h, low: h - 0.5, close: h, volume: 1 }));
  const r = run('PivotPointsHighLow@tv-basicstudies', bars, { left: 3, right: 3 });
  assert.equal(r.high[4], 9);
  assert.equal(r.high.filter((v) => v != null).length >= 1, true);
  assert.equal(r.high[3], null);
  assert.equal(r.low[8], 0.5);
});

test('Williams fractals need two lower highs (or higher lows) either side', () => {
  const highs = [1, 2, 5, 2, 1, 2, 3, 2, 1];
  const bars = highs.map((h, i) => ({ time: T0 + i * 3600, open: h, high: h, low: h - 1, close: h, volume: 1 }));
  const r = run('WilliamsFractal@tv-basicstudies', bars, { periods: 2 });
  assert.equal(r.up[2], 5);
  assert.equal(r.up[6], 3); // 3 beats the two candles either side (1, 2 | 2, 1)
  assert.equal(r.up[3], null);
  const flatTop = [1, 5, 5, 1, 1].map((h, i) => ({ time: T0 + i * 3600, open: h, high: h, low: h - 1, close: h, volume: 1 }));
  assert.ok(run('WilliamsFractal@tv-basicstudies', flatTop, { periods: 1 }).up.every((v) => v == null), 'equal highs are not a fractal');
});

test('ZigZag joins the swings and ignores moves smaller than the deviation', () => {
  const path = [100, 110, 120, 110, 100, 110, 120, 130];
  const r = run('ZigZag@tv-basicstudies', path.map((c, i) => zero(c, i)), { deviation: 5 });
  assert.deepEqual(r.zz, path);
  // wiggles under 5% are ignored: the line runs straight from 100 up to 130
  const wiggle = [100, 102, 101, 104, 103, 108, 107, 115, 130];
  const w = run('ZigZag@tv-basicstudies', wiggle.map((c, i) => zero(c, i)), { deviation: 5 });
  near(w.zz[0], 100); near(w.zz[8], 130);
  assert.ok(w.zz.every((v, i) => i === 0 || v >= w.zz[i - 1]), 'monotonic while no reversal reaches 5%');
});

test('ZigZag marks a reversal of at least the deviation', () => {
  const path = [100, 120, 100, 80, 100];
  const r = run('ZigZag@tv-basicstudies', path.map((c, i) => zero(c, i)), { deviation: 10 });
  assert.equal(r.zz[1], 120); assert.equal(r.zz[3], 80); // pivots at the top and bottom
});
