import test from'node:test';import assert from'node:assert/strict';import{ongoingDb,owner,person,source,tradeId}from'./helpers/ongoing-copy-db.mjs';
const skip=!process.env.DEMO_TEST_DEPS;
test('Connect reuses the existing monitor with execution OFF, no role/token change and service-only controls',{skip},async()=>{const f=await ongoingDb();try{
 assert.equal((await f.connect()).r.execution_on,false);assert.equal((await f.q('select execution_enabled,role from ladder_accounts where id=3')).execution_enabled,false);assert.equal((await f.q('select count(*) n from ladder_accounts')).n,1);
 await f.db.exec('set role authenticated');await assert.rejects(f.control('on'),/permission denied/);
 }finally{await f.db.close()}});
test('explicit owner ON assigns only selected people to A-book live and more than five distinct trades are admitted',{skip},async()=>{const f=await ongoingDb();try{
 await f.connect();await f.select();assert.equal((await f.q('select book_state from ab_trader_profiles')).book_state,'BB_DEMO');await f.control('on');
 assert.equal((await f.q('select book_state from ab_trader_profiles')).book_state,'AB_LIVE');assert.equal((await f.q('select execution_enabled from ladder_accounts where id=3')).execution_enabled,false);
 for(let i=1;i<=50;i++){await f.add(i);assert.equal((await f.claim(i)).r.ok,true);}
 assert.equal((await f.q('select count(*) n from ongoing_copy_intents')).n,50);assert.equal((await f.claim(1)).r.reason,'DUPLICATE_NO_SEND');assert.equal((await f.q('select thresholds from ab_policy_versions')).thresholds.stage2AutoPct,2.75);
 }finally{await f.db.close()}});
test('parallel duplicate admissions reserve one intention and never repay a refused or unknown attempt',{skip},async()=>{const f=await ongoingDb();try{
 await f.connect();await f.select();await f.control('on');await f.add(1);const attempts=await Promise.all(Array.from({length:100},()=>f.claim(1)));assert.equal(attempts.filter(x=>x.r.ok).length,1);
 await f.q('select ongoing_copy_note($1,true,$2)',[tradeId(1),'Refused before send']);assert.equal((await f.claim(1)).r.reason,'DUPLICATE_NO_SEND');
 }finally{await f.db.close()}});
test('developer/capacity/holds/halt failures cannot turn ON or move any trader to live',{skip},async()=>{const f=await ongoingDb();try{
 await f.connect();await f.select();await assert.rejects(f.control('on',null,false),/DEVELOPER/);await f.db.exec('delete from book_capacity_limits');await assert.rejects(f.control('on'),/DEVELOPER/);
 await f.db.exec("insert into book_capacity_limits values('l3',200,500,'Synthetic evidence');update ab_person_signals set investigation_hold=true");await assert.rejects(f.control('on'),/MODEL_ASSIGNMENT_REFUSED/);
 assert.equal((await f.q('select execution_on from ongoing_copy_connections')).execution_on,false);assert.equal((await f.q('select book_state from ab_trader_profiles')).book_state,'BB_DEMO');
 await f.db.exec('update ab_person_signals set investigation_hold=false;update platform_config set trading_halted=true');await assert.rejects(f.control('on'),/HALTED/);
 }finally{await f.db.close()}});
test('OFF and Disconnect stop new entries while exact owned exits stay available; aliases cannot retarget',{skip},async()=>{const f=await ongoingDb();try{
 await f.connect();await f.select();await f.control('on');await f.add(1);await f.claim(1);await f.db.exec(`insert into book_orders(source_trade_id,event,book,status,qty,ongoing_copy_connection_id)values('${tradeId(1)}','open','l3','filled',.01,1)`);
 await f.control('off',1);assert.equal((await f.q(`select ongoing_copy_route('${person}','${source}')r`)).r,'off');assert.equal((await f.q(`select ongoing_copy_access('l3',$1,true)r`,[tradeId(1)])).r,true);
 assert.equal((await f.q(`select ongoing_copy_access('l4',$1,true)r`,[tradeId(1)])).r,false);await f.control('disconnect',1);
 assert.equal((await f.q(`select ongoing_copy_access('l3',$1,true)r`,[tradeId(1)])).r,true);await f.add(2);assert.equal((await f.claim(2)).r.ok,false);
 await assert.rejects(f.connect(),/RECONCILE/);await f.db.exec("update ladder_accounts set account_id='different'");assert.equal((await f.q(`select ongoing_copy_access('l3',$1,true)r`,[tradeId(1)])).r,false);
 }finally{await f.db.close()}});
