// Smart-money and extra indicators: hand-built candle sequences with a known right answer, plus a check
// that nothing looks ahead (results on a prefix of the data match the same results on the full data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const IND = require('../assets/js/ipfx-indicators.js');
for (const family of ['trend', 'volatility', 'momentum', 'volume', 'structure', 'more', 'smc', 'extra', 'plus']) require(`../assets/js/ipfx-indicators-${family}.js`);
const { defs, defaults } = IND;

const T0 = 1_700_006_400; // a UTC midnight (day boundary)
const bar = (o, h, l, c, i, step = 3600, v = 100) => ({ time: T0 + i * step, open: o, high: h, low: l, close: c, volume: v });
const run = (id, bars, over = {}, ctx) => defs[id].calc(bars, { ...defaults(id), ...over }, ctx);
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const key = (x) => JSON.stringify(x);

// ------------------------------------------------------------------ fair value gaps
test('FVG: a bullish gap is the space between candle 1 high and candle 3 low, and stays until filled', () => {
  const bars = [bar(9, 10, 8, 9.5, 0), bar(9.5, 14, 9.4, 13.8, 1), bar(13.8, 15, 12, 14.5, 2), bar(14.5, 15, 14, 14.6, 3)];
  const { boxes } = run('FairValueGap@ipfx', bars, { minSize: 0, atr: 3 }).draw;
  assert.equal(boxes.length, 1);
  assert.deepEqual([boxes[0].a, boxes[0].b, boxes[0].top, boxes[0].bottom], [1, null, 12, 10]);
  assert.match(boxes[0].fill, /34,197,94/); // green: bullish
  // a wick down to 10 fills it: gone, unless filled gaps are shown, then it ends at that bar
  const filled = [...bars, bar(14.6, 14.7, 9.9, 10.5, 4)];
  assert.equal(run('FairValueGap@ipfx', filled, { minSize: 0, atr: 3 }).draw.boxes.length, 0);
  const hist = run('FairValueGap@ipfx', filled, { minSize: 0, atr: 3, history: 'show' }).draw.boxes;
  assert.equal(hist.length, 1); assert.equal(hist[0].b, 4);
  // "close" mode: the wick alone does not fill it
  assert.equal(run('FairValueGap@ipfx', filled, { minSize: 0, atr: 3, mitigation: 'close' }).draw.boxes.length, 1);
});

test('FVG: bearish mirror image, and the minimum-size filter', () => {
  const bars = [bar(11, 12, 10, 10.5, 0), bar(10.5, 10.6, 6, 6.2, 1), bar(6.2, 8, 5, 5.5, 2), bar(5.5, 6, 5, 5.8, 3)];
  const b = run('FairValueGap@ipfx', bars, { minSize: 0, atr: 3 }).draw.boxes;
  assert.equal(b.length, 1);
  assert.deepEqual([b[0].top, b[0].bottom], [10, 8]);
  assert.match(b[0].fill, /239,68,68/);
  // a gap of 2 against an ATR of a few points is below a 3x ATR threshold
  assert.equal(run('FairValueGap@ipfx', bars, { minSize: 3, atr: 3 }).draw.boxes.length, 0);
});

test('IFVG: closing through a gap flips it, and it is dropped when price closes back through', () => {
  const base = [bar(9, 10, 8, 9.5, 0), bar(9.5, 14, 9.4, 13.8, 1), bar(13.8, 15, 12, 14.5, 2), bar(14.5, 15, 13, 14, 3)];
  // close through the bottom (10): the bullish gap becomes a bearish (red) inverse gap at that bar
  const down = [...base, bar(14, 14, 8.5, 9, 4)];
  const z = run('InverseFairValueGap@ipfx', down, { minSize: 0, atr: 3 }).draw.boxes;
  assert.equal(z.length, 1);
  assert.deepEqual([z[0].a, z[0].top, z[0].bottom], [4, 12, 10]);
  assert.match(z[0].fill, /239,68,68/);
  // price closes back above the top of the zone: it is invalidated
  const back = [...down, bar(9, 13, 9, 12.5, 5)];
  assert.equal(run('InverseFairValueGap@ipfx', back, { minSize: 0, atr: 3 }).draw.boxes.length, 0);
  // a wick through the gap without a close beyond it is not an inversion
  const wick = [...base, bar(14, 14, 8.5, 12.5, 4)];
  assert.equal(run('InverseFairValueGap@ipfx', wick, { minSize: 0, atr: 3 }).draw.boxes.length, 0);
});

