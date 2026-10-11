import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes}from 'node:module';
import {launchReadiness} from '../supabase/functions/_shared/launch-readiness.ts';
const source=fs.readFileSync(new URL('../supabase/functions/ladder-admin/index.ts',import.meta.url),'utf8');
const code=stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm,''));
async function scenario(action,{fault=null,aal='aal2',owner=true,missing=false,extra={}}={}){
 const writes=[];let handler;
 const db={rpc:async(name)=>({data:name==='treasury_book_totals'?{book_states:{BB_DEMO:2000},open_risk:{b:20000},day_pnl:[]}: {accounts:[],fills:0,fee_complete_fills:0},error:(name==='treasury_book_totals'&&fault==='totals'||name==='e8_reference_summary'&&fault==='reference')?{code:'FAULT'}:null}),from(table){let op='read',value;const q={select(){return q},single(){return q},maybeSingle(){return q},order(){return q},limit(){return q},eq(){return q},in(){return q},insert(v){op='insert';value=v;return q},update(v){op='update';value=v;return q},then(resolve,reject){
  let data=table==='admins'?{user_id:'synthetic-owner'}:table==='ab_settings'?{singleton:true,starting_reserve_usd:0}:table==='ladder_settings'?{}:table==='treasury_snapshots'?null:[];
  if(op!=='read'){writes.push({table,op,value});data=missing?null:{id:1,singleton:true};}
  if(table==='ladder_accounts'&&action==='ladder_update'&&op==='read')data={role:'monitor'};
  const error=(fault===table||fault==='write'&&op!=='read'&&table!=='admin_audit_log')?{code:'SYNTHETIC_FAULT'}:null;
  return Promise.resolve({data:error?null:data,error}).then(resolve,reject);
 }};return q}};
 const context={Deno:{env:{get:k=>k==='IPFX_OWNER_EMAIL'?'owner@example.invalid':'synthetic-fixture'},serve:f=>handler=f},createClient:(_url,_key,options)=>options?.global?{auth:{getUser:async()=>({data:{user:{id:'synthetic-owner',email:owner?'owner@example.invalid':'not-owner@example.invalid'}}})}}:db,
  allowRequest:async()=>true,readJsonObject:async()=>({action,...extra}),launchReadiness,Response,Date,Math,Number,String,Boolean,Array,Object,Map,Set,Error,atob};
 vm.createContext(context);vm.runInContext(code,context);
 const token='fixture.'+Buffer.from(JSON.stringify({aal})).toString('base64url')+'.fixture';
 const r=await handler({method:'POST',headers:{get:k=>k==='origin'?'https://ipfxcapital.com':k==='authorization'?'Bearer '+token:null}});
 return {status:r.status,body:await r.json(),writes};
}
test('owner and MFA required before returning any setup or financial data',async()=>{
 for(const options of [{aal:'aal1'},{owner:false}]){const r=await scenario('overview',options);assert.ok([401,403].includes(r.status));assert.equal(r.writes.length,0);}
});
test('failed balance/account reads do not become zero values or empty lists',async()=>{
 for(const fault of ['treasury_snapshots','ab_settings','ladder_accounts','totals']){const r=await scenario('overview',{fault});assert.equal(r.status,503);assert.equal(r.body.ok,false);assert.equal(r.body.open_risk,undefined);}
});
test('optional monitor diagnostics report unknown rather than blocking unrelated financial data',async()=>{
 const r=await scenario('overview',{fault:'reference'});assert.equal(r.status,200);assert.equal(r.body.readiness.diagnostics_complete,false);
 assert.equal(r.body.readiness.checks.find(c=>c.id==='sampling').state,'unknown');
});
test('audit failure prevents reserve, halt, receipt and sponsorship mutation',async()=>{
 for(const [action,extra]of [['set_reserve',{usd:100}],['halt',{on:true}],['payout_add',{amount_usd:10}],['sponsorship_decide',{id:1,status:'pending'}]]){
  const r=await scenario(action,{fault:'admin_audit_log',extra});assert.equal(r.status,503);assert.equal(r.writes.filter(w=>w.table!=='admin_audit_log').length,0);
 }
});
test('failed or nonexistent mutation never acknowledges success',async()=>{
 for(const [action,extra]of [['set_reserve',{usd:100}],['halt',{on:true}],['payout_add',{amount_usd:10}],['sponsorship_decide',{id:1,status:'pending'}]])for(const options of [{fault:'write'},{missing:true}]){
  const r=await scenario(action,{...options,extra});assert.equal(r.status,503);assert.equal(r.body.ok,false);assert.match(r.body.error,/could not be confirmed/);
 }
});
test('monitor enablement stays denied and successful records require a returned row',async()=>{
 assert.equal((await scenario('ladder_update',{extra:{id:1,execution_enabled:true}})).status,400);
 const r=await scenario('set_reserve',{extra:{usd:0}});assert.equal(r.status,200);assert.equal(r.writes.at(-1).value.starting_reserve_usd,0);
});
