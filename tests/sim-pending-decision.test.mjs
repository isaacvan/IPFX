import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture,account,user,root,slice} from './helpers/e8-db-fixture.mjs';
const migration=new URL('../supabase/migrations/20261007200000_sim_pending_and_decision_quotes.sql',import.meta.url);
async function setup(){
 const f=await fixture();
 await f.db.exec(`create table pending_orders(id uuid primary key,account_id uuid,user_id uuid,symbol text,side text,order_type text,
 volume numeric,trigger_price numeric,sl numeric,tp numeric,status text,filled_trade_id uuid,fill_price numeric,
 reject_reason text,expires_at timestamptz,created_at timestamptz default now(),resolved_at timestamptz,oco_group uuid);
 create table market_data_sources(id text primary key,display_name text not null,tier text not null check(tier in('testing','production')),is_official boolean,enabled boolean,notes text);
 create table order_audit_events(id bigint generated always as identity primary key,trade_id uuid,account_id uuid,user_id uuid,
 event text,symbol text,side text,requested_volume numeric,bid numeric,ask numeric,fill_price numeric,quote_ts timestamptz,server_ts timestamptz default now(),source_id text references market_data_sources);`);
 await f.db.exec(fs.readFileSync(migration,'utf8'));
 await f.db.exec(fs.readFileSync(new URL('../supabase/migrations/20261007201000_register_broker_quote_sources.sql',import.meta.url),'utf8'));return f;
}
const pending='55555555-5555-4555-8555-555555555555';
const place=`insert into pending_orders(id,account_id,user_id,symbol,side,order_type,volume,trigger_price,status)
 values('${pending}','${account}','${user}','EURUSD','buy','limit',.02,1.09,'pending')`;
async function audit(db,id,event,lots,bid,ask){await db.exec(`insert into order_audit_events(trade_id,account_id,user_id,event,symbol,side,requested_volume,bid,ask,source_id)
 values('${id}','${account}','${user}','${event}','EURUSD','buy',${lots},${bid},${ask},'tradelocker')`);}

