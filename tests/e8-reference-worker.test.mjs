// Runs the production handler with a broker/database double. No real account/network.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
import {applicableRules,measuredFill,referenceRules} from '../supabase/functions/_shared/e8-reference.ts';
async function harness(options={}){
 const now=new Date().toISOString(),calls=[],writes=[];
 const profile={account_id:1,lease:'lease',scope:'E8',symbols:['EURUSD'],last_quote_at:null,last_history_at:null,
  rate_rules:[{type:'QUOTES',limit:20,windowMs:1000},{type:'GET_ORDERS_HISTORY',limit:2,windowMs:60000}],
  broker_config:{rateLimits:[{rateLimitType:'QUOTES',limit:20,intervalNum:1,measure:'SECONDS'},{rateLimitType:'GET_ORDERS_HISTORY',limit:2,intervalNum:1,measure:'MINUTES'}]},config_at:now,...options.profile};
 const db={rpc:async(name,args)=>{calls.push({name,args});return name==='e8_monitor_claim'?{data:options.idle?null:profile,error:null}: {data:{ok:!options.budgetDenied,wait_ms:60000},error:null};},
  from(table){let operation='select',body,filters=[];const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},gt(){return q;},in(){return q;},
   update(b){operation='update';body=b;return q;},insert(b){operation='insert';body=b;return q;},upsert(b){operation='upsert';body=b;return q;},
   maybeSingle(){return q;},then(resolve,reject){
    let data=null,error=null;
    if(table==='ladder_accounts'&&operation==='select')data={id:1,api_env:'demo',acc_num:'1',account_id:'99',access_expires_at:new Date(Date.now()+3600000).toISOString(),access_token_ciphertext:'fixture',instrument_map:[{symbol:'EURUSD',info_route_id:1,tradable_instrument_id:'10'}]};
    if(table==='live_quotes')data=[{symbol:'EURUSD',bid:1.1,ask:1.1002,received_at:new Date(Date.now()+60000).toISOString()}];
    if(operation!=='select'){writes.push({table,operation,body,filters});if(table===options.failTable)error={code:'FIXTURE'};if(table==='e8_monitor_profiles')data=options.expiredLease?[]:[{account_id:1}];}
    return Promise.resolve({data,error}).then(resolve,reject);
   }};return q;
  }};
 let handler;
 const tl={config:async()=>profile.broker_config,refresh:async()=>{throw Error('UNEXPECTED_REFRESH');},
  quote:async()=>{calls.push({name:'broker_quote'});if(options.brokerError)throw Error(options.brokerError);return {bid:1.1,ask:1.1002};},
  historyWithConfig:async()=>{calls.push({name:'broker_history'});if(options.historyError)throw Error(options.historyError);return[{id:'long-order-id',status:'filled',filledQty:.1,avgPrice:1.1,commission:0,fee:0,swap:options.swap??0,tradableInstrumentId:'10',lastModified:Date.now()}];}};
 const context=vm.createContext({Response,TextEncoder,Uint8Array,crypto:globalThis.crypto,Date,Map,JSON,Error,Number,String,Array,Math,setTimeout,
  Deno:{env:{get:n=>({COST_MONITOR_SECRET:'x'.repeat(32),TRADELOCKER_TOKEN_ENCRYPTION_KEY:'fixture'}[n]??'fixture')},serve:h=>handler=h},
  createClient:()=>db,readClient:(_env,before)=>({ ...tl,quote:async(...args)=>{await before('/trade/quotes?routeId=1');return tl.quote(...args);},historyWithConfig:async(...args)=>{await before('/trade/accounts/99/ordersHistory');return tl.historyWithConfig(...args);}}),
  decryptSecret:async()=> 'private-fixture-never-exposed',encryptSecret:async()=> 'cipher-fixture',jwtExpiresAt:()=>now,
  applicableRules,measuredFill,referenceRules,TL_SYMBOLS:{EURUSD:'EURUSD'}});
 const source=fs.readFileSync(new URL('../supabase/functions/e8-reference/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
 const js=stripTypeScriptTypes(source);
 vm.runInContext(js,context);
 const run=async(auth=true)=>{const response=await handler(new Request('https://fixture.test',{method:'POST',headers:{'x-cost-secret':auth?'x'.repeat(32):'bad'}}));return{status:response.status,body:await response.json()};};
 return{run,calls,writes,profile};
}
test('worker rejects unauthorised requests without broker/database reads',async()=>{
 const h=await harness();assert.equal((await h.run(false)).status,401);assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
});
test('worker saves read-only quotes and revised fee history, excludes future IPFX quote, retains actual config timestamp',async()=>{
 const h=await harness({swap:-2});const r=await h.run();assert.equal(r.status,200);assert.equal(r.body.samples,1);
 assert.equal(h.writes.find(x=>x.table==='cost_samples').body.ipfx_bid,null);
 const fill=h.writes.find(x=>x.table==='cost_fills').body[0];assert.equal(fill.swap,-2);assert.equal(fill.costs_complete,true);
 const saved=h.writes.find(x=>x.table==='e8_monitor_profiles');assert.equal(saved.body.config_at,h.profile.config_at);assert.ok(saved.filters.some(x=>x[0]==='lease'));
 assert.equal(h.calls.filter(x=>x.name==='broker_quote').length,1);assert.equal(h.calls.filter(x=>x.name==='broker_history').length,1);
});
test('API capacity refusal prevents broker reads and reports unavailable',async()=>{
 const h=await harness({budgetDenied:true});const r=await h.run();assert.equal(r.status,503);assert.equal(r.body.error_code,'SAMPLING_DEFERRED_API_BUDGET');assert.equal(h.calls.some(x=>x.name==='broker_quote'),false);
});
test('provider 429 and a failed quote archive never report successful sampling',async()=>{
 for(const options of [{brokerError:'TRADELOCKER_HTTP_429'},{failTable:'e8_reference_quotes'}]){const h=await harness(options);const r=await h.run();assert.equal(r.status,503);assert.equal(r.body.samples,0);}
});
test('fee history failure stays visible while usable quote observations are retained',async()=>{
 const h=await harness({historyError:'FILL_HISTORY_UNAVAILABLE'});const r=await h.run();assert.equal(r.status,200);assert.equal(r.body.samples,1);
 assert.equal(h.writes.find(x=>x.table==='e8_monitor_profiles').body.history_error_code,'FILL_HISTORY_UNAVAILABLE');
});
test('a replaced/expired worker lease cannot acknowledge successful state',async()=>{
 const h=await harness({expiredLease:true});const r=await h.run();assert.equal(r.status,503);assert.equal(r.body.error,'MONITOR_STATE_WRITE_FAILED');
});
