import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{ongoingDb,owner,person,tradeId}from'./helpers/ongoing-copy-db.mjs';
const skip=!process.env.DEMO_TEST_DEPS;
const read=n=>fs.readFileSync(new URL('../supabase/migrations/'+n,import.meta.url),'utf8');
async function planDb(){
 const f=await ongoingDb();
 await f.db.exec(`alter table book_orders add column updated_at timestamptz default now(),add column idempotency_key text unique,add column price_scale_per_lot numeric,add column risk_release_applied boolean default false;
  create table cost_fills(id bigint generated always as identity,account_id bigint,ref text,raw jsonb);
  create table finalize_log(id bigint);create function fn_finalize_book_exit(bigint)returns void language sql as 'insert into public.finalize_log values($1)';`);
 await f.db.exec(read('20261015230000_ongoing_owner_limits.sql'));await f.db.exec(read('20261016000000_ab_risk_plan.sql'));
 await f.connect();await f.select();await f.control('on');return f;
}
const version=f=>f.q('select version from ongoing_copy_connections where id=1').then(r=>r.version);
const plan=async(f,p)=>f.q(`select ongoing_copy_risk_plan(1,$1,'${owner}',$2::jsonb,'Synthetic risk plan')r`,[await version(f),JSON.stringify(p)]);
const RECOMMENDED={size_mode:'risk',risk_per_trade_usd:50,stop_multiple:1.5,trader_max_open:3,trader_daily_cut_usd:200,kill_switch_on:true,kill_day_loss_usd:750,daily_loss_on:true,daily_loss_usd:600,lots:1};
const save=(f,reading)=>f.q(`select ongoing_copy_guard_save(3,$1::jsonb)r`,[JSON.stringify(reading)]).then(x=>x.r);

test('the recommended plan saves in one audited change while execution stays on; inconsistent plans are refused',{skip},async()=>{const f=await planDb();try{
 assert.equal((await plan(f,RECOMMENDED)).r.ok,true);
 const c=await f.q('select * from ongoing_copy_connections');assert.equal(c.execution_on,true);assert.equal(c.size_mode,'risk');assert.equal(Number(c.risk_per_trade_usd),50);
 assert.equal(c.trader_max_open,3);assert.equal(Number(c.kill_day_loss_usd),750);assert.equal(Number(c.daily_loss_usd),600);assert.equal(Number(c.broker_lots),1);
 assert.equal((await f.q("select count(*)n from admin_audit_log where action='ongoing_copy_risk_plan'")).n,1);
 await assert.rejects(plan(f,{...RECOMMENDED,daily_loss_usd:800}),/RISK_PLAN_OUT_OF_RANGE/);
 await assert.rejects(plan(f,{...RECOMMENDED,risk_per_trade_usd:null}),/RISK_PLAN_OUT_OF_RANGE/);
 await assert.rejects(plan(f,{...RECOMMENDED,stop_multiple:5}),/RISK_PLAN_OUT_OF_RANGE/);
 await assert.rejects(f.q(`select ongoing_copy_risk_plan(1,1,'${owner}','{}'::jsonb,'Stale')`),/STALE_CONNECTION_VERSION/);
}finally{await f.db.close()}});

test('kill switch: trips once on the broker day loss, switches execution off and asks for every position to close',{skip},async()=>{const f=await planDb();try{
 await plan(f,RECOMMENDED);
 let d=await save(f,{balance:49000,equity:48700,today_net:-200,open_net:-100,positions:3});assert.equal(d.flatten,false);assert.equal(Number(d.day_pnl),-300);
 d=await save(f,{error:'RATE_LIMITED'});assert.equal(d.flatten,false);
 d=await save(f,{balance:49000,equity:48240,today_net:-400,open_net:-360,positions:4});
 assert.equal(d.flatten,true);assert.equal(d.reason,'DAY_LOSS');assert.equal(d.tripped_now,true);
 const c=await f.q('select execution_on,kill_reason from ongoing_copy_connections');assert.equal(c.execution_on,false);assert.match(c.kill_reason,/DAY_LOSS: day P&L -760/);
 assert.equal((await f.q("select count(*)n from admin_audit_log where action='ongoing_copy_kill_switch'")).n,1);
 // Still breached with positions left: keep flattening, but no second trip.
 d=await save(f,{balance:49000,equity:48240,today_net:-760,open_net:0,positions:1});assert.equal(d.flatten,true);assert.equal(d.tripped_now,false);
 d=await save(f,{balance:49000,equity:48240,today_net:-760,open_net:0,positions:0});assert.equal(d.flatten,false);
 assert.equal((await f.q("select count(*)n from admin_audit_log where action='ongoing_copy_kill_switch'")).n,1);
 // New copies are refused while execution is off.
 await f.add(9);assert.equal((await f.claim(9)).r.ok,false);
}finally{await f.db.close()}});

