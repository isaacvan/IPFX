import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {pathToFileURL} from 'node:url';
const {PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js'));
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('warnings commit with closes, breach at three, dedupe and carry across the same attempt',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
  create table trading_accounts(id uuid primary key default gen_random_uuid(),user_id uuid,challenge_type text,stage int,phase text,status text,balance numeric,sl_strikes integer default 0,updated_at timestamptz,breach_reason text,breached_at timestamptz,breach_equity numeric,breach_floor numeric,access_revoked_at timestamptz,access_revoked_reason text,mirror_enabled boolean,funded_from_account_id uuid);
  create table trades(id uuid primary key default gen_random_uuid(),account_id uuid,status text,close_reason text,stripped_profit numeric);
  create table sl_strikes(account_id uuid,user_id uuid,trade_id uuid unique,strike_no integer,stripped_profit numeric);
  create table infinity_retired_accounts(account_id uuid primary key);
  create table account_breach_events(account_id uuid primary key,user_id uuid,challenge_type text,stage integer,reason text,trigger_equity numeric,breach_floor numeric);
  create table pending_orders(account_id uuid,status text,resolved_at timestamptz);
  create function fn_ensure_demo_account(uuid)returns uuid language sql as $$select $1$$;`);
  const old=read('supabase/migrations/20261005140000_infinity_sl_strikes.sql');
  await db.exec(old.slice(old.indexOf('create or replace function public.fn_record_sl_strike'),old.indexOf('-- Breach reason')));
  await db.exec(old.slice(old.indexOf('create or replace function public.fn_claim_account_breach'),old.indexOf('-- Progress:')));
  const s=read('supabase/migrations/20261009070000_launch_reliability.sql');await db.exec(s.slice(s.indexOf('create or replace function public.fn_carry_infinity_strikes'),s.indexOf('alter table public.treasury_snapshots')));
  const a=(await db.query(`insert into trading_accounts(user_id,challenge_type,stage,phase,status,balance) values(gen_random_uuid(),'infinity',1,'evaluation','active',1000) returning id,user_id`)).rows[0];
  const close=async()=>(await db.query(`insert into trades(account_id,status,close_reason,stripped_profit)values($1,'closed','no_stop_loss',5)returning id`,[a.id])).rows[0].id;
  await close();await close();assert.equal((await db.query('select sl_strikes from trading_accounts where id=$1',[a.id])).rows[0].sl_strikes,2);
  const child=(await db.query(`insert into trading_accounts(user_id,challenge_type,stage,phase,status,balance,funded_from_account_id)values($1,'infinity',2,'evaluation','active',5000,$2)returning id,sl_strikes`,[a.user_id,a.id])).rows[0];assert.equal(child.sl_strikes,2);
  await db.query(`insert into pending_orders values($1,'pending',null)`,[child.id]);
  const tid=(await db.query(`insert into trades(account_id,status,close_reason)values($1,'closed','no_stop_loss')returning id`,[child.id])).rows[0].id;
  const frozen=(await db.query('select status,sl_strikes,access_revoked_at from trading_accounts where id=$1',[child.id])).rows[0];assert.equal(frozen.status,'breached');assert.equal(frozen.sl_strikes,3);assert.ok(frozen.access_revoked_at);
  await db.query(`update trades set close_reason='no_stop_loss'where id=$1`,[tid]);assert.equal((await db.query('select sl_strikes from trading_accounts where id=$1',[child.id])).rows[0].sl_strikes,3);
  assert.equal((await db.query('select status from pending_orders where account_id=$1',[child.id])).rows[0].status,'cancelled');
  const fresh=(await db.query(`insert into trading_accounts(user_id,challenge_type,stage,phase,status,balance)values(gen_random_uuid(),'infinity',1,'evaluation','active',1000)returning sl_strikes`)).rows[0];assert.equal(fresh.sl_strikes,0);
 }finally{await db.close()}
});
test('capacity reservations block unknown, stale, over-position and over-margin opens atomically',async()=>{
 const db=new PGlite();try{
  await db.exec('create role anon;create role authenticated;create role service_role;');await db.exec(read('supabase/migrations/20261009073000_destination_capacity.sql'));
  let seq=1;const reserve=async qty=>(await db.query('select fn_reserve_book_slot($1,$2,$3)as r',['s1','00000000-0000-4000-8000-'+String(seq++).padStart(12,'0'),qty])).rows[0].r;
  assert.equal((await reserve(.01)).reason,'DOCUMENTED_CAPACITY_NOT_CONFIGURED');
  await db.exec(`insert into book_capacity_limits values('s1',3,1000,'Synthetic documented capacity',now());insert into book_capacity_state values('s1',now()-interval '10 seconds',0,0,10000);`);
  assert.equal((await reserve(.01)).reason,'BROKER_INVENTORY_STALE');await db.exec(`update book_capacity_state set observed_at=now(),free_margin_usd=0;`);assert.equal((await reserve(.01)).reason,'INSUFFICIENT_MARGIN');
  await db.exec(`update book_capacity_state set free_margin_usd=10000;`);
  const burst=await Promise.all(Array.from({length:20},()=>reserve(.01)));assert.equal(burst.filter(x=>x.ok).length,3);assert.equal(burst.filter(x=>x.reason==='POSITION_CAPACITY_FULL').length,17);
  await db.exec('set role authenticated');await assert.rejects(reserve(.01),/permission denied/);
 }finally{await db.close()}
});
