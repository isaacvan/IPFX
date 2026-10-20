// Product UI test in a separate, disposable Chromium process. Real Markets
// HTML/CSS and order/tour code; every network request is synthetic or blocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=new URL('../',import.meta.url);
const read=f=>fs.readFileSync(new URL(f,root),'utf8'),html=read('trading.html');
const slice=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const enabled=Boolean(process.env.MARKETS_BROWSER_TEST);
const dependency=process.env.E8_PLAYWRIGHT||path.join(process.env.USERPROFILE||'','.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
async function fixture(){
 const {chromium}=require(dependency);
 const browser=await chromium.launch({headless:true,executablePath:process.env.E8_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],requests=[];
  page.setDefaultTimeout(10000);
  page.on('pageerror',e=>errors.push(e.message));
  const document=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'');
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());
   if(u.hostname==='markets-fixture.invalid')return route.fulfill({contentType:'text/html; charset=utf-8',body:document});
   return route.abort();
  });
  await page.goto('https://markets-fixture.invalid/trading.html');
  await page.exposeFunction('syntheticEngine',async body=>{requests.push(body);return{ok:true,account:{id:'synthetic-demo',is_demo:false,status:'active',challenge_type:'infinity',limits:{require_stop_loss:true,max_risk_per_trade_usd:5}},open_trades:body.action==='open'?[{id:'synthetic-trade',side:body.side,symbol:body.symbol,opened_at:'2026-10-20T00:00Z',open_price:body.side==='buy'?1.1227:1.1226}]:[]};});
  await page.addScriptTag({content:`
   var activeSym='EURUSD',ordLots=.01,orderType='market',slOn=false,tpOn=false,engineBusy=false,domDigits=5,ordMidPrice=1.12265,FUT_SPECS={};
   var selectedAccountMode='challenge',accountModeIntent='challenge',lastStateAt=0;
   var engineState={account:{id:'synthetic-demo',is_demo:false,status:'active',challenge_type:'infinity',limits:{require_stop_loss:true,max_risk_per_trade_usd:5}},open_trades:[]};
   var liveQuotesBySymbol=new Map([['EURUSD',{bid:1.1226,ask:1.1227,digits:5}]]),WL_DATA={forex:[{sym:'EURUSD'}]},ENGINE_URL='https://synthetic-engine.invalid';
   var execSymbol=s=>s,symMeta=()=>({quoteCurrency:'USD'}),contractSizeFor=()=>100000,clientUsdPerQuote=()=>1,futSym=()=>null;
   var blockInfinityTradeAttempt=()=>false,stageRulesBlockEntry=()=>false,dailyCapMessage=()=>null,feedFresh=()=>true,freshToken=async()=>'synthetic';
   var updatePnlPreview=()=>{},updateRiskPreview=()=>{},updateSltpReadouts=()=>{},renderPositions=()=>{},renderEngineAccount=()=>{},announceAutoClosedTrades=()=>{},showVenueBanner=()=>{};
   var fmtPx=p=>String(p),messages=[];function engineMsg(m){messages.push(m);}
   window.fetch=async(_url,init)=>({ok:true,status:200,json:()=>window.syntheticEngine(JSON.parse(init.body))});
   document.body.classList.add('signed-in');localStorage.setItem('ipfx-markets-tour-v1','1');
   ${slice('async function engineCall(body){','// Non-trading engine calls')}
   ${slice('function setLots(n,btn){','// Typed lot size')}
   ${slice('function lotsInputTyping(el){','// ---- order type (market / limit / stop)')}
   ${slice('function pxDigits(symbol){','// USD value of one unit')}
   ${slice('async function placeOrder(side){','async function cancelPending(')}
   ${slice('function toggleSLTP(type){','// ── SL/TP quick-adjust')}
   ${slice('function adjSltp(type,dir){','function updateSltpReadouts(')}
   ${slice('function payoutMinHold(){','async function closeTradeById(')}
   ${slice('let omTradeId=null','// Break-even:')}
  `});
  await page.addScriptTag({content:read('assets/js/markets-guided.js')});
  await page.locator('#gtCard:not([hidden])').waitFor();
  return{page,browser,errors,requests};
 }catch(error){await browser.close();throw error;}
}
test('real desktop Markets ticket retains smaller lots, attaches a stop, and blocks stale-price clicks',{skip:!enabled,timeout:60000},async()=>{
 const f=await fixture();try{
  await f.page.locator('#ord-lots').fill('0.01');await f.page.locator('#ord-lots').blur();
  await f.page.locator('#tab-order .op-exec-buy').click();
  await f.page.waitForFunction(()=>messages.some(m=>m.includes('filled')));
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].volume,.01);assert.ok(f.requests[0].sl<1.1227);
  await f.page.locator('#gtExact').click();
  const oldStop=Number(await f.page.locator('#slPrice').inputValue());
  await f.page.locator('.op-sltp-grp').first().getByRole('button',{name:'+',exact:true}).click();
  assert.equal(Number(await f.page.locator('#slPrice').inputValue()),Number((oldStop+.00001).toFixed(5)));
  await f.page.evaluate(()=>{feedFresh=()=>false;});
  await f.page.locator('#tab-order .op-exec-buy').click();
  assert.equal(f.requests.length,1);assert.match(await f.page.evaluate(()=>messages.at(-1)),/reconnecting|stale/i);
  for(const width of[1280,1440,1920]){await f.page.setViewportSize({width,height:1000});assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  assert.deepEqual(f.errors,[]);
 }finally{await f.browser.close();}
});
test('real Markets tour closes instantly with each dismissal route and stays dismissed on automatic checks',{skip:!enabled,timeout:60000},async()=>{
 const f=await fixture();try{
  for(const method of['close','Escape','Skip','outside']){
   await f.page.locator('#gtHelp').click();await f.page.getByRole('dialog',{name:'Pick a market',exact:true}).waitFor();
   if(method==='close')await f.page.getByRole('button',{name:'Close tour',exact:true}).click();
   if(method==='Escape')await f.page.keyboard.press('Escape');
   if(method==='Skip')await f.page.getByRole('button',{name:'Skip',exact:true}).click();
   if(method==='outside')await f.page.locator('.gt-tour-scrim').click({position:{x:10,y:10}});
   assert.equal(await f.page.locator('.gt-tour-card').count(),0);assert.equal(await f.page.evaluate(()=>localStorage.getItem('ipfx-markets-tour-v1')),'1');
  }
  await f.page.waitForTimeout(1200);assert.equal(await f.page.locator('.gt-tour-card').count(),0);
  await f.page.locator('#gtHelp').click();assert.equal(await f.page.locator('.gt-tour-card').count(),1);
  assert.deepEqual(f.errors,[]);
 }finally{await f.browser.close();}
});