test('future Infinity stages are eligible but old trades, practice Demo, foreign users, breaches and demotion are not',{skip},async()=>{const f=await ongoingDb();try{
 await f.connect();await f.select();await f.add(1);await f.control('on');assert.equal((await f.claim(1)).r.reason,'NEW_ELIGIBLE_SOURCE_WITH_STOP_REQUIRED');
 await f.add(2);await f.db.exec("update trading_accounts set status='breached'");assert.equal((await f.claim(2)).r.ok,false);await f.db.exec("update trading_accounts set status='active',phase='demo'");assert.equal((await f.claim(2)).r.ok,false);
 await f.db.exec("update trading_accounts set phase='challenge',stage=2");assert.equal((await f.claim(2)).r.ok,true);
 await f.add(3);await f.db.exec("update ab_trader_profiles set book_state='AB_DEMO'");assert.equal((await f.claim(3)).r.ok,false);
 await f.db.exec("update ab_trader_profiles set book_state='AB_LIVE';update trades set user_id='55555555-5555-4555-8555-555555555555' where id='"+tradeId(3)+"'");assert.equal((await f.claim(3)).r.handled,false);
 }finally{await f.db.close()}});
test('risk reservation for this monitor requires an exact admitted ongoing intention; ordinary monitor orders stay blocked',{skip},async()=>{const f=await ongoingDb();try{
 await f.connect();await f.select();await f.control('on');await f.add(1);
 const reserve=()=>f.q(`select ab_reserve_risk('l3',$1,'${person}','XAUUSD',.01,3)r`,[tradeId(1)]);
 assert.equal((await reserve()).r.ok,false);await f.claim(1);assert.equal((await reserve()).r.ok,true);assert.equal((await reserve()).r.reason,'duplicate');
 await f.add(2);await f.claim(2);await f.control('off',2);assert.equal((await f.q(`select ab_reserve_risk('l3',$1,'${person}','XAUUSD',.01,3)r`,[tradeId(2)])).r.ok,false);
 }finally{await f.db.close()}});
test('exit records inherit the original connection and new selected traders while ON require explicit confirmation',{skip},async()=>{const f=await ongoingDb();try{
 await f.connect();await f.select();await f.control('on');await f.add(1);await f.claim(1);await f.db.exec(`insert into book_orders(source_trade_id,event,book,status,qty,ongoing_copy_connection_id)values('${tradeId(1)}','open','l3','filled',.01,1);insert into book_orders(source_trade_id,event,book,status,qty)values('${tradeId(1)}','partial_close','l3','sent',.005)`);
 assert.equal((await f.q("select ongoing_copy_connection_id from book_orders where event='partial_close'")).ongoing_copy_connection_id,1);
 await assert.rejects(f.select(),/CONFIRM/);await f.q(`select ongoing_copy_select(1,'${person}',false,'${owner}','Owner stopped copying')`);assert.equal((await f.q(`select ongoing_copy_route('${person}','${source}')r`)).r,'off');
 }finally{await f.db.close()}});


test('selection changes invalidate prior ON review; OFF returns authoritative state even with an old version',{skip},async()=>{const f=await ongoingDb();try{
 await f.connect();await f.select();assert.equal((await f.control('on',1)).r.reason,'STALE_CONNECTION_VERSION');await f.control('on');
 await assert.rejects(f.q(`select ongoing_copy_select(1,'${person}',true,'${owner}','Synthetic chosen trader',true,1)`),/STALE_CONNECTION/);
 const current=(await f.q('select version from ongoing_copy_connections')).version;await f.q(`select ongoing_copy_select(1,'${person}',true,'${owner}','Synthetic chosen trader',true,${current})`);
 assert.equal((await f.q('select version from ongoing_copy_connections')).version,current+1);
 const stopped=(await f.control('off',1)).r;assert.equal(stopped.execution_on,false);assert.equal(stopped.connected,true);assert.equal(stopped.id,1);assert.equal(stopped.version,current+2);
 }finally{await f.db.close()}});
