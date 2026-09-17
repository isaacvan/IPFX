const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const trading = fs.readFileSync(path.join(root, 'trading.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
const policy = fs.readFileSync(path.join(root, 'desktop/policy.cjs'), 'utf8');

test('desktop mode removes website chrome and preserves the trading workspace', () => {
  assert.match(policy, /trading\.html\?desktop=1/);
  assert.match(trading, /\.desktop-app #dashboardBackBtn,\.desktop-app \.desktop-download-link\{display:none!important\}/);
  assert.match(trading, /\.desktop-app \.ipfx-launch-footer[^}]+display:none!important/);
  assert.match(trading, /\.desktop-app \.btm-outer\{height:132px/);
  assert.match(trading, /\.desktop-app \.guide\{width:clamp\(360px,27vw,430px\)/);
  assert.doesNotMatch(main, /Account Dashboard|Downloads & Releases|Open Web Platform|Contact Support/);
});

test('desktop mode can establish and refresh a Supabase trading session', () => {
  assert.match(trading, /signInWithPassword\(\{email,password\}\)/);
  assert.match(trading, /auth\.getSession\(\)/);
  assert.match(trading, /setFeed\('closed','CONNECT ACCOUNT'\)/);
  assert.match(trading, /onAuthStateChange\(/);
  assert.match(trading, /pollTicketPrice\(\)/);
});

test('desktop build uses the official IPFX brand icon', () => {
  const appIcon = fs.readFileSync(path.join(root, 'desktop/build/icon.png'));
  const officialIcon = fs.readFileSync(path.join(root, 'favicon/android-chrome-512x512.png'));
  assert.deepEqual(appIcon, officialIcon);
});
