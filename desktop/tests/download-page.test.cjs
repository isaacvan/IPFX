const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('download page links resolve and installers stay behind owner auth', () => {
  const root = path.resolve(__dirname, '../..');
  const html = fs.readFileSync(path.join(root, 'downloads.html'), 'utf8');
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1];
    if (/^(https?:|#)/.test(target)) continue;
    assert.ok(fs.existsSync(path.join(root, target)), 'Missing download-page target: ' + target);
  }
  assert.doesNotMatch(html, /href="[^"]+\.(exe|dmg)"/i);
  assert.equal((html.match(/\bdisabled\b/g) || []).length, 3);
  const script = fs.readFileSync(path.join(root, 'assets/js/desktop-downloads.js'), 'utf8');
  assert.match(script, /client\.auth\.getUser\(\)/);
  assert.match(script, /AUTHORIZED_USER_ID/);
  assert.match(script, /createSignedUrl\(/);
  assert.match(script, /desktop-releases/);
});
