import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const deps=process.env.DEMO_TEST_DEPS;
const account='11111111-1111-4111-8111-111111111111', user='22222222-2222-4222-8222-222222222222';
const root='33333333-3333-4333-8333-333333333333',slice='44444444-4444-4444-8444-444444444444';
export async function fixture({atomic=false}={}){
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
 await db.exec(fs.readFileSync(new URL('../../supabase/migrations/20261007160000_e8_automatic_replay.sql',import.meta.url),'utf8'));
 await db.exec(fs.readFileSync(new URL('../../supabase/migrations/20261007180100_e8_quantity_integrity.sql',import.meta.url),'utf8'));
 if(atomic){
  await db.exec(`alter table trading_accounts add column user_id uuid,add column balance numeric not null default 100000,add column updated_at timestamptz;
  update trading_accounts set user_id='${user}';alter table trades add column execution_shortfall numeric,add column pnl_basis text check(pnl_basis in('NET_AFTER_COSTS','GROSS_BEFORE_COSTS')),add column stripped_profit numeric;`);
  await db.exec(fs.readFileSync(new URL('../../supabase/migrations/20261007180000_atomic_ipfx_closes.sql',import.meta.url),'utf8'));
 }
 const anchor=new Date().toISOString(),exec=db.exec.bind(db);
 db.exec=sql=>exec(sql.replaceAll('now()',`timestamptz '${anchor}'`));
 const open=async(symbol='EURUSD',side='buy')=>db.exec(`insert into trades(id,account_id,user_id,symbol,side,volume,status,open_price,opened_at)
 values('${root}','${account}','${user}','${symbol}','${side}',.02,'open',1.1,now()-interval '120 seconds');`);
 const quote=async(seconds,bid,ask)=>db.exec(`insert into e8_reference_quotes(account_id,symbol,bid,ask,requested_at,received_at)
 values(3,'EURUSD',${bid},${ask},now()-interval '${seconds} seconds',now()-interval '${seconds-0.1} seconds');`);
 const result=async()=>(await db.query('select * from e8_sim_trade_results')).rows[0];
 return {db,open,quote,result};
}
export {account,user,root,slice};
