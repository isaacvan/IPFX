import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
import {receiptCosts,isolatedBalance,pairedPaper} from '../supabase/functions/_shared/e8-evidence.ts';
import {finiteNumber} from '../supabase/functions/_shared/e8-reference.ts';
const user={id:'11111111-1111-4111-8111-111111111111',email:'owner@example.invalid'};
async function harness(options={}){
 let handler;const calls=[];
 const db={auth:{getUser:async()=>({data:{user:options.noSession?null:user},error:null})},
  rpc:async(name,args)=>{calls.push({name,args});return {data:{ok:true,statementAuthenticated:false},error:null};},
  from:table=>{const q={select(){return q},eq(){return q},in(){return q},gt(){return q},lte(){return q},limit(){return q},maybeSingle(){return q},insert(body){calls.push({table,body});return q},then(resolve){return resolve({data:table==='admins'?options.notAdmin?null:{user_id:user.id}:table==='ladder_accounts'?{role:'monitor',platform:'tradelocker',execution_enabled:false}:table==='e8_account_snapshots'?options.snapshots:table==='cost_fills'?[{raw:{positionId:'999'}},{raw:{positionId:'999'}}]:null,error:null})}};return q;}};
 const context=vm.createContext({Request,Response,TextEncoder,Uint8Array,Date,Number,String,JSON,Array,Object,Map,Set,Math,Error,atob,crypto,
  Deno:{env:{get:key=>key==='IPFX_OWNER_EMAIL'?'owner@example.invalid':'synthetic'},serve:h=>handler=h},
  createClient:()=>db,allowRequest:async()=>!options.rateDenied,readJsonObject:async req=>req.json(),receiptCosts,isolatedBalance,pairedPaper,finiteNumber});
 const source=fs.readFileSync(new URL('../supabase/functions/e8-monitor-admin/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');vm.runInContext(stripTypeScriptTypes(source),context);
 const token='synthetic.'+Buffer.from(JSON.stringify({aal:options.noMfa?'aal1':'aal2'})).toString('base64url')+'.synthetic';
 return {calls,run:async body=>{const r=await handler(new Request('https://fixture.invalid',{method:'POST',headers:{Origin:'https://ipfxcapital.com',Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:r.status,body:await r.json()};}};
}
const r={brokerAccountId:'123',positionId:'999',openingOrderId:'900',closingOrderIds:['901'],quantity:.01,gross:-.49,net:-.55,fee:-.06,swap:0,feeIncludesCommission:true,evidenceNote:'Synthetic closed position'};
test('all evidence actions retain verified owner and MFA checks before any record mutation',async()=>{
 for(const options of[{noSession:true},{noMfa:true},{notAdmin:true},{rateDenied:true}]){const h=await harness(options);const result=await h.run({action:'import_receipt',account_id:3,confirm_reviewed:true,receipt:r});assert.ok([401,403,429].includes(result.status));assert.equal(h.calls.length,0);}
});
test('balance check cannot silently assume USD or override a reported foreign currency; confirmations remain audited',async()=>{
 const before={id:1,account_id:3,received_at:new Date(Date.now()-3600000).toISOString(),currency:null,amounts:{balance:50000,positionsCount:0,ordersCount:0}};
 const after={...before,id:2,received_at:new Date().toISOString(),amounts:{balance:49999.45,positionsCount:0,ordersCount:0}};
 const body={action:'balance_check',account_id:3,before_id:1,after_id:2,gross:-.49,signed_adjustments:0,confirm_no_other_activity:true,confirm_postings_settled:true,confirm_same_broker_day:true,confirm_history_complete:true};
 const h=await harness({snapshots:[before,after]});assert.equal((await h.run(body)).body.result.net,null);
 const declared=await h.run({...body,confirm_usd_statement:true});assert.equal(declared.status,200);assert.ok(Math.abs(declared.body.result.net+.55)<1e-8);assert.equal(declared.body.result.currencyBasis,'OWNER_CONFIRMED_USD_STATEMENT');assert.equal(declared.body.result.receiptVerified,false);
 const foreign=await harness({snapshots:[{...before,currency:'EUR'},{...after,currency:'EUR'}]});assert.equal((await foreign.run({...body,confirm_usd_statement:true})).body.result.net,null);
 assert.ok(h.calls.some(c=>c.table==='admin_audit_log'));
});
test('receipt import requires review, rejects missing costs and sends only a normalized exact-position RPC',async()=>{
 const h=await harness();assert.equal((await h.run({action:'import_receipt',account_id:3,receipt:r})).status,400);
 assert.equal((await h.run({action:'import_receipt',account_id:3,confirm_reviewed:true,receipt:{...r,swap:null}})).status,400);
 assert.equal(h.calls.length,0);const result=await h.run({action:'import_receipt',account_id:3,confirm_reviewed:true,receipt:{...r,accessToken:'NEVER_PERSIST',canEnableLive:true}});
 assert.equal(result.status,200);assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'e8_import_position_receipt');assert.equal(JSON.stringify(h.calls).includes('NEVER_PERSIST'),false);assert.equal(h.calls[0].args.p_actor,user.id);
});
