import assert from "node:assert/strict";
import test from "node:test";
import { detectStrategyFingerprint, fingerprintDistance, type StrategyTrade } from "../lib/strategy-profile.ts";

function trades(options: { count:number; holdMinutes:number; symbol?:string; side?:"buy"|"sell"; volume?:(i:number)=>number; pnl?:(i:number)=>number; gapMinutes?:number; stop?:boolean; target?:boolean; startHour?:number }): StrategyTrade[] {
  const base=new Date(`2026-01-05T${String(options.startHour??8).padStart(2,"0")}:00:00Z`).getTime();
  const gap=options.gapMinutes??60;
  return Array.from({length:options.count},(_,i)=>{
    const openedAt=new Date(base+i*gap*60000), entry=1.1+i*.0001;
    return {id:`t${i}`,symbol:options.symbol??"EURUSD",side:options.side??(i%2?"sell":"buy"),openedAt,closedAt:new Date(openedAt.getTime()+options.holdMinutes*60000),volume:options.volume?.(i)??.1,entryPrice:entry,exitPrice:entry+.0002,stopLoss:options.stop===false?null:entry-.001,takeProfit:options.target===false?null:entry+.002,pnl:options.pnl?.(i)??(i%3===0?-10:15)};
  });
}

test("requires enough valid trades before assigning a strategy",()=>{
  const result=detectStrategyFingerprint(trades({count:7,holdMinutes:5}));
  assert.equal(result.status,"insufficient_evidence");
  assert.equal(result.primaryStyle,"insufficient_evidence");
  assert.deepEqual(result.labels,[]);
});

test("detects an interpretable scalping and systematic-sizing fingerprint",()=>{
  const result=detectStrategyFingerprint(trades({count:24,holdMinutes:5,gapMinutes:30,stop:true,target:true}));
  assert.equal(result.status,"descriptive");
  assert.equal(result.primaryStyle,"scalping");
  const labels=new Set(result.labels.map(x=>x.label));
  assert.ok(labels.has("scalping"));
  assert.ok(labels.has("instrument_specialist"));
  assert.ok(labels.has("systematic_sizing"));
  assert.ok(labels.has("stop_defined"));
  assert.ok(labels.has("target_defined"));
  assert.equal(result.features.topSymbol,"EURUSD");
});

test("detects swing holding horizon without claiming trend or mean reversion",()=>{
  const result=detectStrategyFingerprint(trades({count:12,holdMinutes:60*48,gapMinutes:60*72,symbol:"XAUUSD"}));
  assert.equal(result.primaryStyle,"swing");
  assert.ok(result.labels.some(x=>x.label==="swing"));
  assert.ok(result.limitations.some(x=>x.includes("market-context")));
});

test("flags rapid post-loss resizing as review evidence, not an outcome",()=>{
  const source=trades({count:14,holdMinutes:5,gapMinutes:10,pnl:i=>i%2===0?-10:8,volume:i=>2**Math.floor((i+1)/2)});
  const result=detectStrategyFingerprint(source);
  const signal=result.labels.find(x=>x.label==="rapid_post_loss_resizing");
  assert.ok(signal);
  assert.match(signal!.summary,/Review context/);
  assert.ok(result.limitations.some(x=>x.includes("never as an automatic failure")));
});

test("fingerprint distance is symmetric and separates unlike styles",()=>{
  const scalp=detectStrategyFingerprint(trades({count:20,holdMinutes:5,gapMinutes:20,symbol:"EURUSD",volume:()=>.1}));
  const swing=detectStrategyFingerprint(trades({count:20,holdMinutes:60*72,gapMinutes:60*96,symbol:"XAUUSD",side:"buy",volume:i=>.1+(i%5)*.3,startHour:20}));
  const ab=fingerprintDistance(scalp,swing),ba=fingerprintDistance(swing,scalp);
  assert.ok(ab!==null&&ab>.2);
  assert.equal(ab,ba);
});

test("invalid rows are excluded and coverage is explicit",()=>{
  const source=trades({count:10,holdMinutes:60});
  source.push({...source[0]!,id:"bad",closedAt:new Date(source[0]!.openedAt.getTime()-1)});
  source[1]={...source[1]!,pnl:null};
  const result=detectStrategyFingerprint(source);
  assert.equal(result.sampleSize,10);
  assert.equal(result.coverage,.9);
});

import { clusterStrategyCohorts, strategyDrift } from "../lib/strategy-profile.ts";

test("complete-link cohorts group similar styles deterministically",()=>{
  const a=detectStrategyFingerprint(trades({count:20,holdMinutes:5,gapMinutes:20,symbol:"EURUSD"}));
  const b=detectStrategyFingerprint(trades({count:20,holdMinutes:8,gapMinutes:25,symbol:"EURUSD"}));
  const c=detectStrategyFingerprint(trades({count:20,holdMinutes:60*72,gapMinutes:60*96,symbol:"XAUUSD",side:"buy",startHour:20}));
  const cohorts=clusterStrategyCohorts([{traderId:"c",profile:c},{traderId:"b",profile:b},{traderId:"a",profile:a}],.3);
  assert.deepEqual(cohorts.map(x=>x.memberIds),[["a","b"]]);
});

test("strategy drift labels material changes and refuses insufficient profiles",()=>{
  const short=detectStrategyFingerprint(trades({count:7,holdMinutes:5}));
  const scalp=detectStrategyFingerprint(trades({count:20,holdMinutes:5,gapMinutes:20,symbol:"EURUSD"}));
  const swing=detectStrategyFingerprint(trades({count:20,holdMinutes:60*72,gapMinutes:60*96,symbol:"XAUUSD",side:"buy",startHour:20}));
  assert.equal(strategyDrift(short,scalp),null);
  assert.equal(strategyDrift(scalp,swing)?.label,"material_change");
});
