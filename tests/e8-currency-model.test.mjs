import fs from'node:fs';import test from'node:test';import assert from'node:assert/strict';import {fixture,account,root,user,slice}from'./helpers/e8-db-fixture.mjs';
const sql=fs.readFileSync(new URL('../supabase/migrations/20261012233000_e8_currency_model.sql',import.meta.url),'utf8').split('-- LIVE_ACCURACY_WRAPPER_FOLLOWS')[0],deps=process.env.DEMO_TEST_DEPS;
async function setup({book='a',side='buy',currency='JPY',infinity=false}={}){const f=await fixture();await f.db.exec(`create table e8_instrument_evidence(id bigint generated always as identity,account_id bigint,symbol text,lot_size numeric,quote_currency text,details jsonb,observed_at timestamptz);
 insert into e8_instrument_evidence(account_id,symbol,lot_size,quote_currency,details,observed_at)values(3,'USDJPY',100000,'${currency}','{"minLot":0.01,"maxLot":100,"lotStep":0.01}',now()-interval '180 seconds');
 insert into ab_trader_profiles values('${user}','${book==='a'?'AB_DEMO':'BB_DEMO'}');`);await f.db.exec(sql);if(infinity)await f.db.exec(`update trading_accounts set challenge_type='infinity',status='active' where id='${account}'`);await f.open('USDJPY',side);
 const quote=(symbol,sec,bid,ask,acct=3)=>f.db.exec(`insert into e8_reference_quotes(account_id,symbol,bid,ask,requested_at,received_at)values(${acct},'${symbol}',${bid},${ask},now()-interval '${sec} seconds',now()-interval '${sec-.1} seconds')`);
 const close=()=>f.db.exec(`update trades set status='closed',closed_at=now()-interval '40 seconds',close_price=1.099 where id='${root}'`);
 const model=async()=>(await f.db.query(`select e8_currency_model('${root}') m`)).rows[0].m;
 return {...f,q:quote,close,model};}
test('JPY gains use ask conversion, liabilities bid, across both frozen directions and trader sides',{skip:!deps},async()=>{for(const book of['a','b'])for(const side of['buy','sell']){const f=await setup({book,side});try{await f.q('USDJPY',119,150,150.02);await f.q('USDJPY',39,151,151.02);await f.close();const m=await f.model(),buy=book==='a'?side==='buy':side==='sell';assert.equal(m.available,true);assert.ok(Math.abs(m.gross_usd-(buy?1960/151.02:-2040/151))<1e-9);assert.equal(m.net_verified,false);assert.equal(m.currency_assumption,'USD_ACCOUNT_MODEL');assert.equal(m.fully_closed,true);}finally{await f.db.close()}}});
test('partial quantities weighted exactly once, and archived USD-unavailable records stay unchanged',{skip:!deps},async()=>{const f=await setup();try{await f.db.exec(`update trades set volume=.01 where id='${root}';insert into trades(id,parent_trade_id,account_id,user_id,symbol,side,volume,status,open_price,close_price,opened_at,closed_at,close_reason)values('${slice}','${root}','${account}','${user}','USDJPY','buy',.01,'closed',1.1,1.101,now()-interval '120 seconds',now()-interval '80 seconds','partial');`);await f.q('USDJPY',119,150,150.02);await f.q('USDJPY',79,150.5,150.52);await f.q('USDJPY',39,151,151.02);await f.close();await f.db.query('select e8_sim_tick()');const before=(await f.result()).status,m=await f.model();assert.equal(before,'USD_SCALE_UNVERIFIED');assert.equal(m.available,true);assert.equal(m.events.length,2);assert.ok(Math.abs(m.gross_usd-(480/150.52+980/151.02))<1e-9);assert.equal((await f.result()).status,before);await f.db.exec('set role authenticated');await assert.rejects(f.model(),/permission denied/);}finally{await f.db.close()}});
test('direct GBP conversion is bid for gains, ask for losses, and stale/future/wrong-account FX cannot price',{skip:!deps},async()=>{for(const mode of['valid','stale','future','wrong-account']){const f=await setup({currency:'GBP'});try{await f.q('USDJPY',119,150,150.02);await f.q('USDJPY',39,151,151.02);await f.q('GBPUSD',mode==='stale'?60:mode==='future'?38:40,1.2,1.21,mode==='wrong-account'?9:3);await f.close();const m=await f.model();assert.equal(m.available,mode==='valid');if(mode==='valid')assert.ok(Math.abs(m.gross_usd-1960*1.2)<1e-9);else assert.equal(m.reason,'FRESH_ASOF_FX_MISSING');}finally{await f.db.close()}}});
test('late quotes, oversized exits, unsupported currency and missing step/spec are rejected',{skip:!deps},async()=>{for(const mode of['late','over','unsupported','step','spec']){const f=await setup({currency:mode==='unsupported'?'SEK':'JPY'});try{await f.q('USDJPY',mode==='late'?39:119,150,150.02);await f.q('USDJPY',38,151,151.02);await f.close(); // Archive is immutable; insert an extra source event instead.
 if(mode==='over')await f.db.exec(`insert into e8_sim_events(trade_id,source_row_id,kind,event_at,lots,source_snapshot)values('${root}','55555555-5555-4555-8555-555555555555','partial',now()-interval '80 seconds',.03,'{}')`);
 if(mode==='step')await f.db.exec(`update e8_instrument_evidence set details='{}'`);if(mode==='spec')await f.db.exec(`update e8_instrument_evidence set observed_at=now()`);
 const m=await f.model();assert.equal(m.available,false,mode);assert.equal(m.net_verified,false);
 }finally{await f.db.close()}}});

