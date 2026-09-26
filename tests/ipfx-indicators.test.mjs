// Native IPFX chart indicators: maths checked against known values
// (StockCharts' published RSI worked example) and against exact results on
// simple series. Every indicator in the registry must also pass the generic
// shape checks, so a new definition can't ship without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const IND = require('../assets/js/ipfx-indicators.js');
for (const family of ['trend', 'volatility', 'momentum', 'volume', 'structure', 'more']) require(`../assets/js/ipfx-indicators-${family}.js`);
const { defs, ta, defaults, cleanInputs, label } = IND;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tradingHtml = fs.readFileSync(path.join(root, 'trading.html'), 'utf8');
// ids of the hand-written catalog in trading.html (INDS)
const indsStart = tradingHtml.indexOf('const INDS=[');
const indsBlock = tradingHtml.slice(indsStart, tradingHtml.indexOf('];', indsStart));
const staticIds = [...indsBlock.matchAll(/id:'([A-Za-z0-9_]+@tv-basicstudies)'/g)].map((m) => m[1]);

const bar = (c, i, spread = 0) => ({ time: 1_700_000_000 + i * 3600, open: c, high: c + spread, low: c - spread, close: c, volume: 100 });
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
      // marker plots (divergences, gaps, moon phases) can legitimately be empty on a smooth series; they have their own tests
      if (p.type !== 'dots' && !d.needsSymbol) assert.ok(out[p.key].some((v) => v != null), `${id}: plot ${p.key} produces values on 300 bars`);
    }
  }
});

test('inputs are clamped and typed; labels show the key numbers', () => {
  assert.deepEqual(cleanInputs('MAExp@tv-basicstudies', { length: '20.6', source: 'hl2' }), { length: 21, source: 'hl2' });
  assert.deepEqual(cleanInputs('MAExp@tv-basicstudies', { length: -5, source: 'bogus' }), { length: 1, source: 'close' });
  assert.equal(label('BB@tv-basicstudies', defaults('BB@tv-basicstudies')), 'BB 20 2');
});

test('every catalog entry in trading.html has a native version', () => {
  assert.ok(staticIds.length >= 20, `found ${staticIds.length} static catalog ids`);
  for (const id of staticIds) assert.ok(defs[id], `${id} is listed in the Indicators tab but has no native definition`);
});

test('every native definition is listed: in the static catalog, or through its own meta', () => {
  const cats = new Set(['trend', 'volatility', 'momentum', 'volume', 'structure']);
  const seen = new Set(), names = new Set();
  for (const [id, d] of Object.entries(defs)) {
    if (staticIds.includes(id)) continue;
    assert.ok(d.meta, `${id} has no meta, so it would not appear in the Indicators list`);
    assert.ok(cats.has(d.meta.cat), `${id}: category ${d.meta.cat}`);
    assert.ok(d.meta.brief && d.meta.brief.length > 8, `${id}: brief`);
    assert.ok(d.meta.explain && d.meta.explain.length > 60, `${id}: a real explanation`);
    assert.match(d.meta.color, /^#[0-9a-f]{6}$/i, `${id}: catalog colour`);
    assert.ok(!seen.has(id) && !names.has(d.name), `${id}: duplicate id or name ${d.name}`);
    seen.add(id); names.add(d.name);
  }
  // catalog() hands exactly those to the page, with the fields the registry test needs
  const cat = IND.catalog();
  assert.ok(cat.length >= 50, `catalog has ${cat.length} entries`);
  for (const e of cat) for (const f of ['cat', 'id', 'name', 'full', 'color', 'brief', 'explain']) assert.ok(e[f], `${e.id}: catalog field ${f}`);
  const all = [...staticIds, ...cat.map((e) => e.id)];
  assert.equal(new Set(all).size, all.length, 'no id is listed twice');
  const allNames = [...tradingHtml.matchAll(/,name:'([^']+)'/g)].map((m) => m[1]).slice(0, staticIds.length).concat(cat.map((e) => e.name));
  assert.equal(new Set(allNames).size, allNames.length, 'no display name is used twice');
});

test('definitions are internally consistent: select inputs, plots, levels, panes', () => {
  for (const [id, d] of Object.entries(defs)) {
    for (const i of d.inputs) {
      assert.ok(['int', 'float', 'source', 'select'].includes(i.type), `${id}: input type ${i.type}`);
      if (i.type === 'select') assert.ok(Array.isArray(i.options) && i.options.includes(i.default), `${id}: select default is an option`);
      if (i.type === 'int' || i.type === 'float') assert.ok(Number.isFinite(i.default), `${id}: numeric default`);
    }
    const keys = d.plots.map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length, `${id}: plot keys are unique`);
    for (const p of d.plots) {
      assert.ok(['line', 'histogram', 'dots'].includes(p.type), `${id}: plot type ${p.type}`);
      if (p.type === 'line' || p.type === 'dots') assert.match(p.color, /^#[0-9a-f]{6}$/i, `${id}.${p.key}: colour`);
      if (p.shiftInput) assert.ok(d.inputs.some((i) => i.key === p.shiftInput), `${id}.${p.key}: shiftInput is an input`);
    }
    if (d.range) assert.ok(d.range[0] < d.range[1], `${id}: range`);
    assert.ok(d.pane === 'overlay' || !d.plots.some((p) => p.scale), `${id}: only overlays can use their own scale`);
  }
});

test('select inputs accept only their options', () => {
  assert.equal(cleanInputs('MACross@tv-basicstudies', { type: 'wma' }).type, 'wma');
  assert.equal(cleanInputs('MACross@tv-basicstudies', { type: 'nonsense' }).type, 'sma');
});

test('indicators survive real-world data: gaps, zero ranges, a single bar and no bars', () => {
  const T = 1_700_000_000;
  const flat = [...Array(120)].map((_, i) => ({ time: T + i * 60, open: 5, high: 5, low: 5, close: 5, volume: 0 }));
  const one = [{ time: T, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
  for (const [id, d] of Object.entries(defs)) {
    for (const bars of [[], one, flat]) {
      const out = d.calc(bars, defaults(id));
      for (const p of d.plots) {
        assert.equal(out[p.key].length, bars.length, `${id}: ${p.key} length on ${bars.length} bars`);
        assert.ok(out[p.key].every((v) => v === null || Number.isFinite(v)), `${id}: ${p.key} has NaN/Infinity on ${bars.length} bars`);
      }
    }
  }
});
