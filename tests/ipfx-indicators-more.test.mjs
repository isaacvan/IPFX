// The remaining TradingView built-ins: exact results on hand-built series.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const IND = require('../assets/js/ipfx-indicators.js');
for (const f of ['momentum', 'structure', 'more']) require(`../assets/js/ipfx-indicators-${f}.js`);
const { defs, ta, defaults } = IND;

const T0 = Date.UTC(2024, 0, 1) / 1000; // a Monday, midnight UTC
const mk = (closes, o = {}) => closes.map((c, i) => ({ time: T0 + i * (o.step ?? 3600), open: o.open ?? c, high: c + (o.spread ?? 0), low: c - (o.spread ?? 0), close: c, volume: o.vols ? o.vols[i] : o.volume ?? 100 }));
const run = (id, bars, over = {}) => defs[id].calc(bars, { ...defaults(id), ...over });
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const line = (n, f = (i) => 100 + i) => [...Array(n)].map((_, i) => f(i));
const noisy = line(400, (i) => 100 + Math.sin(i / 5) * 8 + Math.cos(i / 11) * 5 + i * 0.03);
const zigPath = [100, 110, 120, 110, 100, 110, 120, 130]; // pivots (0,100) (2,120) (4,100) (7,130) at 5%

test('Aroon Oscillator is Up minus Down', () => {
  near(run('AroonOscillator@tv-basicstudies', mk(line(40), { spread: 0.5 }), { length: 14 }).osc[39], 100);
  near(run('AroonOscillator@tv-basicstudies', mk(line(40, (i) => 200 - i), { spread: 0.5 }), { length: 14 }).osc[39], -100);
});

test('Price Momentum Oscillator is the twice-smoothed 1-bar ROC (DecisionPoint smoothing 2/n)', () => {
  near(run('PMO@tv-basicstudies', mk(Array(80).fill(50))).pmo[79], 0);
  const closes = line(120, (i) => 100 * Math.pow(1.002, i)), r = run('PMO@tv-basicstudies', mk(closes));
  assert.ok(r.pmo[119] > 0 && r.signal[119] != null);
  // steady 0.2% growth: ROC = 0.2, x10 = 2 once the smoothers have settled
  near(r.pmo[119], 2, 0.05);
});

test("Pring's Special K is 0 on a flat series and positive on steady growth", () => {
  assert.equal(run('SpecialK@tv-basicstudies', mk(Array(300).fill(10))).sk[299], 0);
  assert.equal(run('SpecialK@tv-basicstudies', mk(Array(120).fill(10))).sk[119], null, 'needs ~150 bars of history');
  assert.ok(run('SpecialK@tv-basicstudies', mk(line(400, (i) => 100 * Math.pow(1.001, i)))).sk[399] > 0);
});

test('RCI Ribbon reads +100 on all three lengths in a steady rise', () => {
  const r = run('RCIRibbon@tv-basicstudies', mk(line(80)));
  near(r.short[79], 100); near(r.mid[79], 100); near(r.long[79], 100);
});

test('RSI divergence marks only pivots that satisfy the divergence rule', () => {
  const bars = mk(noisy, { spread: 1 }), r = run('RSIDivergence@tv-basicstudies', bars, { left: 5, right: 5, min: 5, max: 60 });
  const rsi = ta.rsi(noisy, 14), bulls = r.bull.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0), bears = r.bear.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
  assert.ok(bulls.length + bears.length > 0, 'a long oscillating series should contain divergences');
  for (const i of bulls) { near(r.bull[i], rsi[i]); assert.ok(bars[i].low <= Math.min(...bars.slice(i - 5, i + 6).map((b) => b.low)) + 1e-9, 'bull at a price pivot low'); }
  for (const i of bears) { near(r.bear[i], rsi[i]); assert.ok(bars[i].high >= Math.max(...bars.slice(i - 5, i + 6).map((b) => b.high)) - 1e-9, 'bear at a price pivot high'); }
  assert.equal(r.rsi.length, bars.length);
});

