// Chart colours on the phone and the computer version (16 Nov 2026). Colours only: nothing here touches orders,
// prices or accounts. The browser part runs with MARKETS_BROWSER_TEST=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = new URL('../', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8');
const html = read('trading.html'), js = read('assets/js/markets-colors.js'), css = read('assets/css/markets-colors.css'), chart = read('assets/js/ipfx-chart.js');

test('defaults, presets and the way back to the old look', () => {
  assert.match(js, /const DEFAULTS = \{ up: '#4FAF91', down: '#D9545B', bg: '#010102' \};/);
  for (const n of ['IPFX Neon', 'Bright neon', 'Classic', 'Blue / Orange', 'White / Grey']) assert.ok(js.includes(`name: '${n}'`), n);
  assert.match(js, /\{ name: 'Classic', up: '#10B981', down: '#EF4444' \}/, 'Classic is the colour of the old candles');
  assert.match(js, /\{ name: 'Dark', c: '#0a0a0c' \}/, 'Dark is the old chart background');
  assert.match(chart, /let UP = "#10b981", DOWN = "#ef4444";/, 'the chart script keeps its own defaults');
});

test('colours are remembered, validated, and only the chart is recoloured on a computer', () => {
  assert.match(js, /localStorage\.setItem\(KEY, JSON\.stringify\(colors\)\)/);
  assert.match(js, /localStorage\.getItem\(KEY\) \|\| localStorage\.getItem\(OLD_KEY\)/, 'phone choices made before the shared panel carry over');
  assert.match(js, /const chrome = phoneLayout\(\) && !light;/);
  assert.match(js, /if \(chrome\) document\.documentElement\.style\.setProperty\('--bg', colors\.bg\); else document\.documentElement\.style\.removeProperty\('--bg'\);/);
  assert.doesNotMatch(js, /placeOrder|engineCall|fetch\(|closeTrade|XMLHttpRequest/, 'colours never touch orders, prices or accounts');
});

test('the page loads the panel for everyone, with a computer button in the top bar', () => {
  assert.match(html, /<link rel="stylesheet" href="\/assets\/css\/markets-colors\.css\?v=\d+[a-z]?">/);
  assert.match(html, /<script src="\/assets\/js\/markets-colors\.js\?v=\d+[a-z]?"><\/script>/);
  assert.match(js, /b\.id = 'chartColorsBtn'/);
  assert.match(js, /tools\.insertBefore\(b, tools\.firstChild\)/);
  assert.match(css, /@media \(min-width:761px\)\{\s*\.ic-sheet\{inset:auto;top:112px;right:16px/, 'floats beside the chart on a computer');
});

const enabled = Boolean(process.env.MARKETS_BROWSER_TEST);
const dependency = process.env.E8_PLAYWRIGHT || path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

test('on a computer: neon candles on a near-black chart by default, the button opens the panel, a choice sticks, Reset restores', { skip: !enabled }, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = require(dependency);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.E8_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('ipfx-markets-tour-v1', '1'); localStorage.setItem('ipfx_cookie_consent_v1', JSON.stringify({ essential: true, analytics: false, version: 1 })); } catch (_) {} });
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.hostname !== 'markets-colors.invalid') return route.abort();
      const file = new URL('.' + decodeURIComponent(u.pathname), root);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file.pathname)] || 'application/octet-stream' });
    });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('https://markets-colors.invalid/trading.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 30000 });
    // The real chart needs a price library from a CDN, which the test blocks; give the colour module a stand-in chart.
    await page.evaluate(() => {
      const calls = []; let bg = '#0a0a0c';
      window.__fake = { calls, get bg() { return bg; } };
      ipfxChart = { setColors: (u, d) => calls.push([u, d]), chart: { options: () => ({ layout: { background: { color: bg } } }), applyOptions: (o) => { bg = o.layout.background.color; } } };
    });
    await page.waitForFunction(() => window.__fake.calls.length > 0, null, { timeout: 5000 });
    assert.deepEqual(await page.evaluate(() => [window.__fake.calls.at(-1), window.__fake.bg]), [['#4FAF91', '#D9545B'], '#010102']);
    assert.equal(await page.locator('#chartColorsBtn').count(), 1);
    assert.equal(await page.locator('#icColors').isHidden(), true);
    await page.click('#chartColorsBtn');
    assert.equal(await page.locator('#icColors').isVisible(), true);
    await page.click('#icPresets button[data-i="2"]');          // Classic
    await page.click('#icBgs button[data-i="1"]');              // Dark
    await page.waitForTimeout(700);
    assert.deepEqual(await page.evaluate(() => [window.__fake.calls.at(-1), window.__fake.bg]), [['#10B981', '#EF4444'], '#0a0a0c'], 'the old look is one tap away');
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('ipfx-chart-colors'))), { up: '#10B981', down: '#EF4444', bg: '#0a0a0c' });
    await page.click('#icReset');
    await page.waitForTimeout(700);
    assert.deepEqual(await page.evaluate(() => [window.__fake.calls.at(-1), window.__fake.bg]), [['#4FAF91', '#D9545B'], '#010102']);
    await page.mouse.click(300, 400);                           // a click elsewhere closes the floating panel
    assert.equal(await page.locator('#icColors').isHidden(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
