import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {exactExecutionReceipt} from '../supabase/functions/_shared/ongoing-execution.ts';

const text=fs.readFileSync(new URL('../supabase/functions/book-executor/index.ts',import.meta.url),'utf8');
const code=text.slice(text.indexOf('async function closeLeg('),text.indexOf('// ---------- Shadow copy:'));
const openId='360287970200000001',position='360287970100000001',exitId='360287970200000002';
function fixture(options={}){
 const trace=[],reads=[],writes=[],logs=[];let closes=0,plans=0,finalized=0;
 const leg={id:4,status:'reconciliation_required',book:'l3',source_trade_id:'synthetic-trade',event:'open',ongoing_copy_connection_id:1,
  broker_order_id:openId,broker_position_id:position,qty:.01,ongoing_prior_position_ids:[],side:'buy',fill_price:null,price_scale_per_lot:100,...options.leg};
 const db={from:()=>{let patch=null,filters=[];const q={select(){return q},eq(k,v){filters.push([k,v]);return q},in(k,v){filters.push([k,v]);return q},update(v){patch=v;return q},
  then(resolve){if(!patch)return resolve({data:[{...leg}]});writes.push({patch,filters});
   if(patch.status==='filled'){
    trace.push('opening-receipt-saved');
    if(options.recoveryLost)return resolve({data:[],error:options.recoveryError?{message:'synthetic storage failure'}:null});
    Object.assign(leg,patch);return resolve({data:[{id:leg.id}],error:null});
   }
   if(patch.dispatch_state==='sent')return resolve({data:options.dispatchLost?[]:[{id:5}]});
   resolve({error:null});
  }};return q},rpc:async(name,args)=>{trace.push(name);if(name==='fn_plan_book_exit'){
   plans++;assert.equal(leg.status,'filled','only a verified and saved opening receipt can plan a close');
   return{data:options.planRefused?{ok:false,reason:'PRIOR_EXIT_RECONCILIATION_REQUIRED'}:{ok:true,claim:{id:5,qty:options.partial?.005:.01,dispatch_state:'planned'},remaining:.01}};
  }if(name==='fn_finalize_book_exit')finalized++;return{}}};
 const context=vm.createContext({Date,Number,String,Array,Math,Promise,exactExecutionReceipt,console:{info:s=>logs.push(JSON.parse(s))},
  destination:async(_db,book,exitOnly,source)=>{trace.push('destination');assert.equal(exitOnly,true);assert.equal(source,'synthetic-trade');return options.noDestination?null:{token:'synthetic-only',accountId:'synthetic-account',accNum:'1'}},
  orderFill:async(_token,account,acc,want,waits)=>{assert.equal(account,'synthetic-account');reads.push({want,waits});
   if(want.orderId===openId){trace.push('opening-receipt-read');if(options.missing)return null;if(options.historyFailure)throw Error('synthetic history outage');
    return{qty:.01,price:4000,orderId:openId,positionId:position,...options.fill};}
   assert.equal(want.orderId,exitId);return options.exitUnknown?null:{qty:options.partial?.005:.01,price:4000.5,orderId:exitId,positionId:position};
  },
  closePositionQty:async(_token,_acc,pos,qty)=>{assert.equal(pos,position);assert.equal(qty,options.partial?.005:.01);closes++;trace.push('close-dispatched');return{orderId:exitId}},
  responseIds:x=>x,saveDispatchEvidence:async()=>{},instrumentFor:()=>({tradable_instrument_id:'6148'}),
 });vm.runInContext(stripTypeScriptTypes(code),context);
 return{trace,reads,writes,logs,counts:()=>({closes,plans,finalized}),run:()=>context.closeLeg(db,{source_trade_id:'synthetic-trade',event:options.partial?'partial_close':'close',slice_id:'synthetic-slice'})};
}

test('requested full/partial exit immediately resolves an exact delayed opening receipt without waiting for cron',async()=>{
 for(const partial of [false,true])for(const status of ['sent','reconciliation_required']){
  const f=fixture({partial,leg:{status}}),result=await f.run();assert.equal(result.ok,true);assert.equal(f.counts().closes,1);assert.equal(f.counts().finalized,1);
  assert.equal(f.reads.length,2);assert.deepEqual(Array.from(f.reads[0].waits),[0]);assert.equal(f.reads[0].want.strictOrder,true);
  assert.ok(f.trace.indexOf('opening-receipt-saved')<f.trace.indexOf('fn_plan_book_exit'));assert.ok(f.trace.indexOf('fn_plan_book_exit')<f.trace.indexOf('close-dispatched'));
  assert.equal(f.writes[0].patch.status,'filled');assert.ok(f.writes[0].filters.some(([k,v])=>k==='status'&&v.includes('reconciliation_required')));
 }
});

test('wrong, incomplete, reused or missing opening evidence cannot send a close or release risk',async()=>{
 for(const options of [
  {missing:true},{historyFailure:true},{fill:{orderId:'999'}},{fill:{positionId:'999'}},{fill:{qty:.02}},{fill:{price:0}},
  {leg:{ongoing_prior_position_ids:[position]}},{leg:{ongoing_prior_position_ids:null}},{leg:{broker_order_id:null}},
  {leg:{error:'POSITION_NOT_NEW_HEDGED: manual reconciliation required'}},{noDestination:true},
  {recoveryLost:true},{recoveryLost:true,recoveryError:true},
 ]){
  const f=fixture(options),result=await f.run();assert.equal(result.ok,false,JSON.stringify(options));
  assert.deepEqual(f.counts(),{closes:0,plans:0,finalized:0});
 }
});

test('resolved openings still require the quantity plan and unique dispatch claim; uncertain exit never releases risk',async()=>{
 for(const options of [{planRefused:true},{dispatchLost:true},{exitUnknown:true}]){
  const f=fixture(options),result=await f.run();assert.equal(result.ok,false);assert.equal(f.counts().closes,options.exitUnknown?1:0);assert.equal(f.counts().finalized,0);
 }
});

test('already confirmed openings keep the existing immediate close path without an extra opening history read',async()=>{
 const f=fixture({leg:{status:'filled',fill_price:4000}}),result=await f.run();assert.equal(result.ok,true);assert.equal(f.reads.length,1);assert.equal(f.reads[0].want.orderId,exitId);
 assert.equal(f.writes.some(w=>w.patch.status==='filled'),false);
});
