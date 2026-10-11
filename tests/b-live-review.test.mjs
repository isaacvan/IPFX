import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {POLICY_V1,decide} from '../supabase/functions/_shared/ab-classifier.ts';
import {bLiveReview} from '../supabase/functions/_shared/b-live-review.ts';
import {solutionOptions} from '../supabase/functions/_shared/brain-solutions.ts';
const DAY=86400000,now=Date.parse('2026-10-11T12:00:00Z'),policy={...POLICY_V1,version:4,stage2AutoTarget:'AB_LIVE',stage2AutoMinTrades:15,stage2AutoMinCopyR:0,maxCopyGapR:.1,herdBlocksAuto:true};
const points=(n,rev=.5)=>Array.from({length:n},(_,i)=>({closedAt:now-(n-i)*DAY,sameR:-rev-.1,reverseR:rev,traderR:-rev,holdSeconds:600}));
const input=(p=points(60),extra={})=>({state:'BB_DEMO',stateSince:now-90*DAY,lastAbExitAt:null,now,points:p,...extra});
test('early watch is separate from live proof and retains missing criteria',()=>{const r=bLiveReview(input(points(10)),policy);assert.equal(r.status,'WATCH');assert.equal(r.can_enable_live,false);assert.equal(r.broker_net_verified,false);assert.ok(r.checks.find(c=>c.label==='Trading days').passed===false);assert.equal(decide(input(points(10)),policy),null);});
test('live-review eligibility reuses exact policy; manual choice is not changed',()=>{for(const manual of[false,true]){const i=input(),r=bLiveReview(i,policy,manual);assert.equal(decide(i,policy).to,'BB_LIVE');assert.equal(r.status,'POLICY_REVIEW');assert.equal(r.manual_override,manual);assert.ok(r.checks.every(c=>c.passed));assert.equal(i.state,'BB_DEMO');}});
test('A-shortcut precedence, suspension, cool-off, fast holds and latency guards do not become B promotion',()=>{
 const a=points(60).map(p=>({...p,sameR:.1,traderR:.1}));assert.equal(bLiveReview(input(a,{stage2ProfitPct:2.75}),policy).status,'OTHER_MODEL');
 assert.equal(bLiveReview(input(undefined,{suspend:'investigation'}),policy).status,'BLOCKED');
 for(const i of[input(undefined,{lastAbExitAt:now-DAY}),input(points(60).map(p=>({...p,holdSeconds:10}))),input(points(60).map(p=>({...p,traderR:1})))]){assert.notEqual(bLiveReview(i,policy).status,'POLICY_REVIEW');assert.equal(decide(i,policy),null);}
});
test('cost drag, small samples, invalid/future evidence and selected labels cannot claim execution',()=>{
 assert.equal(bLiveReview(input(points(9)),policy).status,'BUILDING');assert.equal(bLiveReview(input(points(60,-.1)),policy).status,'BUILDING');
 assert.equal(bLiveReview(input([{...points(1)[0],reverseR:NaN}]),policy).status,'UNAVAILABLE');assert.equal(bLiveReview(input([{...points(1)[0],closedAt:now+1}]),policy).status,'UNAVAILABLE');
 const r=bLiveReview(input(undefined,{state:'BB_LIVE'}),policy);assert.equal(r.status,'SELECTED');assert.equal(r.broker_net_verified,false);
});
test('seeded streams: recommendation never invents a live-policy qualification',()=>{let seed=932;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32};for(let k=0;k<1000;k++){const ps=points(10+Math.floor(rnd()*90)).map(p=>{const rev=rnd()*3-1;return{...p,reverseR:rev,sameR:-rev-.1,traderR:-rev,holdSeconds:rnd()<.1?20:120}});const i=input(ps,{stateSince:now-rnd()*100*DAY});const r=bLiveReview(i,policy);assert.equal(r.status==='POLICY_REVIEW',decide(i,policy)?.to==='BB_LIVE');}});
test('B review solution buttons review the model rather than warn/pause a losing trader',()=>{assert.deepEqual(solutionOptions({key:'trader:b-review:synthetic',category:'trader',person_id:'synthetic',severity:'info'}).map(x=>x.kind),['review_model','recheck']);});
test('owner panel distinguishes stale criteria, hypothetical costs, absent reference and unavailable destination',()=>{const source=fs.readFileSync(new URL('../assets/js/team-brain.js',import.meta.url),'utf8'),start=source.indexOf('  function renderBReview('),end=source.indexOf('  function ukTradeTime(',start),c={data:{policy:{version:4}},Date,Number,esc:x=>String(x??'').replaceAll('<','&lt;'),fin:x=>x!=null&&Number.isFinite(Number(x)),exactUsd:x=>x==null?'Unavailable':String(x)};vm.createContext(c);vm.runInContext(source.slice(start,end)+'\nglobalThis.render=renderBReview',c);const m={b_review:bLiveReview(input(),policy),as_of:new Date().toISOString()},p={book_state:'BB_DEMO'};
 const h=c.render(m,p,{BB_LIVE:{available:false,reason:'No live connection'}},null);assert.match(h,/Review for B-book live/);assert.match(h,/Actual E8 net: Unverified/);assert.match(h,/summary unavailable/);assert.match(h,/No live connection/);assert.doesNotMatch(h,/data-model/);
 assert.match(c.render({...m,as_of:'2020-01-01'},p,{},null),/Stale assessment/);assert.match(c.render(m,{book_state:'AB_DEMO'}, {},null),/Stale assessment/);assert.match(c.render(m,p,{}, {window_days:30,source_closed_roots:3,captured_roots:2,b_roots:2,a_roots:0,sample_limit:200,sampled_roots:2,complete_gross_roots:1,gross_usd:null}),/E8 reverse gross estimate: Unavailable/);
});