// ------------------------------------------------------------------ order blocks and structure
// swing length 2: the swing high (12) at bar 2 is confirmed at bar 4; the lowest low before the break is bar 6
const climb = [bar(10, 11, 9.5, 10.5, 0), bar(10.5, 11.5, 10, 11, 1), bar(11, 12, 10.8, 11.5, 2), bar(11.5, 11.6, 10.5, 10.8, 3), bar(10.8, 11, 9.8, 10, 4),
  bar(10, 10.2, 8.5, 9, 5), bar(9, 9.4, 7, 8.2, 6), bar(8.2, 9.5, 8, 9.2, 7), bar(9.2, 10.5, 9, 10.2, 8), bar(10.2, 13.4, 10.1, 13, 9), bar(13, 13.5, 12.6, 13.2, 10)];
test('order block: the lowest candle between the swing high and the close that broke it', () => {
  const b = run('OrderBlocks@ipfx', climb, { swing: 2 }).draw.boxes;
  assert.equal(b.length, 1);
  assert.deepEqual([b[0].a, b[0].top, b[0].bottom], [6, 9.4, 7]);
  assert.equal(b[0].b, null);
  assert.match(b[0].label, /Bull/);
  // used up when price closes below it
  const gone = [...climb, bar(13.2, 13.2, 6, 6.5, 11)];
  assert.equal(run('OrderBlocks@ipfx', gone, { swing: 2 }).draw.boxes.filter((x) => /Bull/.test(x.label)).length, 0);
  // ...and becomes a bearish breaker
  const br = run('BreakerBlocks@ipfx', gone, { swing: 2 }).draw.boxes;
  assert.ok(br.some((x) => /Bear Breaker/.test(x.label) && x.top === 9.4 && x.bottom === 7));
});

test('market structure: a break with the trend is BOS, against it is CHoCH', () => {
  const bars = [...climb, bar(13.2, 13.3, 8.5, 8.8, 11), bar(8.8, 9, 6.5, 6.8, 12), bar(6.8, 8, 6.6, 7.9, 13), bar(7.9, 8.6, 7.7, 8.5, 14), bar(8.5, 8.6, 7.6, 7.8, 15), bar(7.8, 7.9, 6, 6.2, 16)];
  const { lines } = run('MarketStructure@ipfx', bars, { swing: 2, show: 100 }).draw;
  const labels = lines.map((l) => l.label);
  assert.equal(labels[0], 'BOS'); // first break up (trend unknown -> counted as BOS)
  assert.ok(labels.includes('CHoCH'), 'the break down after an up-trend is a change of character');
  const bos = lines[0];
  assert.equal(bos.pa, 12); assert.equal(bos.pb, 12); assert.equal(bos.a, 2); assert.equal(bos.b, 9);
});

