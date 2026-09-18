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
  assert.doesNotMatch(trading, /id="dashboardBackBtn"/);
  assert.doesNotMatch(trading, /class="back-btn desktop-download-link"/);
  assert.doesNotMatch(trading, /<div class="ipfx-launch-footer"/);
  assert.match(trading, /#chatBtn,#chatWin,#welcomeCard\{display:none!important\}/);
  assert.match(trading, /\.desktop-app \.ipfx-cookie-panel,\.desktop-app \.ipfx-cookie-preferences\{display:none!important\}/);
  assert.match(trading, /\.desktop-app \.btm-outer\{height:132px/);
  assert.match(trading, /\.desktop-app \.guide\{width:clamp\(360px,27vw,430px\)/);
  assert.doesNotMatch(main, /Account Dashboard|Downloads & Releases|Open Web Platform|Contact Support/);
  assert.match(main, /classList\.add\('desktop-app'\)/);
});

test('web and desktop modes can establish and refresh a Supabase trading session', () => {
  assert.match(trading, /@supabase\/supabase-js@2\.57\.4\/dist\/umd\/supabase\.min\.js/);
  assert.match(trading, /\.desktop-auth\{display:none;position:fixed;inset:0/);
  assert.match(trading, /\.desktop-auth\.open\{display:flex\}/);
  assert.match(trading, /signInWithPassword\(\{email,password\}\)/);
  assert.match(trading, /Promise\.race\(\[signIn,timeout\]\)/);
  assert.match(trading, /auth\.getSession\(\)/);
  assert.match(trading, /desktopMode\(\)\?'CONNECT ACCOUNT':'SIGN IN'/);
  assert.match(trading, /onAuthStateChange\(/);
  assert.match(trading, /pollTicketPrice\(\)/);
});

test('desktop build uses the official IPFX brand icon', () => {
  const appIcon = fs.readFileSync(path.join(root, 'desktop/build/icon.png'));
  const officialIcon = fs.readFileSync(path.join(root, 'favicon/android-chrome-512x512.png'));
  assert.deepEqual(appIcon, officialIcon);
  const windowsIcon = fs.readFileSync(path.join(root, 'desktop/build/icon.ico'));
  assert.ok(windowsIcon.length > 65536, 'Windows icon must include high-resolution frames');
  assert.deepEqual([...windowsIcon.subarray(0, 4)], [0, 0, 1, 0]);
  assert.match(main, /process\.platform==='win32'\?'build\/icon\.ico':'build\/icon\.png'/);
});
