import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import{pathToFileURL}from'node:url';
const deps=process.env.DEMO_TEST_DEPS;
test('E8 SQL rejects execution accounts, preserves quote/history and serialises rate windows',{skip:!deps},async()=>{
 const{PGlite}=await import(pathToFileURL(deps+'/node_modules/@electric-sql/pglite/dist/index.js').href);const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);
 create schema net;create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds int) returns bigint language sql as 'select 1::bigint';
 create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';
 create table ladder_accounts(id bigint primary key,label text,role text,execution_enabled boolean,platform text);
 create table cost_samples(id bigint primary key);create table cost_fills(account_id bigint,role text,ref text);`);
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261007140000_e8_reference_monitor.sql',import.meta.url),'utf8'));
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261007160500_e8_monitor_cadence.sql',import.meta.url),'utf8'));
 await db.exec(`insert into ladder_accounts values(1,'E8','monitor',false,'tradelocker'),(2,'Copy','ladder',true,'tradelocker');`);
 await assert.rejects(db.exec(`insert into e8_monitor_profiles(account_id,scope) values(2,'demo')`),/read-only/);
 await db.exec(`insert into e8_monitor_profiles(account_id,scope,enabled) values(1,'E8',true)`);
 await assert.rejects(db.exec("update ladder_accounts set role='ladder',execution_enabled=true where id=1"),/execution account/);
 const p=(await db.query('select e8_monitor_claim() p')).rows[0].p;assert.equal(p.account_id,1);assert.ok(p.lease);
 const cadence=(await db.query('select extract(epoch from next_run)*1000 deadline,extract(epoch from clock_timestamp())*1000 claimed,interval_ms from e8_monitor_profiles where account_id=1')).rows[0];
 assert.equal(Number(cadence.deadline)%Number(cadence.interval_ms),0,'deadline is aligned rather than delayed by dispatch');
 assert.ok(Number(cadence.deadline)>Number(cadence.claimed));
 assert.ok(Number(cadence.deadline)-Number(cadence.claimed)<=Number(cadence.interval_ms));
 assert.equal((await db.query('select e8_monitor_claim() p')).rows[0].p,null,'concurrent worker cannot take the held profile');
 const rules=[{type:'QUOTES',limit:2,windowMs:1000}];
 for(const bad of [null,{},[],[{}],[{type:'QUOTES',limit:'NaN',windowMs:1000}],[{type:'QUOTES',limit:2,windowMs:null}]])
  assert.equal((await db.query('select e8_monitor_take($1,$2,$3) r',['E8','QUOTES',JSON.stringify(bad)])).rows[0].r.ok,false);
 assert.equal((await db.query('select e8_monitor_take($1,$2,$3) r',['E8','QUOTES',JSON.stringify(rules)])).rows[0].r.ok,true);
 assert.equal((await db.query('select e8_monitor_take($1,$2,$3) r',['E8','QUOTES',JSON.stringify(rules)])).rows[0].r.ok,false);
 await db.exec(`insert into e8_reference_quotes(account_id,symbol,bid,ask,requested_at,received_at) values(1,'EURUSD',1.1,1.1002,now()-interval '1 second',now());
 insert into e8_fill_revisions(account_id,ref,revision_sha256,data) values(1,'order','one','{}'),(1,'order','two','{"swap":-1}');`);
 await assert.rejects(db.exec('delete from e8_fill_revisions'),/append-only/);
 await db.exec(`insert into e8_reference_projections values(gen_random_uuid(),1,gen_random_uuid(),'{}','{}',now())`);
 await assert.rejects(db.exec('delete from e8_reference_projections'),/append-only/);
 const summary=(await db.query('select e8_reference_summary() r')).rows[0].r;assert.equal(summary.quotes[0].fresh,true);assert.equal(summary.revisions,2);
 await db.exec("update e8_reference_quotes set received_at=now()-interval '1 minute',requested_at=now()-interval '2 minutes'");
 assert.equal((await db.query('select e8_reference_summary() r')).rows[0].r.quotes[0].fresh,false);
 await db.exec('update e8_monitor_profiles set enabled=false');
 assert.equal((await db.query('select e8_monitor_claim() p')).rows[0].p,null);
 }finally{await db.close();}
});