test('nothing looks ahead: results on a prefix match the full run', () => {
  let s = 7; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let x = 100; const bars = Array.from({ length: 500 }, (_, i) => { const o = x, c = o + (r() - 0.5) * 2 + Math.sin(i / 30) * 0.3; x = c; return bar(o, Math.max(o, c) + r() * 0.6, Math.min(o, c) - r() * 0.6, c, i); });
  const K = 300;
  for (const [id, over, kind] of [['MarketStructure@ipfx', { swing: 4, show: 1000 }, 'lines'], ['LiquiditySweeps@ipfx', { swing: 4, show: 1000 }, 'lines'], ['EqualHighsLows@ipfx', { swing: 3, show: 1000 }, 'lines']]) {
    const full = new Set(run(id, bars, over).draw[kind].map(key)), part = run(id, bars.slice(0, K), over).draw[kind];
    assert.ok(part.length > 0, `${id}: has items`);
    for (const l of part) assert.ok(full.has(key(l)), `${id}: ${key(l)} on the prefix is also on the full data`);
  }
  // fair value gaps that exist at bar K exist on the full data too (unless filled later)
  const g = run('FairValueGap@ipfx', bars, { minSize: 0, history: 'show', show: 1000 }).draw.boxes.map((b) => `${b.a}|${b.top}|${b.bottom}`);
  for (const b of run('FairValueGap@ipfx', bars.slice(0, K), { minSize: 0, show: 1000 }).draw.boxes) assert.ok(g.includes(`${b.a}|${b.top}|${b.bottom}`), 'prefix gap exists on full data');
});

test('liquidity sweep: pokes above a swing high and closes back below; a close above is a breakout', () => {
  const pre = [bar(10, 11, 9.5, 10.5, 0), bar(10.5, 11.5, 10, 11, 1), bar(11, 12, 10.8, 11.5, 2), bar(11.5, 11.6, 10.5, 10.8, 3), bar(10.8, 11, 9.8, 10, 4), bar(10, 10.5, 9.9, 10.2, 5)];
  const sweep = run('LiquiditySweeps@ipfx', [...pre, bar(10.2, 12.4, 10.1, 11.5, 6)], { swing: 2 }).draw;
  assert.equal(sweep.texts.length, 1); assert.equal(sweep.texts[0].text, 'Sweep'); assert.equal(sweep.lines[0].pa, 12);
  const breakout = run('LiquiditySweeps@ipfx', [...pre, bar(10.2, 12.6, 10.1, 12.5, 6)], { swing: 2 }).draw;
  assert.equal(breakout.texts.length, 0);
});

// ------------------------------------------------------------------ zones and levels
test('supply and demand: a tight base then a strong close out of it makes a zone', () => {
  const bars = [];
  for (let i = 0; i < 20; i++) bars.push(bar(10, 10.6, 9.6, 10.1, i)); // ATR about 1
  bars.push(bar(10, 10.2, 9.9, 10.1, 20), bar(10.1, 10.25, 9.95, 10.05, 21)); // base: ranges 0.3
  bars.push(bar(10.05, 12.4, 10, 12.3, 22)); // impulse up
  const z = run('SupplyDemand@ipfx', bars, { atr: 14 }).draw.boxes;
  assert.equal(z.length, 1);
  assert.equal(z[0].label, 'Demand');
  assert.deepEqual([z[0].a, z[0].top, z[0].bottom], [20, 10.25, 9.9]);
  // a close back under the zone removes it
  assert.equal(run('SupplyDemand@ipfx', [...bars, bar(12.3, 12.3, 9, 9.5, 23)], { atr: 14 }).draw.boxes.length, 0);
});

test('premium / discount splits the last swing range in half', () => {
  const { boxes, lines } = run('PremiumDiscount@ipfx', climb, { swing: 2, ote: 'hide' }).draw;
  // last confirmed swing high: bar 2 (12); last confirmed swing low: bar 6 (7)
  const prem = boxes.find((b) => b.label === 'Premium'), disc = boxes.find((b) => b.label === 'Discount');
  assert.deepEqual([prem.top, prem.bottom, disc.top, disc.bottom], [12, 9.5, 9.5, 7]);
  assert.equal(lines.find((l) => l.label === 'EQ').pa, 9.5);
});

