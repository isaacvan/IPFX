import test from 'node:test';import assert from 'node:assert/strict';
import {finiteNumber,epochMs,referenceRules,applicableRules,referenceFill,referenceNet,measuredFill,replayReference} from '../supabase/functions/_shared/e8-reference.ts';
test('missing costs/quotes never become measured zero',()=>{
 for(const x of [null,undefined,'',false,[],{},NaN,Infinity])assert.equal(finiteNumber(x),null);
 assert.equal(finiteNumber(0),0);assert.equal(referenceNet('sell',1.1,1.099,1,100000,null),null);
 assert.ok(Math.abs(referenceNet('sell',1.1,1.099,1,100000,7)-93)<1e-8);
});
test('E8 reference buys ask and sells bid; stale/future quotes and missing slippage fail',()=>{
 const q={bid:1.1,ask:1.1002,receivedAt:10000,startedAt:9900,accountId:1,symbol:'EURUSD'};
 assert.equal(referenceFill(q,'sell',10100,500,0).price,1.1);
 assert.equal(referenceFill(q,'buy',10100,500,0).price,1.1002);
 assert.equal(referenceFill(q,'buy',11000,500,0),null);assert.equal(referenceFill(q,'buy',9000,500,0),null);
 assert.equal(referenceFill(q,'buy',10100,500,null),null);
 assert.ok(referenceFill(q,'sell',10100,500,1).price<q.bid);
 assert.match(referenceFill(q,'buy',10100,500,1).basis,/ESTIMATE/);
});
test('provider rate config retains all applicable windows and rejects unknown layouts',()=>{
 const config={d:{rateLimits:[{rateLimitType:'QUOTES',limit:2,intervalNum:1,measure:'SECONDS'},
  {rateLimitType:'GLOBAL',limit:30,intervalNum:1,measure:'MINUTES'}]}};
 const rules=referenceRules(config);assert.deepEqual(rules.map(r=>r.windowMs),[1000,60000]);
 assert.equal(applicableRules(rules,'QUOTES').length,2);assert.equal(applicableRules([],'QUOTES').length,0);
 assert.equal(referenceRules({rateLimits:[{rateLimitType:'QUOTES',limit:20,intervalNum:1,measure:'HOURS'}]}).length,0);
 assert.equal(referenceRules({rateLimits:{QUOTES:{limit:2,intervalNum:1,measure:'SECONDS'}}}).length,1);
});

test('instrument specifications retain provider-specific and shared pacing windows',()=>{
 const rules=[{type:'GET_INSTRUMENT_DETAILS',limit:2,windowMs:1000},{type:'GLOBAL',limit:20,windowMs:60000},{type:'QUOTES',limit:10,windowMs:1000}];
 assert.deepEqual(applicableRules(rules,'INSTRUMENT_DETAILS').map(x=>x.type),['GLOBAL','GET_INSTRUMENT_DETAILS']);
 assert.equal(applicableRules([{type:'QUOTES',limit:10,windowMs:1000}],'INSTRUMENT_DETAILS').length,0);
});
test('fill revisions keep changed fee/swap values and unknown fees remain incomplete',()=>{
 const row={id:'1234567890123456789',status:'filled',filledQty:.1,avgPrice:1.1,lastModified:1791388800000,tradableInstrumentId:1,commission:0,fee:0,swap:0};
 const names=new Map([['1','EURUSD']]);const first=measuredFill(row,1,'monitor',names);
 assert.equal(first.ref,row.id);assert.equal(first.costs_complete,true);assert.equal(first.commission,0);
 assert.equal(measuredFill({...row,swap:-2},1,'monitor',names).swap,-2);
 assert.equal(measuredFill({...row,fee:undefined},1,'monitor',names).costs_complete,false);
 assert.equal(measuredFill({...row,status:'rejected'},1,'monitor',names),null);
 assert.equal(epochMs(1791388800),1791388800000);
});
const replay={accountId:1,symbol:'EURUSD',traderSide:'buy',book:'b',lots:1,openedAt:1000,
 closes:[{at:20000,lots:.25},{at:30000,lots:.75}],scaleUSD:100000,feesUSD:7,adverseBps:0,minDelayMs:100,maxWaitMs:15000,assumptionSource:'Verified test assumptions'};
const quotes=[{bid:1.1,ask:1.1002,startedAt:1100,receivedAt:1200,accountId:1,symbol:'EURUSD'},
 {bid:1.099,ask:1.0992,startedAt:20100,receivedAt:20200,accountId:1,symbol:'EURUSD'},
 {bid:1.098,ask:1.0982,startedAt:30100,receivedAt:30200,accountId:1,symbol:'EURUSD'}];
test('reverse and same-direction replay account for two partial exits, spread and explicit fees',()=>{
 const b=replayReference(replay,quotes),a=replayReference({...replay,book:'a'},quotes);
 assert.equal(b.available,true);assert.ok(Math.abs(b.netUSD-148)<1e-8);assert.ok(Math.abs(a.netUSD+202)<1e-8);
 assert.equal(b.slices.length,2);assert.equal(b.entrySamplingWaitMs,200);
 assert.ok(a.netUSD+b.netUSD<0,'spread and fees prevent symmetric zero-sum results');
});
test('a sampled quote is not a future-free fill and missing coverage is never zero P&L',()=>{
 assert.equal(replayReference(replay,quotes.slice(0,2)).reason,'EXIT_REFERENCE_MISSING');
 assert.equal(replayReference({...replay,feesUSD:null},quotes).netUSD,null);
 assert.equal(replayReference({...replay,closes:[{at:30000,lots:.5}]},quotes).reason,'CLOSE_QUANTITY_MISMATCH');
 assert.equal(replayReference(replay,quotes.map(q=>({...q,accountId:2}))).reason,'ENTRY_REFERENCE_MISSING');
 assert.equal(replayReference(replay,quotes.map(q=>({...q,startedAt:q.startedAt-500}))).reason,'ENTRY_REFERENCE_MISSING');
 assert.equal(replayReference({...replay,adverseBps:10000},quotes).available,false);
});
test('official SDK GET_ORDERS_HISTORY rule applies to history, not quote budget',()=>{
 const rules=referenceRules({rateLimits:[{rateLimitType:'GET_ORDERS_HISTORY',limit:2,intervalNum:1,measure:'MINUTES'}]});
 assert.equal(applicableRules(rules,'ORDERS_HISTORY').length,1);assert.equal(applicableRules(rules,'QUOTES').length,0);
});
