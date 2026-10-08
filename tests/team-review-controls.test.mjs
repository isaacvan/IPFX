import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import{pathToFileURL}from'node:url';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',alias='33333333-3333-4333-8333-333333333333',owner='44444444-4444-4444-8444-444444444444';
const aid='51111111-1111-4111-8111-111111111111',bid='52222222-2222-4222-8222-222222222222',aliasAccount='53333333-3333-4333-8333-333333333333';
const sql=fs.readFileSync(new URL('../supabase/migrations/20261008160031_team_review_controls.sql',import.meta.url),'utf8');
async function setup(){
 const{PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href),db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table admins(user_id uuid primary key);insert into admins values('${owner}');
 create schema realtime;create table private_signals(topic text,payload jsonb,private bool);
 create function realtime.send(jsonb,text,text,bool)returns void language sql as 'insert into public.private_signals values($3,$1,$4)';
 create table aliases(alias uuid,person uuid);insert into aliases values('${alias}','${a}');
 create function ab_person_of(uuid)returns uuid language sql as 'select coalesce((select person from public.aliases where alias=$1),$1)';
 create table trading_accounts(id uuid primary key,user_id uuid,phase text default 'evaluation',challenge_type text default 'infinity',status text default 'active');
 insert into trading_accounts(id,user_id)values('${aid}','${a}'),('${bid}','${b}'),('${aliasAccount}','${alias}');
 create table trades(id uuid primary key default gen_random_uuid(),account_id uuid,symbol text default 'XAUUSD',side text default 'buy',
  opened_at timestamptz default now(),closed_at timestamptz,status text default 'open',parent_trade_id uuid,volume numeric default 1,open_price numeric default 2000,sl numeric,tp numeric);
 create table pending_orders(id uuid default gen_random_uuid(),account_id uuid,status text default 'pending',resolved_at timestamptz);
 create table ab_settings(book_halt bool default false);insert into ab_settings default values;
 create table admin_audit_log(actor_id uuid,action text,target_user_id uuid,detail jsonb);
 create table ab_heartbeats(worker text primary key,ok bool,at timestamptz,detail jsonb);
 create table ab_alerts(id bigint generated always as identity primary key,key text unique,severity text,category text,title text,detail text,person_id uuid,value numeric,
  first_seen timestamptz default now(),resolved_at timestamptz,acknowledged_at timestamptz,acknowledged_by uuid);
 create function ab_alerts_scan()returns jsonb language plpgsql as $$begin
 create temp table if not exists _alert_now(key text primary key,severity text,category text,title text,detail text,person_id uuid,value numeric)on commit drop;
 truncate _alert_now;
 insert into public.ab_alerts as a (key, severity, category, title, detail, person_id, value)
 select * from _alert_now on conflict(key)do update set resolved_at=null;
 return '{}'::jsonb;end;$$;`);
 await db.exec(sql);return db;
}
async function alert(db,key='trader:NO_SL:'+a,person=a,category='rules'){
 return (await db.query(`insert into ab_alerts(key,severity,category,title,person_id)values($1,'warning',$2,'Review',$3)returning *`,[key,category,person])).rows[0];
}
async function act(db,x,kind,request=crypto.randomUUID(),reason='Synthetic review action',actor=owner){
 return(await db.query('select ab_owner_alert_solution($1,$2,$3,$4,$5,$6) r',[x.id,kind,reason,actor,request,x.first_seen])).rows[0].r;
}
test('warning is idempotent, audited and readable only through trusted controls',async()=>{const db=await setup();try{
 const x=await alert(db),id=crypto.randomUUID();assert.equal((await act(db,x,'warn',id)).ok,true);await act(db,x,'warn',id);await act(db,x,'warn');
 assert.equal((await db.query('select count(*) n from trader_service_notices')).rows[0].n,1);
 assert.equal((await db.query('select count(*) n from admin_audit_log')).rows[0].n,1);
 const signals=(await db.query('select * from private_signals')).rows;assert.equal(signals.length,2);assert.ok(signals.every(x=>x.private&&!JSON.stringify(x.payload).includes('Synthetic review action')));
 const c=(await db.query('select brain_trader_controls($1) r',[alias])).rows[0].r;assert.equal(c.notices.length,1);assert.equal(c.paused,false);
 await db.exec('set role authenticated');await assert.rejects(db.exec('select * from trader_service_notices'),/permission denied/);
 await assert.rejects(db.query('select brain_trader_controls($1)',[a]),/permission denied/);await db.exec('reset role');
 await assert.rejects(act(db,x,'warn',crypto.randomUUID(),'Clear reason',b),/ADMIN_REQUIRED/);
 await db.query('update ab_alerts set resolved_at=now() where id=$1',[x.id]);assert.equal((await act(db,x,'warn',id)).ok,true);
 }finally{await db.close();}});
test('pause blocks new practice/challenge/alias entries and cancels pending; closing and reducing risk remain allowed',async()=>{const db=await setup();try{
 const t=(await db.query('insert into trades(account_id) values($1) returning id',[aid])).rows[0];
 await db.query('insert into pending_orders(account_id)values($1),($2)',[aid,aliasAccount]);
 const x=await alert(db);assert.equal((await act(db,x,'pause')).ok,true);
 for(const account of[aid,aliasAccount])await assert.rejects(db.query('insert into trades(account_id)values($1)',[account]),/TRADER_PAUSED/);
 await db.query(`update trading_accounts set phase='demo' where id=$1`,[aid]);await assert.rejects(db.query('insert into pending_orders(account_id)values($1)',[aid]),/TRADER_PAUSED/);
 const p=(await db.query('select status,resolved_at from pending_orders')).rows;assert.ok(p.every(x=>x.status==='cancelled'&&x.resolved_at));
 await db.query('update trades set volume=0.5 where id=$1',[t.id]);await assert.rejects(db.query('update trades set volume=2 where id=$1',[t.id]),/TRADER_PAUSED/);
 await db.query(`update trades set status='closed' where id=$1`,[t.id]);
 await db.exec('select ab_alerts_scan()');const pause=(await db.query(`select * from ab_alerts where key like 'rules:team-pause:%'`)).rows[0];
 await db.query(`update trading_accounts set status='breached' where id=$1`,[aid]);await act(db,pause,'resume');
 assert.equal((await db.query('select status from trading_accounts where id=$1',[aid])).rows[0].status,'breached');
 assert.equal((await db.query('select brain_trader_controls($1) r',[a])).rows[0].r.paused,false);
 await act(db,x,'pause');assert.equal((await db.query('select brain_trader_controls($1) r',[a])).rows[0].r.paused,true); // A new action can reapply an entry pause after review; no stale success.
 }finally{await db.close();}});
test('invalid/stale actions and audit failure cannot silently apply a warning or halt',async()=>{const db=await setup();try{
 const x=await alert(db);await assert.rejects(act(db,x,'halt_books'),/HALT_NOT_ALLOWED/);
 assert.equal((await act(db,{...x,first_seen:'2000-01-01'},'warn')).ok,false);
 await db.exec(`alter table admin_audit_log add constraint fail_audit check(action<>'brain_alert_solution')`);
 await assert.rejects(act(db,x,'warn'),/fail_audit/);assert.equal((await db.query('select count(*) n from trader_service_notices')).rows[0].n,0);
 assert.equal((await db.query('select count(*) n from private_signals')).rows[0].n,0);
 const system=await alert(db,'system:prices',null,'system');await assert.rejects(act(db,system,'halt_books'),/fail_audit/);
 assert.equal((await db.query('select book_halt from ab_settings')).rows[0].book_halt,false);
 }finally{await db.close();}});
async function matching(db,{days=3,aliasPeer=false,offset=3}={}){
 for(let k=0;k<6;k++){
  const day=days===1?1:(k%days)+1,hour=Math.floor(k/days)*2;
  const timestamp=new Date(Date.now()-day*86400000-hour*3600000).toISOString();
  await db.query(`insert into trades(account_id,opened_at,closed_at,status)values($1,$3::timestamptz,$3::timestamptz+interval '2 minutes','closed'),($2,$3::timestamptz+($4::text||' seconds')::interval,$3::timestamptz+interval '2 minutes 5 seconds','closed')`,[aid,aliasPeer?aliasAccount:bid,timestamp,offset]);
 }
}
test('repeated paired opens and exits across days flag two people, evidence is reviewable and newly matched data reopens it',async()=>{const db=await setup();try{
 await matching(db);await db.exec('select trade_similarity_scan();select ab_alerts_scan()');
 const reviews=(await db.query('select * from trade_similarity_reviews')).rows;assert.equal(reviews.length,1);assert.equal(reviews[0].matches,6);assert.equal(reviews[0].evidence.length,6);
 const x=(await db.query(`select * from ab_alerts where key like 'rules:similarity:%'`)).rows[0];assert.equal(x.person_id,a);
 assert.equal((await db.query('select count(*) n from trader_entry_pauses')).rows[0].n,0);
 await act(db,x,'pause_pair');assert.equal((await db.query('select count(*) n from trader_entry_pauses where active')).rows[0].n,2);
 for(const account of[aid,bid])await assert.rejects(db.query('insert into trades(account_id)values($1)',[account]),/TRADER_PAUSED/);
 await act(db,x,'clear_similarity');const r=(await db.query('select * from trade_similarity_reviews')).rows[0];assert.ok(r.reviewed_through);assert.equal(r.reviewed_by,owner);
 assert.equal((await db.query('select count(*) n from trader_entry_pauses where active')).rows[0].n,2); // Clearing evidence does not silently undo a separately chosen pause.
 await db.query(`update trade_similarity_reviews set latest_match=latest_match+interval '1 second'`);assert.equal((await db.query('select latest_match>reviewed_through fresh from trade_similarity_reviews')).rows[0].fresh,true);
 }finally{await db.close();}});
test('single-day coincidence, unrelated entries, partial slices and aliases do not manufacture a copying flag',async()=>{
 for(const variant of[{days:1},{offset:40},{aliasPeer:true}]){const db=await setup();try{
  await matching(db,variant);await db.exec('select trade_similarity_scan()');assert.equal((await db.query('select count(*) n from trade_similarity_reviews')).rows[0].n,0);
 }finally{await db.close();}}
 const db=await setup();try{await matching(db);await db.exec(`update trades set parent_trade_id=gen_random_uuid()`);await db.exec('select trade_similarity_scan()');assert.equal((await db.query('select count(*) n from trade_similarity_reviews')).rows[0].n,0);}finally{await db.close();}
});