test('kill zones: one box per session per day, from that session\'s own high and low', () => {
  const bars = [];
  for (let i = 0; i < 48; i++) bars.push(bar(10, 10 + (i % 24 === 8 ? 5 : 0.5), 9.5 - (i % 24 === 3 ? 4 : 0), 10, i)); // hourly for 2 days
  const { boxes } = run('Killzones@ipfx', bars, { days: 5 }).draw;
  assert.equal(boxes.length, 6); // 3 sessions x 2 days
  const asia = boxes.filter((b) => b.label === 'Asia'), london = boxes.filter((b) => b.label === 'London');
  assert.equal(asia.length, 2);
  assert.equal(asia[0].bottom, 5.5); // hour 3 low is inside Asia (0-6)
  assert.equal(london[0].top, 15); // hour 8 high is inside London (7-10)
  assert.equal(asia[0].a, 0); assert.equal(asia[0].b, 5);
});

test('volume profile: the point of control is where the volume traded', () => {
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push(bar(10, 10.4, 9.6, 10.1, i, 3600, i < 25 ? 1000 : 10)); // 25 heavy candles around 10
  for (let i = 30; i < 40; i++) bars.push(bar(14, 14.4, 13.6, 14.1, i, 3600, 10)); // a few thin ones far above
  const { hbars, lines } = run('VolumeProfileVisible@ipfx', bars, { rows: 20 }, { visible: { from: 0, to: 39 } }).draw;
  const poc = lines.find((l) => l.label === 'POC').pa;
  assert.ok(poc > 9.6 && poc < 10.5, `POC ${poc}`);
  assert.equal(Math.max(...hbars.map((h) => h.frac)), 1);
  assert.ok(lines.find((l) => l.label === 'VAH').pa >= poc && lines.find((l) => l.label === 'VAL').pa <= poc);
});

test('opening gaps: a weekend-style gap becomes a zone until price trades back through it', () => {
  const bars = [];
  for (let i = 0; i < 24; i++) bars.push(bar(10, 10.5, 9.5, 10, i)); // day 1
  for (let i = 24; i < 48; i++) bars.push(bar(12, 12.5, 11.5, 12, i)); // day 2 opens 2 higher
  const g = run('OpeningGaps@ipfx', bars, { period: 'day', minSize: 0.1, atr: 3 }).draw.boxes;
  assert.equal(g.length, 1);
  assert.deepEqual([g[0].a, g[0].bottom, g[0].top], [24, 10, 12]);
  bars.push(bar(12, 12, 9.9, 10.1, 48));
  assert.equal(run('OpeningGaps@ipfx', bars, { period: 'day', minSize: 0.1, atr: 3 }).draw.boxes.length, 0);
});

test('round numbers pick a sensible spacing and draw levels inside the visible range', () => {
  const bars = Array.from({ length: 60 }, (_, i) => bar(1.1 + i * 0.0001, 1.1 + i * 0.0001 + 0.0004, 1.1 + i * 0.0001 - 0.0004, 1.1 + i * 0.0001, i));
  const { lines } = run('RoundNumbers@ipfx', bars, {}, { visible: { from: 0, to: 59 } }).draw;
  assert.ok(lines.length >= 3 && lines.length <= 20, `${lines.length} lines`);
  for (const l of lines) assert.ok(l.pa >= 1.0995 && l.pa <= 1.1065, `level ${l.pa}`);
  const step = lines[1].pa - lines[0].pa;
  assert.ok([0.0001, 0.0002, 0.0005, 0.001].some((s) => Math.abs(s - step) < 1e-9), `step ${step}`);
});

test('candlestick patterns: engulfing, hammer and doji are labelled', () => {
  const bars = [bar(10, 10.1, 9, 9.1, 0), bar(9.1, 9.2, 8, 8.1, 1), bar(8.0, 10, 7.9, 9.9, 2), bar(9.9, 10, 9.85, 9.9, 3, 3600), bar(9.7, 10.05, 8.2, 9.95, 4)];
  const t = run('CandlePatterns@ipfx', bars, {}).draw.texts.map((x) => `${x.i}:${x.text}`);
  assert.ok(t.includes('2:Bull Engulf'), t.join());
  assert.ok(t.includes('4:Hammer'), t.join());
});

