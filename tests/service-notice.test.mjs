// Weekend service notice on IPFX Markets (24-25 Oct 2026). Delete this test with the notice when service resumes.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
const html = fs.readFileSync(new URL('../trading.html', import.meta.url), 'utf8');

test('IPFX Markets shows a short service notice above the top bar, with no dismiss control', () => {
  const at = html.indexOf('id="siteNotice"'), top = html.indexOf('<div class="topbar">');
  assert.ok(at > 0 && at < top, 'the notice sits before the top bar');
  const block = html.slice(html.lastIndexOf('<div class="site-notice"', at), html.indexOf('</div>', at) + 6);
  assert.match(block, /We are resolving some technical issues over the weekend\. IPFX Markets will be back on Monday\./);
  assert.match(block, /Your accounts and progress are safe/);
  assert.doesNotMatch(block, /<button|onclick|dismiss|close/i, 'traders cannot hide it');
  assert.ok(block.replace(/<[^>]+>/g, '').length < 220, 'short and concise');
  assert.match(html, /\.site-notice\{flex-shrink:0;/, 'part of the flex column, so the page layout is not pushed off screen');
});