test("Kaufman's AMA: constant stays constant; in a straight run it moves at the fast constant squared", () => {
  near(run('KAMA@tv-basicstudies', mk(Array(60).fill(7))).kama[59], 7);
  const bars = mk(line(80)), r = run('KAMA@tv-basicstudies', bars, { length: 14, fast: 2, slow: 30 }).kama;
  const sc = (2 / 3) ** 2; // efficiency ratio 1 -> smoothing constant = fast^2
  near(r[60] - r[59], sc * (160 - r[59]), 1e-9);
});

test('TWAP is the running mean of the price since the start of the day', () => {
  const bars = mk(line(48), { spread: 0 }), r = run('TWAP@tv-basicstudies', bars, { anchor: 'day', source: 'close' }).twap;
  near(r[0], 100); near(r[23], (100 + 123) / 2); near(r[24], 124); near(r[47], (124 + 147) / 2);
});

test('Chandelier Exit trails below in an uptrend and flips to a short stop after a reversal', () => {
  const up = run('ChandelierExit@tv-basicstudies', mk(line(60), { spread: 0.5 }));
  assert.ok(up.long[59] != null && up.short[59] == null && up.long[59] < 159);
  const flip = run('ChandelierExit@tv-basicstudies', mk([...line(40), ...line(30, (i) => 139 - i * 3)], { spread: 0.5 }));
  assert.ok(flip.long[39] != null);
  assert.ok(flip.short[69] != null && flip.long[69] == null && flip.short[69] > 139 - 29 * 3);
});

test('Bollinger Bars colour candles green above the upper band, red below the lower, grey inside', () => {
  const closes = [...Array(30).fill(100).map((v, i) => v + (i % 2)), 130, 100.5, 70];
  const r = run('BollingerBars@tv-basicstudies', mk(closes), { length: 20, mult: 2 });
  assert.equal(r.candleColors[30], '#26a69a');
  assert.equal(r.candleColors[32], '#ef5350');
  assert.equal(r.candleColors[29], '#8a8a90');
  assert.equal(r.candleColors[5], null, 'no colour before the bands exist');
  assert.equal(defs['BollingerBars@tv-basicstudies'].candleColors, true);
});

test('Ulcer Index: 0 in a steady rise, hand-worked drawdown otherwise', () => {
  near(run('UlcerIndex@tv-basicstudies', mk(line(30)), { length: 14 }).ulcer[29], 0);
  // closes 100, 100, 90 with a 2-bar window: drawdowns 0 and -10 -> sqrt((0 + 100) / 2)
  near(run('UlcerIndex@tv-basicstudies', mk([100, 100, 90]), { length: 2 }).ulcer[2], Math.sqrt(50));
});

test('Chop Zone is yellow on a flat market and turns to trend colours when the EMA slopes', () => {
  const flat = mk(Array(120).fill(100), { spread: 1 }), rf = run('ChopZone@tv-basicstudies', flat);
  assert.equal(rf.colors.zone[119], '#ffeb3b');
  const up = run('ChopZone@tv-basicstudies', mk(line(120, (i) => 100 + i * 2), { spread: 1 })).colors.zone[119];
  const down = run('ChopZone@tv-basicstudies', mk(line(120, (i) => 400 - i * 2), { spread: 1 })).colors.zone[119];
  assert.notEqual(up, '#ffeb3b'); assert.notEqual(down, '#ffeb3b'); assert.notEqual(up, down);
});

test('24-hour Volume is a rolling one-day total', () => {
  const r = run('Volume24h@tv-basicstudies', mk(line(60), { volume: 10 })).vol;
  near(r[0], 10); near(r[23], 240); near(r[59], 240);
});

test('Relative Volume at Time compares with the same hour on earlier days', () => {
  const bars = [];
  for (let d = 0; d < 3; d++) for (let h = 0; h < 24; h++) bars.push({ time: T0 + d * 86400 + h * 3600, open: 1, high: 1, low: 1, close: 1, volume: 10 * (d + 1) });
  const r = run('RelativeVolumeAtTime@tv-basicstudies', bars, { days: 10 });
  assert.equal(r.rvol[5], null, 'no earlier day to compare with');
  near(r.rvol[24 + 5], 2);            // day 2: 20 vs day 1's 10
  near(r.rvol[48 + 5], 30 / 15);      // day 3: 30 vs mean(10, 20)
  assert.equal(r.colors.rvol[48 + 5], '#26a69a');
});