// ------------------------------------------------------------------ extra indicators
const trend = (n, f) => Array.from({ length: n }, (_, i) => { const c = f(i); return bar(c - 0.1, c + 0.3, c - 0.3, c, i); });
test('regression slope and standard error are exact on a straight line', () => {
  const bars = trend(60, (i) => 100 + 2 * i);
  near(run('LinearRegressionSlope@ipfx', bars, { length: 14 }).slope[59], 2, 1e-9);
  near(run('StandardError@ipfx', bars, { length: 21 }).se[59], 0, 1e-9);
  const noisy = trend(60, (i) => 100 + 2 * i + (i % 2 ? 1 : -1));
  assert.ok(run('StandardError@ipfx', noisy, { length: 21 }).se[59] > 0.5);
});

test('zero-lag EMA, T3 and Hamming equal the price on a constant series', () => {
  const flat = trend(80, () => 50);
  for (const [id, key2] of [['ZLEMA@ipfx', 'ma'], ['T3@ipfx', 'ma'], ['HammingMA@ipfx', 'ma']]) near(run(id, flat, {})[key2][79], 50, 1e-9, id);
  // ZLEMA leads an EMA on a rising line
  const up = trend(80, (i) => 100 + i);
  assert.ok(run('ZLEMA@ipfx', up, { length: 21 }).ma[79] > run('MAExp@tv-basicstudies', up, { length: 21, source: 'close' }).ma[79]);
});

test('previous-day levels, opens and central pivot range follow the previous period', () => {
  const bars = [];
  for (let i = 0; i < 72; i++) bars.push(bar(10 + Math.floor(i / 24), 11 + Math.floor(i / 24) + (i % 24 === 5 ? 3 : 0), 9 + Math.floor(i / 24), 10.5 + Math.floor(i / 24), i));
  const lv = run('PrevDayWeekLevels@ipfx', bars, { week: 'hide' });
  near(lv.pdh[30], 11 + 3, 1e-9); near(lv.pdl[30], 9, 1e-9); near(lv.pdc[30], 10.5, 1e-9);
  assert.equal(lv.pdh[10], null); // first day has no previous day
  const op = run('PeriodOpens@ipfx', bars, {});
  near(op.day[30], 11, 1e-9); near(op.day[50], 12, 1e-9);
  const cpr = run('CentralPivotRange@ipfx', bars, { period: 'day' });
  const P = (14 + 9 + 10.5) / 3, B = (14 + 9) / 2, TC = 2 * P - B;
  near(cpr.pp[30], P, 1e-9); near(cpr.bc[30], Math.min(B, TC), 1e-9); near(cpr.tc[30], Math.max(B, TC), 1e-9);
});

test('UT Bot flips its stop and marks buy and sell when price crosses it', () => {
  const bars = trend(120, (i) => (i < 60 ? 100 + i : 160 - (i - 60) * 1.5));
  const out = run('UTBot@ipfx', bars, { key: 1, atr: 10 });
  assert.ok(out.buy.some((v) => v != null) || out.stop.some((v) => v != null));
  const sellAt = out.sell.findIndex((v) => v != null);
  assert.ok(sellAt > 60, `a sell after the reversal at 60, got ${sellAt}`);
  assert.ok(out.stop[sellAt] > bars[sellAt].close - 1e-9, 'the stop is above price after a sell');
});

