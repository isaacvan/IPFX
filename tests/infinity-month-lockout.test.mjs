import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import{pathToFileURL}from'node:url';
const user='22222222-2222-4222-8222-222222222222',failed='11111111-1111-4111-8111-111111111111',other='33333333-3333-4333-8333-333333333333';
async function setup(){
 const{PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href);const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}');insert into auth.users(id) values('${user}');
 create function ab_person_of(uuid) returns uuid language sql as 'select coalesce((select (raw_app_meta_data->''suspension''->>''kept_user_id'')::uuid from auth.users where id=$1),$1)';
 create table lock_test_time(at timestamptz);insert into lock_test_time values('2026-10-08T10:00:00Z');
 create function lock_test_clock() returns timestamptz language sql stable as 'select at from public.lock_test_time';
 create table trading_accounts(id uuid primary key,user_id uuid,challenge_type text,status text,breached_at timestamptz);
 create table account_breach_events(account_id uuid,triggered_at timestamptz);
 create table trades(id uuid,account_id uuid,user_id uuid,status text);
 create table pending_orders(id uuid,account_id uuid,user_id uuid,status text);
 create table commerce_orders(id uuid,user_id uuid,sku text,source_account_id uuid,status text);
 insert into trading_accounts values('${failed}','${user}','infinity','breached','2026-10-08T09:00:00Z');`);
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261008140017_infinity_monthly_breach_lockout.sql',import.meta.url),'utf8').replaceAll('clock_timestamp()','public.lock_test_clock()'));
 const lock=async(id=user)=>(await db.query('select fn_infinity_breach_lockout($1) l',[id])).rows[0].l;
 return{db,lock};
}
test('failure locks until exactly the first of the next UTC month, regardless of which month the run started',async()=>{
 const f=await setup();try{
 let l=await f.lock();assert.equal(l.locked,true);assert.equal(Date.parse(l.blocked_until),Date.parse('2026-11-01T00:00:00Z'));
 await f.db.exec("update lock_test_time set at='2026-10-31T23:59:59Z'");assert.equal((await f.lock()).locked,true);
 await f.db.exec("update lock_test_time set at='2026-11-01T00:00:00Z'");assert.equal((await f.lock()).locked,false);
 assert.equal((await f.db.query('select status from trading_accounts')).rows[0].status,'breached');
 }finally{await f.db.close();}
});
test('restarts, new Infinity orders/pending and continuation links are blocked; explicit practice remains usable',async()=>{
 const f=await setup();try{
 await assert.rejects(f.db.exec(`insert into trading_accounts values('${other}','${user}','infinity','active',null)`),/BREACHED_UNTIL_NEXT_MONTH/);
 // A parallel account existing before failure cannot create new Infinity positions.
 await f.db.exec('alter table trading_accounts disable trigger infinity_month_account_insert');await f.db.exec(`insert into trading_accounts values('${other}','${user}','infinity','active',null)`);
 await f.db.exec('alter table trading_accounts enable trigger infinity_month_account_insert');
 for(const table of['trades','pending_orders'])await assert.rejects(f.db.exec(`insert into ${table} values('${other}','${other}','${user}','${table==='trades'?'open':'pending'}')`),/BREACHED_UNTIL_NEXT_MONTH/);
 await f.db.exec(`insert into commerce_orders values('${other}','${user}','challenge_continue',null,'created')`);
 await assert.rejects(f.db.exec(`update commerce_orders set source_account_id='${failed}'`),/BREACHED_UNTIL_NEXT_MONTH/);
 await f.db.exec(`update trading_accounts set challenge_type='demo',status='demo' where id='${other}';insert into trades values('${other}','${other}','${user}','open')`);
 await f.db.exec("update lock_test_time set at='2026-11-01T00:00:00Z'");await f.db.exec(`insert into trading_accounts values('44444444-4444-4444-8444-444444444444','${user}','infinity','active',null)`);
 }finally{await f.db.close();}
});
test('December rolls into January and a mapped duplicate cannot bypass the person lock',async()=>{
 const f=await setup();try{
 await f.db.exec("update trading_accounts set breached_at='2026-12-31T20:00:00Z';update lock_test_time set at='2026-12-31T23:00:00Z'");
 assert.equal(Date.parse((await f.lock()).blocked_until),Date.parse('2027-01-01T00:00:00Z'));
 await f.db.exec(`insert into auth.users values('${other}','{"suspension":{"kept_user_id":"${user}"}}')`);assert.equal((await f.lock(other)).locked,true);
 }finally{await f.db.close();}
});
test('a missing breach timestamp requires review, and ordinary clients cannot call the privileged eligibility RPC',async()=>{
 const f=await setup();try{
 await f.db.exec('update trading_accounts set breached_at=null');assert.equal((await f.lock()).code,'INFINITY_BREACH_DATE_UNAVAILABLE');assert.equal((await f.lock()).locked,true);
 await f.db.exec("insert into account_breach_events select id,'2026-10-08' from trading_accounts");assert.equal((await f.lock()).code,'INFINITY_ACCOUNT_BREACHED');
 await f.db.exec('set role authenticated');await assert.rejects(f.db.query('select fn_infinity_breach_lockout($1)',[user]),/permission/);await f.db.exec('reset role');
 }finally{await f.db.close();}
});
