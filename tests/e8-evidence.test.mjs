import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {observedQuote,quoteBenchmark,quoteShortfall,receiptCosts,isolatedBalance,pairedPaper} from '../supabase/functions/_shared/e8-evidence.ts';
import {readClient} from '../supabase/functions/_shared/tradelocker-read.ts';
import {saveDispatchEvidence} from '../supabase/functions/_shared/e8-dispatch-evidence.ts';
const scope={accountId:'123',instrumentId:'6148',routeId:950997};
const quote=(at,bid=4100,ask=4100.3)=>observedQuote({bp:bid,ap:ask},scope,at-20,at);
test('unknown provider timestamp stays unknown; future, crossed and post-event quotes never benchmark past events',()=>{
 const q=quote(1000);assert.equal(q.providerAt,null);assert.equal(quoteBenchmark(q,1200,scope).providerAgeMs,null);
 for(const invalid of[quote(1500),{...q,accountId:'other'},{...q,instrumentId:'other'},quote(0)])assert.equal(quoteBenchmark(invalid,1200,scope),null);
 assert.equal(observedQuote({bp:10,ap:9},scope,1,2),null);assert.equal(observedQuote({bp:null,ap:10},scope,1,2),null);
 assert.equal(observedQuote({bp:10,ap:11,timestamp:9999999999999},scope,1,2).providerAt,null);
});
test('buy/sell shortfall uses the correct side and retains favourable differences',()=>{
 const q=quoteBenchmark(quote(1000),1100,scope);
 assert.ok(Math.abs(quoteShortfall('buy',4100.4,.01,100,q).quoteCurrencyShortfall-.1)<1e-9);
 assert.equal(quoteShortfall('sell',4100.1,.01,100,q).priceShortfall<0,true);
 assert.equal(quoteShortfall('buy',4100,.01,100,null),null);
});
test('signed costs handle swap credits and fee-inclusive commission once; unknown is not zero',()=>{
 const r=receiptCosts({gross:1,net:.96,fee:-.06,swap:.02,feeIncludesCommission:true,commission:-.06});assert.ok(Math.abs(r.adjustments+.04)<1e-9);assert.equal(r.statementAuthenticated,false);
 assert.equal(receiptCosts({gross:1,net:.9,fee:-.02,commission:-.08,swap:0,feeIncludesCommission:false}).net,.9);
 for(const swap of[null,'',undefined])assert.throws(()=>receiptCosts({gross:1,net:.94,fee:-.06,swap,feeIncludesCommission:true}),/required/);
 assert.throws(()=>receiptCosts({gross:1,net:.94,fee:.06,swap:0,feeIncludesCommission:true}),/does not match/);
});
test('balance allocation refuses overlap, unstable postings, missing costs/currency and unconfirmed day boundary',()=>{
 const x={before:50000,after:49999.45,gross:-.49,adjustments:0,currency:'USD',flatBefore:true,flatAfter:true,onePosition:true,noOtherActivity:true,stableAfter:true,sameBrokerDay:true,windowComplete:true};
 const r=isolatedBalance(x);assert.ok(Math.abs(r.net+.55)<1e-8);assert.ok(Math.abs(r.combinedCost-.06)<1e-8);assert.equal(r.receiptVerified,false);
 for(const field of['flatBefore','flatAfter','onePosition','noOtherActivity','stableAfter','sameBrokerDay','windowComplete'])assert.equal(isolatedBalance({...x,[field]:false}).net,null);
 for(const change of[{adjustments:null},{currency:null},{after:NaN}])assert.equal(isolatedBalance({...x,...change}).net,null);
});
test('paired A/B replay includes spreads and partial quantities; future or incomplete exits cannot qualify',()=>{
 const inputs={...scope,side:'buy',scale:100,signedCostsA:-.06,signedCostsB:null,maxReceiveAgeMs:1000};
 const events=[{kind:'open',at:1100,lots:.02,quote:quote(1000)},{kind:'partial',at:2100,lots:.01,quote:quote(2000,4101,4101.4)},{kind:'close',at:3100,lots:.01,quote:quote(3000,4102,4102.5)}];
 for(const side of['buy','sell']){const r=pairedPaper(events,{...inputs,side});assert.equal(r.available,true);assert.ok(Math.abs(r.identityResidual)<1e-8);assert.equal(r.netB,null);assert.equal(r.netVerified,false);}
 assert.equal(pairedPaper(events.slice(0,2),inputs).available,false);
 assert.equal(pairedPaper([{...events[0],quote:quote(1200)},...events.slice(1)],inputs).available,false);
 assert.equal(pairedPaper([events[0],{...events[2],lots:.03}],inputs).available,false);
});
test('simultaneous quote reads share one budgeted request only for the same login/account/route/instrument',async()=>{
 const oldFetch=globalThis.fetch,oldDeno=globalThis.Deno;let reads=0,budgets=0;
 globalThis.Deno={env:{get:()=>undefined}};globalThis.fetch=async()=>{reads++;await new Promise(r=>setTimeout(r,10));return new Response(JSON.stringify({d:{bp:4100,ap:4100.3}}));};
 try{const client=readClient('demo',async()=>{budgets++;});const result=await Promise.all(Array.from({length:2000},()=>client.quoteEvidence('SYNTHETIC_TOKEN','123','1',2,'6148')));
  assert.equal(reads,1);assert.equal(budgets,1);assert.equal(result.length,2000);assert.equal(result[0].providerAt,null);
  await Promise.all([client.quoteEvidence('SYNTHETIC_OTHER','123','1',2,'6148'),client.quoteEvidence('SYNTHETIC_TOKEN','124','1',2,'6148')]);assert.equal(reads,3);
 }finally{globalThis.fetch=oldFetch;globalThis.Deno=oldDeno;}
});
test('truncated broker history is rejected rather than presented as complete receipt evidence',async()=>{
 const oldFetch=globalThis.fetch,oldDeno=globalThis.Deno;globalThis.Deno={env:{get:()=>undefined}};
 globalThis.fetch=async()=>new Response(JSON.stringify({d:{hasMore:true,ordersHistory:[]}}));
 try{await assert.rejects(readClient('demo').historyWithConfig('SYNTHETIC','123','1',{}),/TRUNCATED/);}
 finally{globalThis.fetch=oldFetch;globalThis.Deno=oldDeno;}
});
test('evidence failure is contained and registered for background completion, with no order or retry capability',async()=>{
 const old=globalThis.EdgeRuntime,oldWarn=console.warn;const registered=[],calls=[];globalThis.EdgeRuntime={waitUntil:p=>registered.push(p)};console.warn=()=>{};
 try{const work=saveDispatchEvidence({rpc:async(name)=>{calls.push(name);throw Error('synthetic outage');}},{operationId:1,sentAt:new Date().toISOString(),ackAt:null,ackMs:null,receiptLookupMs:null,fillPrice:null,fillQty:null,fillConfirmed:false});await work;
  assert.deepEqual(calls,['e8_record_dispatch']);assert.equal(registered.length,1);
 }finally{globalThis.EdgeRuntime=old;console.warn=oldWarn;}
});
test('clipboard receipt parser preserves long IDs, rejects ambiguous columns and keeps absent costs blank',()=>{
 const context=vm.createContext({window:{},Number,String,Object,Error});vm.runInContext(fs.readFileSync(new URL('../assets/js/e8-evidence.js',import.meta.url),'utf8'),context);
 const parse=context.window.IPFXE8Evidence.parseRow,r=parse('Position ID\tOpening order ID\tAmount\tP&L\tNet P&L\tFee\tSwap\n360287970193809597\t360287970213574522\t0.01\t-$0.49\t-$0.55\t-$0.06\t—');
 assert.equal(r.positionId,'360287970193809597');assert.equal(r.fee,'-0.06');assert.equal(r.swap,undefined);assert.throws(()=>parse('Fee\tFee\n0\t0'),/do not match/);
});
