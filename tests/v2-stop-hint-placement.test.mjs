// The "Stops can only be tightened" line must sit on its own row under Sell / lot size / Buy, not inside the lot-size stepper.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const js = read('assets/js/infinity-v2-ui.js'), html = read('trading.html');
test('v2 stop hint is inserted after the trade row, never inside the lot control', () => {
  assert.match(js, /\$\('ord-lots'\)\?\.closest\('\.op-trade-row'\)/);
  assert.match(js, /row\.insertAdjacentElement\('afterend',hint\)/);
  assert.doesNotMatch(js, /ord-lots'\)\?\.parentElement\?\.parentElement\?\.appendChild\(hint\)/);
  assert.match(html, /class="op-trade-row"[^>]*>[\s\S]*?id="ord-lots"/, 'the lots input lives inside .op-trade-row');
  assert.match(html, /infinity-v2-ui\.js\?v=20261102a/);
});