test('pending create/amend/cancel/delete is durable and never opens or prices a reverse trade',async()=>{
 const {db}=await setup();try{
 await db.exec(place);await db.exec(`update pending_orders set trigger_price=1.08,sl=1.07 where id='${pending}';
 update pending_orders set status='cancelled' where id='${pending}';`);
 let s=(await db.query('select * from ipfx_sim_pending_state')).rows[0];
 assert.equal(s.tracking_status,'REMOVED_FROM_ACTIVE');assert.equal(s.snapshot.trigger_price,1.08);
 assert.deepEqual((await db.query('select kind from ipfx_sim_pending_events order by id')).rows.map(r=>r.kind),['created','amended','cancelled']);
 assert.equal((await db.query('select count(*) n from e8_sim_positions')).rows[0].n,0);
 await db.exec(`delete from pending_orders where id='${pending}'`);
 s=(await db.query('select * from ipfx_sim_pending_state')).rows[0];assert.equal(s.status,'deleted');
 assert.equal((await db.query('select e8_sim_summary() s')).rows[0].s.pending_active,0);
 await assert.rejects(db.exec('delete from ipfx_sim_pending_events'),/append-only/);
 }finally{await db.close();}
});
test('filled order needs a trade link; expiry/rejection/OCO removal stay visible',async()=>{
 const {db,open}=await setup();try{
 await db.exec(place);await db.exec(`update pending_orders set status='filled',fill_price=1.09 where id='${pending}'`);
 assert.equal((await db.query('select e8_sim_summary() s')).rows[0].s.pending_unconfirmed,1);
 await db.exec(`update pending_orders set filled_trade_id='${slice}' where id='${pending}'`);
 assert.equal((await db.query('select e8_sim_summary() s')).rows[0].s.pending_unconfirmed,1,'nonexistent trade link stays unconfirmed');
 await open();await db.exec(`update pending_orders set filled_trade_id='${root}' where id='${pending}'`);
 assert.equal((await db.query('select * from ipfx_sim_pending_state')).rows[0].tracking_status,'LINKED_SOURCE_TRADE');
 assert.equal((await db.query('select count(*) n from e8_sim_positions')).rows[0].n,1);
 for(const status of ['expired','rejected','cancelled']){
  await db.exec(`update pending_orders set status='${status}',reject_reason='OCO / gate / expiry' where id='${pending}'`);
  assert.equal((await db.query('select * from ipfx_sim_pending_state')).rows[0].tracking_status,'REMOVED_FROM_ACTIVE');
 }
 }finally{await db.close();}
});
test('exact server quotes give a distinct zero-delay baseline, weighted partials, and no invented fees or E8 fills',async()=>{
 const {db,open}=await setup();try{
 await open();await audit(db,root,'open',.02,1.1,1.1002);
 await db.exec(`update trades set volume=.01 where id='${root}';
 insert into trades(id,parent_trade_id,account_id,user_id,symbol,side,volume,status,open_price,close_price,opened_at,closed_at,pnl,close_reason)
 values('${slice}','${root}','${account}','${user}','EURUSD','buy',.01,'closed',1.1,1.101,now()-interval '120 seconds',now()-interval '80 seconds',1,'partial');`);
 await audit(db,slice,'partial_close',.01,1.101,1.1012);
 await db.exec(`update trades set status='closed',closed_at=now()-interval '40 seconds',close_price=1.102,pnl=2 where id='${root}'`);
 await audit(db,root,'close',.01,1.102,1.1022);
 const r=(await db.query('select * from ipfx_sim_decision_results')).rows[0];
 assert.equal(r.status,'CLOSED_DECISION_GROSS_ESTIMATE');assert.equal(Number(r.same_gross_usd),2.6);assert.equal(Number(r.reverse_gross_usd),-3.4);
 assert.equal((await db.query('select source_id from ipfx_sim_decision_quotes limit 1')).rows[0].source_id,'tradelocker');
 assert.equal(r.net_usd,null);assert.match(r.basis,/ZERO_DELAY.*NOT_E8_FILL/);
 assert.equal((await db.query('select count(*) n from e8_sim_prices')).rows[0].n,0,'does not replace E8 observations');
 await db.exec('delete from order_audit_events');assert.equal((await db.query('select * from ipfx_sim_decision_results')).rows[0].status,r.status);
 await assert.rejects(db.exec('delete from ipfx_sim_decision_quotes'),/append-only/);
 await db.exec('set role authenticated');await assert.rejects(db.query('select * from ipfx_sim_decision_results'),/permission denied/);
 }finally{await db.close();}
});
test('missing, duplicate, crossed or mismatched quote evidence blocks P&L; foreign audit rows are excluded',async()=>{
 for(const mode of ['missing','duplicate','crossed','quantity','foreign','nan']){
 const {db,open}=await setup();try{
 await open();if(!['missing','foreign'].includes(mode)) await audit(db,root,'open',mode==='quantity'?'.03':'.02',mode==='crossed'?'1.2':mode==='nan'?"'NaN'":'1.1',1.1002);
 if(mode==='duplicate')await audit(db,root,'open',.02,1.1,1.1002);
 if(mode==='foreign'){await db.exec(`insert into order_audit_events(trade_id,account_id,user_id,event,symbol,side,requested_volume,bid,ask)
 values('${root}','${account}','${slice}','open','EURUSD','buy',.02,1.1,1.1002)`);}
 const r=(await db.query('select * from ipfx_sim_decision_results')).rows[0];assert.equal(r.selected_gross_usd,null);
 assert.equal(r.status,mode==='duplicate'?'AMBIGUOUS_DECISION_QUOTES':['missing','foreign'].includes(mode)?'DECISION_QUOTE_MISSING':'DECISION_QUOTE_INVALID');
 }finally{await db.close();}}
});
