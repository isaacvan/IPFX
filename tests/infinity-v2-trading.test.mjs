import test from 'node:test';import assert from 'node:assert/strict';
import {validateStop,validateRisk,pauseRemainingSeconds,referencePricing} from '../supabase/functions/_shared/infinity-v2-trading.mjs';
const rules={stop_spread_multiple:8,total_risk_multiple:3,stop_pause_seconds:600};
test('buy and sell stop minimum, directional tightening, widening and break-even',()=>{
 const buy={side:'buy',entry:100,price:100,bid:99.95,ask:100.05,newStop:99.2,rules};
 assert.equal(validateStop(buy),null);
 assert.equal(validateStop({...buy,newStop:99.21}),'STOP_TOO_CLOSE');
 assert.equal(validateStop({...buy,oldStop:99.3}),'STOP_CANNOT_WIDEN');
 assert.equal(validateStop({...buy,oldStop:99,newStop:100,price:102}),null);
 const sell={...buy,side:'sell',newStop:100.8};
 assert.equal(validateStop(sell),null);
 assert.equal(validateStop({...sell,oldStop:100.7}),'STOP_CANNOT_WIDEN');
});
test('scaling shares a single opening-risk allowance and preserves aggregate allowance',()=>{
 const input={groupOpeningRisk:3,additionalOpeningRisk:2,openRisk:13,additionalOpenRisk:2,perTradeLimit:5,rules};
 assert.equal(validateRisk(input),null);
 assert.equal(validateRisk({...input,additionalOpeningRisk:2.01}),'COUNTED_TRADE_RISK_LIMIT');
 assert.equal(validateRisk({...input,openRisk:13.01}),'TOTAL_OPEN_RISK_LIMIT');
 assert.equal(validateRisk({...input,openRisk:NaN}),'RISK_UNAVAILABLE');
});
test('pause expires at exactly ten minutes',()=>{
 const stop='2026-11-01T00:00:00Z', t=Date.parse(stop);
 assert.equal(pauseRemainingSeconds(stop,t,rules),600);
 assert.equal(pauseRemainingSeconds(stop,t+599999,rules),1);
 assert.equal(pauseRemainingSeconds(stop,t+600000,rules),0);
});
test('reference spread markup and missing-reference fallback preserve usable prices',()=>{
 const input={mid:100,currentBid:99,currentAsk:101,referenceBid:99.5,referenceAsk:100.5,referenceFresh:true,profile:{spread_markup:1.15}};
 assert.deepEqual(referencePricing(input),{bid:99.425,ask:100.575,fallback:false});
 assert.deepEqual(referencePricing({...input,referenceFresh:false}),{bid:99,ask:101,fallback:true});
});
