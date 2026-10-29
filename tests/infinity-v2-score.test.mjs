import test from 'node:test';
import assert from 'node:assert/strict';
import {groupCountedTrades, consistencyScore, evaluateStage} from '../supabase/functions/_shared/infinity-v2-score.mjs';
const rules={group_gap_minutes:15,min_hold_seconds:300,score_r_cap:5,sd_floor:0.5,target_pct:4,min_counted_trades:20,stage_score:0.75,combined_score:null,best_day_share:0.35};
const origin=Date.parse('2026-11-01T00:00:00Z');
const at=m=>new Date(origin+m*60000).toISOString();
const trade=(id,open,close,pnl=2,extra={})=>({id,account_id:'a',symbol:'EURUSD',side:'buy',status:'closed',opened_at:at(open),closed_at:at(close),pnl,initial_risk_usd:5,...extra});
test('grouping keeps symbol streams independent and tracks older overlapping legs',()=>{
 const ts=[trade('a',0,100),trade('b',1,6,2,{symbol:'USDJPY'}),trade('c',20,25),trade('d',60,65),trade('e',116,121)];
 const gs=groupCountedTrades(ts,rules);
 assert.deepEqual(gs.map(g=>g.ids),[['a','c','d'],['b'],['e']]);
});
test('15-minute entry boundary is inclusive and accounts and directions stay separate',()=>{
 assert.equal(groupCountedTrades([trade('a',0,5),trade('b',15,20)],rules).length,1);
 assert.equal(groupCountedTrades([trade('a',0,5),trade('b',15.001,20)],rules).length,2);
 assert.equal(groupCountedTrades([trade('a',0,5),trade('b',1,6,2,{side:'sell'}),trade('c',2,7,2,{account_id:'b'})],rules).length,3);
});
test('R uses the sum of opening risks; cap applies only to score, not P&L',()=>{
 const [g]=groupCountedTrades([trade('a',0,5,90),trade('b',1,6,10)],rules);
 assert.equal(g.r,5); assert.equal(g.pnl,100);assert.equal(g.risk,10);
 assert.equal(groupCountedTrades([trade('a',0,5,-90)],rules)[0].r,-5);
});
test('sample sd and floor produce finite scores; invalid risk never becomes a counted observation',()=>{
 const gs=groupCountedTrades([trade('a',0,5,5),trade('b',20,25,5)],rules);
 assert.equal(consistencyScore(gs,rules).score,2*Math.sqrt(2));
 assert.equal(consistencyScore(groupCountedTrades([trade('x',0,5,5,{initial_risk_usd:null})],rules),rules).n,0);
 assert.equal(consistencyScore([],rules).score,0);
});
test('five-minute boundary, excluded profits and fully counted losses',()=>{
 const gs=groupCountedTrades([trade('a',0,4.999,5),trade('b',20,25,5),trade('c',40,41,-3)],rules);
 assert.deepEqual(gs.map(g=>g.eligiblePnl),[0,5,-3]);
});
test('qualification requires target, score, count, concentration and flatness together',()=>{
 const ts=Array.from({length:20},(_,i)=>trade(String(i),i*1440,i*1440+5,2));
 const input={account:{starting_balance:1000,balance:1040},trades:ts,rules};
 assert.equal(evaluateStage(input).eligible,true);
 assert.ok(evaluateStage({...input,pendingCount:1}).unmet.includes('NOT_FLAT'));
 assert.ok(evaluateStage({...input,integrityHold:true}).unmet.includes('INTEGRITY_REVIEW'));
 assert.ok(evaluateStage({...input,account:{starting_balance:1000,balance:1039.99}}).unmet.includes('BALANCE_TARGET'));
 assert.ok(evaluateStage({...input,trades:ts.slice(0,19)}).unmet.includes('COUNTED_TRADES'));
 assert.ok(evaluateStage({...input,rules:{...rules,stage_score:100}}).unmet.includes('STAGE_SCORE'));
});
test('switched runs ignore observations opened before switch; best day uses net total',()=>{
 const ts=[trade('a',0,5,20),trade('b',1440,1445,-5),trade('c',2880,2885,10)];
 assert.equal(evaluateStage({account:{starting_balance:1000,balance:1025},trades:ts,rules}).bestDayShare,20/25);
 assert.equal(groupCountedTrades(ts,rules,at(1)).length,2);
});
test('any consecutive 40 completed decision groups can trigger Stage 4 performance breach',()=>{
 const ts=Array.from({length:41},(_,i)=>trade(String(i),i*20,i*20+5,i===0?1000:-12.5));
 const r=evaluateStage({account:{starting_balance:25000,balance:25500},trades:ts,rules:{...rules,performance_window:40,performance_loss_pct:2}});
 assert.equal(r.performanceBreach,true);
 ts[40].pnl=-12.49;
 assert.equal(evaluateStage({account:{starting_balance:25000,balance:25500},trades:ts,rules:{...rules,performance_window:40,performance_loss_pct:2}}).performanceBreach,false);
});
test('Stage 2 requires both stage and cumulative scores, and Stage 3 requires 50 new groups',()=>{
 const ts=Array.from({length:40},(_,i)=>trade(String(i),i*1440,i*1440+5,10));
 const prior=Array.from({length:20},(_,i)=>trade('p'+i,i*1440,i*1440+5,-25,{account_id:'parent'}));
 const input={account:{starting_balance:5000,balance:5400},trades:ts,lineageTrades:prior,rules:{...rules,target_pct:7,min_counted_trades:40,stage_score:1.25,combined_score:1.65}};
 const r=evaluateStage(input);
 assert.ok(r.stats.score>=1.25);assert.ok(r.unmet.includes('COMBINED_SCORE'));
 const s3=evaluateStage({...input,account:{starting_balance:10000,balance:10800},lineageTrades:[],rules:{...rules,target_pct:8,min_counted_trades:50,stage_score:null,combined_score:2}});
 assert.ok(s3.unmet.includes('COUNTED_TRADES'));
});
test('every consistency threshold rejects just below and accepts just above',()=>{
 for(const [n,stage,combined] of [[20,.75,null],[40,1.25,null],[40,null,1.65],[50,null,2]]){
  const threshold=stage??combined;
  for(const delta of [-1e-6,1e-6]){
   const mean=(threshold+delta)*.5/Math.sqrt(n);
   const trades=Array.from({length:n},(_,i)=>trade(String(i),i*1440,i*1440+5,mean*5));
   const r=evaluateStage({account:{starting_balance:1000,balance:1040},trades,rules:{...rules,min_counted_trades:n,stage_score:stage,combined_score:combined}});
   assert.equal(r.unmet.includes(stage==null?'COMBINED_SCORE':'STAGE_SCORE'),delta<0);
  }
 }
});
