import fs from 'node:fs';import test from 'node:test';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const actor='11111111-1111-4111-8111-111111111111',trade='22222222-2222-4222-8222-222222222222';
async function fixture(){
 const {PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href),db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table ladder_accounts(id bigint primary key,platform text,role text,account_id text,label text);
 create table e8_monitor_profiles(account_id bigint primary key,enabled boolean,next_run timestamptz,symbols text[] default array['XAUUSD']);
 create table e8_reference_quotes(id bigint generated always as identity primary key,account_id bigint,symbol text,bid numeric,ask numeric,requested_at timestamptz,received_at timestamptz,broker_quote_at timestamptz);
 create table e8_sim_positions(trade_id uuid primary key,reference_account_id bigint,symbol text);
 create table e8_sim_events(id bigint generated always as identity primary key,trade_id uuid,event_at timestamptz,kind text,captured_at timestamptz default clock_timestamp(),source_row_id uuid,lots numeric,source_snapshot jsonb default '{}');
 create table trades(id uuid primary key,close_requested_at timestamptz,volume numeric,status text);
 create table ipfx_sim_pending_events(id bigint generated always as identity primary key,kind text,captured_at timestamptz default clock_timestamp(),snapshot jsonb);
 create table book_orders(id bigint primary key,book text,source_trade_id uuid,event text,side text,symbol text,created_at timestamptz);
 create table cost_fills(account_id bigint,ref text,qty numeric,price numeric,side text,symbol text,raw jsonb,filled_at timestamptz,created_at timestamptz default now());
 create table e8_instrument_evidence(account_id bigint,broker_symbol text,lot_size numeric,quote_currency text,observed_at timestamptz);
 create table e8_account_snapshots(id bigint,account_id bigint,received_at timestamptz,amounts jsonb,currency text);
 create table kick_calls(at timestamptz default clock_timestamp());
 create function kick_e8_reference() returns void language sql as 'insert into public.kick_calls default values';
 create function e8_revision_immutable() returns trigger language plpgsql as $$begin raise exception 'append-only';end$$;
 insert into ladder_accounts values(3,'tradelocker','monitor','123','Synthetic E8');
 insert into e8_monitor_profiles(account_id,enabled,next_run) values(3,true,now()+interval '1 hour');
 insert into e8_sim_positions values('${trade}',3,'XAUUSD');
 insert into trades values('${trade}',null,.01,'open');
 insert into book_orders values(1,'l3','${trade}','open','buy','XAUUSD',now()-interval '10 seconds');
 insert into cost_fills(account_id,ref,qty,price,side,symbol,raw,filled_at) values
 (3,'900',.01,4102.96,'buy','XAUUSD.C','{"positionId":"999","isOpen":true,"status":"Filled"}',now()-interval '5 minutes'),
 (3,'901',.004,4102.47,'sell','XAUUSD.C','{"positionId":"999","isOpen":false,"status":"Filled"}',now()-interval '4 minutes'),
 (3,'902',.006,4102.47,'sell','XAUUSD.C','{"positionId":"999","isOpen":false,"status":"Filled"}',now()-interval '3 minutes');
 insert into e8_instrument_evidence values(3,'XAUUSD.C',100,'USD',now()-interval '1 hour');`);
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261015180000_e8_execution_evidence.sql',import.meta.url),'utf8'));
 return db;
}
const receipt=(over={})=>({brokerAccountId:'123',positionId:'999',openingOrderId:'900',closingOrderIds:['901','902'],quantity:.01,gross:-.49,net:-.55,fee:-.06,swap:0,feeIncludesCommission:true,evidenceNote:'Synthetic reviewed Closed Positions row',...over});
const importReceipt=(db,r)=>db.query('select e8_import_position_receipt($1,$2,$3) r',[3,actor,JSON.stringify(r)]);
test('database receipt import matches every partial, exact account and contract; duplicates are idempotent, revisions visible and never authenticated',{skip:!process.env.DEMO_TEST_DEPS},async()=>{
 const db=await fixture();try{
  const first=(await importReceipt(db,receipt())).rows[0].r,second=(await importReceipt(db,receipt())).rows[0].r;assert.equal(first.id,second.id);assert.equal(first.statementAuthenticated,false);
  assert.equal((await importReceipt(db,receipt({closingOrderIds:['902','901']}))).rows[0].r.id,first.id);
  for(const [change,error]of[[{brokerAccountId:'124'},'ACCOUNT'],[{closingOrderIds:['901']},'QUANTITY'],[{closingOrderIds:['901','901']},'INVALID'],[{swap:null},'NUMERIC'],[{gross:-.4,net:-.46},'GROSS'],[{net:-.60},'RECONCILE']])await assert.rejects(importReceipt(db,receipt(change)),new RegExp(error));
  await importReceipt(db,receipt({net:-.56,fee:-.07}));const overview=(await db.query('select e8_evidence_overview() r')).rows[0].r;assert.equal(overview.receipts.length,2);assert.equal(overview.receipts[0].conflict,true);assert.equal(overview.net_accuracy_certified,false);
  await assert.rejects(db.exec('delete from e8_position_receipts'),/append-only/);await db.exec('set role authenticated');await assert.rejects(db.query('select * from e8_position_receipts'),/permission denied/);
  await assert.rejects(importReceipt(db,receipt()),/permission denied/);
 }finally{await db.close();}
});
test('close intent is captured before final closure; pending cancellation is prioritised and a wakeup outage preserves the queue',{skip:!process.env.DEMO_TEST_DEPS},async()=>{
 const db=await fixture();try{
  await db.exec(`create or replace function kick_e8_reference() returns void language plpgsql as $$begin raise exception 'synthetic outage';end$$;
   update trades set close_requested_at=clock_timestamp() where id='${trade}';
   insert into ipfx_sim_pending_events(kind,snapshot) values('cancelled','{"symbol":"XAUUSD"}');`);
  assert.equal((await db.query('select status from trades')).rows[0].status,'open');
  const rows=(await db.query('select kind from e8_event_quote_demands order by demand_id')).rows;assert.deepEqual(rows.map(r=>r.kind),['close_intent','pending_cancelled']);
  const due=(await db.query('select e8_event_quote_due(3) r')).rows[0].r;assert.equal(due[0].priority,0);assert.equal(due[0].events,2);
 }finally{await db.close();}
});
test('source events coalesce immediate wakeups and share one post-event quote without backdating it',{skip:!process.env.DEMO_TEST_DEPS},async()=>{
 const db=await fixture();try{
  await db.exec(`insert into e8_reference_quotes(account_id,symbol,bid,ask,requested_at,received_at) values(3,'XAUUSD',4100,4100.3,clock_timestamp()-interval '.5 second',clock_timestamp()-interval '.4 second');
   insert into e8_sim_events(trade_id,event_at,kind) values('${trade}',clock_timestamp(),'open'),('${trade}',clock_timestamp(),'partial');`);
  assert.equal((await db.query('select count(*) n from kick_calls')).rows[0].n,1);const due=(await db.query('select e8_event_quote_due(3) r')).rows[0].r;assert.equal(due.length,1);assert.equal(due[0].events,2);assert.equal(due[0].priority,0);
  const rows=(await db.query('select * from e8_event_quote_demands')).rows;assert.ok(rows.every(r=>r.decision_quote_id&&r.observed_quote_id===null));
  const q=(await db.query(`insert into e8_reference_quotes(account_id,symbol,bid,ask,requested_at,received_at) values(3,'XAUUSD',4101,4101.3,clock_timestamp(),clock_timestamp()) returning id`)).rows[0];
  assert.equal((await db.query('select e8_event_quote_link(3,$1,$2) n',['XAUUSD',q.id])).rows[0].n,2);assert.equal((await db.query('select e8_event_quote_due(3) r')).rows[0].r.length,0);
  await db.exec('delete from e8_reference_quotes');assert.ok((await db.query('select * from e8_event_quote_demands')).rows.every(r=>r.observed_quote!==null&&r.observed_quote_id===null));
 }finally{await db.close();}
});
test('dispatch evidence selects only fresh pre-send account quotes and survives quote retention deletion',{skip:!process.env.DEMO_TEST_DEPS},async()=>{
 const db=await fixture();try{
  await db.exec(`insert into e8_reference_quotes(account_id,symbol,bid,ask,requested_at,received_at) values
   (3,'XAUUSD',4100,4100.3,clock_timestamp()-interval '3 seconds',clock_timestamp()-interval '2.5 seconds'),
   (3,'XAUUSD',4101,4101.3,clock_timestamp()-interval '1 second',clock_timestamp()-interval '.8 second'),
   (3,'XAUUSD',4200,4200.3,clock_timestamp(),clock_timestamp());`);
  await db.exec(`update e8_reference_quotes set instrument_id='6148';
   insert into e8_reference_quotes(account_id,symbol,bid,ask,requested_at,received_at,instrument_id)
   values(3,'XAUUSD',4500,4500.3,clock_timestamp()-interval '.7 second',clock_timestamp()-interval '.6 second','OTHER_INSTRUMENT');`);
  await db.query(`select e8_record_dispatch(1,clock_timestamp()-interval '.5 second',clock_timestamp(),10,100,4101.4,.01,true,'6148')`);
  let r=(await db.query('select e8_evidence_overview() r')).rows[0].r.dispatches[0];assert.equal(Number(r.ask),4101.3);assert.ok(Math.abs(Number(r.quote_shortfall)-.1)<1e-8);assert.equal(r.provider_age_ms,null);
  await db.exec('delete from e8_reference_quotes');r=(await db.query('select e8_evidence_overview() r')).rows[0].r.dispatches[0];assert.equal(Number(r.ask),4101.3);
  await assert.rejects(db.exec('update e8_dispatch_evidence set fill_confirmed=false'),/append-only/);
 }finally{await db.close();}
});
test('2,000 synthetic events retain individual evidence but coalesce to one symbol queue, without provider requests',{skip:!process.env.DEMO_TEST_DEPS},async()=>{
 const db=await fixture();try{
  const start=Date.now();await db.exec(`insert into e8_sim_events(trade_id,event_at,kind) select '${trade}',clock_timestamp(),'amend' from generate_series(1,2000)`);
  const seconds=(Date.now()-start)/1000,waiting=(await db.query('select e8_event_quote_due(3) r')).rows[0].r;
  assert.equal(waiting.length,1);assert.equal(waiting[0].events,2000);assert.equal((await db.query('select count(*) n from e8_event_quote_demands')).rows[0].n,2000);
  assert.ok((await db.query('select count(*) n from kick_calls')).rows[0].n<=Math.ceil(seconds)+1);
 }finally{await db.close();}
});
