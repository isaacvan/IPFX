import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import{stripTypeScriptTypes}from'node:module';
const source=fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts',import.meta.url),'utf8');
const enforceSource=source.slice(source.indexOf('async function enforce('),source.indexOf('async function usedMarginUsd('));
async function harness({guard,price=2000}={}){
 const today=new Date().toISOString().slice(0,10),acct={id:'fixture-account',user_id:'fixture-user',challenge_type:'infinity',phase:'evaluation',
 status:'active',venue:'ipfx',balance:100000,starting_balance:100000,day_start_equity:100000,day_start_date:today,max_drawdown_pct:5,
 daily_loss_pct:2.5,drawdown_mode:'static',trailing_peak:100000,total_paid_out:0};
 const trades=[{id:'fixture-trade',account_id:acct.id,user_id:acct.user_id,symbol:'XAUUSD',side:'buy',volume:1,open_price:2000,
 status:'open',opened_at:new Date().toISOString(),sl:null,tp:null}],calls=[];
 const snapshot=guard||{checked:true,status:'breached',breach_reason:'daily_loss',balance:100000,day_start_equity:100000,day_start_date:today,
 trailing_peak:100000,breach_equity:97500,breach_floor:97500,access_revoked_at:new Date().toISOString()};
 const db={rpc:async(name,args)=>{calls.push({name,args});return{data:name==='fn_infinity_breach_lockout'?{locked:false}:snapshot};},from(table){
  const filters=[];let patch=null;
  const result=()=>{if(table==='trades')return{data:trades.filter(t=>filters.every(([k,v])=>t[k]===v))};
   if(table==='trading_accounts'){if(patch)Object.assign(acct,patch);return{data:[{...acct}]};}return{data:[]};};
  const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},order(){return q;},update(p){patch=p;return q;},insert(){return q;},
   then(resolve,reject){return Promise.resolve(result()).then(resolve,reject);},maybeSingle:async()=>({data:acct})};return q;
 }};
 const context=vm.createContext({Date,Number,Object,String,Math,Promise,console,
 warmQuotes:async()=>{},claimOrderLock:async()=>true,releaseOrderLock:async()=>{},fetchQuote:async()=>({bid:price,ask:price+.2}),
 lastKnownQuote:async()=>({bid:price,ask:price+.2}),quoteStale:()=>false,marketOpen:()=>true,
 closeTrade:async(_db,_acct,t,_exit,reason)=>{calls.push({name:'close',reason,id:t.id});t.status='closed';return true;},
 isTradableAccount:a=>a.status==='active'||a.status==='demo',isDemoAccount:a=>a.phase==='demo'&&a.status==='demo',
 slDeadlineSeconds:async()=>null,futuresSessionEnforced:()=>false,
 processPendingOrders:async(_db,a,open)=>{assert.equal(a.status,snapshot.status||'active');return open;},
 tradePnl:async(t,px)=>(px-t.open_price)*100*t.volume,round2:n=>Math.round(n*100)/100,
 });
 vm.runInContext(stripTypeScriptTypes(enforceSource),context);
 return{acct,calls,result:await context.enforce(db,acct)};
}
test('actual engine consumes the committed breach before stops/pending and flattens even though access is revoked',async()=>{
 const r=await harness();assert.equal(r.acct.status,'breached');assert.equal(r.result.open.length,0);
 assert.deepEqual(r.calls.map(x=>x.name),['fn_enforce_infinity_from_quotes','fn_infinity_breach_lockout','close']);assert.equal(r.calls[2].reason,'breach');
 assert.equal(r.acct.breach_equity,97500);
});
test('actual engine marks uncertain risk unpriced, blocks qualification and does not manufacture a breach',async()=>{
 const r=await harness({guard:{checked:false,reason:'MARK_UNAVAILABLE'},price:1950});
 assert.equal(r.acct.status,'active');assert.equal(r.result.unpriced,1);assert.equal(r.result.open.length,1);
 assert.equal(r.calls.some(x=>x.name==='fn_claim_account_breach'),false);
});
test('engine selects immutable failed source, blocks all trading mutations in challenge mode, and includes revoked cleanup',()=>{
 const hub=source.slice(source.indexOf('if (body.action === "hub_specs"'),source.indexOf('if (body.action === "sweep"'));
 const sweep=source.slice(source.indexOf('if (body.action === "sweep"'),source.indexOf('// privileged client for writes'));
 for(const text of[hub,sweep]){assert.doesNotMatch(text,/\.is\("access_revoked_at", null\)/);assert.match(text,/acct\.access_revoked_at && acct\.status !== "breached"/);}
 const selection=source.slice(source.indexOf('let breachSource:'),source.indexOf('if (action === "state")'));
 assert.match(selection,/\.or\("access_revoked_at\.is\.null,status\.eq\.breached"\)/);
 assert.match(selection,/breachSource && !requestedDemo/);for(const action of['open','place_pending','cancel_pending','modify','set_trailing','partial_close','close','close_all'])assert.ok(selection.includes('"'+action+'"'));
 assert.match(selection,/order_blocked: true/);
});
test('actual pending processor expires old orders but does not fill any order while portfolio risk is unknown',async()=>{
 const start=source.indexOf('async function processPendingOrders('),end=source.indexOf('\nasync function ',start+1);
 const pending=[{id:'expired',status:'pending',expires_at:new Date(Date.now()-10000).toISOString()},
 {id:'unexpired',status:'pending',expires_at:new Date(Date.now()+10000).toISOString()}];
 let fetched=0;const db={from(){let patch=null,id=null;const q={select(){return q;},eq(k,v){if(k==='id')id=v;return q;},order(){return q;},update(p){patch=p;return q;},
 then(resolve,reject){if(patch)Object.assign(pending.find(x=>x.id===id),patch);return Promise.resolve({data:pending}).then(resolve,reject);}};return q;}};
 const context=vm.createContext({Date,Number,String,Promise,INSTRUMENTS:{},isTradableAccount:()=>true,fetchQuote:async()=>{fetched++;throw new Error('Must not price a fill');}});
 vm.runInContext(stripTypeScriptTypes(source.slice(start,end)),context);await context.processPendingOrders(db,{id:'fixture-account'},[],100000,false);
 assert.equal(pending[0].status,'expired');assert.equal(pending[1].status,'pending');assert.equal(fetched,0);
});
