// Maintenance banner on IPFX Markets (owner request 2026-11-18): shows until 8 pm UK time, then removes itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const js = read('assets/js/maintenance-notice.js'), html = read('trading.html');
test('the banner script is loaded on IPFX Markets', () => {
  assert.match(html, /<script src="\/assets\/js\/maintenance-notice\.js\?v=\d{8}[a-z]"><\/script>/);
});
test('it ends at 8 pm UK time and hides itself afterwards, and closing it lasts for the browser tab', () => {
  const until = js.match(/until: '([^']+)'/)[1];
  assert.equal(new Date(until).toISOString(), '2026-11-18T20:00:00.000Z');
  assert.match(js, /if \(!isFinite\(untilMs\) \|\| Date\.now\(\) >= untilMs\) return;/);
  assert.match(js, /sessionStorage\.setItem\(KEY, '1'\)/);
  assert.match(js, /insertBefore\(el, top\)/, 'sits above the top bar');
});
