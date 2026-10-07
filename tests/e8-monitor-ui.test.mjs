import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
// Browser fixture blocks all external traffic. Never uses an existing owner profile.
test('owner monitor renders freshness, clears credentials and submits reverse partial replay',{skip:!process.env.E8_BROWSER_TEST,timeout:60000},async(t)=>{
 const require=createRequire(import.meta.url);
 const {chromium}=require(process.env.E8_PLAYWRIGHT);
 process.stdout.write('fixture: launching isolated browser\n');
 const server=await chromium.launchServer({executablePath:process.env.E8_CHROME,headless:true,timeout:20000,args:['--disable-background-networking']});
 t.signal.addEventListener('abort',()=>server.process().kill('SIGKILL'),{once:true});
 const browser=await chromium.connect(server.wsEndpoint(),{timeout:15000});
 process.stdout.write('fixture: browser ready\n');
 try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],requests=[];
 page.setDefaultTimeout(15000);
 page.on('pageerror',e=>errors.push(e.message));
 const fixture={ok:true,accounts:[{id:1,label:'E8 fixture',account_id:'99'}],summary:{accounts:[{id:1,label:'E8 fixture',enabled:true,status:'READY'}],quotes:[{account_id:1,symbol:'EURUSD',bid:1.1,ask:1.1002,spread:.0002,received_at:new Date().toISOString(),fresh:true,age_ms:100}],fills:1,fee_complete_fills:0,revisions:1},simulation:{positions:1,events:3,recent:[{trade_id:'synthetic-trade',symbol:'EURUSD',is_practice:true,selected_book:'b',trader_side:'buy',exited_lots:.02,original_lots:.02,status:'CLOSED_GROSS_ESTIMATE',selected_gross_usd:-3.4}]}};
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.pathname==='/team-e8-monitor.html')return route.fulfill({contentType:'text/html',body:fs.readFileSync(new URL('../team-e8-monitor.html',import.meta.url),'utf8')});
  if(url.pathname==='/assets/js/team-e8-monitor.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(new URL('../assets/js/team-e8-monitor.js',import.meta.url),'utf8')});
  if(url.hostname==='cdn.jsdelivr.net')return route.fulfill({contentType:'text/javascript',body:"window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'fixture-owner-session'}}})}})};"});
  if(url.pathname.includes('/functions/v1/')){
   const headers={'Access-Control-Allow-Origin':'https://fixture.test','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'authorization,content-type'};
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers,body:''});
   const body=req.postDataJSON();requests.push({fn:url.pathname,body});
   const response=body.action==='project'?{ok:true,result:{available:true,netUSD:148,grossUSD:155,feesUSD:7,entrySamplingWaitMs:200,slices:[{samplingWaitMs:200},{samplingWaitMs:200}]}}:body.action==='ladder_add'?{ok:true,id:1}:body.action==='overview'?fixture:{ok:true};
   return route.fulfill({contentType:'application/json',headers,body:JSON.stringify(response)});
  }
  return route.fulfill({status:200,body:''});
 });
 await page.goto('https://fixture.test/team-e8-monitor.html',{timeout:15000});process.stdout.write('fixture: page loaded\n');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('updated'),null,{timeout:15000});
 assert.match(await page.locator('#quotes').innerText(),/Recent API reply/);assert.match(await page.locator('#history').innerText(),/Missing fees are unknown/);
 assert.match(await page.locator('#simulationTrades').innerText(),/buy → sell \(B\)/);assert.match(await page.locator('#simulationTrades').innerText(),/\$-3.40/);assert.match(await page.locator('#simulationTrades').innerText(),/Unverified/);
 await page.locator('#email').fill('fixture@example.invalid');await page.locator('#password').fill('synthetic-test-value');await page.locator('#server').fill('fixture');await page.locator('#account').fill('99');await page.locator('#connectBtn').click();
 await page.waitForFunction(()=>document.querySelector('#password').value==='');
 await page.locator('#projectLots').fill('1');await page.locator('#openedAt').fill('2026-10-07T10:00');await page.locator('#scaleUSD').fill('100000');await page.locator('#feesUSD').fill('7');await page.locator('#adverseBps').fill('0');await page.locator('#minDelayMs').fill('100');
 await page.locator('[data-close-time]').first().fill('2026-10-07T10:05');await page.locator('[data-close-lots]').first().fill('.25');await page.locator('#addClose').click();
 await page.locator('[data-close-time]').nth(1).fill('2026-10-07T10:10');await page.locator('[data-close-lots]').nth(1).fill('.75');await page.locator('#assumptionSource').fill('Synthetic verified test schedule');await page.locator('#projectBtn').click();
 await page.waitForFunction(()=>document.querySelector('#projectResult').textContent.includes('148.00'));
 const projection=requests.find(r=>r.body.action==='project').body.replay;assert.equal(projection.book,'b');assert.equal(projection.closes.length,2);assert.equal(projection.feesUSD,7);
 assert.equal(requests.find(r=>r.body.action==='ladder_add').body.role,'monitor');assert.deepEqual(errors,[]);
 if(process.env.E8_SCREENSHOT)await page.screenshot({path:process.env.E8_SCREENSHOT,fullPage:true});
 }finally{await server.kill();}
});
