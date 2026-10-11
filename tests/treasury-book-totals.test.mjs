import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {pathToFileURL}from 'node:url';
test('2,000-person treasury counts and risk are full database aggregates, never API-row-limited',{skip:!process.env.DEMO_TEST_DEPS},async()=>{
 const {PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href),db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create table ab_trader_profiles(book_state text);create table ab_risk_reservations(book text,risk_usd numeric,status text);create table book_daily_pnl(book text,day date,pnl_usd numeric);
   insert into ab_trader_profiles select case when n<=1500 then 'BB_DEMO' else 'AB_DEMO' end from generate_series(1,2000)n;
   insert into ab_risk_reservations select 'b',10,'active' from generate_series(1,2000);insert into ab_risk_reservations values('a',999999,'released');
   insert into book_daily_pnl values('b',(now() at time zone 'UTC')::date,12.34),('a',(now() at time zone 'UTC')::date,-3),('b',(now() at time zone 'UTC')::date-1,999999);`);
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261011090000_treasury_book_totals.sql',import.meta.url),'utf8'));
  const r=(await db.query('select treasury_book_totals() r')).rows[0].r;
  assert.equal(r.book_states.BB_DEMO,1500);assert.equal(r.book_states.AB_DEMO,500);assert.equal(r.open_risk.b,20000);assert.equal(r.open_risk.a,undefined);
  assert.equal(r.day_pnl.find(p=>p.book==='b').pnl_usd,12.34);
  await db.exec('set role authenticated');await assert.rejects(db.query('select treasury_book_totals()'),/permission denied/);
 }finally{await db.close();}
});
