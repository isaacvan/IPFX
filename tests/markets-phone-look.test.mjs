// Phone look (owner request 2026-11-19): bolder colours, volume bars, order confirmation, lighter order strip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const colors = read('assets/js/markets-colors.js'), phone = read('assets/js/markets-phone.js'), css = read('assets/css/markets-phone.css'), vol = read('assets/js/ipfx-indicators-volume.js');
test('IPFX Bold is the phone default; the computer default and saved choices are unchanged', () => {
  assert.match(colors, /const PHONE_DEFAULTS = \{ up: '#00A884', down: '#E43C48', bg: '#010102' \};/);
  assert.match(colors, /\{ name: 'IPFX Bold', up: '#00A884', down: '#E43C48' \}/);
  assert.match(colors, /const defaultsNow = \(\) => \(phoneLayout\(\) \? PHONE_DEFAULTS : DEFAULTS\);/);
  assert.match(colors, /function current\(\) \{ if \(!chosen\) colors = \{ \.\.\.defaultsNow\(\) \}; return colors; \}/);
});
test('bolder Sell and Buy on phones', () => {
  assert.match(css, /\.qt-sell,\.op-exec-sell\{background:#c82c38!important\}/);
  assert.match(css, /\.qt-buy,\.op-exec-buy\{background:#008064!important\}/);
});
test('volume is on by default on phones only for traders who never saved indicators; muted bars on phones only', () => {
  assert.match(phone, /localStorage\.getItem\('ipfx_chart_layout_' \+ \(p\.get\('login'\) \|\| p\.get\('name'\) \|\| 'guest'\)\) !== null\) return;/);
  assert.match(phone, /selectedStudies\.add\('Volume@tv-basicstudies'\)/);
  assert.match(vol, /const phone = typeof document !== "undefined" && document\.documentElement\.classList\.contains\("phone"\);/);
  assert.match(vol, /c\.up \+ "4D"/);
});
test('orders ask for confirmation until one-click trading is on; Submit presses the same button again', () => {
  assert.match(phone, /e\.target\.closest\('#qtSell,#qtBuy,\.op-exec-btn'\)/);
  assert.match(phone, /if \(!btn \|\| confirmPass \|\| !MQ\.matches \|\| oneClick\(\) \|\| btn\.disabled\) return;/);
  assert.match(phone, /confirmPass = true; try \{ target\.click\(\); \} finally \{ confirmPass = false; \}/);
  assert.match(phone, /id="phOneClickToggle" role="switch"/);
  assert.doesNotMatch(phone.slice(phone.indexOf('Order type switch'), phone.indexOf('function apply()')), /placeOrder\(|qtPlace\(|engineCall/, 'the sheet never places an order itself');
});
test('MARKET / PENDING switch presses the ticket\'s own buttons; Pending opens the Trade tab', () => {
  assert.match(phone, /if \(isPending\(\)\) \{ const m = typeButton\('market'\); if \(m\) m\.click\(\); \}/);
  assert.match(phone, /else \{ const pb = typeButton\('pending'\); if \(pb\) pb\.click\(\); setTab\('trade', true\); \}/);
});
