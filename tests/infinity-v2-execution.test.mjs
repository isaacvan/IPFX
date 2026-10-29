import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts',import.meta.url),'utf8');
const part=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
test('actual v2 source close has identical price, commission and pricing delay eligibility whether copied or not',async()=>{
 const outcomes=[];
 for(const copied of [false,true]){
  const commits=[],dispatched=[];const acct={id:'a',user_id:'u',balance:1000,rules_version:'infinity_v2',challenge_type:'infinity'};
  const db={rpc:async(name,args)=>name==='fn_request_ipfx_full_close'?{data:{ok:true}}:(commits.push(args),{data:{ok:true,balance:1001}})};
  const c=vm.createContext({Date,Number,Math,console:{info(){},error(){}},bookLegs:async()=>({a:copied,b:false}),
   bookNow(){throw Error('v2 must not wait for broker pricing');},hedgeCloseFirst(){throw Error('v2 must not wait for broker pricing');},
   accountSpec:async()=>({commissionPerLot:6}),rulesV2:()=>true,round2:n=>Math.round(n*100)/100,
   tradePnl:async(t,p)=>p-t.open_price,fireMirror:async()=>{},mirrorLater(){},bookLater:body=>dispatched.push(body),shadowLater(){},logAudit:async()=>{}});
  vm.runInContext(stripTypeScriptTypes(part('async function closeTrade(','// Third stop-loss warning')),c);
  const done=await c.closeTrade(db,acct,{id:'t',symbol:'XAUUSD',side:'buy',volume:.01,open_price:2000},2001,'manual',{},null,undefined,async hasBroker=>{
   assert.equal(hasBroker,false,'same simulated delay for every v2 trader');return {price:2001.25,shortfallUsd:.25};});
  assert.equal(done,true);assert.equal(commits.length,1);outcomes.push(commits[0]);if(copied)assert.equal(dispatched.length,1);
 }
 assert.deepEqual(JSON.parse(JSON.stringify(outcomes[0])),JSON.parse(JSON.stringify(outcomes[1])));assert.equal(outcomes[0].p_exit,2001.25);assert.equal(outcomes[0].p_commission,.06);
});
test('actual v2 execution wrapper applies the configured synthetic delay and account quote without touching broker APIs',async()=>{
 const waits=[],c=vm.createContext({Date,Math:{...Math,random:()=>0,floor:Math.floor,max:Math.max,min:Math.min},EXEC_DELAY_MIN_MS:300,EXEC_DELAY_MAX_MS:900,
  setTimeout:fn=>{waits.push(300);fn();},warmQuotes:async()=>{},accountQuote:async()=>({bid:1.101,ask:1.102}),quoteStale:()=>false,roundPrice:(_,n)=>n,adverse:n=>n});
 vm.runInContext(stripTypeScriptTypes(part('async function executeForAccount(','// ---------- symbol tradeability')),c);
 const result=await c.executeForAccount({}, {rules_version:'infinity_v2'},'EURUSD',true,{bid:1.1,ask:1.101},0,true,false);
 assert.equal(result.price,1.102);assert.equal(result.decision,1.101);assert.deepEqual(waits,[300]);
});
