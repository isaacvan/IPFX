// Expectancy (R) per trader: E = (1 - winRate)(PF - 1), with a 100-closed-trade significance gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
// Pull the real functions out of admin.html and evaluate them, so the test checks the shipped code.
const grab = (name) => {
  const i = html.indexOf('function ' + name + '(');
  assert.ok(i > 0, name + ' defined');
  // balance braces from the first {
  let d = html.indexOf('{', i), depth = 0, j = d;
  for (; j < html.length; j++) { if (html[j] === '{') depth++; else if (html[j] === '}' && --depth === 0) { j++; break; } }
  return html.slice(i, j);
};
const ctx = {};
new Function(grab('expectancyR') + '\n' + grab('expectancyCell') + '\nthis.expectancyR=expectancyR;this.expectancyCell=expectancyCell;').call(ctx);
const { expectancyR, expectancyCell } = ctx;

test('expectancyR matches (1 - winRate)(PF - 1)', () => {
  assert.equal(expectancyR(50, 2).toFixed(2), '0.50');   // 1:1 win/loss counts, 2x payoff
  assert.equal(expectancyR(50, 1), 0);                    // breakeven
  assert.equal(expectancyR(40, 0.5).toFixed(2), '-0.30'); // losing edge
  assert.equal(expectancyR(60, 3).toFixed(2), '0.80');
  assert.equal(expectancyR(null, 2), null);               // no closed trades
  assert.equal(expectancyR(100, null), Infinity);         // all wins, no losses
  assert.equal(expectancyR(0, null), 0);
});

test('expectancyCell gates significance at 100 closed trades', () => {
  const sig = expectancyCell({ trades: 120, win_rate: 55, profit_factor: 1.8 });
  assert.equal(sig.cls, 'pos');                           // positive AND significant -> green
  assert.doesNotMatch(sig.txt, /n&lt;100/);
  assert.match(sig.txt, /^\+0\.36R/);

  const unproven = expectancyCell({ trades: 40, win_rate: 55, profit_factor: 1.8 });
  assert.equal(unproven.cls, '');                         // positive but < 100 -> not green
  assert.match(unproven.txt, /n&lt;100/);

  const losing = expectancyCell({ trades: 200, win_rate: 45, profit_factor: 0.7 });
  assert.equal(losing.cls, 'neg');                        // negative -> red

  assert.equal(expectancyCell({ trades: 0 }).txt, '—');   // no trades
  assert.equal(expectancyCell({ trades: 150, win_rate: 100, profit_factor: null }).txt.startsWith('∞R'), true);
});

test('admin.html wires expectancy into card, sort and detail modal', () => {
  assert.match(html, /<span>Expectancy<\/span><b class="mono \$\{ec\.cls\}">\$\{ec\.txt\}<\/b>/);
  assert.match(html, /const ec=expectancyCell\(st\);/);
  assert.match(html, /<option value="exp">Expectancy \(R\)<\/option>/);
  assert.match(html, /if\(s==='exp'\)return expectancyCell\(b\.stats\|\|\{\}\)\.sortv-expectancyCell\(a\.stats\|\|\{\}\)\.sortv;/);
  assert.match(html, /\['Expectancy \(R\)',/);
});
