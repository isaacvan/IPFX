import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {DEFAULT_SHADOW_POLICIES} from '../lib/trader-detector.ts';
const require=createRequire(import.meta.url);
const ts=require('../dashboard/node_modules/typescript');

function worker(failTrades=false) {
  const calls:any[]=[];let handler:any;
  const policy=DEFAULT_SHADOW_POLICIES.traditional;
  const dataset:Record<string,any[]>={
    trader_detector_policy_versions:[{id:'policy',version:2,challenge_type:'traditional',status:'SHADOW_UNCALIBRATED',thresholds:policy}],
    trading_accounts:[{id:'account',user_id:'user',starting_balance:10000,status:'active',challenge_type:'traditional',stage:1,phase:'evaluation',funded_from_account_id:null,created_at:'2026-01-01T00:00:00Z'}],
    trades:[],trade_safety_flags:[],a_book_rule_snapshots:[],
  };
  function query(table:string) {
    let rows=[...(dataset[table]??[])];let one=false;let error:any=null;
    const q:any={
      select(){return q;},insert(row:any){calls.push({table,insert:row});rows=[{id:'run'}];return q;},update(row:any){calls.push({table,update:row});return q;},
      in(k:string,vs:any[]){rows=rows.filter(r=>vs.includes(r[k]));return q;},eq(k:string,v:any){rows=rows.filter(r=>r[k]===v);return q;},
      lte(k:string,v:any){rows=rows.filter(r=>r[k]<=v);return q;},gt(k:string,v:any){rows=rows.filter(r=>r[k]>v);return q;},
      order(){return q;},limit(n:number){rows=rows.slice(0,n);return q;},single(){one=true;return q;},maybeSingle(){one=true;return q;},
      then(resolve:any,reject:any){if(failTrades&&table==='trades')error={message:'source unavailable'};return Promise.resolve({data:one?(rows[0]??null):rows,error}).then(resolve,reject);},
    };return q;
  }
  const db={from:query,rpc:async(name:string,args:any)=>{calls.push({rpc:name,args});return {data:name==='trader_detector_claim_scan'?{lease_token:'test-lease',after_account_id:null}:{inserted:true,alerts_queued:0},error:null};}};
  const moduleCache=new Map<string,any>();
  function load(file:URL):any {
    if(moduleCache.has(file.href))return moduleCache.get(file.href);
    const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const module={exports:{}};
    const localRequire=(specifier:string)=>specifier.startsWith('https:')?{createClient:()=>db}:load(new URL(specifier,file));
    new Function('module','exports','require','Deno',code)(module,module.exports,localRequire,
      {env:{get:(key:string)=>({TRADER_DETECTOR_CRON_SECRET:'test-secret',SUPABASE_URL:'https://unit.invalid',SUPABASE_SERVICE_ROLE_KEY:'fake'}[key])},serve:(fn:any)=>{handler=fn;}});
    moduleCache.set(file.href,module.exports);return module.exports;
  }
  load(new URL('../../supabase/functions/trader-detector/index.ts',import.meta.url));
  return {calls,handler,dataset};
}
test('worker rejects unauthenticated requests before accessing the database',async()=>{
  const {handler,calls}=worker(); const response=await handler(new Request('https://unit.invalid',{method:'POST'}));
  assert.equal(response.status,401);assert.equal(calls.length,0);
});
test('worker cold scan writes insufficient evidence through the atomic RPC with input provenance',async()=>{
  const {handler,calls}=worker();const response=await handler(new Request('https://unit.invalid',{method:'POST',headers:{'x-detector-secret':'test-secret'}}));
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  const commit=calls.find(c=>c.rpc==='trader_detector_commit_assessment');assert.ok(commit);
  assert.equal(commit.args.p_assessment.state,'INSUFFICIENT_EVIDENCE');
  assert.match(commit.args.p_assessment.input_sha256,/^[a-f0-9]{64}$/);
  assert.equal(commit.args.p_assessment.forecast_id,null);
  assert.equal(commit.args.p_assessment.live_enabled,false);
});
test('source outage reports failed health and returns a retryable non-success status',async()=>{
  const {handler,calls}=worker(true);const response=await handler(new Request('https://unit.invalid',{method:'POST',headers:{'x-detector-secret':'test-secret'}}));
  assert.equal(response.status,503);
  assert.ok(calls.some(c=>c.rpc==='trader_detector_record_failure'));
  assert.ok(!calls.some(c=>c.rpc==='trader_detector_commit_assessment'));
});

test('worker limits each scan to fifty accounts and saves a continuation cursor',async()=>{
  const {handler,calls,dataset}=worker();
  const base=dataset.trading_accounts[0];
  dataset.trading_accounts=Array.from({length:51},(_,i)=>({...base,id:`account-${String(i).padStart(3,'0')}`,user_id:`user-${i}`}));
  const response=await handler(new Request('https://unit.invalid',{method:'POST',headers:{'x-detector-secret':'test-secret'}}));
  const result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));
  assert.equal(result.accountsSeen,50);assert.equal(result.nextAccountCursor,'account-049');
  assert.ok(calls.some(c=>c.rpc==='trader_detector_finish_scan'&&c.args.p_after_account_id==='account-049'));
});
