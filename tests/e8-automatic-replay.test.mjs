import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const deps=process.env.DEMO_TEST_DEPS;
const account='11111111-1111-4111-8111-111111111111', user='22222222-2222-4222-8222-222222222222';
const root='33333333-3333-4333-8333-333333333333',slice='44444444-4444-4444-8444-444444444444';
async function fixture(){
 const {PGlite}=await import(pathToFileURL(deps+'/node_modules/@electric-sql/pglite/dist/index.js').href);
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema cron;
 create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';
 create table trading_accounts(id uuid primary key,venue text,challenge_type text,status text,starting_balance numeric);
 create table trades(id uuid primary key,account_id uuid,user_id uuid,symbol text,side text,volume numeric,status text,
 open_price numeric,close_price numeric,sl numeric,tp numeric,trail_distance numeric,opened_at timestamptz,closed_at timestamptz,
 pnl numeric,commission numeric,financing numeric,close_reason text,external_source text);
 create table symbol_specs(symbol text primary key,quote_currency text,contract_size numeric);
 create function ab_person_of(uuid) returns uuid language sql as 'select $1';
 create table ab_trader_profiles(person_id uuid primary key,book_state text);
 create table ladder_accounts(id bigint primary key,role text,execution_enabled boolean);
 create table e8_monitor_profiles(account_id bigint primary key,enabled boolean,symbols text[]);
 create table e8_reference_quotes(id bigint generated always as identity,account_id bigint,symbol text,bid numeric,ask numeric,requested_at timestamptz,received_at timestamptz);
 create table ab_heartbeats(worker text primary key,ok boolean,at timestamptz,detail jsonb);
 insert into trading_accounts values('${account}','ipfx','demo','demo',100000);
 insert into symbol_specs values('EURUSD','USD',100000),('USDJPY','JPY',100000);
 insert into ladder_accounts values(3,'monitor',false);
 insert into e8_monitor_profiles values(3,true,array['EURUSD','USDJPY']);`);
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261007160000_e8_automatic_replay.sql',import.meta.url),'utf8'));
 const anchor=new Date().toISOString(),exec=db.exec.bind(db);
 db.exec=sql=>exec(sql.replaceAll('now()',`timestamptz '${anchor}'`));
 const open=async(symbol='EURUSD',side='buy')=>db.exec(`insert into trades(id,account_id,user_id,symbol,side,volume,status,open_price,opened_at)
 values('${root}','${account}','${user}','${symbol}','${side}',.02,'open',1.1,now()-interval '120 seconds');`);
 const quote=async(seconds,bid,ask)=>db.exec(`insert into e8_reference_quotes(account_id,symbol,bid,ask,requested_at,received_at)
 values(3,'EURUSD',${bid},${ask},now()-interval '${seconds} seconds',now()-interval '${seconds-0.1} seconds');`);
 const result=async()=>(await db.query('select * from e8_sim_trade_results')).rows[0];
 return {db,open,quote,result};
}
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
