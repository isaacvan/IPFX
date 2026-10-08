// Application page polish (2026-10-08): section descriptions no longer pulled over their headings; order-summary card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../start-challenge.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('section descriptions keep their spacing: the page-subtitle rule cannot pull them up over the heading', () => {
  assert.match(html, /\.form-section > p \{[^}]*margin: -14px 0 26px/, 'the subtitle rule still exists for the main subtitle');
  assert.match(html, /\.form-section > \.compliance-copy \{ margin: 0 0 22px; font-size: \.84rem; line-height: 1\.65;/, 'a more specific rule restores the description spacing');
  assert.match(html, /\.compliance-heading \{[^}]*margin: 34px 0 14px;[^}]*line-height: 1\.35;/);
});

test('order summary: Infinity shows a proper name and a short mark, other sizes never overflow the tile', () => {
  assert.match(html, /isInfinity \? 'Infinity Challenge' :/);
  assert.match(html, /isInfinity \? '\u221e'/);
  assert.match(html, /'150k':'\$150K'.*'250k':'\$250K'/);
  assert.match(html, /\.os-tier-icon\.is-mark \{ font-size: 1\.7rem; \}/);
  assert.match(html, /\.os-tier-icon\.is-long \{ font-size: 0\.78rem; \}/);
  assert.match(html, /overflow: hidden; line-height: 1; white-space: nowrap;/);
  assert.doesNotMatch(html, /sub:'Infinity Challenge · Free application'/, 'the sub-line no longer repeats the name');
  assert.match(html, /sub:'Free application · no payment required'/);
});