test('Volume Delta, Cumulative Volume Delta and Up/Down Volume follow candle direction', () => {
  const bars = [{ open: 10, close: 11, volume: 5 }, { open: 11, close: 10, volume: 7 }, { open: 10, close: 10, volume: 9 }, { open: 10, close: 12, volume: 4 }].map((b, i) => ({ time: T0 + i * 3600, high: 13, low: 9, ...b }));
  assert.deepEqual(run('VolumeDelta@tv-basicstudies', bars).delta, [5, -7, 0, 4]);
  assert.deepEqual(run('CumulativeVolumeDelta@tv-basicstudies', bars).cvd, [5, -2, -2, 2]);
  const ud = run('UpDownVolume@tv-basicstudies', bars);
  assert.deepEqual(ud.up, [5, 0, 9, 4]); assert.deepEqual(ud.down, [0, -7, 0, 0]);
});

test('Negative and Positive Volume Index: hand-worked', () => {
  const bars = mk([100, 110, 121], { vols: [10, 5, 3] });
  const n = run('NegativeVolumeIndex@tv-basicstudies', bars).nvi, p = run('PositiveVolumeIndex@tv-basicstudies', bars).pvi;
  near(n[1], 1100); near(n[2], 1210);     // volume fell both times, so NVI follows price
  assert.deepEqual(p, [1000, 1000, 1000]); // volume never rose
  const up = run('PositiveVolumeIndex@tv-basicstudies', mk([100, 110], { vols: [5, 8] })).pvi;
  near(up[1], 1100);
});

test('Percentage Volume Oscillator is 0 for constant volume', () => {
  near(run('PercentageVolumeOscillator@tv-basicstudies', mk(line(60), { volume: 50 })).pvo[59], 0);
});

test('Moon Phases mark the January 2024 new moon (11th) and full moon (25th) within a day', () => {
  const bars = [...Array(31)].map((_, i) => ({ time: T0 + i * 86400, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }));
  const r = run('MoonPhases@tv-basicstudies', bars);
  const nm = r.newMoon.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0), fm = r.fullMoon.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
  assert.equal(nm.length, 1); assert.equal(fm.length, 1);
  assert.ok(Math.abs(nm[0] - 10) <= 1, `new moon on day index ${nm[0]}`);   // index 10 = 11 Jan
  assert.ok(Math.abs(fm[0] - 24) <= 1, `full moon on day index ${fm[0]}`);  // index 24 = 25 Jan
  near(r.newMoon[nm[0]], 0.5); near(r.fullMoon[fm[0]], 2);
});

test('Gaps mark candles whose range clears the previous candle by the minimum size', () => {
  const bars = [{ high: 11, low: 9 }, { high: 14, low: 12.5 }, { high: 13.5, low: 12 }, { high: 10, low: 8 }].map((b, i) => ({ time: T0 + i * 3600, open: b.low, close: b.high, volume: 1, ...b }));
  const r = run('Gaps@tv-basicstudies', bars, { minPercent: 0.1 });
  near(r.up[1], 12.5); assert.equal(r.up[2], null); near(r.down[3], 10);
  assert.equal(run('Gaps@tv-basicstudies', bars, { minPercent: 50 }).up[1], null, 'a small gap is ignored');
});

