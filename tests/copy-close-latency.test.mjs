import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const engine=fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts',import.meta.url),'utf8');
const executor=fs.readFileSync(new URL('../supabase/functions/book-executor/index.ts',import.meta.url),'utf8');
const closeCode=engine.slice(engine.indexOf('async function closeTrade('),engine.indexOf('// Third stop-loss warning'));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const flush=async()=>{for(let n=0;n<20;n++)await Promise.resolve()};

function sourceFixture(options={}){
 const trace=[],credit=[],logs=[],broker=deferred(),quotes=deferred();
 const acct={id:'own-account',user_id:'own-user',balance:1000,challenge_type:'infinity'};
 const trade={id:'own-trade',side:options.side??'buy',volume:.01,open_price:4000,symbol:'XAUUSD'};
 const db={rpc:async(name,args)=>{
  trace.push(name);
  if(name==='fn_request_ipfx_full_close')return{data:{ok:!options.fenceRefused}};
  if(name==='fn_commit_ipfx_close'){credit.push(args);return{data:{ok:true,balance:1000+args.p_pnl}}}
 }};
 const context=vm.createContext({Date,Number,Math,console:{info:x=>logs.push(JSON.parse(x)),error:x=>logs.push(JSON.parse(x))},
  bookLegs:async()=>({a:true,b:false}),bookNow:async()=>{trace.push('broker-dispatch');return broker.promise},
  round2:x=>Math.round(x*100)/100,roundAdverse:(_,x)=>x,worseFill:(buy,...xs)=>buy?Math.max(...xs):Math.min(...xs),
  shortfallUsd:async(_,buy,from,to)=>Math.max(0,buy?to-from:from-to),
  tradePnl:async(t,exit)=>(exit-t.open_price)*(t.side==='buy'?1:-1),rulesV2:()=>true,symbolCheck:async()=>({commissionPerLot:6}),
  fireMirror:async()=>{},mirrorLater(){},bookLater(){},shadowLater(){},logAudit:async()=>{},
 });
 vm.runInContext(stripTypeScriptTypes(closeCode),context);
 return{trace,credit,logs,broker,quotes,run:()=>context.closeTrade(db,acct,trade,3999,'manual',{},null,undefined,async hasBookHedge=>{
  trace.push('pricing-start');assert.equal(hasBookHedge,true);
  await quotes.promise;
  if(options.priceFailure)throw Error('Synthetic quote read failure');
  trace.push('pricing-ready');return{price:3999.5,shortfallUsd:.2};
 })};
}

test('actual source close dispatches the owned broker exit while source pricing is blocked, and settles only after both finish',async()=>{
 for(const brokerFirst of [false,true]){
  const f=sourceFixture(),run=f.run();await flush();
  assert.deepEqual(f.trace.slice(0,3),['fn_request_ipfx_full_close','pricing-start','broker-dispatch']);
  assert.equal(f.credit.length,0);
  if(brokerFirst)f.broker.resolve({fill_price:3999.7});else f.quotes.resolve();
  await flush();assert.equal(f.credit.length,0);
  if(brokerFirst)f.quotes.resolve();else f.broker.resolve({fill_price:3999.7});
  assert.equal(await run,true);assert.equal(f.credit.length,1);
  assert.equal(f.credit[0].p_exit,3999.5,'same-direction source remains no better than broker');
  assert.equal(f.credit[0].p_commission,.06);
  assert.equal(f.logs[0].event,'copy_close_pipeline');
 }
});

test('failed durable fence sends no broker close; duplicate in-flight close or failed pricing cannot credit the source',async()=>{
 const refused=sourceFixture({fenceRefused:true});assert.equal(await refused.run(),false);assert.deepEqual(refused.trace,['fn_request_ipfx_full_close']);
 const duplicate=sourceFixture(),dupRun=duplicate.run();await flush();duplicate.broker.resolve({duplicate_a:true});assert.equal(await dupRun,false);duplicate.quotes.resolve();assert.equal(duplicate.credit.length,0);
 const failed=sourceFixture({priceFailure:true}),failedRun=failed.run();await flush();failed.quotes.resolve();failed.broker.resolve({fill_price:3999.7});assert.equal(await failedRun,false);assert.equal(failed.credit.length,0);assert.equal(failed.logs[0].event,'close_price_preparation_failed');
});

test('overlapping pricing preserves adverse broker pricing and shortfall for a closing sell',async()=>{
 const f=sourceFixture({side:'sell'}),run=f.run();await flush();f.quotes.resolve();f.broker.resolve({fill_price:4000.2});assert.equal(await run,true);
 assert.equal(f.credit[0].p_exit,4000.2);assert.ok(Math.abs(f.credit[0].p_shortfall-.9)<1e-9);
});