test('readiness counts uncaptured closed source trades, not just successful estimates; broker proof remains zero',{skip:!deps},async()=>{const f=await setup({infinity:true});try{
 await f.q('USDJPY',119,150,150.02);await f.q('USDJPY',39,151,151.02);await f.close();await f.db.query('select e8_sim_tick()');
 // A root outside the replay capture window must remain in the denominator.
 await f.db.exec(`insert into trades(id,account_id,user_id,symbol,side,volume,status,open_price,opened_at,closed_at)values('66666666-6666-4666-8666-666666666666','${account}','${user}','USDJPY','buy',.02,'closed',150,now()-interval '8 days',now()-interval '7 days');`);
 await f.db.exec(fs.readFileSync(new URL('../supabase/migrations/20261012233500_accuracy_readiness.sql',import.meta.url),'utf8'));
 const q=(await f.db.query('select e8_accuracy_readiness() q')).rows[0].q;
 assert.equal(q.source_closed_roots,2);assert.equal(q.captured_roots,1);assert.equal(q.missing_archive,1);assert.equal(q.currency_supplement_gross,1);
 assert.equal(q.paired_broker_net,0);assert.equal(q.measured_net_accuracy,null);assert.equal(q.certified_95,false);
 await f.db.exec('set role anon');await assert.rejects(f.db.query('select e8_accuracy_readiness()'),/permission denied/);
 }finally{await f.db.close()}});

test('deployed accuracy wrapper uses the FX model without treating reconstruction or fees as broker net',{skip:!deps},async()=>{const f=await setup();try{
 await f.db.exec(`alter table e8_monitor_profiles add column max_quote_age_ms int default 15000;
 create table cost_symbol_model(symbol text,e8_commission_per_lot numeric,note text);
 create table ipfx_sim_decision_quotes(audit_id bigint,trade_id uuid,source_row_id uuid,kind text,bid numeric,ask numeric,quote_ts timestamptz,server_ts timestamptz);
 create view ipfx_sim_decision_results as select '${root}'::uuid trade_id,1::numeric selected_gross_usd;
 insert into cost_symbol_model values('USDJPY',6,'configured estimate');`);
 const migration=fs.readFileSync(new URL('../supabase/migrations/20261012233000_e8_currency_model.sql',import.meta.url),'utf8');
 await f.db.exec(migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.e8_sim_accuracy')));
 await f.q('USDJPY',119,150,150.02);await f.q('USDJPY',39,151,151.02);await f.close();await f.db.query('select e8_sim_tick()');
 const a=(await f.db.query(`select e8_sim_accuracy('${root}') a`)).rows[0].a;
 assert.ok(Math.abs(a.e8_gross_usd-1960/151.02)<1e-9);assert.equal(a.scale_basis,'OBSERVED_FX_MARK_ESTIMATE');assert.equal(a.e8_commission_usd,.12);
 assert.equal(a.net_verified,false);assert.equal(a.net_usd,null);assert.equal(a.currency_model.currency_assumption,'USD_ACCOUNT_MODEL');
 assert.ok(a.e8_entry_wait_ms>0);assert.ok(a.e8_exit_wait_ms>0);assert.equal(a.one_tick_slippage_usd,null);
 }finally{await f.db.close()}});
