import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import{pathToFileURL}from'node:url';
const account='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',trade='33333333-3333-4333-8333-333333333333';
async function setup({mode='static',daily=2.5}={}){
 const{PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href);const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';
 create table risk_test_time(at timestamptz);insert into risk_test_time values('2026-10-08T10:00:00Z');
 create function risk_test_clock() returns timestamptz language sql stable as 'select at from public.risk_test_time';
 create table trading_accounts(id uuid primary key,user_id uuid,challenge_type text,phase text,status text,stage int,venue text,
  starting_balance numeric,balance numeric,day_start_equity numeric,day_start_date date,drawdown_mode text,trailing_peak numeric,
  trailing_peak_date date,max_drawdown_pct numeric,daily_loss_pct numeric,total_paid_out numeric,created_at timestamptz,
  access_revoked_at timestamptz,access_revoked_reason text,breach_reason text,breached_at timestamptz,breach_equity numeric,
  breach_floor numeric,mirror_enabled boolean,updated_at timestamptz);
 create table trades(id uuid primary key,account_id uuid,user_id uuid,symbol text,side text,volume numeric,open_price numeric,status text,
 sl numeric,tp numeric,trail_distance numeric);
 create index on trades(account_id) where status='open';create index on trades(symbol) where status='open';
 create table pending_orders(id uuid primary key,account_id uuid,user_id uuid,status text,resolved_at timestamptz);
 create table symbol_specs(symbol text primary key,contract_size numeric,quote_currency text);
 insert into symbol_specs values('XAUUSD',100,'USD'),('USDJPY',100000,'JPY'),('GBPJPY',100000,'JPY');
 create table live_quotes(symbol text primary key,bid numeric,ask numeric,mid numeric,received_at timestamptz);
 create table ab_heartbeats(worker text primary key,ok boolean,at timestamptz,detail jsonb);
 create table account_breach_events(account_id uuid unique,user_id uuid,challenge_type text,stage int,reason text,trigger_equity numeric,breach_floor numeric);
 create function fn_ensure_demo_account(uuid) returns uuid language sql as 'select $1';
 insert into trading_accounts(id,user_id,challenge_type,phase,status,stage,venue,starting_balance,balance,day_start_equity,
 day_start_date,drawdown_mode,trailing_peak,max_drawdown_pct,daily_loss_pct,total_paid_out,created_at,mirror_enabled)
 values('${account}','${user}','infinity','evaluation','active',1,'ipfx',100000,100000,100000,'2026-10-08','${mode}',100000,5,${daily},0,'2026-10-08',false);`);
 const claim=fs.readFileSync(new URL('../supabase/migrations/20261005140000_infinity_sl_strikes.sql',import.meta.url),'utf8').match(/create or replace function public\.fn_claim_account_breach[\s\S]*?\$function\$;/)[0];
 await db.exec(claim);
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261008132001_infinity_quote_drawdown_guard.sql',import.meta.url),'utf8').replaceAll('clock_timestamp()','public.risk_test_clock()'));
 const quote=async(bid,ask=bid+.2,symbol='XAUUSD',age=0)=>db.query(`insert into live_quotes values($1,$2,$3,($2::numeric+$3::numeric)/2,risk_test_clock()-($4::text||' seconds')::interval)
 on conflict(symbol) do update set bid=excluded.bid,ask=excluded.ask,mid=excluded.mid,received_at=excluded.received_at`,[symbol,bid,ask,age]);
 const open=()=>db.exec(`insert into trades values('${trade}','${account}','${user}','XAUUSD','buy',1,2000,'open',null,null,null)`);
 const row=async()=>{const a=(await db.query('select * from trading_accounts where id=$1',[account])).rows[0];
  for(const k of['balance','starting_balance','day_start_equity','trailing_peak','breach_equity','breach_floor'])if(a[k]!=null)a[k]=Number(a[k]);return a;};
 return{db,quote,open,row};
}
test('daily drawdown freezes at exact equity floor on quote insert and remains failed after recovery',async()=>{
 const f=await setup();try{
 await f.open();await f.db.exec(`insert into pending_orders values('44444444-4444-4444-8444-444444444444','${account}','${user}','pending',null)`);
 await f.quote(1975);let a=await f.row();assert.equal(a.status,'breached');assert.equal(a.breach_reason,'daily_loss');assert.equal(a.breach_equity,97500);
 assert.notEqual(a.access_revoked_at,null);assert.equal((await f.db.query('select status from pending_orders')).rows[0].status,'cancelled');
 await f.quote(2100);a=await f.row();assert.equal(a.status,'breached');assert.equal(a.breach_equity,97500);
 assert.equal((await f.db.query('select count(*) n from account_breach_events')).rows[0].n,1);
 }finally{await f.db.close();}
});
test('overall drawdown takes precedence when both limits cross, and new orders/updates/reactivation are rejected',async()=>{
 const f=await setup();try{
 await f.quote(2000);await f.open();await f.quote(1950);assert.equal((await f.row()).breach_reason,'max_drawdown');
 await assert.rejects(f.db.exec(`insert into trades values('55555555-5555-4555-8555-555555555555','${account}','${user}','XAUUSD','buy',1,2000,'open',null,null,null)`),/FROZEN/);
 await assert.rejects(f.db.exec(`insert into pending_orders values('44444444-4444-4444-8444-444444444444','${account}','${user}','pending',null)`),/FROZEN/);
 await assert.rejects(f.db.exec(`update trades set volume=2 where id='${trade}'`),/FROZEN/);
 await assert.rejects(f.db.exec(`update trading_accounts set status='active',access_revoked_at=null where id='${account}'`),/FROZEN/);
 await assert.rejects(f.db.exec(`update trading_accounts set breach_equity=0 where id='${account}'`),/FROZEN/);
 await f.db.exec(`update trades set status='closed' where id='${trade}'`);
 await assert.rejects(f.db.exec(`update trades set status='open' where id='${trade}'`),/CANNOT_REOPEN/);
 // Cleanup balance credits still work on the failed record; they never revive it.
 await f.db.exec(`update trading_accounts set balance=95000 where id='${account}'`);assert.equal((await f.row()).status,'breached');
 }finally{await f.db.close();}
});
test('trailing intraday peak persists on price increases and its drawdown cannot recover',async()=>{
 const f=await setup({mode:'trailing_intraday',daily:50});try{
 await f.quote(2000);await f.open();await f.quote(2100);assert.equal((await f.row()).trailing_peak,110000);
 await f.quote(2050);const a=await f.row();assert.equal(a.status,'breached');assert.equal(a.breach_floor,105000);assert.equal(a.breach_reason,'max_drawdown');
 }finally{await f.db.close();}
});
test('EOD peaks do not tighten intraday; UTC rollover counts a carried floating loss',async()=>{
 const f=await setup({mode:'trailing_eod',daily:50});try{
 await f.quote(2000);await f.open();await f.quote(2100);assert.equal((await f.row()).trailing_peak,100000);
 await f.db.exec("update risk_test_time set at=at+interval '1 day'");await f.quote(2060);assert.equal((await f.row()).trailing_peak,106000);
 }finally{await f.db.close();}
 const g=await setup();try{
 await g.quote(2000);await g.open();await g.quote(1984);await g.db.exec("update risk_test_time set at=at+interval '1 day'");
 await g.quote(1984);assert.equal((await g.row()).day_start_equity,100000);await g.quote(1975);assert.equal((await g.row()).breach_reason,'daily_loss');
 }finally{await g.db.close();}
});
test('realized balance loss also freezes; practice and external venue accounts are unaffected',async()=>{
 const f=await setup();try{
 await f.db.exec(`update trading_accounts set balance=97500 where id='${account}'`);assert.equal((await f.row()).status,'breached');
 }finally{await f.db.close();}
 for(const external of[false,true]){
 const g=await setup();try{
 await g.db.exec(`update trading_accounts set ${external?"venue='broker_demo'":"challenge_type='demo',phase='demo',status='demo'"} where id='${account}'`);
 await g.open();await g.quote(1900);assert.equal((await g.row()).status,external?'active':'demo');
 }finally{await g.db.close();}
 }
});
test('stale/crossed/missing FX prices are unavailable, never valued as zero or used for false breaches',async()=>{
 const f=await setup();try{
 await f.open();await f.quote(1970,1970.2,'XAUUSD',100);assert.equal((await f.row()).status,'active');
 assert.equal((await f.db.query(`select fn_infinity_quote_equity('${account}') e`)).rows[0].e,null);
 await f.quote(1970,1960);assert.equal((await f.row()).status,'active');
 const r=(await f.db.query(`select fn_enforce_infinity_from_quotes('${account}') r`)).rows[0].r;assert.equal(r.reason,'MARK_UNAVAILABLE');
 await f.db.exec(`update trades set symbol='GBPJPY',open_price=190 where id='${trade}'`);await f.quote(189,189.2,'GBPJPY');
 assert.equal((await f.row()).status,'active');await f.quote(150,149,'USDJPY');assert.equal((await f.db.query(`select fn_infinity_quote_equity('${account}') e`)).rows[0].e,null);
 await f.quote(150,150.2,'USDJPY');assert.notEqual((await f.db.query(`select fn_infinity_quote_equity('${account}') e`)).rows[0].e,null);
 }finally{await f.db.close();}
});
test('failed resting orders cannot be rearmed; a separately approved new account is required',async()=>{
 const f=await setup();try{
 await f.quote(2000);await f.open();await f.db.exec(`insert into pending_orders values('44444444-4444-4444-8444-444444444444','${account}','${user}','pending',null)`);
 await f.quote(1975);await assert.rejects(f.db.exec("update pending_orders set status='pending'"),/FROZEN/);
 const fresh='66666666-6666-4666-8666-666666666666';await f.db.exec(`insert into trading_accounts select '${fresh}',user_id,challenge_type,phase,'active',1,venue,
 starting_balance,starting_balance,starting_balance,day_start_date,drawdown_mode,starting_balance,trailing_peak_date,max_drawdown_pct,daily_loss_pct,
 0,created_at,null,null,null,null,null,null,false,updated_at from trading_accounts where id='${account}'`);
 await f.db.exec(`insert into trades values('77777777-7777-4777-8777-777777777777','${fresh}','${user}','XAUUSD','buy',.01,1975,'open',null,null,null)`);
 assert.equal((await f.row()).status,'breached');assert.equal((await f.db.query('select status from trading_accounts where id=$1',[fresh])).rows[0].status,'active');
 }finally{await f.db.close();}
});
test('public roles cannot invoke privileged equity/breach checks',async()=>{
 const f=await setup();try{
 await f.db.exec('set role authenticated');await assert.rejects(f.db.query('select fn_enforce_infinity_from_quotes($1)',[account]),/permission/);
 await f.db.exec('reset role');assert.equal((await f.row()).status,'active');
 }finally{await f.db.close();}
});
test('missing risk percentages are unavailable rather than silently removing a drawdown floor',async()=>{
 const f=await setup();try{
 await f.db.exec(`update trading_accounts set max_drawdown_pct=null where id='${account}'`);
 assert.equal((await f.db.query(`select fn_enforce_infinity_from_quotes('${account}') r`)).rows[0].r.reason,'RULES_UNAVAILABLE');
 assert.equal((await f.row()).status,'active');
 }finally{await f.db.close();}
});
test('one price update covers 1000 synthetic Infinity portfolios and does not lose a simultaneous breach',{timeout:60000},async t=>{
 const f=await setup();try{
 await f.quote(2000);await f.db.exec(`insert into trading_accounts(id,user_id,challenge_type,phase,status,stage,venue,
 starting_balance,balance,day_start_equity,day_start_date,drawdown_mode,trailing_peak,max_drawdown_pct,daily_loss_pct,total_paid_out,created_at)
 select md5('account-'||g)::uuid,'${user}','infinity','evaluation','active',1,'ipfx',100000,100000,100000,'2026-10-08','static',100000,5,2.5,0,'2026-10-08' from generate_series(1,1000) g;
 insert into trades(id,account_id,user_id,symbol,side,volume,open_price,status)
 select md5('trade-'||g)::uuid,md5('account-'||g)::uuid,'${user}','XAUUSD','buy',1,2000,'open' from generate_series(1,1000) g;`);
 let start=performance.now();await f.quote(1999.9);t.diagnostic('1000-portfolios steady update: '+Math.round(performance.now()-start)+' ms (synthetic SQL only)');
 start=performance.now();await f.quote(1975);t.diagnostic('1000 simultaneous freezes: '+Math.round(performance.now()-start)+' ms (synthetic SQL only)');
 assert.equal((await f.db.query("select count(*) n from trading_accounts where status='breached'")).rows[0].n,1000);
 assert.equal((await f.db.query('select count(*) n from account_breach_events')).rows[0].n,1000);
 await f.quote(2100);assert.equal((await f.db.query("select count(*) n from trading_accounts where status='breached'")).rows[0].n,1000);
 }finally{await f.db.close();}
});
test('a bookkeeping failure still freezes the observed crossing, and pending cancellation retries after recovery',async()=>{
 const f=await setup();try{
 await f.db.exec(fs.readFileSync(new URL('../supabase/migrations/20261008133001_infinity_freeze_fallback.sql',import.meta.url),'utf8').replaceAll('clock_timestamp()','public.risk_test_clock()'));
 await f.quote(2000);await f.open();await f.db.exec(`insert into pending_orders values('44444444-4444-4444-8444-444444444444','${account}','${user}','pending',null);
 create or replace function fn_ensure_demo_account(uuid) returns uuid language plpgsql as $$begin raise exception 'injected bookkeeping failure';end$$;`);
 await f.quote(1975);assert.equal((await f.row()).status,'breached');assert.equal((await f.row()).breach_equity,97500);
 assert.equal((await f.db.query("select ok from ab_heartbeats where worker='infinity-freeze-fallback'")).rows[0].ok,false);
 assert.equal((await f.db.query('select count(*) n from account_breach_events')).rows[0].n,1);
 await f.quote(2100);assert.equal((await f.row()).status,'breached');
 await f.db.query('select fn_cleanup_failed_pending()');assert.equal((await f.db.query('select status from pending_orders')).rows[0].status,'cancelled');
 }finally{await f.db.close();}
});
