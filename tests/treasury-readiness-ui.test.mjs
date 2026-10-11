import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire}from 'node:module';
test('owner setup UI handles saved-but-unsampled monitors, stale reads and failed/double saves',{skip:!process.env.TREASURY_BROWSER_TEST,timeout:60000},async(t)=>{
 const require=createRequire(import.meta.url),{chromium}=require(process.env.E8_PLAYWRIGHT);
 const server=await chromium.launchServer({executablePath:process.env.E8_CHROME,headless:true,args:['--disable-background-networking','--disable-gpu']});
 t.signal.addEventListener('abort',()=>server.process()?.kill('SIGKILL'),{once:true});
 try{
  const browser=await chromium.connect(server.wsEndpoint(),{timeout:15000});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),requests=[],errors=[];
  let readFails=false,saveFails=false;
  page.setDefaultTimeout(10000); page.on('pageerror',e=>errors.push(e.message));
  const data={ok:true,snapshot:null,settings:{starting_reserve_usd:0},ladder_accounts:[{id:1,label:'Synthetic E8',role:'monitor',api_env:'live',size_usd:50000,execution_enabled:false}],limits:[],readiness:{as_of:new Date().toISOString(),diagnostics_complete:true,checks:[
   {title:'E8 monitoring connection',state:'checked',detail:'Saved read-only; not proof of sampling.',href:'team-e8-monitor.html'},
   {title:'Recent E8 observations',state:'action',detail:'Start sampling and confirm a recent quote.',href:'team-e8-monitor.html#settings'},
   {title:'Execution demo connection',state:'action',detail:'Connect approved demo.',href:'#accountSetup'},
   {title:'<img src=x onerror=alert(1)>',state:'unknown',detail:'<script>injected</script>',href:'javascript:alert(1)'}]}};
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.hostname==='fixture.test'){
    const path=url.pathname.slice(1);if(['team-treasury.html','assets/js/team-treasury.js','assets/css/team-books.css'].includes(path))return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(new URL('../'+path,import.meta.url),'utf8')});
   }
   if(url.hostname==='cdn.jsdelivr.net')return route.fulfill({contentType:'text/javascript',body:"window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'synthetic-session'}}})}})};"});
   if(url.pathname.endsWith('/ladder-admin')){
    const headers={'Access-Control-Allow-Origin':'https://fixture.test','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'authorization,content-type'};
    if(request.method()==='OPTIONS')return route.fulfill({status:204,headers,body:''});
    const body=request.postDataJSON();requests.push(body);
    if(body.action!=='overview')await new Promise(r=>setTimeout(r,150));
    const failed=body.action==='overview'?readFails:saveFails;
    return route.fulfill({status:failed?503:200,headers,contentType:'application/json',body:JSON.stringify(failed?{ok:false,error:'Synthetic save/read unavailable'}:body.action==='overview'?data:{ok:true})});
   }
   return route.fulfill({status:200,body:''});
  });
  await page.goto('https://fixture.test/team-treasury.html');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('updated'));
  assert.match(await page.locator('#setupRows').innerText(),/Saved read-only; not proof of sampling/);
  assert.equal(await page.locator('#setupRows img,#setupRows script').count(),0);
  assert.equal(await page.locator('#setupRows a[href^="javascript:"]').count(),0);
  if(process.env.TREASURY_SCREENSHOT)await page.screenshot({path:process.env.TREASURY_SCREENSHOT.replace('.png','-before.png'),fullPage:true});
  await page.locator('a[href="#accountSetup"]').click();assert.equal(await page.locator('#accountSetup').evaluate(e=>e.open),true);
  saveFails=true;await page.locator('#poAmount').fill('12');await page.locator('#payoutForm').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Synthetic'));
  assert.equal(requests.filter(r=>r.action==='payout_add').length,1);assert.equal(await page.locator('#poAmount').inputValue(),'12');
  readFails=true;await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#setupStatus').textContent.includes('stale'));
  assert.match(await page.locator('#status').innerText(),/Last successful refresh.*stale/);
  readFails=false;await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('updated'));
  assert.equal(await page.locator('#refresh').isDisabled(),false);assert.deepEqual(errors,[]);
  if(process.env.TREASURY_SCREENSHOT)await page.screenshot({path:process.env.TREASURY_SCREENSHOT,fullPage:true});
 }finally{await server.kill();}
});