test('kill switch also trips on the equity floor, and never when switched off',{skip},async()=>{const f=await planDb();try{
 await plan(f,{...RECOMMENDED,kill_switch_on:false});assert.equal((await save(f,{equity:40000,today_net:-900,open_net:-900,positions:2})).flatten,false);
 await plan(f,{...RECOMMENDED,equity_floor_usd:47000});const d=await save(f,{equity:46990,today_net:-10,open_net:0,positions:1});assert.equal(d.reason,'EQUITY_FLOOR');assert.equal(d.flatten,true);
}finally{await f.db.close()}});

test('admission carries the risk sizing, and per-trader open and daily-loss limits stop a trader’s new copies',{skip},async()=>{const f=await planDb();try{
 await plan(f,{...RECOMMENDED,trader_max_open:2,trader_daily_cut_usd:100});
 await f.add(1);let c=(await f.claim(1)).r;assert.equal(c.ok,true);assert.equal(c.size_mode,'risk');assert.equal(Number(c.risk_per_trade_usd),50);assert.equal(Number(c.stop_multiple),1.5);
 const openCopy=(i)=>f.db.query(`insert into book_orders(source_trade_id,event,book,person_id,status,qty,side,ongoing_copy_connection_id,broker_position_id,fill_price,price_scale_per_lot,idempotency_key)values($1,'open','l3','${person}','filled',.1,'buy',1,$2,4000,100,$3)`,[tradeId(i),String(600+i),'l3:'+i+':open']);
 await openCopy(1);await f.add(2);await f.claim(2);await openCopy(2);
 await f.add(3);c=(await f.claim(3)).r;assert.equal(c.ok,false);assert.equal(c.reason,'TRADER_OPEN_COPY_LIMIT');
 // One copy closes at -$120 today: open count drops but the daily cut now applies.
 await f.db.query(`update trades set status='closed' where id=$1`,[tradeId(1)]);
 await f.db.query(`insert into book_orders(source_trade_id,event,book,person_id,status,qty,side,dispatch_state,broker_confirmed_qty,pnl_usd,ongoing_copy_connection_id,idempotency_key)values($1,'close','l3','${person}','closed',.1,'sell','confirmed',.1,-120,1,'l3:1:close')`,[tradeId(1)]);
 await f.add(4);c=(await f.claim(4)).r;assert.equal(c.ok,false);assert.equal(c.reason,'TRADER_DAILY_LOSS_CUT');
 // A trader with their own lot size is sized by those lots, not by risk.
 await f.q(`select ongoing_copy_trader_lots(1,'${person}',.02,'${owner}','Own lots')`);await plan(f,{...RECOMMENDED,trader_max_open:null,trader_daily_cut_usd:null});
 await f.add(5);c=(await f.claim(5)).r;assert.equal(c.size_mode,'fixed');assert.equal(Number(c.broker_lots),.02);
}finally{await f.db.close()}});

