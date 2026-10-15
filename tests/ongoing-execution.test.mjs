import test from'node:test';import assert from'node:assert/strict';import{ongoingSizing,exactExecutionReceipt}from'../supabase/functions/_shared/ongoing-execution.ts';import{bookOpenFixture}from'./helpers/book-open-fixture.mjs';
const spec={lotSize:100,minLot:.01,maxLot:100,lotStep:.01,quotingCurrency:'USD'},source={contract_size:100,quote_currency:'USD'};
test('broker contract and lot step determine planned stop risk; unsupported currency, minimum, contract and ceiling are refused',()=>{
 assert.equal(ongoingSizing(spec,source,100,.01,'buy',4000,3999,10).risk,3);assert.equal(ongoingSizing({...spec,lotSize:10},source,100,.1,'buy',4000,3999,10).risk,3);
 for(const [broker,src,lots,cap]of[[{...spec,lotSize:0},source,.01,10],[{...spec,minLot:1},source,.01,10],[{...spec,quotingCurrency:'EUR'},source,.01,10],[spec,source,.015,10],[spec,source,.01,2],[spec,{...source,contract_size:0},.01,10]])assert.throws(()=>ongoingSizing(broker,src,100,lots,'buy',4000,3999,cap));
});
test('variable-lot exact receipts require exact numeric string IDs and a new hedged position, never a reused/netted position',()=>{
 const f={qty:.1,price:4000,orderId:'360287970213096396',positionId:'360287970193705790'};
 assert.equal(exactExecutionReceipt(.1,f.orderId,f.positionId,f),true);
 assert.equal(exactExecutionReceipt(.1,f.orderId,f.positionId,f,[f.positionId]),false);
 for(const x of[{qty:.05},{qty:.2},{price:0},{price:Infinity},{positionId:'wrong'},{orderId:'wrong'}])assert.equal(exactExecutionReceipt(.1,f.orderId,f.positionId,{...f,...x}),false);
 assert.equal(exactExecutionReceipt(.1,Number(f.orderId),f.positionId,f),false);
});
test('actual ongoing open path chooses only the authorised monitor, performs guards, journals its connection and uses no five-slot test',async()=>{
 const f=bookOpenFixture({ongoing:true,otherLadder:true});const r=await f.run();assert.equal(f.posts.length,1);assert.equal(f.posts[0].qty,.01);assert.equal(r.legs[0].fill_price,4000);
 assert.equal(f.requests.find(x=>x.table==='book_orders'&&x.verb==='insert').value.ongoing_copy_connection_id,1);
 assert.equal(f.requests.find(x=>x.name==='capacity-guard').requireEmpty,false);
 assert.ok(!f.requests.some(x=>x.name==='copy_test_claim'||x.name==='copy_test_note'));
 for(const x of['ongoing_copy_claim','destination-guard','ab_reserve_risk','capacity-guard','ongoing_copy_access','book_orders:insert'])assert.ok(f.trace.indexOf(x)>=0&&f.trace.indexOf(x)<f.trace.indexOf('broker-submit'),x);
});
test('risk, metadata, currency, capacity and final OFF checks stop the actual order; old position identity or wrong quantity quarantines one send',async()=>{
 for(const o of[{riskRefused:true},{brokerSpec:{lotSize:0}},{sourceSpec:{quote_currency:'EUR'}},{capacityRefused:true},{accessRefused:true},{noDestination:true}]){const f=bookOpenFixture({ongoing:true,...o});await f.run();assert.equal(f.posts.length,0,JSON.stringify(o));}
 for(const o of[{priorPositions:['901']},{fill:{qty:.005}}]){const f=bookOpenFixture({ongoing:true,...o});const r=await f.run();assert.equal(f.posts.length,1);assert.match(r.legs[0].error,/reconciliation/);assert.equal(f.requests.find(x=>x.table==='book_orders'&&x.verb==='update').value.status,'reconciliation_required');if(o.priorPositions)assert.match(f.requests.find(x=>x.table==='book_orders'&&x.verb==='update').value.error,/POSITION_NOT_NEW_HEDGED/);}
});
test('many synthetic ongoing opens are not stopped by the old five-trade limit, while all broker I/O remains mocked',async()=>{
 for(let i=0;i<100;i++){const f=bookOpenFixture({ongoing:true});await f.run();assert.equal(f.posts.length,1);assert.equal(f.posts[0].side,'buy');}
});
test('a source closed or reduced while its opening receipt was in flight triggers an owned exit catch-up',async()=>{
 for(const change of[{status:'closed',volume:.02},{status:'open',volume:.01}]){
  const f=bookOpenFixture({ongoing:true,sourceChangedDuringOpen:change});await f.run();assert.equal(f.posts.length,1);
  const exit=f.requests.find(x=>x.name==='catchup-exit');assert.equal(exit.body.source_trade_id,'synthetic-trade');assert.equal(exit.body.event,change.status==='closed'?'close':'partial_close');
 }
});
test('owner position loss cap places the broker stop where the copy loses at most the cap, never beyond the 3x backstop',()=>{
 const spec={lotSize:100,minLot:.01,maxLot:100,lotStep:.01,quotingCurrency:'USD'},source={contract_size:100,quote_currency:'USD'};
 // Gold 0.01 lot = $1 per $1 move. Trader stop $1 away => 3x backstop $3 away ($3 risk).
 const off=ongoingSizing(spec,source,100,.01,'buy',4000,3999,10);assert.equal(off.stop,3997);assert.equal(off.risk,3);
 // Cap $2 is tighter than the backstop: stop at 3998 (buy) / 4002 (sell), risk $2.
 const buy=ongoingSizing(spec,source,100,.01,'buy',4000,3999,10,2);assert.equal(buy.stop,3998);assert.equal(buy.risk,2);
 const sell=ongoingSizing(spec,source,100,.01,'sell',4000,4001,10,2);assert.equal(sell.stop,4002);assert.equal(sell.risk,2);
 // Cap looser than the backstop: the backstop still binds.
 const loose=ongoingSizing(spec,source,100,.01,'buy',4000,3999,10,50);assert.equal(loose.stop,3997);assert.equal(loose.risk,3);
 // With the cap on, the old $10 ceiling no longer refuses a wide trader stop: the cap bounds the loss instead.
 assert.throws(()=>ongoingSizing(spec,source,100,.01,'buy',4000,3990,10),/CEILING/);
 const wide=ongoingSizing(spec,source,100,.01,'buy',4000,3990,10,8);assert.equal(wide.stop,3992);assert.equal(wide.risk,8);
 // Bigger lots tighten the stop for the same dollar cap; a stop inside 0.05% of price is refused, not sent.
 assert.equal(ongoingSizing(spec,source,100,.1,'buy',4000,3999,100,20).stop,3998);
 assert.throws(()=>ongoingSizing(spec,source,100,1,'buy',4000,3999,1000,1),/TOO_TIGHT/);
 assert.throws(()=>ongoingSizing(spec,source,100,.01,'buy',4000,3999,10,0),/INVALID/);
});
test('the real open path sends the capped stop to the broker only when the owner cap is on, and uses the trader’s own lots',async()=>{
 const off=bookOpenFixture({ongoing:true});await off.run();assert.equal(off.posts.length,1);assert.equal(off.posts[0].sl,3997);
 const on=bookOpenFixture({ongoing:true,trial:{position_loss_cap_usd:2}});await on.run();assert.equal(on.posts.length,1);assert.equal(on.posts[0].sl,3998);
 const lots=bookOpenFixture({ongoing:true,trial:{broker_lots:.02,position_loss_cap_usd:4}});await lots.run();assert.equal(lots.posts[0].qty,.02);assert.equal(lots.posts[0].sl,3998);
 const tight=bookOpenFixture({ongoing:true,trial:{position_loss_cap_usd:.01}});const r=await tight.run();assert.equal(tight.posts.length,0);assert.match(JSON.stringify(r),/too tight/);
});
test('risk plan sizing: lots from the per-copy budget and the trader stop, broker stop at the multiple, never more than the max lots',()=>{
 const spec={lotSize:100,minLot:.01,maxLot:100,lotStep:.01,quotingCurrency:'USD'},source={contract_size:100,quote_currency:'USD'};
 // Gold: $100 per 1.00 per lot. Trader stop 1.00 away, 1.5x => broker stop 1.50 away = $150 per lot; $50 budget => 0.33 lots, $49.50 risk.
 const a=ongoingSizing(spec,source,100,1,'buy',4000,3999,100,null,{usd:50,multiple:1.5});assert.equal(a.lots,.33);assert.equal(a.stop,3998.5);assert.equal(a.risk,49.5);
 const s=ongoingSizing(spec,source,100,1,'sell',4000,4001,100,null,{usd:50,multiple:1.5});assert.equal(s.stop,4001.5);assert.equal(s.lots,.33);
 // The owner's max lots still caps the size (risk falls below budget).
 const capped=ongoingSizing(spec,source,100,.1,'buy',4000,3999,100,null,{usd:50,multiple:1.5});assert.equal(capped.lots,.1);assert.equal(capped.risk,15);
 // A wide stop is taken smaller (not refused) while it fits the minimum lot...
 const wide=ongoingSizing(spec,source,100,1,'buy',4000,3980,100,null,{usd:50,multiple:1.5});assert.equal(wide.lots,.01);assert.equal(wide.risk,30);
 // ...and refused only when even the minimum lot would risk more than the budget.
 assert.throws(()=>ongoingSizing(spec,source,100,1,'buy',4000,3900,100,null,{usd:50,multiple:1.5}),/BELOW_MIN_LOT/);
 // A stop inside 0.02% of price is refused rather than sent; a position cap below the budget lowers it.
 assert.throws(()=>ongoingSizing(spec,source,100,1,'buy',4000,3999.5,100,null,{usd:50,multiple:1.5}),/TOO_TIGHT/);
 assert.equal(ongoingSizing(spec,source,100,1,'buy',4000,3999,100,25,{usd:50,multiple:1.5}).lots,.16);
});
test('the real open path sends the risk-sized lots and stop to the broker',async()=>{
 const f=bookOpenFixture({ongoing:true,trial:{broker_lots:1,size_mode:'risk',risk_per_trade_usd:50,stop_multiple:1.5,max_trade_risk_usd:100},fill:{qty:.33}});await f.run();
 assert.equal(f.posts.length,1);assert.equal(f.posts[0].qty,.33);assert.equal(f.posts[0].sl,3998.5);
 const refused=bookOpenFixture({ongoing:true,trial:{broker_lots:1,size_mode:'risk',risk_per_trade_usd:1,stop_multiple:1.5}});const r=await refused.run();assert.equal(refused.posts.length,0);assert.match(JSON.stringify(r),/minimum lot exceeds/);
});
