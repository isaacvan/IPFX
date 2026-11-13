// IPFX Markets on phones (13 Nov 2026).
// The phone layout must never change the desktop layout, must never place an order by itself, and the install helper
// (service worker) must never cache prices, account data or API calls. The browser part runs with MARKETS_BROWSER_TEST=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = new URL('../', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8');
const html = read('trading.html');
const css = read('assets/css/markets-phone.css');
const js = read('assets/js/markets-phone.js');
const sw = read('markets-sw.js');

test('the phone stylesheet only loads on phone-sized screens', () => {
  const links = html.match(/<link[^>]*markets-phone\.css[^>]*>/g) || [];
  assert.equal(links.length, 1);
  assert.match(links[0], /media="not all" data-phone-media="\(max-width: 760px\), \(pointer: coarse\) and \(max-height: 520px\)"/, 'off until markets-phone.js switches it on');
  assert.match(html, /<script src="\/assets\/js\/markets-phone\.js\?v=\d+[a-z]?"><\/script>/);
  assert.match(html, /viewport-fit=cover/);
  for (const page of fs.readdirSync(new URL('./', root)).filter((f) => f.endsWith('.html') && f !== 'trading.html')) {
    assert.doesNotMatch(read(page), /markets-phone\.css/, `${page} must not load the Markets phone layout`);
  }
});

test('phone elements are hidden on wider screens even without the phone stylesheet', () => {
  assert.match(js, /html:not\(\.phone\) \.ph-only\{display:none!important\}/);
  for (const cls of ['ph-tabbar', 'ph-ind', 'ph-bal', 'ph-sym', 'ph-acct', 'ph-acct-more', 'ph-install', 'ph-install-guide', 'ph-auth-close', 'ph-auth-links', 'ph-sym-close']) {
    assert.match(js, new RegExp(`className = '${cls}( [a-z-]+)* ?ph-only'|className = '${cls} ph-only'`), `${cls} is phone-only`);
  }
  assert.match(js, /window\.matchMedia\('\(max-width: 760px\), \(pointer: coarse\) and \(max-height: 520px\)'\)/);
});

