import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const engine=fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts',import.meta.url),'utf8');
test('actual scoped engine helper asks only for active Infinity gold; practice, breached and other symbols do not request a test route',async()=>{
 const code=engine.slice(engine.indexOf('async function scopedCopyTestRoute('),engine.indexOf('async function callBook('));
 const fn=vm.runInNewContext(stripTypeScriptTypes(code)+'\nscopedCopyTestRoute',{inBrainScope:a=>a.challenge_type==='infinity'&&a.phase!=='demo'&&a.status!=='demo'});
 const calls=[],db={rpc:async(name,args)=>{calls.push({name,args});return {data:'a',error:null}}};
 const a={id:'fixture-infinity',user_id:'fixture-user',challenge_type:'infinity',status:'active',phase:'challenge'};
 assert.equal(await fn(db,a,'XAUUSD'),'a');assert.equal(calls[0].args.p_source,a.id);
 for(const [change,symbol]of[[{challenge_type:'demo',status:'demo',phase:'demo'},'XAUUSD'],[{status:'breached'},'XAUUSD'],[{phase:'demo'},'XAUUSD'],[{},'EURUSD']]){
  const before=calls.length;assert.equal(await fn(db,{...a,...change},symbol),null);assert.equal(calls.length,before);
 }
 assert.equal(await fn({rpc:async()=>({data:'a',error:{message:'unavailable'}})},a,'XAUUSD'),null);
});
