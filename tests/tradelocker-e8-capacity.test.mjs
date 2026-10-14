import test from 'node:test';import assert from 'node:assert/strict';import {brokerCapacitySnapshot,brokerAvailableFunds} from '../supabase/functions/_shared/tradelocker.ts';
import {reserveCapacity} from '../supabase/functions/_shared/book-capacity.ts';
const e8Columns=["balance", "projectedBalance", "availableFunds", "blockedBalance", "cashBalance", "unsettledCash", "withdrawalAvailable", "stocksValue", "optionValue", "initialMarginReq", "maintMarginReq", "marginWarningLevel", "blockedForStocks", "stockOrdersReq", "stopOutLevel", "warningMarginReq", "marginBeforeWarning", "todayGross", "todayNet", "todayFees", "todayVolume", "todayTradesCount", "openGrossPnL", "openNetPnL", "positionsCount", "ordersCount"];
test('real E8 configured availableFunds schema yields tradable capacity without orders',async()=>{
 const originalFetch=globalThis.fetch,originalDeno=globalThis.Deno;const calls=[];globalThis.Deno={env:{get:()=>undefined}};
 globalThis.fetch=async(url,init)=>{assert.equal(init.method,'GET');calls.push(String(url));let d;
 if(String(url).endsWith('/config'))d={accountDetailsConfig:{columns:e8Columns.map(id=>({id}))},positionsConfig:{columns:[{id:'id'}]},ordersConfig:{columns:[{id:'id'}]}};
 else if(String(url).endsWith('/state'))d={accountDetailsData:e8Columns.map(id=>id==='availableFunds'?49000:0)};
 else if(String(url).endsWith('/positions'))d={positions:[]};else if(String(url).endsWith('/orders'))d={orders:[]};else throw Error('Unexpected fixture request');return new Response(JSON.stringify({d}),{status:200});};
 try{const s=await brokerCapacitySnapshot('SYNTHETIC_E8_REAL_SCHEMA','fixture','1');assert.equal(s.free_margin_usd,49000);assert.equal(s.open_positions,0);assert.equal(s.pending_orders,0);assert.deepEqual(s.position_ids,[]);assert.equal(calls.length,4);}finally{globalThis.fetch=originalFetch;globalThis.Deno=originalDeno;}
});


test('tradable funds use configured field names and reject missing, malformed or ambiguous evidence',()=>{
 const config=ids=>({accountDetailsConfig:{columns:ids.map(id=>({id}))}}),state=values=>({d:{accountDetailsData:values}});
 for(const field of ['availableFunds','freeMargin','availableMargin'])assert.equal(brokerAvailableFunds(config(['balance',field]),state([50000,'123.45'])),123.45);
 assert.equal(brokerAvailableFunds(config(['availableFunds','freeMargin']),state([90,100])),90);
 assert.equal(brokerAvailableFunds(config(['availableFunds']),state([0])),0);
 assert.throws(()=>brokerAvailableFunds(config(['balance']),state([50000])),/FREE_MARGIN_UNVERIFIED/);
 for(const v of [null,'', ' ',true,{},'NaN',-1])assert.throws(()=>brokerAvailableFunds(config(['availableFunds']),state([v])),/FREE_MARGIN_UNVERIFIED/);
 assert.throws(()=>brokerAvailableFunds(config(['availableFunds','availableFunds']),state([100,200])),/SCHEMA_UNVERIFIED/);
 assert.throws(()=>brokerAvailableFunds(config(['availableFunds']),state([])),/SCHEMA_UNVERIFIED/);
 assert.throws(()=>brokerAvailableFunds(config(['', 'availableFunds']),state([1,2])),/SCHEMA_UNVERIFIED/);
});


test('capacity failure records a safe actionable code without leaking broker response bodies',async()=>{
 const beforeFetch=globalThis.fetch,beforeDeno=globalThis.Deno;globalThis.Deno={env:{get:()=>undefined}};
 const db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{book:'l3'}})})})}),rpc:async()=>({data:true})};
 globalThis.fetch=async()=>new Response(JSON.stringify({private:'SYNTHETIC_SECRET_RESPONSE'}),{status:403});
 try{const r=await reserveCapacity(db,'l3','fixture',.01,{token:'SYNTHETIC_HTTP_FAILURE',accountId:'fixture',accNum:'1'});assert.equal(r.ok,false);assert.equal(r.reason,'BROKER_CAPACITY_UNVERIFIED: HTTP_403');assert.ok(!JSON.stringify(r).includes('SYNTHETIC_SECRET_RESPONSE'));}finally{globalThis.fetch=beforeFetch;globalThis.Deno=beforeDeno;}
});
