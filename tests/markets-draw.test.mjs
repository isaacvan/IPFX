// Phone drawing tools column (owner request 2026-11-19).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const draw = read('assets/js/markets-draw.js'), page = read('trading.html');

test('the drawing layer loads after the phone layout script', () => {
  const phone = page.indexOf('/assets/js/markets-phone.js?v='), d = page.indexOf('/assets/js/markets-draw.js?v=');
  assert.ok(phone > 0 && d > phone);
});
test('it only builds on the phone layout, so the computer version is unchanged', () => {
  assert.match(draw, /const phone = \(\) => document\.documentElement\.classList\.contains\('phone'\);/);
  assert.match(draw, /if \(!phone\(\)\) \{ if \(svg && svg\.firstChild\) render\(\); return; \}/);
});
test('drawings are saved per symbol as (time, price), so they stay on their candles', () => {
  assert.match(draw, /const KEY = \(sym\) => 'ipfx-draw:' \+ sym;/);
  assert.match(draw, /logicalToCoordinate\(timeToLogical\(pt\.t\)\)/);
  assert.match(draw, /series\.coordinateToPrice\(y\)/);
});
test('every tool in the column is present', () => {
  for (const t of ['cursor', 'trend', 'hline', 'vline', 'rect', 'fib', 'measure']) assert.ok(draw.includes(`'${t}'`), t);
});
test('the drawing layer never places, changes or closes orders', () => {
  assert.doesNotMatch(draw, /placeOrder|engineCall|qtPlace|closePosition|\.click\(\)/);
});
