import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,account,user,root,slice} from './helpers/e8-db-fixture.mjs';
const deps=process.env.DEMO_TEST_DEPS;

test('automatic replay keeps correct reverse spreads, partial weights, frozen direction, unknown fees and immutable archive',{skip:!deps},async()=>{
 const {db,open,quote,result}=await fixture();try{
 await open();
 await db.exec(`update trades set sl=1.09,tp=1.13 where id='${root}';update trades set volume=.01 where id='${root}';
 insert into trades(id,parent_trade_id,account_id,user_id,symbol,side,volume,status,open_price,close_price,opened_at,closed_at,pnl,commission,close_reason)
 values('${slice}','${root}','${account}','${user}','EURUSD','buy',.01,'closed',1.1,1.101,now()-interval '120 seconds',now()-interval '80 seconds',1,0,'partial');
 update trades set status='closed',closed_at=now()-interval '40 seconds',close_price=1.102,pnl=2,commission=0 where id='${root}';
 insert into ab_trader_profiles values('${user}','AB_LIVE');`);
 await quote(119,1.1,1.1002);await quote(79,1.101,1.1012);await quote(39,1.102,1.1022);
 await db.query('select e8_sim_tick()');const r=await result();
 assert.equal(r.status,'CLOSED_GROSS_ESTIMATE');assert.equal(r.selected_book,'b');assert.equal(r.is_practice,true);
 assert.equal(Number(r.reverse_gross_usd),-3.4);assert.equal(Number(r.same_gross_usd),2.6);
 assert.ok(Math.abs(Number(r.reverse_gross_usd)+Number(r.same_gross_usd)+.8)<1e-9,'both directions pay both spreads');
 assert.equal(Number(r.selected_gross_50k_usd),-1.7);assert.equal(Number(r.source_pnl_usd),3);
 assert.equal(r.net_usd,null);assert.equal(r.net_status,'UNVERIFIED_FEES_SWAP_AND_SLIPPAGE');
 assert.equal((await db.query('select count(*) n from e8_sim_events')).rows[0].n,5);
 await db.query('select e8_sim_tick()');assert.equal((await db.query('select count(*) n from e8_sim_prices')).rows[0].n,3);
 for(const table of ['e8_sim_positions','e8_sim_events','e8_sim_prices']) await assert.rejects(db.exec(`delete from ${table}`),/append-only/);
 await db.exec('set role authenticated');await assert.rejects(db.query('select * from e8_sim_trade_results'),/permission denied/);
 }finally{await db.close();}
});
test('a sell is reversed to buy; unsupported FX conversions and missing quotes never fabricate P&L',{skip:!deps},async()=>{
 for(const symbol of ['EURUSD','USDJPY']){const {db,open,quote,result}=await fixture();try{
 await open(symbol,'sell');await db.exec(`update trades set status='closed',closed_at=now()-interval '40 seconds',close_price=1.099 where id='${root}'`);
 if(symbol==='EURUSD'){await quote(119,1.1,1.1002);await quote(39,1.099,1.0992);}
 await db.query('select e8_sim_tick()');const r=await result();
 if(symbol==='EURUSD'){assert.equal(Number(r.reverse_gross_usd),-2.4);assert.equal(Number(r.same_gross_usd),1.6);}
 else{assert.equal(r.status,'USD_SCALE_UNVERIFIED');assert.equal(r.reverse_gross_usd,null);}
 assert.equal(r.net_usd,null);
 }finally{await db.close();}}
 const {db,open,result}=await fixture();try{await open();await db.query('select e8_sim_tick()');assert.equal((await result()).status,'REFERENCE_QUOTE_MISSING_WITHIN_WINDOW');}finally{await db.close();}
});
test('late entry observations and missing partial quantity prevent a completed estimate',{skip:!deps},async()=>{
 const {db,open,quote,result}=await fixture();try{
 await open();await db.exec(`update trades set status='closed',volume=.01,closed_at=now()-interval '100 seconds',close_price=1.101 where id='${root}';`);
 await quote(119,1.1,1.1002);await quote(99,1.101,1.1012);await db.query('select e8_sim_tick()');
 assert.equal((await result()).status,'QUANTITY_MISMATCH');
 assert.equal((await result()).reverse_gross_usd,null);
 }finally{await db.close();}
 const h=await fixture();try{
 await h.open();await h.db.exec(`update trades set status='closed',closed_at=now()-interval '110 seconds',close_price=1.101 where id='${root}';`);
 await h.quote(109,1.1,1.1002);await h.db.query('select e8_sim_tick()');
 const r=await h.result();assert.equal(r.status,'ENTRY_OBSERVATION_AFTER_EXIT');assert.equal(r.reverse_gross_usd,null);
 }finally{await h.db.close();}
});
test('partial slices must bind to the same account, side, symbol and entry',{skip:!deps},async()=>{
 const {db,open}=await fixture();try{await open();
 await assert.rejects(db.exec(`insert into trades(id,parent_trade_id,account_id,user_id,symbol,side,volume,status,open_price,opened_at,closed_at,close_reason)
 values('${slice}','${root}','${account}','${user}','EURUSD','sell',.01,'closed',1.1,now()-interval '120 seconds',now()-interval '80 seconds','partial')`),/does not match/);
 }finally{await db.close();}
});
