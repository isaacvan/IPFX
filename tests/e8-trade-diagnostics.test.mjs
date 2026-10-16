import test from 'node:test';import assert from 'node:assert/strict';
import {diagnoseTradeEvidence,loadTradeDiagnostic} from '../supabase/functions/_shared/e8-trade-diagnostics.ts';
const start=Date.parse('2026-10-15T19:46:00Z'),at=n=>new Date(start+n).toISOString();
const opening='360287970200000001',closing='360287970200000002',position='360287970100000001';
function fixture(){
 const root={id:1,event:'open',book:'l3',source_trade_id:'synthetic-trade',status:'filled',broker_order_id:opening,broker_position_id:position,qty:.01,side:'buy',fill_price:1.12125,price_scale_per_lot:100000,ongoing_prior_position_ids:[]};
 const exit={...root,id:2,event:'close',side:'sell',status:'closed',dispatch_state:'confirmed',broker_order_id:closing,fill_price:1.12134};
 const fill=(ref,qty,price,side,isOpen,created)=>({account_id:3,ref,qty,price,side,symbol:'EURUSD.C',filled_at:at(created),raw:{id:ref,positionId:position,isOpen,status:'Filled',createdDate:String(start+created),tradableInstrumentId:'6155'}});
 const before={id:10,account_id:3,requested_at:at(-2000),received_at:at(-1000),currency:null,amounts:{balance:1000,todayNet:-7.34,todayGross:-6.62,todayFees:.72,positionsCount:0,ordersCount:0}};
 const after={...structuredClone(before),id:11,requested_at:at(55000),received_at:at(55100),amounts:{...before.amounts,balance:1000.04,todayNet:-7.30,todayGross:-6.53,todayFees:.77}};
 const settled={...structuredClone(after),id:12,requested_at:at(115000),received_at:at(115100)};
 const fills=[fill(opening,.01,1.12125,'buy',true,2300),fill(closing,.01,1.12134,'sell',false,52600)];
 return{accountId:3,root,exits:[exit],source:{id:'synthetic-trade',symbol:'EURUSD',status:'closed',opened_at:at(2000),closed_at:at(40300),close_requested_at:at(40000)},fills,
  dispatches:[{operation_id:1,sent_at:at(2200),ack_ms:50,receipt_lookup_ms:400,fill_confirmed:true,quote_snapshot:{account_id:3,instrument_id:'6155',route_id:9,bid:1.12119,ask:1.12130,requested_at:at(2100),received_at:at(2150),broker_quote_at:null}},{operation_id:2,sent_at:at(52400),ack_ms:60,receipt_lookup_ms:300,fill_confirmed:true}],
  before,after:[after,settled],intervalFills:structuredClone(fills),historyHealthy:true,contract:{account_id:3,instrument_id:'6155',lot_size:100000,quote_currency:'USD',observed_at:at(-3600000)}};
}
test('exact receipts separate broker gross, source/dispatch delays and a reviewable balance-cost candidate',()=>{
 const d=diagnoseTradeEvidence(fixture());assert.equal(d.available,true);assert.equal(d.brokerGrossUsd,.09);assert.equal(d.netVerified,false);assert.equal(d.canEnableLive,false);
 assert.equal(d.timing[1].sourceToDispatchMs,12400);assert.equal(d.timing[1].sourceToBrokerOrderMs,12600);
 assert.ok(Math.abs(d.timing[0].quoteShortfallUsd+.05)<1e-8);assert.equal(d.timing[0].providerQuoteAgeMs,null);
 const b=d.balanceCandidate;assert.equal(b.available,true);assert.ok(Math.abs(b.accountNet-.04)<1e-8);assert.ok(Math.abs(b.combinedCost-.05)<1e-8);
 assert.ok(Math.abs(b.costPerLot-5)<1e-8);assert.equal(b.currency,null);assert.equal(b.commission,null);assert.equal(b.swap,null);assert.equal(b.netVerified,false);
});
test('missing dispatches and future, stale, wrong-account or wrong-instrument quotes never become zero delay or slippage',()=>{
 const f=fixture();f.dispatches=[];let d=diagnoseTradeEvidence(f);assert.equal(d.timing[0].sourceToDispatchMs,null);assert.equal(d.timing[0].brokerAckMs,null);assert.equal(d.timing[0].quoteShortfall,null);
 for(const change of[{account_id:4},{instrument_id:'6148'},{received_at:at(2300)},{received_at:at(500)},{bid:0}]){const x=fixture();Object.assign(x.dispatches[0].quote_snapshot,change);assert.equal(diagnoseTradeEvidence(x).timing[0].quoteShortfall,null);}
});
test('wrong identities, sides, quantities, reused positions or unconfirmed exits refuse a completed diagnostic',()=>{
 const changes=[x=>x.root.book='l4',x=>x.source.status='open',x=>x.root.ongoing_prior_position_ids=[position],x=>x.exits[0].dispatch_state='unknown',x=>x.exits[0].broker_position_id='999',x=>x.exits[0].broker_order_id=Number(closing),x=>x.exits[0].qty=.005,x=>x.fills[1].side='buy',x=>x.fills[0].account_id=4,x=>x.fills[1].raw.isOpen=true,x=>x.fills[1].raw.id='999',x=>x.fills[1].raw.tradableInstrumentId='6148',x=>x.fills[1].raw.positionId=Number(position),x=>x.fills[1].price=1.2,x=>x.fills.push(structuredClone(x.fills[1]))];
 for(const change of changes){const x=fixture();change(x);assert.equal(diagnoseTradeEvidence(x).available,false);}
});
test('overlap, unstable postings, currency conflicts, missing fees or rollover-like daily totals prevent cost allocation',()=>{
 const changes=[x=>x.before=null,x=>x.before.account_id=4,x=>x.before.amounts.positionsCount=1,x=>x.after[0].amounts.ordersCount=1,x=>x.after[1].amounts.balance+=.01,x=>x.after[1].currency='EUR',x=>delete x.after[0].amounts.todayFees,x=>x.after[0].amounts.todayGross=0,x=>x.historyHealthy=false,x=>x.intervalFills.push({...x.intervalFills[1],ref:'999'}),x=>x.intervalFills[0].account_id=4,x=>x.after=x.after.slice(0,1)];
 for(const change of changes){const x=fixture();change(x);const d=diagnoseTradeEvidence(x);assert.equal(d.available,true);assert.equal(d.balanceCandidate.available,false);assert.equal(d.balanceCandidate.netVerified,false);}
});
test('foreign currency is never mixed with USD gross; mismatching balances refuse allocation',()=>{
 const f=fixture();for(const s of[f.before,...f.after])s.currency='EUR';const d=diagnoseTradeEvidence(f);assert.equal(d.balanceCandidate.available,false);assert.equal(d.balanceCandidate.netVerified,false);
 f.after[0].amounts.balance+=5;assert.equal(diagnoseTradeEvidence(f).balanceCandidate.available,false);
});
test('contract evidence must predate entry and match exact account, instrument, USD and lot size',()=>{
 for(const change of[x=>x.contract=null,x=>x.contract.account_id=4,x=>x.contract.instrument_id='6148',x=>x.contract.lot_size=100,x=>x.contract.quote_currency='JPY',x=>x.contract.observed_at=at(5000)]){const f=fixture();change(f);assert.equal(diagnoseTradeEvidence(f).available,false);}
});
test('loader scopes the position to the exact saved book, uses bounded saved reads, and never writes or contacts a provider',async()=>{
 const f=fixture(),calls=[];let snapshots=0,fillReads=0;
 const db={from:table=>{const filters=[],q={select(){return q},eq(k,v){filters.push([k,v]);return q},neq(){return q},in(){return q},order(){return q},lt(){return q},gt(){return q},gte(){return q},lte(){return q},limit(n){assert.ok(n<=1001);return q},maybeSingle(){return q},
  then(resolve){calls.push({table,filters});let data;
   if(table==='book_orders')data=filters.some(([k,v])=>k==='event'&&v==='open')?f.root:f.exits;
   else if(table==='trades')data=f.source;
   else if(table==='cost_fills')data=++fillReads===1?f.fills:f.intervalFills;
   else if(table==='e8_dispatch_evidence')data=f.dispatches;
   else if(table==='e8_monitor_profiles')data={history_error_code:null,last_history_at:at(200000)};
   else if(table==='e8_instrument_evidence')data=f.contract;
   else if(table==='e8_account_snapshots')data=++snapshots===1?[f.before]:f.after;
   else throw Error('Unexpected read');resolve({data,error:null});}};return q;}};
 const d=await loadTradeDiagnostic(db,3,position);assert.equal(d.available,true);assert.equal(d.balanceCandidate.available,true);
 assert.ok(calls[0].filters.some(([k,v])=>k==='book'&&v==='l3'));assert.ok(calls[0].filters.some(([k,v])=>k==='broker_position_id'&&v===position));assert.equal(calls.length,10);
});
