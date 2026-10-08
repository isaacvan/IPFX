import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import{createRequire}from'node:module';
test('owner sees fresh source closes, blocked live controls and persistent backend demo choice',{skip:!process.env.E8_BROWSER_TEST,timeout:60000},async t=>{
 const require=createRequire(import.meta.url),{chromium}=require(process.env.E8_PLAYWRIGHT);
 const server=await chromium.launchServer({executablePath:process.env.E8_CHROME,headless:true,timeout:20000,args:['--disable-background-networking']});
 t.signal.addEventListener('abort',()=>server.process().kill('SIGKILL'),{once:true});let browser;
 try{browser=await chromium.connect(server.wsEndpoint(),{timeout:15000});}catch(e){await server.kill();throw e;}
 try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),calls=[],errors=[];
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 const person='22222222-2222-4222-8222-222222222222';
 const profile={person_id:person,book_state:'BB_DEMO',manual_book_state:null,state_reason:'start',state_since:new Date().toISOString()};
 const routing={AB_DEMO:{available:true},BB_DEMO:{available:true},AB_LIVE:{available:false,reason:'E8 monitor is read-only'},BB_LIVE:{available:false,reason:'Live reverse adapter not connected'}};
 const overview=()=>({ok:true,generated_at:new Date().toISOString(),alerts:[],resolved:[],policy:{version:4},settings:{book_halt:false},counts:{BB_DEMO:1},
  health:{jobs:[],heartbeats:[],market_open:true},books:{limits:[],live_daily:[],paper_daily:[],execution:{},skips:[],ladder:{}},traders:[{...profile,name:'Synthetic owner trader',metrics:{trades:1}}],events:[]});
 const trader=()=>({ok:true,profile:{...profile},routing,metrics:{trades:1},trades:[],events:[],accounts:[],
  activity:{as_of:new Date().toISOString(),source_trades:[{id:'fixture-closed-trade',symbol:'EURUSD',side:'buy',volume:.01,status:'closed',pnl:1,close_reason:'manual',
   hold_seconds:3822,lowest_pnl_usd:-42.5,lowest_pnl_status:'OBSERVED_QUOTES',lowest_pnl_at:'2026-10-08T09:00:00Z',low_observed_until:'2026-10-08T09:10:00Z'},
   {id:'older-closed-trade',symbol:'XAUUSD',side:'sell',volume:.1,status:'closed',pnl:10,hold_seconds:90061,lowest_pnl_usd:null,lowest_pnl_status:'UNAVAILABLE_HISTORY'},
   {id:'partial-fixture-trade',parent_trade_id:'fixture-closed-trade',symbol:'EURUSD',side:'buy',volume:.005,status:'closed',close_reason:'partial',pnl:.5,hold_seconds:92,lowest_pnl_usd:-2.25,lowest_pnl_status:'INCOMPLETE_HISTORY'}],simulations:[],pending:[]}});
 await context.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.pathname==='/team-brain.html')return route.fulfill({contentType:'text/html',body:fs.readFileSync(new URL('../team-brain.html',import.meta.url),'utf8')});
  if(u.pathname.startsWith('/assets/')){
   const p=new URL('..'+u.pathname,import.meta.url);
   return route.fulfill({contentType:u.pathname.endsWith('.js')?'text/javascript':'text/css',body:fs.existsSync(p)?fs.readFileSync(p,'utf8'):''});
  }
  if(u.hostname==='cdn.jsdelivr.net')return route.fulfill({contentType:'text/javascript',body:"window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'fixture-only'}}})}})};"});
  if(u.pathname.includes('/functions/v1/')){
   const headers={'Access-Control-Allow-Origin':'https://fixture.test','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'authorization,content-type'};
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers,body:''});
   const body=req.postDataJSON();calls.push(body);let response;
   if(body.action==='set_model'){
    assert.equal(body.expected_state,profile.book_state);assert.equal(body.expected_manual,profile.manual_book_state);
    profile.book_state=body.target;profile.manual_book_state=body.target;response={ok:true,state:body.target,control:'MANUAL'};
   }else response=body.action==='find_traders'?{ok:true,results:[{user_id:person,full_name:'Synthetic owner trader'}]}:body.action==='add_trader'?{ok:true,person_id:person,created:false}:body.action==='trader'?trader():overview();
   return route.fulfill({contentType:'application/json',headers,body:JSON.stringify(response)});
  }
  return route.fulfill({status:200,body:''});
 });
 await page.goto('https://fixture.test/team-brain.html');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('updated'));
 await page.locator('#registeredName').fill('Synthetic');await page.locator('#findTraderBtn').click();
 await page.getByRole('button',{name:'Add Synthetic owner trader to Brain',exact:true}).click();
 assert.equal(calls.find(c=>c.action==='add_trader').user_id,person);
 await page.waitForSelector('#modelReason');assert.match(await page.locator('#dLive').innerText(),/fixture-/);
 assert.match(await page.locator('#dLive').innerText(),/closed/);
 assert.match(await page.locator('#dLive').innerText(),/1h 3m 42s/);assert.match(await page.locator('#dLive').innerText(),/-\$42\.50/);
 assert.match(await page.locator('#dLive').innerText(),/1d 1h 1m 1s/);assert.match(await page.locator('#dLive').innerText(),/Unavailable/);
 assert.match(await page.locator('#dLive').innerText(),/partial history/);assert.match(await page.locator('#dLive').innerText(),/before fees/);
 assert.equal(await page.locator('[data-model="AB_LIVE"]').isDisabled(),true);assert.equal(await page.locator('[data-model="BB_LIVE"]').isDisabled(),true);
 await page.locator('#modelReason').fill('Reviewed consistent performance');await page.locator('[data-model="AB_DEMO"]').click();
 await page.waitForFunction(()=>document.querySelector('#modelStatus')?.textContent.includes('Saved on the backend'));
 assert.match(await page.locator('#dBox').innerText(),/A-book demo.*Owner choice/i);
 assert.equal(calls.filter(c=>c.action==='set_model').length,1);assert.equal(profile.manual_book_state,'AB_DEMO');
 await page.locator('#modelReason').fill('Draft stays while refreshing');
 await page.waitForTimeout(10500);assert.equal(await page.locator('#modelReason').inputValue(),'Draft stays while refreshing');
 assert.ok(calls.filter(c=>c.action==='trader').length>=3,'open trader refreshes without another manual action');
 assert.equal(calls.filter(c=>c.action==='set_model').length,1);assert.deepEqual(errors,[]);
 if(process.env.MODEL_SCREENSHOT)await page.screenshot({path:process.env.MODEL_SCREENSHOT,fullPage:false});
 }finally{await server.kill();}
});
