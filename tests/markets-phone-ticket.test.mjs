// Phone ticket size, drag handle, Trade-tab fold arrow and the Home Screen start page (owner request 2026-11-25).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const js = read('assets/js/markets-phone-ticket.js'), css = read('assets/css/markets-phone.css'), page = read('trading.html');
const phoneJs = read('assets/js/markets-phone.js');

test('loads after the phone layout and the drawing tools', () => {
  const a = page.indexOf('/assets/js/markets-draw.js?v='), b = page.indexOf('/assets/js/markets-phone-ticket.js?v=');
  assert.ok(a > 0 && b > a);
});
test('one shared setting (min / default / full) for the Chart and Trade tabs, remembered safely', () => {
  assert.match(js, /const KEY = 'ipfx-phone-ticket';/);
  assert.match(js, /const STATES = \['min', 'default', 'full'\];/);
  assert.match(js, /try \{ const v = localStorage\.getItem\(KEY\); if \(STATES\.includes\(v\)\) state = v; \} catch \(_\) \{\}/);
  assert.match(js, /if \(save\) \{ try \{ localStorage\.setItem\(KEY, s\); \} catch \(_\) \{\} \}/);
});
test('grab bar: pointer capture, no page scroll while dragging, snaps on release, chart never under 120px', () => {
  assert.match(js, /grab\.setPointerCapture\(e\.pointerId\)/);
  assert.match(js, /const CHART_MIN = 120;/);
  assert.match(js, /const top = Math\.max\(nat\.min, room - CHART_MIN\);/);
  assert.match(css, /\.ph-grab\{[^}]*touch-action:none/);
  assert.match(css, /\.ph-grab::before\{[^}]*height:44px/);
  assert.match(css, /\.chart-area\{min-height:120px\}/);
});
test('folded ticket keeps only Sell / lots / Buy on both tabs, and the 30-second stop card stays as a compact banner', () => {
  assert.match(css, /html\[data-pticket="min"\] \.chart-wrap>\.qt \.qt-head,html\[data-pticket="min"\] \.chart-wrap>\.qt \.qt-more,html\[data-pticket="min"\] \.chart-wrap>\.qt \.qt-margin\{display:none!important\}/);
  assert.match(css, /html\[data-ptab="trade"\]\[data-pticket="min"\] #tab-order>\*:not\(\.op-trade-row\):not\(\.ph-fold\)\{display:none!important\}/);
  assert.match(css, /html\[data-pticket="min"\] \.eng-toast\.rule \.rule-pos,html\[data-pticket="min"\] \.eng-toast\.rule \.rule-txt\{display:none!important\}/);
  assert.doesNotMatch(css, /html\[data-pticket="min"\] \.eng-toast\.rule\{display:none/);
});
test('narrow screens: the tab row and lot sizes scroll sideways instead of being cut off', () => {
  assert.match(css, /\.chart-wrap>\.qt \.qt-chips,\.chart-wrap>\.qt \.qt-presets,\.op-quickbar,\.op-presets\{display:flex!important;flex-wrap:nowrap;min-width:0;overflow-x:auto/);
  assert.match(css, /scroll-snap-type:x proximity/);
});
test('layout only: never places, changes or closes an order; inert on computers', () => {
  assert.doesNotMatch(js, /placeOrder|qtPlace|engineCall|closePosition|flattenAll/);
  assert.match(js, /const phone = \(\) => root\.classList\.contains\('phone'\);/);
  assert.match(js, /if \(!phone\(\)\) return orig\.apply\(this, arguments\);/);
  assert.match(js, /html:not\(\.phone\) #phGrab,html:not\(\.phone\) #phTicketFold\{display:none!important\}/);
});

// ── Home Screen icon ──
function runSnippet(file, standalone) {
  const html = read(file);
  const m = html.match(/<script>\/\* Opened from the Home Screen icon[^<]*<\/script>/);
  assert.ok(m, file + ' has the Home Screen redirect');
  let went = null;
  const window = { matchMedia: () => ({ matches: standalone }), navigator: { standalone: false } };
  const location = { replace: (u) => { went = u; } };
  vm.runInNewContext(m[0].replace(/^<script>|<\/script>$/g, ''), { window, location });
  return went;
}
test('Home Screen icon: homepage and Download page open Markets in the installed app, unchanged in a browser tab', () => {
  for (const f of ['index.html', 'downloads.html']) {
    assert.equal(runSnippet(f, true), '/trading.html?phone=1&source=app', f);
    assert.equal(runSnippet(f, false), null, f);
  }
  const head = read('index.html').slice(0, 600);
  assert.ok(head.indexOf('Opened from the Home Screen icon') < head.indexOf('<title>'), 'runs before the homepage renders');
});
test('Download page names the app IPFX Markets and links the Markets manifest', () => {
  const d = read('downloads.html');
  assert.match(d, /<link rel="manifest" href="\/markets\.webmanifest">/);
  assert.match(d, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(d, /<meta name="apple-mobile-web-app-title" content="IPFX Markets">/);
  assert.match(d, /<link rel="apple-touch-icon" href="\/assets\/images\/app\/apple-touch-icon\.png">/);
  const m = JSON.parse(read('markets.webmanifest'));
  assert.equal(m.name, 'IPFX Markets'); assert.equal(m.display, 'standalone'); assert.equal(m.scope, '/trading.html');
  assert.match(m.start_url, /^\/trading\.html/);
});
test('installed app signed out: the sign-in sheet opens on Markets', () => {
  assert.match(phoneJs, /if \(installedApp\(\) && !window\.Capacitor\) \{/);
  assert.match(phoneJs, /!hasSession\(\) && typeof window\.openDesktopAuth === 'function'\) window\.openDesktopAuth\(\);/);
});
