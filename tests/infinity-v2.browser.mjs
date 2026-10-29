// Local UI only. External requests are blocked, so preview cannot reach a trader account.
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';import {v2db,uid} from './helpers/infinity-v2-db.mjs';
const {chromium}=await import(pathToFileURL(path.resolve(process.env.BROWSER_TEST_DEPS,'node_modules/playwright/index.mjs')).href);
const root=path.resolve('.');const server=http.createServer((req,res)=>{let name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(root,'.'+name);
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.json')?'application/json':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});let mutations=0;
await page.route('**/*',route=>{const req=route.request();if(req.method()==='POST')mutations++;return req.url().startsWith(url)?route.continue():route.abort();});
try{
 await page.goto(url+'/trading.html?v2preview=1',{waitUntil:'domcontentloaded'});
 const b=page.locator('#tbRestart');await b.waitFor({state:'visible'});await b.click();
 await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByRole('button',{name:'Agree and restart',exact:true}).waitFor();assert.equal(await page.locator('#rsGo').isDisabled(),true);
 assert.ok((await page.locator('#rsDialog').innerText()).includes('1.65 combined'));
 await page.locator('#rsAgree').check();assert.equal(await page.locator('#rsGo').isEnabled(),true);
 await page.locator('#rsGo').click();await page.getByText("Preview complete",{exact:true}).waitFor();
 assert.ok((await page.locator('#rsDialog').innerText()).includes('Preview only'));
 await page.locator('#rsDialog [data-rs="close"]').click();assert.equal(await page.locator('#rsDialog').evaluate(el=>el.open),false);
 for(const light of [false,true]){
  await page.evaluate(light=>document.body.classList.toggle('light',light),light);await b.click();await page.getByRole('button',{name:'Continue',exact:true}).click();
  const width=await page.locator('#rsDialog').evaluate(d=>({client:d.clientWidth,scroll:d.scrollWidth}));assert.ok(width.scroll<=width.client+1);
  await page.screenshot({path:path.resolve('../infinity-v2-test-tmp/restart-'+(light?'light':'dark')+'.png')});
  await page.locator('#rsDialog [data-rs="close"]').click();
 }
 assert.equal(mutations,0,'preview must never issue an account mutation');
 console.log('PASS: actual trading.html preview; consent, Stage 2 combined threshold, confirmation, close, dark/light, no horizontal overflow and zero POST requests');
 if(process.env.DEMO_TEST_DEPS){
 const fixture=await v2db();try{
  await fixture.account({version:'infinity_v1',created:new Date(Date.now()-40*86400000).toISOString()});
  const engine=fs.readFileSync('supabase/functions/trading-engine/index.ts','utf8'),from=engine.indexOf('  if (body.action === "restart_infinity" || body.action === "switch_infinity_v2")'),to=engine.indexOf('  if (body.action === "infinity_status")',from);
  const handler=stripTypeScriptTypes('async function run(){'+engine.slice(from,to)+'}');
  const sqlRpc=async(name,args)=>{try{
   const entries=Object.entries(args),sql='select public.'+name+'('+entries.map(([key],i)=>key+' => $'+(i+1)).join(',')+') result';
   return {data:(await fixture.db.query(sql,entries.map(x=>x[1]))).rows[0].result};
  }catch(e){return {error:{message:e.message}};}};
  async function state(){const a=(await fixture.db.query("select * from trading_accounts where status='active' order by created_at desc limit 1")).rows[0];
   const p=a.rules_version==='infinity_v2'?(await fixture.db.query('select infinity_v2_progress($1) p',[a.id])).rows[0].p:null;
   return {ok:true,account:{...a,infinity_v2:p,limits:{},progress:{}},open_trades:[],pending_orders:[]};}
  await page.unroute('**/*');
  await page.route('**/*',async route=>{const req=route.request();if(req.method()==='POST'&&req.url().includes('/functions/v1/trading-engine')){
   const body=req.postDataJSON();let result;
   if(body.action==='infinity_rules'){result=(await fixture.db.query('select infinity_v2_status() s')).rows[0].s;}
   else if(body.action==='infinity_status'){const s=(await fixture.db.query('select infinity_v2_status() s')).rows[0].s;result={ok:true,infinity:{...s,attempts_left:1,attempts_cap:1,is_restart:true,has_active:true,reason:null}};}
   else if(body.action==='state')result=await state();
   else if(['switch_infinity_v2','restart_infinity'].includes(body.action)){
    const c=vm.createContext({Response,body,user:{id:uid},db:{rpc:sqlRpc},rateLimited:async()=>false,claimOrderLock:async()=>true,releaseOrderLock:async()=>{},CORS:{},cleanV2Error:s=>s,err:(error,status)=>new Response(JSON.stringify({ok:false,error}),{status})});
    vm.runInContext(handler,c);const response=await c.run();return route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
   }else result={ok:true};
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  }return req.url().startsWith(url)?route.continue():route.abort();});
  await page.goto(url+'/trading.html',{waitUntil:'domcontentloaded'});
  const initial=await state();await page.evaluate(s=>{engineState=s;selectedAccountMode='challenge';hasSession=()=>true;freshToken=async()=> 'local-test-token';engineCall=async body=>{const r=await fetch(ENGINE_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(j.account)engineState=j;window.dispatchEvent(new Event('ipfx-state'));return j;};},initial);
  await page.evaluate(()=>window.ipfxInfinityV2.refresh());await page.locator('#iv2Switch').waitFor({state:'visible'});await page.locator('#iv2Switch').click();
  await page.locator('#iv2SwitchDialog [data-terms]').check();await page.locator('#iv2SwitchDialog [data-accept]').click();await page.waitForFunction(()=>engineState.account.rules_version==='infinity_v2');
  await page.evaluate(()=>window.ipfxInfinityV2.render());assert.ok((await page.locator('#ch-title').innerText()).includes('Infinity v2'));
  await page.evaluate(()=>window.ipfxRestart.refresh());await page.locator('#tbRestart').click();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.locator('#rsAgree').check();await page.locator('#rsGo').click();
  await page.getByText("You're restarted",{exact:true}).waitFor();
  assert.equal((await fixture.db.query('select count(*) n from infinity_v2_switches')).rows[0].n,1);assert.equal((await fixture.db.query('select count(*) n from infinity_v2_restarts')).rows[0].n,1);
  assert.equal((await fixture.db.query("select count(*) n from trading_accounts where status='active' and rules_version='infinity_v2'")).rows[0].n,1);
  await page.goto(url+'/infinity-v2.html',{waitUntil:'domcontentloaded'});await page.locator('#content').waitFor({state:'visible'});assert.ok((await page.locator('#stages').innerText()).includes('1.65 combined'));
  console.log('PASS: local test-account switch and restart through actual engine action code and real PGlite transactions; exactly one acceptance of each operation and one active v2 account; no production access');
 }finally{await fixture.db.close();}
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