test('real position dialog guards partial-close confirmation and permits a confirmed valid slice',{skip:!enabled,timeout:60000},async()=>{
 const f=await fixture();try{
  const open=()=>f.page.evaluate(()=>{
   selectedAccountMode='challenge';engineState.account.id='synthetic-demo';
   engineState.account.limits.payout_min_hold_seconds=60;
   engineState.open_trades=[{id:'synthetic-position',side:'buy',symbol:'EURUSD',volume:.1,open_price:1.1227,opened_at:new Date().toISOString()}];
   openPartialDialog('synthetic-position');
  });
  await open();await f.page.locator('#omGo').click();await f.page.locator('#mhClose').waitFor({state:'visible'});
  assert.equal(await f.page.locator('#omGo').isDisabled(),true);
  await f.page.evaluate(()=>omSubmit());
  await f.page.evaluate(()=>{selectedAccountMode='demo';engineState.account.id='another-synthetic-account';});
  await f.page.locator('#mhClose').click();await f.page.waitForFunction(()=>!omSubmitting,null,{timeout:10000});
  assert.equal(f.requests.length,0);assert.match(await f.page.locator('#omErr').innerText(),/account changed/i);
  await open();await f.page.locator('#omGo').click();await f.page.locator('#mhClose').click();
  await f.page.waitForFunction(()=>messages.includes('Partial close filled'),null,{timeout:10000});
  assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0],{action:'partial_close',trade_id:'synthetic-position',volume:.05,account_mode:'challenge'});
  assert.equal(await f.page.locator('#omDlg').evaluate(el=>el.classList.contains('open')),false);
  assert.deepEqual(f.errors,[]);
 }catch(error){
  error.message+='; dialog state '+JSON.stringify(await f.page.evaluate(()=>({title:document.getElementById('omTitle').textContent,busy:engineBusy,submitting:omSubmitting,messages,dialog:document.getElementById('omDlg').className,confirmation:document.getElementById('mhDlg')?.className})))+'; errors '+JSON.stringify(f.errors)+'; requests '+JSON.stringify(f.requests);
  throw error;
 }finally{await f.browser.close();}
});
