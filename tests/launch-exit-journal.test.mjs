import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {pathToFileURL} from 'node:url';
const deps=process.env.DEMO_TEST_DEPS;if(!deps)throw Error('DEMO_TEST_DEPS required for the SQL exit journal tests');
const {PGlite}=await import(pathToFileURL(deps+'/node_modules/@electric-sql/pglite/dist/index.js'));
const migration=fs.readFileSync(new URL('../supabase/migrations/20261009071000_book_exit_journal.sql',import.meta.url),'utf8');
test('durable exits track absolute source volume, retries and confirmed broker inventory',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
  create table trades(id uuid primary key,status text,volume numeric,parent_trade_id uuid,close_reason text);
  create table book_orders(id bigint generated always as identity primary key,book text,source_trade_id uuid,person_id uuid,event text,idempotency_key text unique,symbol text,side text,qty numeric,status text,price_scale_per_lot numeric,broker_position_id text,broker_order_id text,fill_price numeric);
  create table shadow_orders(event text,status text,qty numeric);
  create table book_position_slots(book text,source_trade_id uuid,state text);
  create table released_risk(fraction numeric);
  create function ab_release_risk(text,uuid,numeric default 1)returns void language sql as $$insert into public.released_risk values($3)$$;
  insert into trades values('00000000-0000-4000-8000-000000000001','open',.1,null,null);`);
  await db.exec(migration);
  await db.exec(`insert into book_orders(book,source_trade_id,person_id,event,idempotency_key,symbol,side,qty,status,source_initial_volume,lot_step)
  values('b','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','open','open','EURUSD','sell',1,'filled',.1,.01);`);
  const plan=async(full=false,slice='first')=>(await db.query('select fn_plan_book_exit(1,$1,$2) as v',[full,slice])).rows[0].v;
  await db.exec(`update trades set volume=.06;`);const first=await plan();assert.equal(Number(first.claim.qty),.4);assert.equal(first.claim.dispatch_state,'planned');
  const retry=await plan();assert.equal(retry.claim.id,first.claim.id);assert.equal(Number(retry.remaining),1);
  await db.exec(`update book_orders set dispatch_state='unknown' where id=${first.claim.id};update trades set volume=.03;`);
  assert.equal((await plan(false,'second')).reason,'PRIOR_EXIT_RECONCILIATION_REQUIRED');
  await db.exec(`update book_orders set dispatch_state='confirmed',broker_confirmed_qty=.4,status='closed',broker_order_id='receipt-one',fill_price=1.101 where id=${first.claim.id}`);
  await db.query('select fn_finalize_book_exit($1)',[first.claim.id]);await db.query('select fn_finalize_book_exit($1)',[first.claim.id]);assert.equal((await db.query('select count(*)::int n from released_risk')).rows[0].n,1);
  const second=await plan(false,'second');assert.equal(Number(second.claim.qty),.3);
  await db.exec(`update book_orders set dispatch_state='confirmed',broker_confirmed_qty=.3,status='closed' where id=${second.claim.id}`);
  const third=await plan(true);assert.equal(Number(third.claim.qty),.3);
  await db.exec(`update book_orders set dispatch_state='confirmed',broker_confirmed_qty=.3,status='closed' where id=${third.claim.id}`);
  assert.equal((await plan(true)).claim.dispatch_state,'confirmed');
  await db.exec('set role authenticated');await assert.rejects(plan(),/permission denied/);
 }finally{await db.close()}
});
