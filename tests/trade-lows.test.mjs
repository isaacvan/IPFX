import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {fixture,account,user,root,slice} from './helpers/e8-db-fixture.mjs';
async function setup(){
 const f=await fixture({atomic:true});
 await f.db.exec(`create table low_test_time(at timestamptz);insert into low_test_time values('2026-10-08T10:00:00Z');
 create function low_test_clock() returns timestamptz language sql stable as 'select at from public.low_test_time';
 create table quote_ticks(symbol text,ts timestamptz,mid numeric,bid numeric,ask numeric);
 create index on quote_ticks(symbol,ts desc);
 create view ipfx_sim_decision_results as select null::uuid trade_id,null::text status,null::numeric selected_gross_usd where false;
 create table ipfx_sim_pending_state(person_id uuid,captured_at timestamptz);
 insert into symbol_specs values('XAUUSD','USD',100),('GBPJPY','JPY',100000);
 `);
 await f.db.exec(fs.readFileSync(new URL('../supabase/migrations/20261008120000_trade_duration_and_lows.sql',import.meta.url),'utf8')
  .replaceAll('clock_timestamp()','public.low_test_clock()'));
 const trade=async({id=root,symbol='EURUSD',side='buy',lots=.2,entry=1.1,age=600,closed=120}={})=>f.db.exec(`
 insert into trades(id,account_id,user_id,symbol,side,volume,status,open_price,opened_at,closed_at)
 values('${id}','${account}','${user}','${symbol}','${side}',${lots},'${closed==null?'open':'closed'}',${entry},
 low_test_clock()-interval '${age} seconds',${closed==null?'null':`low_test_clock()-interval '${closed} seconds'`});`);
 const tick=async(age,bid,ask,symbol='EURUSD')=>f.db.exec(`insert into quote_ticks values('${symbol}',low_test_clock()-interval '${age} seconds',(${bid}::numeric+${ask}::numeric)/2,${bid},${ask});`);
 const run=()=>f.db.query('select ipfx_trade_low_tick()');
 const activity=async()=>(await f.db.query('select ab_brain_live_activity($1) a',[user])).rows[0].a.source_trades;
 return {...f,trade,tick,run,activity};
}
test('closed duration is exact; buy lows use bid, sell lows use ask and exclude before/after lifetime',async()=>{
 const f=await setup();try{
 await f.trade();await f.tick(700,1.01,1.0102);await f.tick(500,1.097,1.0972);await f.tick(250,1.101,1.103);
 await f.tick(60,1.01,1.0102);await f.run();let rows=await f.activity();
 assert.equal(rows[0].hold_seconds,480);assert.equal(rows[0].lowest_pnl_usd,-60);assert.equal(rows[0].lowest_pnl_status,'OBSERVED_QUOTES');
 const sell='55555555-5555-4555-8555-555555555555';await f.trade({id:sell,side:'sell'});await f.run();
 rows=await f.activity();assert.equal(rows.find(x=>x.id===sell).lowest_pnl_usd,-60);
 await f.db.exec('delete from quote_ticks');assert.equal((await f.activity()).find(x=>x.id===root).lowest_pnl_usd,-60);
 assert.equal((await f.db.query('select complete from ipfx_trade_lows where trade_id=$1',[root])).rows[0].complete,true);
 }finally{await f.db.close();}
});
test('opening spread, positive-only lows and missing old history never become invented zero losses',async()=>{
 const f=await setup();try{
 await f.tick(610,1.0998,1.1);await f.trade();await f.run();
 assert.equal((await f.activity())[0].lowest_pnl_usd,-4);
 await f.trade({id:'66666666-6666-4666-8666-666666666666',entry:1.099,age:500});await f.tick(400,1.100,1.1002);await f.run();
 assert.equal((await f.activity()).find(x=>x.id.startsWith('666')).lowest_pnl_usd,20);
 await f.trade({id:'77777777-7777-4777-8777-777777777777',age:86400,closed:86400-600});await f.run();
 const old=(await f.activity()).find(x=>x.id.startsWith('777'));
 assert.equal(old.hold_seconds,600);assert.equal(old.lowest_pnl_usd,null);assert.equal(old.lowest_pnl_status,'UNAVAILABLE_QUOTES');
 }finally{await f.db.close();}
});
test('partial exits inherit prior lows for their lots but cannot inherit later losses',async()=>{
 const f=await setup();try{
 await f.trade({lots:1,closed:null});await f.tick(60,1.099,1.0992);await f.run();
 await f.db.exec(`update trades set volume=.75 where id='${root}';
 insert into trades(id,parent_trade_id,account_id,user_id,symbol,side,volume,status,open_price,opened_at,closed_at,close_reason)
 values('${slice}','${root}','${account}','${user}','EURUSD','buy',.25,'closed',1.1,
 low_test_clock()-interval '600 seconds',low_test_clock(),'partial');
 update low_test_time set at=at+interval '60 seconds';`);
 await f.tick(20,1.097,1.0972);await f.run();
 const rows=await f.activity(),p=rows.find(x=>x.id===root),s=rows.find(x=>x.id===slice);
 assert.equal(p.volume,.75);assert.equal(p.lowest_pnl_usd,-225);assert.equal(s.volume,.25);assert.equal(s.lowest_pnl_usd,-25);
 assert.equal(s.hold_seconds,600);assert.equal(s.parent_trade_id,root);
 }finally{await f.db.close();}
});
test('historical currency conversion is contemporaneous and missing conversion stays unavailable',async()=>{
 const f=await setup();try{
 await f.trade({symbol:'USDJPY',side:'sell',entry:150,lots:.1});await f.tick(300,150.8,151,'USDJPY');await f.run();
 assert.equal((await f.activity())[0].lowest_pnl_usd,-66.27);
 await f.trade({id:'88888888-8888-4888-8888-888888888888',symbol:'GBPJPY',entry:190});
 await f.tick(200,189.5,189.7,'GBPJPY');await f.run();
 const cross=(await f.activity()).find(x=>x.symbol==='GBPJPY');assert.equal(cross.lowest_pnl_usd,null);assert.equal(cross.lowest_pnl_status,'UNAVAILABLE_QUOTES');
 }finally{await f.db.close();}
});
test('retention gaps are explicit, batching is bounded and public roles cannot inspect trade lows',async()=>{
 const f=await setup();try{
 await f.trade({age:36000,closed:null});await f.tick(60,1.099,1.0992);await f.run();
 assert.equal((await f.activity())[0].lowest_pnl_status,'INCOMPLETE_HISTORY');
 await assert.rejects(f.db.query('select ipfx_trade_low_tick(501)'),/Batch/);
 await f.db.exec('set role authenticated');await assert.rejects(f.db.query('select * from ipfx_trade_lows'),/permission/);
 await assert.rejects(f.db.query('select ipfx_trade_low_tick()'),/permission/);await f.db.exec('reset role');
 assert.equal((await f.db.query('select execution_enabled from ladder_accounts')).rows[0].execution_enabled,false);
 }finally{await f.db.close();}
});
test('a changed entry cannot silently reuse an old-entry P&L low; invalid quotes do not become zero',async()=>{
 const f=await setup();try{
 await f.trade({closed:null});await f.tick(60,1.099,1.0992);await f.run();
 await f.db.exec(`update trades set open_price=1.098 where id='${root}'`);
 assert.equal((await f.activity())[0].lowest_pnl_usd,null);assert.equal((await f.activity())[0].lowest_pnl_status,'UNAVAILABLE_ENTRY_CHANGED');
 await f.trade({id:'99999999-9999-4999-8999-999999999999',symbol:'XAUUSD',entry:2000});
 await f.tick(300,1990,1980,'XAUUSD');await f.tick(250,1990,'\'Infinity\'','XAUUSD');await f.run();
 const gold=(await f.activity()).find(x=>x.symbol==='XAUUSD');assert.equal(gold.lowest_pnl_usd,null);assert.equal(gold.lowest_pnl_status,'UNAVAILABLE_QUOTES');
 }finally{await f.db.close();}
});
