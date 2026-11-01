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
 {const t=await page.locator('#rsDialog').innerText();assert.ok(t.includes('1 this stage'),'Stage 1 score 1.0');assert.ok(t.includes('1.65 this stage'),'Stage 2 score 1.65');assert.ok(t.includes('2 combined'),'combined 2.0');assert.ok(!t.includes('0.75')&&!t.includes('1.25'),'old thresholds gone');}
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

 // Overall consistency score: always shown in the challenge panel, and announced after each counted trade.
 {const rules={stage_score:1,combined_score:null,min_counted_trades:20,target_pct:4,best_day_share:.35,group_gap_minutes:15,score_r_cap:5,min_hold_seconds:300,
   risk_pct:.5,starting_balance:1000,daily_loss_pct:2.5,max_drawdown_pct:5,stop_spread_multiple:8,stop_pause_seconds:600,stop_deadline_seconds:30,sl_strikes_max:3,total_risk_multiple:3};
  const state=(n,score,pending=false)=>({ok:true,account:{id:'acct-preview',rules_version:'infinity_v2',challenge_type:'infinity',stage:1,status:'active',is_demo:false,starting_balance:1000,equity:1012.5,
   limits:{daily_floor:988,daily_loss_allowance_usd:25,max_dd_floor:962.5,drawdown_allowance_usd:50},
   infinity_v2:{applies:true,eligible:false,unmet:[],n,score,combined_score:score,run_n:n,run_score:score,counted_profit:0,target:40,best_day_share:null,rules,scoring_pending:pending}},open_trades:[],pending_orders:[]});
  const push=async st=>page.evaluate(st=>{engineState=st;window.dispatchEvent(new Event('ipfx-state'));window.ipfxInfinityV2.render();},st);
  // The existing read-and-tick step must show the v2 rules (never the v1 session / 1-minute wording), then let the trader continue.
  await push(state(5,0.62));await page.locator('#stageRulesDialog[open]').waitFor();
  {const t=await page.locator('#stageRulesDialog').innerText();
   for(const re of [/Stage 1 rules: 6 things to know/,/To pass: make \$40\.00 profit with at least 20 counted trades, a consistency score of 1\.0 and no day over 35% of your profit, then close every trade\. No minimum days/,
    /counted trade is one trade, or several on the same instrument and direction within 15 minutes/,/stop-loss within 30s, at least 8× the spread away/,/held 5 minutes or more; losses always count\. After a stop-out, that instrument pauses for 10 minutes/,
    /lose \$25\.00 in one day.*or drop \$50\.00 below your highest closed balance/s])assert.match(t,re,String(re));
   assert.doesNotMatch(t,/under 1 minute|exposure|sessions|trading days/i);}
  await page.screenshot({path:path.resolve('../infinity-v2-test-tmp/v2-rules-dialog.png')});
  for(const box of await page.locator('#stageRulesReadList input').all())await box.check();
  await page.locator('#stageRulesContinue').click();assert.equal(await page.locator('#stageRulesDialog').evaluate(d=>d.open),false);
  await push(state(5,0.62));
  {const bars=await page.locator('#ch-bars').innerText();assert.match(bars,/Daily loss room[\s\S]*\$24\.50 left[\s\S]*Resets 00:00 UTC/);assert.match(bars,/Drawdown room[\s\S]*\$50\.00 left[\s\S]*Trails your closed balance/);}
  assert.match(await page.locator('#iv2Overall').innerText(),/Overall consistency score\s*0\.62[\s\S]*5 counted trades this run · Stage 1 needs 1.0/);
  assert.equal(await page.locator('#iv2ScoreToast').count(),0,'no notice before a new counted trade');
  await push(state(5,0.62,true));assert.equal(await page.locator('#iv2ScoreToast').count(),0,'no notice while scoring is pending');
  await push(state(6,1.08));
  await page.locator('#iv2ScoreToast.show').waitFor();
  const toast=await page.locator('#iv2ScoreToast').innerText();
  assert.match(toast,/Counted trade complete/i);assert.match(toast,/1\.08/);assert.match(toast,/▲ \+0\.46/);assert.match(toast,/6 counted trades · Stage 1 needs 1.0/);
  assert.match(await page.locator('#iv2Overall .iv2-ov-v').getAttribute('class'),/\bok\b/,'meets the Stage 1 requirement: shown in green');
  await page.screenshot({path:path.resolve('../infinity-v2-test-tmp/overall-score.png')});
  await push(state(7,0.95));assert.match(await page.locator('#iv2ScoreToast').innerText(),/▼ -0\.13/,'a drop is shown too');
  // How Infinity v2 works: opens from the panel link, short, and every number is the account's own rule
  await page.locator('#iv2ScoreToast button').click();await page.locator('.btab',{hasText:'Challenge'}).click();await page.getByRole('button',{name:/How Infinity v2 works/}).click();
  await page.locator('#iv2GuideDialog').waitFor({state:'visible'});
  {const g=await page.locator('#iv2GuideDialog').innerText();
   for(const re of [/Stage 1/,/Profit target 4% \(\$40\)/,/At least 20 counted trades/,/Consistency score 1\.0 this stage/,/No single day over 35%/,/within 15 minutes/,/\+2R/,/-1R/,/stop loss within 30 seconds/,/at least 8× the spread/,/never widen or remove/,/3 missing stops end the run/,/Risk at most 0\.5% \(\$5\) per counted trade/,/3× that/,/held 5 minutes/,/pauses for 10 minutes/,/Daily loss 2\.5% \(\$25\)/,/Max drawdown 5% \(\$50\)/,/No daily profit cap/])assert.match(g,re,String(re));
   assert.ok(g.split(/\s+/).length<330,'guide stays short: '+g.split(/\s+/).length+' words');}
  await page.screenshot({path:path.resolve('../infinity-v2-test-tmp/guide.png')});
  await page.locator('#iv2GuideDialog .rs-x').click();assert.equal(await page.locator('#iv2GuideDialog').evaluate(d=>d.open),false);
  await page.evaluate(()=>{engineState={ok:true,account:{id:'v1',rules_version:'infinity_v1',challenge_type:'infinity',stage:1,status:'active'},open_trades:[],pending_orders:[]};window.dispatchEvent(new Event('ipfx-state'));window.ipfxInfinityV2.render();});
  assert.equal(await page.locator('#iv2Overall').isHidden(),true,'not shown on v1 accounts');
  console.log('PASS: overall consistency score shown in the panel and announced after each counted trade (up and down), hidden while pending and on v1');}
 console.log('PASS: actual trading.html preview; consent, Stage 2 combined threshold, confirmation, close, dark/light, no horizontal overflow and zero POST requests');
 // Monthly restart notice: a signed-in v1 trader with a restart left sees it; Keep my run hides it for the month; Restart opens the dialog.
 {const p2=await browser.newPage({viewport:{width:1440,height:1000}});
  await p2.route('**/*',route=>{const req=route.request();
   if(/functions\/v1\/trading-engine/.test(req.url()))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,infinity:{v2_enabled:true,attempts_left:1,attempts_cap:1,has_active:true,is_restart:false,v2_terms_version:'test'}})});
   return req.url().startsWith(url)?route.continue():route.abort();});
  await p2.goto(url+'/trading.html',{waitUntil:'domcontentloaded'});await p2.locator('#rsNote').waitFor({state:'attached'});
  const sim=async(version)=>p2.evaluate(async version=>{hasSession=()=>true;freshToken=async()=>'test-token';selectedAccountMode='challenge';
   engineState={ok:true,account:{id:'a1',challenge_type:'infinity',rules_version:version,status:'active',is_demo:false,stage:1},open_trades:[],pending_orders:[]};
   await window.ipfxRestart.refresh();window.ipfxRestart.note();},version);
  await sim('infinity_v1');
  assert.equal(await p2.locator('#rsNote').isVisible(),true,'v1 trader with a restart left sees the notice');
  const month=new Date().toLocaleDateString('en-GB',{month:'long',timeZone:'UTC'});
  assert.match(await p2.locator('#rsNote').innerText(),new RegExp('Your '+month+' restart is ready[\\s\\S]*1 restart this month[\\s\\S]*Keep my run[\\s\\S]*Restart on v2'));
  await p2.screenshot({path:path.resolve('../infinity-v2-test-tmp/restart-notice.png')});
  await p2.getByRole('button',{name:'Restart on v2'}).click();assert.equal(await p2.locator('#rsDialog').evaluate(d=>d.open),true,'opens the restart dialog');
  await p2.locator('#rsDialog .rs-x').click();
  await sim('infinity_v1');await p2.getByRole('button',{name:'Keep my run'}).click();
  await sim('infinity_v1');assert.equal(await p2.locator('#rsNote').isHidden(),true,'Keep my run hides it for this month');
  await p2.evaluate(()=>localStorage.clear());await sim('infinity_v2');assert.equal(await p2.locator('#rsNote').isHidden(),true,'not shown on a v2 run');
  await p2.close();
  console.log('PASS: monthly restart notice shown to v1 traders with a restart left; opens the dialog; Keep my run hides it; never on v2 runs');}
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
  // right after switching, the trader reads and ticks the v2 rules before trading
  await page.locator('#stageRulesDialog[open]').waitFor();assert.match(await page.locator('#stageRulesDialog').innerText(),/counted trades[\s\S]*8× the spread[\s\S]*5 minutes/);
  for(const box of await page.locator('#stageRulesReadList input').all())await box.check();await page.locator('#stageRulesContinue').click();
  await page.evaluate(()=>window.ipfxRestart.refresh());await page.locator('#tbRestart').click();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.locator('#rsAgree').check();await page.locator('#rsGo').click();
  await page.getByText("You're restarted",{exact:true}).waitFor();
  assert.equal((await fixture.db.query('select count(*) n from infinity_v2_switches')).rows[0].n,1);assert.equal((await fixture.db.query('select count(*) n from infinity_v2_restarts')).rows[0].n,1);
  assert.equal((await fixture.db.query("select count(*) n from trading_accounts where status='active' and rules_version='infinity_v2'")).rows[0].n,1);
  await page.goto(url+'/infinity-v2.html',{waitUntil:'domcontentloaded'});await page.locator('#content').waitFor({state:'visible'});{const t=await page.locator('#stages').innerText();assert.ok(t.includes('1.65')&&t.includes('2 combined'),'public rules page shows 1.65 and 2.0');assert.ok(!t.includes('0.75')&&!t.includes('1.25'),'old thresholds gone');}
  console.log('PASS: local test-account switch and restart through actual engine action code and real PGlite transactions; exactly one acceptance of each operation and one active v2 account; no production access');
 }finally{await fixture.db.close();}
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
