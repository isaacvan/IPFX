import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const skip=!process.env.DEMO_TEST_DEPS;
const root=new URL('../',import.meta.url), read=n=>fs.readFileSync(new URL(n,root),'utf8');
const U='22222222-2222-4222-8222-222222222222',V='55555555-5555-4555-8555-555555555555';
async function fixture(){
 const url=new URL('./e8-trader-perf-db.test.mjs',import.meta.url),s=fs.readFileSync(url,'utf8');
 const factory=new Function('fs','pathToFileURL','process','controlSQL','cacheSQL','migration','fixtureURL',
 s.slice(s.indexOf('const U ='),s.indexOf('\nasync function rpc(')).replaceAll('import.meta.url','fixtureURL')+'\nreturn fixture;');
 const db=await factory(fs,pathToFileURL,process,read('supabase/migrations/20261018190000_e8_copy_backtest.sql'),read('supabase/migrations/20261018200000_e8_copy_backtest_cache.sql'),read('supabase/migrations/20261019100000_e8_trader_performance.sql'),url.href)();
 await db.exec(`create table public.ab_risk_limits(book text,per_trade_max_usd numeric,open_risk_max_usd numeric,per_trader_open_max_usd numeric,
 daily_loss_stop_usd numeric,symbol_net_lots_max numeric,room_multiple numeric,crowd_max int);
 insert into public.ab_risk_limits values('a',1000,10000,10000,625,5,2.5,1),('b',1000,10000,10000,625,5,2.5,1);
 update public.trades set sl=3998,tp=4004.4 where user_id='${V}';`);
 await db.exec(read('supabase/migrations/20261019120000_e8_trader_allocator_replay.sql'));
 await db.exec(read('supabase/migrations/20261019190000_e8_trader_allocator_working_set.sql'));
 try { await db.exec(read('supabase/migrations/20261019210000_e8_trader_narrow_path_events.sql')); }
 catch(error){await db.close();throw error;}
 const r=(await db.query('select public.ab_e8_trader_perf_refresh_private() r')).rows[0].r;
 assert.equal(r.ok,true,JSON.stringify(r));return db;
}

test('closed accepted positions retain cash and release crowd/risk in the compact admission set',{skip},async()=>{
 const db=await fixture();try{
 await db.exec(`insert into public.ab_e8_trader_perf_trade_cache
 select 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',latency,slippage,trader_id,fingerprint,computed_at,
 payload||'{"trade_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","in_at":"2026-10-12T10:20:03Z","out_at":"2026-10-12T10:30:06Z"}'::jsonb,minute_path
 from public.ab_e8_trader_perf_trade_cache where trader_id='${U}' and latency=2 and slippage=0;`);
 const a=(await db.query("select public.ab_e8_trader_perf_admit($1,'a',2,0) r",[[U]])).rows[0].r;
 assert.equal(a.accepted,2);assert.equal(a.rejected,0);
 }finally{await db.close();}
});
test('shared allocator rejects crowding at entry, preserves lots and reveals refusal reasons',{skip},async()=>{
 const db=await fixture();try{
 const a=(await db.query("select public.ab_e8_trader_perf_admit($1,'a',2,0) r",[[U,V]])).rows[0].r;
 assert.equal(a.accepted,1);assert.equal(a.rejected,1);assert.match(a.rejections[0].reason,/crowd cap/);
 const p=(await db.query("select public.ab_e8_trader_perf_portfolio($1,'a',2,0) r",[[U,V]])).rows[0].r;
 assert.equal(p.available,true);assert.equal(p.risk_policy_enforced,true);assert.equal(p.crowding.policy_enforced,true);
 assert.ok(Math.abs(p.net-12.24)<.00001);assert.equal(p.admission.accepted,1);assert.equal(p.executable,false);
 await db.exec('update public.ab_risk_limits set crowd_max=5 where true');await db.query('select public.ab_e8_trader_perf_refresh_private()');
 assert.equal((await db.query("select public.ab_e8_trader_perf_admit($1,'a',2,0) r",[[U,V]])).rows[0].r.accepted,2);
 }finally{await db.close();}
});
test('missing risk inputs, absent policy and insufficient room fail closed without changing source trades',{skip},async()=>{
 const db=await fixture();try{
 await db.exec('update public.ab_risk_limits set per_trade_max_usd=1 where true');await db.query('select public.ab_e8_trader_perf_refresh_private()');
 const a=(await db.query("select public.ab_e8_trader_perf_admit($1,'a',2,0) r",[[U,V]])).rows[0].r;
 assert.equal(a.accepted,0);assert.equal(a.rejected,2);assert.ok(a.rejections.every(x=>/risk room/.test(x.reason)));
 await db.exec("update public.ab_e8_trader_perf_cache set metadata=metadata-'risk_policy' where id=1");
 assert.equal((await db.query("select public.ab_e8_trader_perf_admit($1,'a',2,0) r",[[U]])).rows[0].r.available,false);
 assert.equal((await db.query('select count(*) n from public.trades')).rows[0].n,3);
 assert.equal((await db.query("select has_function_privilege('anon','public.ab_e8_trader_perf_admit(uuid[],text,int,int)','execute') yes")).rows[0].yes,false);
 }finally{await db.close();}
});
