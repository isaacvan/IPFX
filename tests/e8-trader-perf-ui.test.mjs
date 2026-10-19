import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const js = read('assets/js/ws-books-traders.js'), css = read('assets/css/ws-books-traders.css');
const U = '22222222-2222-4222-8222-222222222222';
const require = createRequire(import.meta.url);
const bundled = path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const playwright = process.env.E8_PLAYWRIGHT || (fs.existsSync(bundled) ? bundled : null);
const browserEnabled = Boolean(process.env.E8_BROWSER_TEST && playwright);

test('individual research transport is restricted to the three owner cache reads', () => {
  assert.deepEqual([...new Set([...js.matchAll(/T\.brain\('([^']+)'/g)].map(m => m[1]))].sort(), ['e8_trader_detail', 'e8_trader_performance', 'e8_trader_portfolio']);
  assert.doesNotMatch(js, /T\.(?:ladder|admin|book|e8)\(|localStorage|sessionStorage|api\.e8|tradelocker/i);
  assert.match(js, /setInterval\(poll,90000\)/);
  assert.match(js, /cache: 'no-store'/);
  assert.match(js, /document\.visibilityState !== 'hidden'/);
  assert.match(js, /selected\.size >= 50/);
  assert.match(css, /\.et-drawer/);
  assert.match(css, /var\(--group\)/);
  assert.match(js, /95% interval unavailable/);
  assert.match(js, /Sequential evidence/);
});

// Reuse the pricing suite's synthetic database setup, then call the actual SQL refresh,
// read, detail and portfolio functions. No independent mock invents the API's shape.
async function sqlFixture() {
  const fixtureURL = new URL('./e8-trader-perf-db.test.mjs', import.meta.url);
  const source = fs.readFileSync(fixtureURL, 'utf8');
  const setup = source.slice(source.indexOf('const U ='), source.indexOf('\nasync function rpc('));
  assert.ok(setup.includes('async function fixture('), 'shared synthetic SQL setup exists');
  const factory = new Function('fs','pathToFileURL','process','controlSQL','cacheSQL','migration','fixtureURL',setup.replaceAll('import.meta.url','fixtureURL') + '\nreturn fixture;');
  const db = await factory(fs,pathToFileURL,process,read('supabase/migrations/20261018190000_e8_copy_backtest.sql'),read('supabase/migrations/20261018200000_e8_copy_backtest_cache.sql'),read('supabase/migrations/20261019100000_e8_trader_performance.sql'),fixtureURL.href)();
  const refreshed = (await db.query('select public.ab_e8_trader_perf_refresh_private() r')).rows[0].r;
  assert.equal(refreshed.ok,true,JSON.stringify(refreshed));
  return db;
}
async function harness({ db = null, responder = null } = {}) {
  const { chromium } = require(playwright);
  const browser = await chromium.launch({headless:true,executablePath:process.env.E8_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--disable-background-networking']});
  const context = await browser.newContext({viewport:{width:1440,height:1050}}), page = await context.newPage();
  const calls = [], errors = [], unexpected = []; let newer = false;
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'owner.example.invalid') {unexpected.push(url.href);return route.abort();}
    if (url.pathname === '/workspace/books.html') return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Owner UI fixture</title></head><body><main style="padding:30px;max-width:1220px;margin:auto"><div id="e8traders"></div></main><script src="/assets/js/ws-books-traders.js?v=${newer?'new':'20261019a'}"></script></body></html>`});
    if (url.pathname.endsWith('ws-books-traders.js')) return route.fulfill({contentType:'application/javascript; charset=utf-8',body:js});
    unexpected.push(url.href); return route.abort();
  });
  await page.exposeFunction('ownerRead', async (action, body) => {
    calls.push({action,body});
    if (responder) return responder(action,body,calls);
    let sql, args, key;
    if (action === 'e8_trader_performance') {sql='select public.ab_e8_trader_perf_read($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r';args=[body.latency,body.slippage,body.page,body.limit,body.query,body.class_filter,body.symbol,body.min_trades,body.sort,body.direction==='desc'];key='performance';}
    else if(action==='e8_trader_detail'){sql='select public.ab_e8_trader_perf_detail($1,$2,$3) r';args=[body.trader_id,body.latency,body.slippage];key='detail';}
    else if(action==='e8_trader_portfolio'){sql='select public.ab_e8_trader_perf_portfolio($1,$2,$3,$4) r';args=[body.trader_ids,body.book,body.latency,body.slippage];key='portfolio';}
    else throw new Error('Unexpected owner action: '+action);
    return {ok:true,[key]:(await db.query(sql,args)).rows[0].r};
  });
  await page.addInitScript(() => {
    window.__polls=[]; window.setInterval=(callback,ms)=>{window.__polls.push({callback,ms});return window.__polls.length;};
    window.TeamOS={brain:(action,body)=>window.ownerRead(action,body),esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),ukTime:v=>new Date(v).toISOString()};
  });
  await page.goto('https://owner.example.invalid/workspace/books.html');
  await page.addStyleTag({content:read('assets/css/team-os.css')}); await page.addStyleTag({content:css});
  return {page,context,browser,calls,errors,unexpected,setNewer:()=>{newer=true;}};
}
test('desktop UI consumes real generated SQL payloads, filters, scenarios, trader evidence and selected-set cache reads', {skip:!browserEnabled || !process.env.DEMO_TEST_DEPS,timeout:180000}, async () => {
  const db=await sqlFixture(); let h;
  try {
    h=await harness({db});const {page,calls}=h;
    await page.getByRole('button',{name:'one@example.invalid',exact:true}).waitFor();
    assert.match(await page.locator('[data-slot=summary]').innerText(),/4/);
    assert.match(await page.locator('[data-slot=rows]').innerText(),/12\.24/);
    assert.match(await page.locator('[data-slot=rows]').innerText(),/17\.76/);
    assert.match(await page.locator('[data-slot=summary]').innerText(),/5\.0%/);
    if(process.env.E8_TRADER_SCREENSHOT) await page.screenshot({path:process.env.E8_TRADER_SCREENSHOT,fullPage:true});
    await page.getByRole('button',{name:'one@example.invalid',exact:true}).click();
    await page.locator('[data-slot=detail] .et-detail-grid').waitFor();
    const detailText=await page.locator('[data-slot=detail]').innerText();
    for(const label of ['Daily P&L','P&L decomposition','Entry markouts','Hold-time distribution','sample gap','Saved execution sensitivity']) assert.ok(detailText.toLowerCase().includes(label.toLowerCase()),label);
    assert.ok(await page.locator('[data-slot=detail] svg path').count()>0,'actual saved curves rendered');
    assert.match(detailText,/XAUUSD/);
    assert.doesNotMatch(detailText,/NaN|undefined|\[object Object\]/);
    if(process.env.E8_TRADER_SCREENSHOT) await page.screenshot({path:process.env.E8_TRADER_SCREENSHOT.replace(/\.png$/,'-drawer.png'),fullPage:true});
    await page.keyboard.press('Escape');
    await page.getByLabel('Include one@example.invalid in portfolio',{exact:true}).check();
    await page.getByRole('button',{name:'Read saved portfolio',exact:true}).click();
    await page.locator('[data-slot=portfolio] .et-mini-stats').waitFor();
    assert.deepEqual(calls.find(c=>c.action==='e8_trader_portfolio').body.trader_ids,[U]);
    const search=page.getByLabel('Search traders',{exact:true}); await search.fill('one@');
    await page.waitForFunction(()=>document.querySelector('[data-slot=count]').textContent.includes('of 1 matching'));
    assert.equal(await search.evaluate(e=>document.activeElement===e),true);
    await page.getByRole('group',{name:'Entry latency',exact:true}).getByRole('button',{name:'15s',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-slot=freshness]').textContent.includes('15s entry')&&!document.querySelector('[data-slot=freshness]').textContent.includes('Reading'));
    assert.ok(calls.some(c=>c.action==='e8_trader_performance'&&c.body.latency===15&&c.body.query==='one@'));
    await page.getByRole('group',{name:'Slippage per side',exact:true}).getByRole('button',{name:'2 ticks',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-slot=freshness]').textContent.includes('2 adverse ticks')&&!document.querySelector('[data-slot=freshness]').textContent.includes('Reading'));
    const latest=calls.findLast(c=>c.action==='e8_trader_performance'&&c.body.latency===15&&c.body.slippage===2&&c.body.query==='one@').body;assert.equal(latest.slippage,2);assert.equal(latest.query,'one@');assert.equal(latest.limit,100);
    await search.fill(''); await page.getByLabel('Evidence class',{exact:true}).selectOption('INSUFFICIENT_DATA');
    await page.getByLabel('Symbol filter',{exact:true}).fill('XAUUSD'); await page.getByLabel('Minimum trades',{exact:true}).fill('1');
    await page.waitForFunction(()=>document.querySelector('[data-slot=count]').textContent.includes('of 2 matching'));
    await page.getByRole('button',{name:'B net / 95% interval',exact:false}).click();
    await page.waitForFunction(()=>document.querySelector('[data-sort-head=b_net]').getAttribute('aria-sort')==='descending'&&!document.querySelector('[data-slot=freshness]').textContent.includes('Reading'));
    const filtered=calls.findLast(c=>c.action==='e8_trader_performance'&&c.body.sort==='b_net').body;assert.equal(filtered.class_filter,'INSUFFICIENT_DATA');assert.equal(filtered.symbol,'XAUUSD');assert.equal(filtered.min_trades,1);
    await page.getByRole('button',{name:'B net / 95% interval',exact:false}).click();
    await page.waitForFunction(()=>document.querySelector('[data-sort-head=b_net]').getAttribute('aria-sort')==='ascending'&&!document.querySelector('[data-slot=freshness]').textContent.includes('Reading'));
    assert.equal(await page.locator('[data-slot=rows] tr').first().getAttribute('data-id'),'55555555-5555-4555-8555-555555555555');
    for(const width of[1280,1920]){await page.setViewportSize({width,height:1050});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
    assert.deepEqual(h.errors,[]);assert.deepEqual(h.unexpected,[]);
  } finally {await h?.browser.close();await db.close();}
});

test('polling preserves focused inputs, drawer, table scroll, selected IDs, sort and filters; hidden tabs stay quiet and changed assets prompt reload', {skip:!browserEnabled,timeout:60000}, async () => {
  let stamp=new Date().toISOString();
  const rows=Array.from({length:25},(_,i)=>({trader_id:i===0?U:`55555555-5555-4555-8555-${String(i).padStart(12,'0')}`,trader:`fixture-${i}@example.invalid`,trades:210,active_days:12,symbols:[{symbol:'XAUUSD',share:1}],a_net:100+i,b_net:-150-i,a_interval:[-40,200],b_interval:[-200,-30],evidence_class:'INSUFFICIENT_DATA',reasons:['ANYTIME_BOUND_NOT_ESTABLISHED'],tier:'reportable',flags:['POLICY_UNKNOWN'],sample_gap:null}));
  const h=await harness({responder:(action,body)=>action==='e8_trader_performance'?{ok:true,performance:{available:true,computed_at:stamp,total:25,summary:{total:25,enough_data:0,copy_candidates:0,reverse_candidates:0,fdr_target:.05,class_counts:{INSUFFICIENT_DATA:25}},traders:rows}}:action==='e8_trader_detail'?{ok:true,detail:{available:true,trader:'fixture-0@example.invalid',summary:rows[0],daily:[{day:'2026-10-19',trades:2,a_net:4,b_net:-6}]}}:{ok:true,portfolio:{available:false,reason:'SELECTED_SET_NOT_SAVED'}}});
  try {
    const {page,calls}=h; await page.getByRole('button',{name:'fixture-0@example.invalid',exact:true}).waitFor();
    await page.getByLabel('Include fixture-0@example.invalid in portfolio',{exact:true}).check();
    await page.getByRole('button',{name:'fixture-0@example.invalid',exact:true}).click();await page.locator('[data-slot=detail] .et-detail-grid').waitFor();
    await page.evaluate(()=>{document.querySelector('.et-drawer-scroll').scrollTop=225;document.querySelector('.et-main-scroll').scrollLeft=320;document.querySelector('.et-main-scroll').scrollTop=100;});
    // A poll must not recreate the query control or close the drawer.
    await page.evaluate(()=>{const q=document.querySelector('[data-et=query]');window.__query=q;q.value='fixture';q.focus();q.setSelectionRange(2,5);window.__polls[0].callback();});
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(()=>window.__query===document.querySelector('[data-et=query]')&&document.activeElement===window.__query&&window.__query.selectionStart===2&&window.__query.selectionEnd===5),true);
    assert.equal(await page.locator('.et-backdrop').isVisible(),true);
    assert.equal(await page.locator('.et-drawer-scroll').evaluate(e=>e.scrollTop),225);
    assert.equal(await page.locator('.et-main-scroll').evaluate(e=>e.scrollLeft),320);
    assert.equal(await page.locator('[data-et=select]').first().isChecked(),true);
    await page.keyboard.press('Escape');
    const before=calls.length; await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});window.__polls[0].callback();});await page.waitForTimeout(100);assert.equal(calls.length,before);
    h.setNewer();stamp=new Date(Date.now()-31*60000).toISOString();await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
    await page.getByText('A newer version of this page is available.',{exact:false}).waitFor();assert.match(await page.locator('[data-slot=alert]').innerText(),/Stale/);
    assert.equal(await page.getByRole('button',{name:'Reload page',exact:true}).isVisible(),true);
    assert.deepEqual(h.errors,[]);
  } finally {await h.browser.close();}
});

test('nulls, exact reasons, hostile owner data, unavailable portfolios and cache failures remain understandable', {skip:!browserEnabled,timeout:60000}, async () => {
  let fail=false;
  const h=await harness({responder:action=>{if(fail&&action==='e8_trader_performance')throw new Error('CACHE_READ_FAILED');return action==='e8_trader_performance'?{ok:true,performance:{available:true,computed_at:null,total:1,summary:null,traders:[{trader_id:U,trader:'<img src=x onerror=alert(1)>@example.invalid',trades:null,a_net:null,b_net:null,reasons:['EXACT_MISSING_E8_QUOTE'],flags:[],evidence_class:'INSUFFICIENT_DATA'}]}}:action==='e8_trader_detail'?{ok:true,detail:{available:false,reason:'DETAIL_QUOTE_MISSING'}}:{ok:true,portfolio:{available:false,reason:'SELECTED_SET_NOT_SAVED'}};}});
  try {
    const {page}=h; await page.getByText('EXACT_MISSING_E8_QUOTE',{exact:true}).waitFor();assert.equal(await page.locator('#e8traders img').count(),0);
    assert.match(await page.locator('[data-slot=rows]').innerText(),/95% interval unavailable/);
    assert.doesNotMatch(await page.locator('#e8traders').innerText(),/NaN|undefined|\[object Object\]/);
    await page.locator('[data-et=select]').check();await page.getByRole('button',{name:'Read saved portfolio',exact:true}).click();await page.getByText('SELECTED_SET_NOT_SAVED',{exact:true}).waitFor();
    await page.locator('[data-et=detail]').click();await page.getByText('DETAIL_QUOTE_MISSING',{exact:true}).waitFor();await page.keyboard.press('Escape');
    fail=true;await page.getByRole('button',{name:'Refresh analysis',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-slot=alert]').textContent.includes('CACHE_READ_FAILED'));
    assert.equal(await page.locator('[data-slot=rows] tr').count(),1,'last good data retained on a failed poll');assert.deepEqual(h.errors,[]);
  } finally {await h.browser.close();}
});
