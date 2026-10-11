import fs from 'node:fs';import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,root,user} from './helpers/e8-db-fixture.mjs';
const sql=fs.readFileSync(new URL('../supabase/migrations/20261011100000_b_live_review.sql',import.meta.url),'utf8'),deps=process.env.DEMO_TEST_DEPS;
async function setup(){const f=await fixture();await f.db.exec(`create table ab_trader_metrics(person_id uuid,as_of timestamptz,reverse_r numeric,replayed int);
 create function e8_sim_accuracy(uuid) returns jsonb language sql as 'select ''{"e8_gross_usd":3,"e8_after_commission_usd":2,"five_tick_after_commission_usd":1,"scale_basis":"BROKER_SPEC_OBSERVED_AT_ENTRY","broker_size_valid":true}''::jsonb';
 alter table trading_accounts add column user_id uuid;update trading_accounts set user_id='${user}',challenge_type='infinity',status='active';`);
 await f.db.exec(sql.split('-- SCANNER_FROM_DRIFT_CHECKED_LIVE_SOURCE')[0]);return f;}
test('E8 review totals are unknown until complete quotes; partial exits count once and costs remain estimates',{skip:!deps},async()=>{const {db,open,quote}=await setup();try{
 await open();await db.exec(`update trades set status='closed',closed_at=now()-interval '40 seconds',close_price=1.099 where id='${root}'`);await db.query('select e8_sim_tick()');
 let r=(await db.query(`select ab_b_review_reference('${user}') as r`)).rows[0].r;
 assert.equal(r.source_closed_roots,1);assert.equal(r.b_roots,1);assert.equal(r.complete_gross_roots,0);assert.equal(r.gross_usd,null);assert.equal(r.net_verified,false);
 // Append-only missing observations cannot become a manufactured success.
 await quote(119,1.1,1.1002);await quote(39,1.099,1.0992);await db.query('select e8_sim_tick()');r=(await db.query(`select ab_b_review_reference('${user}') as r`)).rows[0].r;assert.equal(r.gross_usd,null);
 await db.exec('set role authenticated');await assert.rejects(db.query(`select ab_b_review_reference('${user}')`),/permission denied/);
 }finally{await db.close()}});
test('complete quote estimates show estimated costs but never actual broker net; missing fee suppresses total',{skip:!deps},async()=>{const {db,open,quote}=await setup();try{
 await open();await db.exec(`update trades set status='closed',closed_at=now()-interval '40 seconds',close_price=1.099 where id='${root}'`);await quote(119,1.1,1.1002);await quote(39,1.099,1.0992);await db.query('select e8_sim_tick()');
 let r=(await db.query(`select ab_b_review_reference('${user}') as r`)).rows[0].r;assert.equal(r.complete_gross_roots,1);assert.equal(r.gross_usd,3);assert.equal(r.after_estimated_commission_usd,2);assert.equal(r.five_tick_stress_usd,1);assert.equal(r.net_usd,null);
 await db.exec(`create or replace function e8_sim_accuracy(uuid) returns jsonb language sql as 'select ''{"e8_gross_usd":3,"broker_size_valid":null}''::jsonb'`);
 r=(await db.query(`select ab_b_review_reference('${user}') as r`)).rows[0].r;assert.equal(r.gross_usd,3);assert.equal(r.after_estimated_commission_usd,null);assert.equal(r.five_tick_stress_usd,null);assert.equal(r.unconfirmed_size_roots,1);
 }finally{await db.close()}});
test('live scanner recommendation block filters stale, future, wrong-model, wrong-policy and held assessments',{skip:!deps},async()=>{const {db}=await setup();try{
 await db.exec(`alter table ab_trader_profiles add column state_since timestamptz;create table ab_policy_versions(version int,status text);insert into ab_policy_versions values(4,'ACTIVE');
 create table user_profiles(user_id uuid,full_name text);create table ab_person_signals(person_id uuid,investigation_hold boolean,critical_flag boolean);
 create temp table _alert_now(key text primary key,severity text,category text,title text,detail text,person_id uuid,value numeric);
 insert into ab_trader_profiles values('${user}','BB_DEMO',now());insert into ab_trader_metrics values('${user}',now(),.5,60,'{"status":"POLICY_REVIEW","policy_version":4,"reason":"Synthetic evidence"}');`);
 const block=sql.split('-- B_REVIEW_ALERTS_BEGIN:')[1].split('-- B_REVIEW_ALERTS_END')[0];const statement=block.slice(block.indexOf('insert into _alert_now'));
 const scan=async()=>{await db.exec('truncate _alert_now');await db.exec(statement);return(await db.query('select * from _alert_now')).rows;};
 assert.equal((await scan()).length,1);assert.match((await scan())[0].detail,/not verified E8 fills/);
 for(const change of[`update ab_trader_metrics set as_of=now()-interval '4 minutes'`,`update ab_trader_metrics set as_of=now()+interval '1 minute'`,`update ab_trader_profiles set book_state='AB_DEMO'`,`update ab_trader_metrics set b_review=jsonb_set(b_review,'{policy_version}','5')`,`insert into ab_person_signals values('${user}',true,false)`]){
 await db.exec('begin');await db.exec(change);assert.equal((await scan()).length,0);await db.exec('rollback');}
 }finally{await db.close()}});
