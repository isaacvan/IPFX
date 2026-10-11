import fs from'node:fs';import vm from'node:vm';import test from'node:test';import assert from'node:assert/strict';
import {decodeAccountState,reconcileAccountTotals} from '../supabase/functions/_shared/e8-account-totals.ts';
import {applicableRules} from '../supabase/functions/_shared/e8-reference.ts';
const ids=['todayGross','todayNet','todayFees','openGrossPnL','openNetPnL','positionsCount'];
const config={accountDetailsConfig:{columns:ids.map(id=>({id}))}},reply=(values=[.07,.01,.06,0,0,0])=>({d:{accountDetailsData:values}});
test('supported exact config decoding reconciles the observed gold result without guessing per-trade fees',()=>{const r=decodeAccountState(config,reply());assert.equal(r.values.todayNet,.01);assert.equal(r.reconciliation.status,'CONSISTENT_POSITIVE_FEE');assert.equal(r.currency,null);assert.equal(r.trade_net_verified,false);assert.equal(r.period_basis,'BROKER_TODAY_BOUNDARY_UNCONFIRMED');assert.equal(r.values.balance,null);});
test('blank/null/Boolean/objects/nonfinite fields stay unknown, explicit zero and fee credits survive',()=>{
 for(const value of[null,'',false,{},Infinity,'NaN']){const r=decodeAccountState(config,reply([.07,.01,value,0,0,0]));assert.equal(r.values.todayFees,null);assert.equal(r.reconciliation.status,'INCOMPLETE');}
 assert.equal(reconcileAccountTotals(.07,.01,-.06).status,'CONSISTENT_SIGNED_FEE');assert.equal(reconcileAccountTotals(0,0,0).status,'ZERO_REPORTED_DIFFERENCE');assert.equal(reconcileAccountTotals(1,1.5,-.5).status,'CONSISTENT_POSITIVE_FEE');assert.equal(decodeAccountState(config,reply([0,0,0,0,0,1.1])).values.positionsCount,null);
});
test('schema width, duplicate names, unexpected object layout fail closed and private extra values are excluded',()=>{
 assert.throws(()=>decodeAccountState(config,reply([1])),/MISMATCH/);assert.throws(()=>decodeAccountState({accountDetailsConfig:{columns:[{id:'todayFees'},{id:'todayFees'}]}},reply([1,2])),/AMBIGUOUS/);assert.throws(()=>decodeAccountState(config,{d:{accountDetailsData:{todayFees:1}}}),/MISMATCH/);
 const r=decodeAccountState({accountDetailsConfig:{columns:[...config.accountDetailsConfig.columns,{id:'privateField'}]}},reply([0,0,0,0,0,0,'SYNTHETIC_PRIVATE']));assert.ok(!JSON.stringify(r).includes('SYNTHETIC_PRIVATE'));
});
test('aggregate changes cannot identify per-trade commission, swaps or payout income',()=>{
 // Identical totals may come from one gold trade or overlapping trades; neither verifies a trader.
 assert.equal(decodeAccountState(config,reply()).trade_net_verified,false);
 assert.equal(reconcileAccountTotals(10,8,1).status,'UNATTRIBUTED_DIFFERENCE','extra swap or timing remains unknown');
 assert.equal(reconcileAccountTotals(100,100,6).status,'UNATTRIBUTED_DIFFERENCE','gross and fee timings can differ');
 // Balance deltas can include a payout/correction and must not be treated as fees.
 const extended={accountDetailsConfig:{columns:[...config.accountDetailsConfig.columns,{id:'balance'}]}};
 const a=decodeAccountState(extended,reply([.07,.01,.06,0,0,0,49000])),b=decodeAccountState(extended,reply([.07,.01,.06,0,0,0,48000]));assert.equal(a.reconciliation.status,b.reconciliation.status);assert.equal(b.trade_net_verified,false);
});
test('only documented global/account-state limits can admit the extra GET',()=>{
 assert.equal(applicableRules([{type:'GET_ACCOUNTS_STATE',limit:4,windowMs:2000}],'ACCOUNT_STATE').length,1);assert.equal(applicableRules([{type:'QUOTES',limit:10,windowMs:1000}],'ACCOUNT_STATE').length,0);
});
test('reported-totals renderer keeps missing values, stale quotes, untrusted labels and whole-account scope explicit',()=>{const c={window:{},Date,Number};vm.createContext(c);vm.runInContext(fs.readFileSync(new URL('../assets/js/e8-account-totals.js',import.meta.url),'utf8'),c);const r={label:'<img onerror=alert(1)>',fresh:true,received_at:new Date().toISOString(),amounts:{todayGross:.07,todayNet:.01,todayFees:.06},reconciliation:{status:'CONSISTENT_POSITIVE_FEE'}};
 const h=c.window.IPFXE8AccountTotals.render([r]);assert.match(h,/0\.01/);assert.match(h,/Unavailable/);assert.match(h,/whole-account/);assert.match(h,/unconfirmed reset/);assert.doesNotMatch(h,/<img/);assert.match(c.window.IPFXE8AccountTotals.render([{...r,received_at:'2020-01-01'}]),/Stale/);assert.match(c.window.IPFXE8AccountTotals.render(null),/unavailable/);
});