test('the phone layer never places, closes or changes a trade itself', () => {
  assert.doesNotMatch(js, /placeOrder|engineCall|closeTradeById|flattenAll|fetch\(/);
  // The bar under the chart is the desktop quick ticket (its own placeOrder path), shown only on the Chart tab;
  // "open the full ticket" goes to the Trade tab.
  assert.match(js, /window\.qtShouldShow = \(\) => \(MQ\.matches \? current === 'chart' : origShow\(\)\)/);
  assert.match(js, /window\.qtOpenFull = \(\) => \(MQ\.matches \? setTab\('trade', true\) : origFull\(\)\)/);
});

test('every tab is one of the existing desktop panels, restyled', () => {
  assert.match(css, /html\[data-ptab="chart"\] \.guide,html\[data-ptab="chart"\] \.btm-outer\{display:none!important\}/);
  assert.match(css, /html\[data-ptab="trade"\] \.guide\{display:flex!important/);
  assert.match(css, /html\[data-ptab="positions"\] \.btm-outer,html\[data-ptab="account"\] \.btm-outer\{display:flex!important/);
  assert.match(css, /input,select,textarea\{font-size:16px!important\}/, 'no zoom-in when a field is tapped on iPhone');
  assert.match(css, /env\(safe-area-inset-bottom/);
  // the open-positions table becomes cards with labelled buttons
  assert.match(css, /#posTableBody \.postbl-act-btn\.act-edit::after\{content:"Edit stop"\}/);
  assert.match(css, /#bp-positions \.postbl thead\{display:none\}/);
});

test('the install helper is limited to Markets and never stores trading data', () => {
  assert.match(js, /navigator\.serviceWorker\.register\('\/markets-sw\.js', \{ scope: '\/trading\.html' \}\)/);
  assert.match(sw, /if \(req\.method !== 'GET' \|\| req\.mode !== 'navigate'\) return;/);
  assert.match(sw, /fetch\(req\)\.catch\(\(\) => caches\.match\(OFFLINE\)\)/, 'network first; the cached page is only the offline notice');
  assert.match(sw, /addAll\(\[OFFLINE, '\/assets\/images\/app\/icon-192\.png'\]\)/);
  assert.doesNotMatch(sw, /cache\.put|caches\.open\([^)]*\)\.then\([^)]*put/);
  assert.ok(fs.existsSync(new URL('markets-offline.html', root)));
});

test('app manifest and icons for iPhone and Android', () => {
  const m = JSON.parse(read('markets.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.match(m.start_url, /^\/trading\.html/);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
  for (const i of m.icons) assert.ok(fs.existsSync(new URL('.' + i.src, root)), i.src);
  assert.match(html, /<link rel="manifest" href="\/site\.webmanifest" id="appManifest">/, 'the Markets app manifest is only swapped in for accounts with the phone version');
  assert.match(html, /<link rel="apple-touch-icon" href="\/assets\/images\/app\/apple-touch-icon\.png">/);
  assert.ok(fs.existsSync(new URL('assets/images/app/apple-touch-icon.png', root)));
});

test('early access: on ipfxcapital.com only the listed accounts get the phone version', () => {
  assert.match(js, /const RELEASED_TO_EVERYONE = false;/);
  assert.match(js, /const EARLY_ACCESS_ACCOUNTS = \['f77286ef-8b51-47f3-b6b7-a62f541a4239'\]; \/\/ paulade491/);
  assert.match(js, /if \(!\/\(\^\|\\.\)ipfxcapital\\.com\$\/i\.test\(location\.hostname\)\) return true;/);
  assert.match(js, /if \(EARLY_ACCESS_ACCOUNTS\.includes\(signedInAccountId\(\)\)\) \{ remember\(true\); return true; \}/);
  assert.match(js, /if \(flag === '1'\) remember\(true\); else if \(flag === '0'\) remember\(false\);/, 'trading.html?phone=1 switches it on for this browser');
  // nothing phone-related runs (no layout, no install offer, no service worker) until it is switched on
  const gate = js.indexOf('if (phoneVersionOn()) start();'), body = js.indexOf('function runPhone() {');
  assert.ok(gate > 0 && body > gate);
  assert.ok(js.indexOf('serviceWorker.register') > body && js.indexOf("'beforeinstallprompt'") > body);
});

const enabled = Boolean(process.env.MARKETS_BROWSER_TEST);
const dependency = process.env.E8_PLAYWRIGHT || path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

async function open(width, height, mobile) {
  const require = createRequire(import.meta.url);
  const { chromium } = require(dependency);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.E8_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript(() => { try { localStorage.setItem('ipfx-markets-tour-v1', '1'); localStorage.setItem('ipfx_cookie_consent_v1', JSON.stringify({ essential: true, analytics: false, version: 1 })); } catch (_) {} });
  // Serve this repository's files; every other request (prices, accounts, CDNs) is blocked.
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'markets-phone.invalid') return route.abort();
    const file = new URL('.' + decodeURIComponent(u.pathname), root);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file.pathname)] || 'application/octet-stream' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('https://markets-phone.invalid/trading.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 30000 });
  await page.waitForTimeout(500);
  return { browser, page, errors };
}

test('on a phone: four tabs, one panel at a time, nothing off the side of the screen', { skip: !enabled }, async () => {
  for (const [w, h] of [[390, 844], [360, 780], [320, 640], [430, 932]]) {
    const { browser, page } = await open(w, h, true);
    try {
      const tabs = await page.locator('#phTabbar button > span').allTextContents();
      assert.deepEqual(tabs.map((t) => t.trim()), ['Chart', 'Trade', 'Positions', 'Account']);
      for (const tab of ['chart', 'trade', 'positions', 'account']) {
        await page.click(`#phTab-${tab}`);
        await page.waitForTimeout(150);
        const s = await page.evaluate(() => {
          const shown = (sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; };
          const bar = document.getElementById('phTabbar').getBoundingClientRect();
          return { tab: document.documentElement.dataset.ptab, scrollW: document.documentElement.scrollWidth, w: innerWidth,
            chart: shown('.chart-wrap'), guide: shown('#guidePanel'), btm: shown('#btmOuter'), strip: shown('#quickTicket'),
            barBottom: Math.round(bar.bottom), h: innerHeight };
        });
        assert.equal(s.tab, tab);
        assert.equal(s.scrollW, s.w, `${w}px ${tab}: no sideways scrolling`);
        assert.equal(s.barBottom, s.h, 'tab bar sits on the bottom edge');
        if (tab === 'chart') assert.deepEqual([s.chart, s.guide, s.btm, s.strip], [true, false, false, true]);
        if (tab === 'trade') assert.deepEqual([s.chart, s.guide, s.btm], [true, true, false]);
        if (tab === 'positions' || tab === 'account') assert.deepEqual([s.chart, s.guide, s.btm], [false, false, true]);
      }
      // The quick-trade bar sits under the chart (not over it); its full-ticket link opens the Trade tab.
      await page.click('#phTab-chart');
      const dock = await page.evaluate(() => {
        const qt = document.getElementById('quickTicket').getBoundingClientRect(), area = document.querySelector('.chart-area').getBoundingClientRect();
        return { below: qt.top >= area.bottom - 1, full: Math.round(qt.width) === innerWidth, sizes: [...document.querySelectorAll('#quickTicket .qt-sell, #quickTicket .qt-buy, #quickTicket .qt-lots')].map((b) => Math.round(b.getBoundingClientRect().height)) };
      });
      assert.deepEqual([dock.below, dock.full], [true, true]);
      for (const hgt of dock.sizes) assert.ok(hgt >= 44, `quick bar ${hgt}px`);
      await page.click('#qtExp');
      await page.click('#quickTicket .qt-full');
      assert.equal(await page.evaluate(() => document.documentElement.dataset.ptab), 'trade');
      const sizes = await page.evaluate(() => [...document.querySelectorAll('.op-exec-btn, #phTabbar button')].map((b) => Math.round(b.getBoundingClientRect().height)));
      for (const hgt of sizes) assert.ok(hgt >= 44, `tap target ${hgt}px`);
    } finally { await browser.close(); }
  }
});

test('on a desktop the phone layer is invisible', { skip: !enabled }, async () => {
  const { browser, page } = await open(1440, 900, false);
  try {
    const s = await page.evaluate(() => ({
      phone: document.documentElement.classList.contains('phone'), tab: document.documentElement.dataset.ptab || null,
      visible: [...document.querySelectorAll('.ph-only')].filter((e) => e.getBoundingClientRect().width > 0).length,
      guide: document.getElementById('guidePanel').getBoundingClientRect().width > 0,
    }));
    assert.deepEqual(s, { phone: false, tab: null, visible: 0, guide: true });
  } finally { await browser.close(); }
});

test('phone chart shows Bid and Ask lines (TradeLocker style), never on desktop', () => {
  assert.match(js, /function syncBidAsk\(\)/);
  assert.match(js, /const ok = MQ\.matches && series && series\.createPriceLine && q && Number\(q\.bid\) > 0 && Number\(q\.ask\) > 0;/);
  assert.match(js, /if \(!ok\) \{ if \(baLines\) \{ for \(const l of Object\.values\(baLines\)\) \{ try \{ baSeries\.removePriceLine\(l\); \} catch \(_\) \{\} \} baLines = null; \} return; \}/);
});