test('a copy closed by its broker stop is recorded once from the exact broker receipt, so the trader’s later close is skipped',{skip},async()=>{const f=await planDb();try{
 await f.add(1);await f.claim(1);
 const open=(await f.q(`insert into book_orders(source_trade_id,event,book,person_id,status,qty,side,ongoing_copy_connection_id,broker_position_id,fill_price,price_scale_per_lot,idempotency_key,symbol)values($1,'open','l3','${person}','filled',.33,'buy',1,'901',4000,100,'l3:x:open','XAUUSD')returning id`,[tradeId(1)])).id;
 let r=(await f.q('select fn_record_ongoing_broker_close($1)r',[open])).r;assert.equal(r.reason,'WAITING_BROKER_CLOSE_RECEIPT');
 const created=Date.now()+1000;
 await f.db.query(`insert into cost_fills(account_id,ref,raw)values(3,'777',$1::jsonb)`,[JSON.stringify({positionId:'901',isOpen:'false',status:'Filled',side:'sell',createdDate:String(created),filledQty:'0.33',avgPrice:'3998.5'})]);
 r=(await f.q('select fn_record_ongoing_broker_close($1)r',[open])).r;assert.equal(r.ok,true);assert.equal(Number(r.pnl_usd),-49.5);
 assert.equal((await f.q("select count(*)n from finalize_log")).n,1);
 assert.equal((await f.q('select fn_record_ongoing_broker_close($1)r',[open])).r.skipped,'ALREADY_CLOSED');
 const exit=await f.q(`select event,status,dispatch_state,broker_order_id,idempotency_key from book_orders where event='close'`);assert.equal(exit.dispatch_state,'confirmed');assert.equal(exit.broker_order_id,'777');assert.match(exit.idempotency_key,/:close$/);
}finally{await f.db.close()}});

test('an exit sent to a position the broker had already closed is resolved from the earlier broker receipt',{skip},async()=>{const f=await planDb();try{
 await f.add(1);await f.claim(1);
 const open=(await f.q(`insert into book_orders(source_trade_id,event,book,person_id,status,qty,side,ongoing_copy_connection_id,broker_position_id,fill_price,price_scale_per_lot,idempotency_key)values($1,'open','l3','${person}','filled',.1,'sell',1,'902',4000,100,'l3:y:open')returning id`,[tradeId(1)])).id;
 await f.db.query(`insert into cost_fills(account_id,ref,raw)values(3,'888',$1::jsonb)`,[JSON.stringify({positionId:'902',isOpen:'false',status:'Filled',side:'buy',createdDate:String(Date.now()+500),filledQty:'0.1',avgPrice:'4002'})]);
 await f.db.query(`insert into book_orders(source_trade_id,event,book,person_id,status,qty,side,dispatch_state,ongoing_copy_connection_id,idempotency_key)values($1,'close','l3','${person}','reconciliation_required',.1,'buy','unknown',1,'l3:y:close')`,[tradeId(1)]);
 const r=(await f.q('select fn_record_ongoing_broker_close($1)r',[open])).r;assert.equal(r.ok,true);assert.equal(Number(r.pnl_usd),-20);
 assert.equal((await f.q(`select count(*)n from book_orders where event='close'`)).n,1);
 assert.equal((await f.q(`select status from book_orders where event='close'`)).status,'closed');
}finally{await f.db.close()}});

test('the daily new-copy limit counts the broker’s own closed loss for its day when the guard reading is fresh',{skip},async()=>{const f=await planDb();try{
 await plan(f,{...RECOMMENDED,kill_switch_on:false,daily_loss_usd:100,daily_loss_on:true});
 await save(f,{equity:49900,today_net:-95,open_net:0,positions:0});
 await f.add(1);await f.claim(1);const r=(await f.q(`select ab_reserve_risk('l3',$1,'${person}','XAUUSD',.01,10)r`,[tradeId(1)])).r;
 // $95 of the $100 already lost at the broker today: only $5 of room, so a $10 copy cannot be reserved in full.
 assert.equal(Number(r.allowed_usd??0)<10,true);
 await f.db.exec(`update ab_equity_guard set read_at=now()-interval '10 minutes'`);await f.add(2);await f.claim(2);
 assert.equal(Number((await f.q(`select ab_reserve_risk('l3',$1,'${person}','XAUUSD',.01,10)r`,[tradeId(2)])).r.allowed_usd),10);
}finally{await f.db.close()}});
