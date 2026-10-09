import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes}from 'node:module';
const source=fs.readFileSync(new URL('../supabase/functions/treasury/index.ts',import.meta.url),'utf8');
const code=stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm,''));
async function scenario(fault){
 const writes=[];let handler;
 const db={rpc:async()=>({data:null,error:null}),from(table){let op='read',value;const q={select(){return q},maybeSingle(){return q},single(){return q},order(){return q},range(){return q},not(){return q},gte(){return q},in(){return q},eq(){return q},insert(v){op='insert';value=v;writes.push({table,op,value:v});return q},update(v){op='update';value=v;writes.push({table,op,value:v});return q},then(resolve,reject){let out={data:[],error:null};
  if(table==='ab_settings')out.data={payout_model:'cash_at_stage3',starting_reserve_usd:2000,sponsor_fee_usd:350};
  if(table==='treasury_open_accounts')out.data=[{id:'synthetic-account',person_id:'synthetic-person',stage:3,starting_balance:10000,balance:10000,max_drawdown_pct:4,max_risk_per_trade_pct:.35,profit_target_pct:8}];
  if(table==='ladder_accounts')out.data=[{id:1,fee_usd:1500}];if(table==='ladder_settings')out.data=null;
  if(table==='treasury_snapshots'&&op==='insert')out.data={id:1};
  if((fault==='fees'&&table==='ladder_accounts')||(fault==='details'&&table==='treasury_account_forecasts'&&op==='insert'))out={data:null,error:{code:'SYNTHETIC_FAILURE'}};
  return Promise.resolve(out).then(resolve,reject);
 }};return q}};
 const placeholder='synthetic-credential-placeholder-for-isolated-test-only';
 const context={Deno:{env:{get:()=>placeholder},serve:f=>handler=f},createClient:()=>db,TextEncoder,Response,Date,Math,Number,String,Map,Error,
 forecastAccount:()=>({accountId:'synthetic-account',personId:'synthetic-person',stage:3,pGraduate:.2,expectedDays:30,payoutIfGraduate:700,expectedPayout:140,s4MonthlyPayout:0,muMean:0,trades:1}),liabilityWithin:()=>({expected:1000,p90:1500,graduates:1}),coverageStatus:(assets)=>assets==null?'unknown':assets<1500?'short':'healthy',ladderDecision(){throw Error('not exercised')}};
 vm.createContext(context);vm.runInContext(code,context);const response=await handler({method:'POST',headers:{get:()=>placeholder}});return {status:response.status,body:await response.json(),writes};
}
test('complete cash inputs publish only after detail writes succeed',async()=>{const r=await scenario();assert.equal(r.status,200);assert.equal(r.body.status,'short');const initial=r.writes.find(w=>w.table==='treasury_snapshots'&&w.op==='insert');assert.equal(initial.value.assets_usd,500);assert.equal(initial.value.complete,false);assert.equal(initial.value.status,'unknown');const detail=r.writes.findIndex(w=>w.table==='treasury_account_forecasts'),complete=r.writes.findIndex(w=>w.op==='update'&&w.value.complete===true);assert.ok(complete>detail);});
test('a fee read failure cannot fabricate zero fees or healthy cash cover',async()=>{const r=await scenario('fees');assert.equal(r.status,503);assert.equal(r.body.status,'unknown');assert.ok(r.writes.every(w=>w.table!=='treasury_snapshots'||w.value.assets_usd==null));});
test('failed forecast-detail writes return an error and never publish completeness',async()=>{const r=await scenario('details');assert.equal(r.status,503);assert.equal(r.body.error,'FORECAST_DETAILS_WRITE_FAILED');assert.equal(r.writes.some(w=>w.op==='update'&&w.value.complete===true),false);});
