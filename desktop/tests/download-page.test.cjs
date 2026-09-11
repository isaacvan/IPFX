const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('download page links resolve and preview never advertises an installer', () => {
  const root = path.resolve(__dirname, '../..');
  const html = fs.readFileSync(path.join(root, 'downloads.html'), 'utf8');
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1];
    if (/^(https?:|#)/.test(target)) continue;
    assert.ok(fs.existsSync(path.join(root, target)), 'Missing download-page target: ' + target);
  }
  assert.doesNotMatch(html, /href="[^"]+\.(exe|dmg)"/i);
  assert.equal((html.match(/\bdisabled\b/g) || []).length, 3);
});