test('manual close and Close All skip synthetic sleep only for managed A copies; unhedged timing remains',async()=>{
 const from=engine.indexOf('} else if (action === "close") {');
 const to=engine.indexOf('// ---- modify:',from);
 const code='async function run(){'+engine.slice(from,to).replace(/^} else if/,'if')+'}}';
 for(const action of ['close','close_all'])for(const copied of [true,false]){
  const sleeps=[],executions=[],passed=[];
  const chain={select(){return chain},eq(){return chain},in(){return chain},not(){return chain},limit(){return chain},maybeSingle:async()=>({data:null})};
  const trade={id:'own-trade',side:'buy',symbol:'XAUUSD',volume:.01};
  const context=vm.createContext({action,body:{trade_id:trade.id},state:{open:[trade]},acct:{},db:{from:()=>chain},clientIp:null,Math,Promise,
   EXEC_DELAY_MIN_MS:300,EXEC_DELAY_MAX_MS:900,setTimeout:(fn,ms)=>{sleeps.push(ms);fn()},
   err:()=>{throw Error('Unexpected handler error')},fetchQuote:async()=>({bid:4000,ask:4001}),quoteStale:()=>false,rulesV2:()=>true,symbolCheck:async()=>({slippageBps:.5}),
   executeAtMarket:async(...args)=>{executions.push(args);return{price:3999.9,decision:4000}},shortfallUsd:async()=>.1,
   closeTrade:async(...args)=>{passed.push(await args[8](copied));return true},logFeedEvent:async()=>{},
  });
  vm.runInContext(stripTypeScriptTypes(code),context);await context.run();assert.equal(passed.length,1);
  assert.equal(executions[0][5],action==='close_all'||copied);
  assert.equal(sleeps.length,action==='close_all'&&!copied?1:0);
 }
});

function brokerFixture({planRefused=false,noDestination=false,duplicate=false,unconfirmed=false}={}){
 const trace=[],logs=[],plan=deferred(),dest=deferred(),writes=[];let dispatches=0;
 const leg={id:1,book:'l3',source_trade_id:'own-trade',ongoing_copy_connection_id:1,broker_position_id:'900',side:'buy',fill_price:4000,price_scale_per_lot:100};
 const claim={id:2,qty:.01,dispatch_state:'planned'};
 const db={rpc:async(name)=>{trace.push(name);if(name==='fn_plan_book_exit'){await plan.promise;return{data:{ok:!planRefused,claim,remaining:.01}}}return{}},
  from:()=>{let patch=null;const chain={select(){return chain},eq(){return chain},in(){return chain},update(v){patch=v;return chain},then(resolve){if(!patch)return resolve({data:[leg]});writes.push(patch);resolve(patch.dispatch_state==='sent'?{data:duplicate?[]:[{id:2}]}:{error:null})}};return chain}
 };
 const from=executor.indexOf('async function closeOwnedLeg('),to=executor.indexOf('// ---------- Shadow copy:',from);
 const context=vm.createContext({Date,Number,String,Math,Promise,console:{info:x=>logs.push(JSON.parse(x))},
  destination:async(...args)=>{trace.push('permission-start');assert.equal(args[3],'own-trade');assert.equal(args[2],true);await dest.promise;return noDestination?null:{}},
  closePositionQty:async()=>{dispatches++;trace.push('broker-submit');return{orderId:'901'}},responseIds:x=>x,
  orderFill:async()=>unconfirmed?null:{price:4000.5,qty:.01,orderId:'901'},
  saveDispatchEvidence:(_db,input)=>{trace.push('dispatch-evidence');return Promise.resolve(input);},
  instrumentFor:()=>({tradable_instrument_id:'6148'}),
 });vm.runInContext(stripTypeScriptTypes(executor.slice(from,to)),context);
 return{trace,logs,plan,dest,writes,dispatches:()=>dispatches,run:()=>context.closeLeg(db,{source_trade_id:'own-trade',event:'close'})};
}

test('actual broker path overlaps plan and destination checks, but never dispatches before both or after either refusal',async()=>{
 for(const options of [{},{planRefused:true},{noDestination:true},{duplicate:true}]){
  const f=brokerFixture(options),run=f.run();await flush();
  assert.ok(f.trace.includes('fn_plan_book_exit')&&f.trace.includes('permission-start'));
  f.plan.resolve();await flush();assert.equal(f.dispatches(),0);f.dest.resolve();await run;
  assert.equal(f.dispatches(),Object.keys(options).length?0:1);
 }
});

test('unconfirmed broker acknowledgement stays unknown with no risk release; confirmed result retains exact gross and separate timing',async()=>{
 for(const unconfirmed of [false,true]){
  const f=brokerFixture({unconfirmed}),run=f.run();await flush();f.plan.resolve();f.dest.resolve();const result=await run;
  assert.equal(f.dispatches(),1);assert.equal(f.writes.at(-1).dispatch_state,unconfirmed?'unknown':'confirmed');
  assert.equal(f.trace.includes('fn_finalize_book_exit'),!unconfirmed);
  if(!unconfirmed)assert.equal(result.fill_price,4000.5);
  assert.equal(f.logs[0].event,'book_exit_timing');assert.equal(typeof f.logs[0].broker_ack_ms,'number');
 }
});