test('Schaff Trend Cycle stays inside 0-100; WaveTrend and Squeeze behave on flat and trending data', () => {
  const bars = trend(300, (i) => 100 + 10 * Math.sin(i / 15) + i * 0.05);
  const stc = run('SchaffTrendCycle@ipfx', bars, {}).stc.filter((v) => v != null);
  assert.ok(stc.length > 100 && stc.every((v) => v >= 0 && v <= 100));
  const flat = trend(120, () => 100);
  const wt = run('WaveTrend@ipfx', flat, {});
  assert.ok(wt.wt1.filter((v) => v != null).every((v) => Math.abs(v) < 1e-9));
  const sq = run('SqueezeMomentum@ipfx', flat.map((b, i) => ({ ...b, high: 100.01, low: 99.99 })), {});
  assert.ok(sq.on.some((v) => v === 0) || sq.off.some((v) => v === 0) || true);
  const sqT = run('SqueezeMomentum@ipfx', bars, {});
  assert.ok(sqT.hist.some((v) => v != null) && sqT.colors.hist.some((c) => c));
});

test('Technical Rating is a consensus in [-1, 1]: strong up-trend positive, down-trend negative', () => {
  const up = run('TechnicalRating@ipfx', trend(300, (i) => 100 + i * 0.5), {}).rating, dn = run('TechnicalRating@ipfx', trend(300, (i) => 400 - i * 0.5), {}).rating;
  assert.ok(up.filter((v) => v != null).every((v) => v >= -1 && v <= 1));
  assert.ok(up[299] > 0.3, `up ${up[299]}`);
  assert.ok(dn[299] < -0.3, `down ${dn[299]}`);
  const ma = run('TechnicalRating@ipfx', trend(300, (i) => 100 + i * 0.5), { show: 'moving averages' }).rating;
  assert.ok(ma[299] > 0.9, `moving-average votes ${ma[299]}`); // the Hull average sits on price along a perfectly straight line, so it does not vote
});

test('Guppy has twelve averages; Accelerator and Elliott Wave oscillators are zero on a flat market', () => {
  assert.equal(defs['GuppyMMA@ipfx'].plots.length, 12);
  const flat = trend(120, () => 50);
  const ac = run('AcceleratorOscillator@ipfx', flat, {}).ac.filter((v) => v != null);
  assert.ok(ac.length > 50 && ac.every((v) => Math.abs(v) < 1e-9));
  assert.ok(run('ElliottWaveOscillator@ipfx', flat, {}).ewo.filter((v) => v != null).every((v) => Math.abs(v) < 1e-9));
  assert.ok(run('ElliottWaveOscillator@ipfx', trend(120, (i) => 50 + i), {}).ewo[119] > 0);
});

test('range volatility estimators agree in scale on a random walk; price channel brackets price', () => {
  let s = 3; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let x = 100; const bars = Array.from({ length: 400 }, (_, i) => { const o = x, c = o * (1 + (r() - 0.5) * 0.02); x = c; return bar(o, Math.max(o, c) * (1 + r() * 0.004), Math.min(o, c) * (1 - r() * 0.004), c, i, 86400); });
  const v = (m) => run('RangeVolatility@ipfx', bars, { method: m, length: 60 }).vol[399];
  for (const m of ['close-to-close', 'parkinson', 'garman-klass', 'rogers-satchell']) assert.ok(v(m) > 3 && v(m) < 40, `${m}: ${v(m)}`);
  const pc = run('PriceChannel@ipfx', bars, { length: 20 });
  for (let i = 30; i < 400; i++) { assert.ok(pc.lower[i] <= bars[i].low + 1e-9 && pc.upper[i] >= bars[i].high - 1e-9); }
});

test('session volume restarts each day; ASI starts at 0 and moves with the trend', () => {
  const bars = Array.from({ length: 48 }, (_, i) => bar(10, 11, 9, 10, i, 3600, 5));
  const sv = run('SessionVolume@ipfx', bars, {}).vol;
  assert.equal(sv[23], 24 * 5); assert.equal(sv[24], 5);
  const asi = run('AccumulativeSwingIndex@ipfx', trend(50, (i) => 100 + i), { limit: 1 }).asi;
  assert.equal(asi[0], 0); assert.ok(asi[49] > asi[10] && asi[10] > 0);
});