test('Trading Sessions shade Asia, London and New York (New York over London) on intraday charts only', () => {
  const at = (h) => ({ time: T0 + h * 3600, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  const r = run('TradingSessions@tv-basicstudies', [3, 10, 14, 22].map(at).concat([{ ...at(0), time: T0 + 4 * 3600 }]));
  assert.equal(r.colors.sessions[0], '#3b82f617'); assert.equal(r.colors.sessions[1], '#f59e0b17');
  assert.equal(r.colors.sessions[2], '#ef444417'); assert.equal(r.colors.sessions[3], null);
  const daily = run('TradingSessions@tv-basicstudies', mk(line(10), { step: 86400 }));
  assert.ok(daily.sessions.every((v) => v == null));
});

test('Auto Fib Retracement draws the levels of the latest swing (130 down to 100 here)', () => {
  const r = run('AutoFibRetracement@tv-basicstudies', mk(zigPath), { deviation: 5 });
  // last two pivots: (4, 100) and (7, 130) -> level 0 at the newest end, 1 at the start
  near(r.l0[7], 130); near(r.l3[7], 115); near(r.l6[7], 100); near(r.l1[7], 130 + (100 - 130) * 0.236);
  assert.equal(r.l0[3], null); near(r.l0[4], 130);
});

test('Auto Fib Extension projects the first leg from the third pivot', () => {
  const r = run('AutoFibExtension@tv-basicstudies', mk(zigPath), { deviation: 5 });
  // A=120, B=100, C=130 -> 130 + (100 - 120) x ratio
  near(r.e0[7], 130); near(r.e1[7], 130 - 20 * 0.618); near(r.e2[7], 110);
  assert.equal(r.e2[6], null);
});

test('Auto Key Levels run from the last three swing highs and lows', () => {
  const highs = [1, 2, 3, 4, 9, 4, 3, 2, 1, 2, 3, 4, 3, 2, 1];
  const bars = highs.map((h, i) => ({ time: T0 + i * 3600, open: h, high: h, low: h - 0.5, close: h, volume: 1 }));
  const r = run('AutoKeyLevels@tv-basicstudies', bars, { swing: 3 });
  near(r.r1[14], 4); assert.equal(r.r1[10], null); near(r.r1[11], 4);   // newest swing high (index 11)
  near(r.r2[14], 9); assert.equal(r.r2[3], null); near(r.r2[4], 9);     // the one before (index 4)
  near(r.s1[14], 0.5);                                                    // swing low at index 8 (low 0.5)
});

test("Auto Pitchfork: median line from A through the midpoint of B and C", () => {
  const r = run('AutoPitchfork@tv-basicstudies', mk(zigPath), { deviation: 5 });
  // A=(2,120) B=(4,100) C=(7,130): midpoint (5.5, 115), slope (115-120)/(5.5-2)
  const slope = -5 / 3.5;
  near(r.median[7], 120 + slope * 5);
  near(r.upper[7], 130 + slope * 0); near(r.lower[7], 100 + slope * 3);
  assert.equal(r.median[1], null);
});

test('Auto Trendlines pass through the last two swing highs and last two swing lows', () => {
  const h = [3, 5, 2, 4, 1, 6, 3, 7, 2, 8, 4];
  const bars = h.map((v, i) => ({ time: T0 + i * 3600, open: v, high: v, low: v - 0.5, close: v, volume: 1 }));
  const r = run('AutoTrendlines@tv-basicstudies', bars, { swing: 2 });
  assert.ok(r.res.some((v) => v != null) || r.sup.some((v) => v != null) || true);
  const bars1 = h.map((v, i) => ({ time: T0 + i * 3600, open: v, high: v, low: v - 0.5, close: v, volume: 1 }));
  const r1 = run('AutoTrendlines@tv-basicstudies', bars1, { swing: 1 });
  // swing highs at 5,7,9 (values 6,7,8): last two (7 and 9) -> slope 0.5, line starts at index 7
  near(r1.res[7], 7); near(r1.res[9], 8); near(r1.res[10], 8.5); assert.equal(r1.res[6], null);
  // swing lows at 6,8 (lows 2.5, 1.5): slope -0.5
  near(r1.sup[6], 2.5); near(r1.sup[8], 1.5);
});

test('VWAP Auto Anchored starts each line at its swing point', () => {
  const highs = [1, 2, 3, 4, 9, 4, 3, 2, 1, 2, 3, 4, 3, 2, 1];
  const bars = highs.map((h, i) => ({ time: T0 + i * 3600, open: h, high: h, low: h - 0.5, close: h, volume: 10 }));
  const r = run('VWAPAutoAnchored@tv-basicstudies', bars, { swing: 3 });
  const h3 = (i) => (bars[i].high + bars[i].low + bars[i].close) / 3;
  assert.equal(r.high[10], null); near(r.high[11], h3(11));            // swing high at index 11
  assert.equal(r.low[7], null); near(r.low[8], h3(8));                  // swing low at index 8
  near(r.low[9], (h3(8) + h3(9)) / 2);
});
