import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {fixture,account,user,root} from './helpers/e8-db-fixture.mjs';
const actor='66666666-6666-4666-8666-666666666666';
const migration=new URL('../supabase/migrations/20261008090000_owner_model_controls.sql',import.meta.url);
async function setup(){
 const f=await fixture({atomic:true});
 await f.db.exec(`alter table ab_trader_profiles add column state_since timestamptz default now(),add column state_reason text,
 add column policy_version int,add column last_ab_exit_at timestamptz,add column updated_at timestamptz;
 insert into ab_trader_profiles(person_id,book_state) values('${user}','BB_DEMO');
 create table admins(user_id uuid primary key);insert into admins values('${actor}');
 create table user_profiles(user_id uuid primary key,full_name text);insert into user_profiles values('${user}','Existing trader');
 create table admin_audit_log(actor_id uuid,action text,detail jsonb);
 create table ab_policy_versions(version int primary key,status text,thresholds jsonb);insert into ab_policy_versions values(4,'ACTIVE','{"stage2AutoPct":2.75,"stage2AutoTarget":"AB_LIVE"}');
 create table ab_lifecycle_events(id bigint generated always as identity,person_id uuid,from_state text,to_state text,reason text,evidence jsonb,policy_version int,actor text);
 create table ab_person_signals(person_id uuid primary key,investigation_hold boolean,critical_flag boolean);insert into ab_person_signals values('${user}',false,false);
 create table ab_settings(book_halt boolean);insert into ab_settings values(false);
 create table ladder_settings(signal_groups int);insert into ladder_settings values(3);
 alter table ladder_accounts add column status text,add column access_token_ciphertext text,add column refresh_token_ciphertext text,add column signal_group int;
 update ladder_accounts set status='funded',signal_group=0,access_token_ciphertext='monitor-fixture',refresh_token_ciphertext='monitor-fixture';
 create table team_book_destinations(book text,status text,environment text);
 create view ipfx_sim_decision_results as select null::uuid trade_id,null::text status,null::numeric selected_gross_usd where false;
 create table ipfx_sim_pending_state(order_id uuid,person_id uuid,captured_at timestamptz,status text);
 `);
 await f.db.exec(fs.readFileSync(migration,'utf8'));
 const set=async(target,{state='BB_DEMO',manual=null,reason='Owner reviewed evidence',by=actor}={})=>(await f.db.query(
  'select ab_owner_set_model($1,$2,$3,$4,$5,$6) r',[user,state,manual,target,reason,by])).rows[0].r;
 const profile=async()=>(await f.db.query('select * from ab_trader_profiles where person_id=$1',[user])).rows[0];
 return {...f,set,profile};
}
test('owner demo choice updates the backend and persists through classifier decisions; Automatic releases it',async()=>{
 const {db,set,profile}=await setup();try{
 let r=await set('AB_DEMO');assert.equal(r.ok,true);assert.equal((await profile()).manual_book_state,'AB_DEMO');
 assert.equal((await db.query(`select ab_apply_transition('${user}','AB_DEMO','AB_LIVE','auto','{}',4) b`)).rows[0].b,false);
 r=await set('BB_DEMO',{state:'AB_DEMO',manual:'AB_DEMO'});assert.equal(r.ok,true);assert.equal((await profile()).book_state,'BB_DEMO');
 r=await set('AUTOMATIC',{state:'BB_DEMO',manual:'BB_DEMO'});assert.equal(r.ok,true);assert.equal((await profile()).manual_book_state,null);
 assert.equal((await db.query(`select ab_apply_transition('${user}','BB_DEMO','AB_DEMO','auto','{}',4) b`)).rows[0].b,true);
 assert.equal((await db.query('select count(*) n from admin_audit_log')).rows[0].n,3);
 assert.equal((await db.query('select thresholds from ab_policy_versions')).rows[0].thresholds.stage2AutoTarget,'AB_LIVE');
 }finally{await db.close();}
});
test('read-only monitor, demo review, halt and wrong signal group cannot satisfy live execution readiness',async()=>{
 const {db,set}=await setup();try{
 assert.equal((await set('AB_LIVE')).ok,false);assert.equal((await set('BB_LIVE')).ok,false);
 await db.exec(`update ladder_accounts set execution_enabled=true where id=3;
 insert into team_book_destinations values('a','connected','demo'),('b','connected','demo');`);
 assert.equal((await set('AB_LIVE')).ok,false,'monitor excluded even if incorrectly enabled');
 assert.equal((await set('BB_LIVE')).ok,false,'demo B account is not live reverse');
 const grp=(await db.query(`select ab_model_signal_group('${user}',3) g`)).rows[0].g;
 await db.exec(`insert into ladder_accounts(id,role,execution_enabled,status,access_token_ciphertext,refresh_token_ciphertext,signal_group)
 values(4,'ladder',true,'funded','fixture','fixture',${(grp+1)%3});`);
 assert.equal((await set('AB_LIVE')).ok,false);await db.exec(`update ladder_accounts set signal_group=${grp} where id=4`);
 assert.equal((await set('AB_LIVE')).ok,true);assert.equal((await db.query(`select ab_route_for_user('${user}') r`)).rows[0].r,'a');
 await db.exec('update ab_settings set book_halt=true');assert.equal((await db.query(`select ab_route_for_user('${user}') r`)).rows[0].r,null);
 }finally{await db.close();}
});
test('critical safety suspends manual traders and clears the override; manual controls cannot bypass suspension',async()=>{
 const {db,set,profile}=await setup();try{
 await set('AB_DEMO');await db.exec(`update ab_person_signals set critical_flag=true where person_id='${user}'`);
 assert.equal((await set('BB_DEMO',{state:'AB_DEMO',manual:'AB_DEMO'})).ok,false);
 assert.equal((await db.query(`select ab_apply_transition('${user}','AB_DEMO','SUSPENDED','critical','{}',4) b`)).rows[0].b,true);
 assert.equal((await profile()).manual_book_state,null);assert.equal((await set('BB_DEMO',{state:'SUSPENDED'})).ok,false);
 }finally{await db.close();}
});
test('stale control state, invalid reasons and non-admin/public callers cannot mutate routing',async()=>{
 const {db,set,profile}=await setup();try{
 assert.equal((await set('AB_DEMO',{reason:'x'})).ok,false);
 assert.equal((await set('AB_DEMO',{manual:'BB_DEMO'})).ok,false);
 await assert.rejects(set('AB_DEMO',{by:root}),/Admin actor/);
 await set('AB_DEMO');const before=(await db.query('select count(*) n from ab_lifecycle_events')).rows[0].n;
 assert.equal((await set('BB_DEMO')).ok,false);assert.equal((await profile()).book_state,'AB_DEMO');
 assert.equal((await db.query('select count(*) n from ab_lifecycle_events')).rows[0].n,before);
 await db.exec('set role authenticated');await assert.rejects(set('BB_DEMO'),/permission denied/);
 }finally{await db.close();}
});
test('existing positions keep frozen model while new opens follow owner model; fresh closes do not wait for ledger',async()=>{
 const {db,set,open}=await setup();try{
 await open();await set('AB_DEMO');
 const other='77777777-7777-4777-8777-777777777777';
 await db.exec(`insert into trades(id,account_id,user_id,symbol,side,volume,status,open_price,opened_at)
 values('${other}','${account}','${user}','EURUSD','sell',.01,'open',1.1,now());
 update trades set status='closed',pnl=1,close_price=1.101,closed_at=now() where id='${root}';`);
 const r=(await db.query('select trade_id,selected_book from e8_sim_positions order by trade_id')).rows;
 assert.equal(r.find(x=>x.trade_id===root).selected_book,'b');assert.equal(r.find(x=>x.trade_id===other).selected_book,'a');
 const a=(await db.query(`select ab_brain_live_activity('${user}') a`)).rows[0].a;
 assert.equal(a.source_trades.find(x=>x.id===root).status,'closed');assert.equal(a.source_trades.find(x=>x.id===root).pnl,1);
 }finally{await db.close();}
});
test('signal grouping matches the executor FNV hash for every UUID and configured group count',async()=>{
 const {db}=await setup();try{for(let i=1;i<=20;i++){
 let h=2166136261;for(const c of user)h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;
 assert.equal((await db.query('select ab_model_signal_group($1,$2) g',[user,i])).rows[0].g,h%i);
 }}finally{await db.close();}
});
test('owner can add a registered trader before their first trade, but cannot invent a user or reset an existing model',async()=>{
 const {db,set,profile}=await setup();try{
 const other='77777777-7777-4777-8777-777777777777';
 assert.equal((await db.query('select ab_owner_enroll_model($1,$2) r',[other,actor])).rows[0].r.ok,false);
 await db.exec(`insert into user_profiles values('${other}','New trader')`);
 const r=(await db.query('select ab_owner_enroll_model($1,$2) r',[other,actor])).rows[0].r;assert.equal(r.created,true);
 assert.equal((await db.query('select book_state from ab_trader_profiles where person_id=$1',[other])).rows[0].book_state,'BB_DEMO');
 await set('AB_DEMO');assert.equal((await db.query('select ab_owner_enroll_model($1,$2) r',[user,actor])).rows[0].r.created,false);
 assert.equal((await profile()).book_state,'AB_DEMO');
 }finally{await db.close();}
});
test('an audit failure rolls back manual state and its lifecycle event together',async()=>{
 const {db,set,profile}=await setup();try{
 await db.exec(`create function fail_model_audit() returns trigger language plpgsql as $$begin raise exception 'fixture audit failure';end $$;
 create trigger fail_model_audit before insert on admin_audit_log for each row execute function fail_model_audit();`);
 await assert.rejects(set('AB_DEMO'),/fixture audit failure/);assert.equal((await profile()).book_state,'BB_DEMO');
 assert.equal((await profile()).manual_book_state,null);assert.equal((await db.query('select count(*) n from ab_lifecycle_events')).rows[0].n,0);
 }finally{await db.close();}
});
