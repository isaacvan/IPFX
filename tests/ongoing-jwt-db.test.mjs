import test from'node:test';import assert from'node:assert/strict';import{ongoingDb,owner,person,tradeId}from'./helpers/ongoing-copy-db.mjs';
const skip=!process.env.DEMO_TEST_DEPS;
test('JWT-only account can be reviewed and explicitly turned ON without a developer key; capacity and exact admission remain required',{skip},async()=>{const f=await ongoingDb();try{
 await f.connect();await f.select();const view=(await f.q(`select ongoing_copy_summary('${owner}')r`)).r;assert.equal(view.connections[0].jwt_available,true);assert.equal(view.connections[0].execution_on,false);
 await f.control('on',null,false);assert.equal((await f.q('select jwt_only from ongoing_copy_connections')).jwt_only,true);
 assert.equal((await f.q(`select ongoing_copy_jwt_capacity_allowed('l3',$1)r`,[tradeId(1)])).r,false);await f.add(1);await f.claim(1);assert.equal((await f.q(`select ongoing_copy_jwt_capacity_allowed('l3',$1)r`,[tradeId(1)])).r,true);
 await f.control('off');assert.equal((await f.q(`select ongoing_copy_jwt_capacity_allowed('l3',$1)r`,[tradeId(1)])).r,false);
 await f.db.exec('set role authenticated');await assert.rejects(f.q(`select ongoing_copy_single_account(1)`),/permission denied/);
 }finally{await f.db.close()}});
test('another active physical execution account blocks JWT-only activation and never changes selected models',{skip},async()=>{const f=await ongoingDb();try{
 await f.connect();await f.select();await f.db.exec("insert into ladder_accounts(id,role,execution_enabled,status,api_env,account_id,server,size_usd)values(4,'ladder',true,'funded','demo','400','Synthetic Broker',50000)");
 await assert.rejects(f.control('on',null,false),/MULTI_ACCOUNT_DEVELOPER/);assert.equal((await f.q('select book_state from ab_trader_profiles')).book_state,'BB_DEMO');assert.equal((await f.q('select execution_on from ongoing_copy_connections')).execution_on,false);
 await f.control('on',null,true);assert.equal((await f.q('select jwt_only from ongoing_copy_connections')).jwt_only,false);
 }finally{await f.db.close()}});
test('a second active account invalidates new JWT-only admissions but exact owned exits survive',{skip},async()=>{const f=await ongoingDb();try{
 await f.connect();await f.select();await f.control('on',null,false);await f.add(1);await f.claim(1);await f.db.exec(`insert into book_orders(source_trade_id,event,book,status,qty,ongoing_copy_connection_id)values('${tradeId(1)}','open','l3','filled',.01,1)`);
 await f.db.exec("insert into ladder_accounts(id,role,execution_enabled,status,api_env,account_id,server,size_usd)values(4,'shadow',true,'evaluation','demo','400','Synthetic Broker',50000)");
 assert.equal((await f.q('select ongoing_copy_ready(1)r')).r,false);assert.equal((await f.q(`select ongoing_copy_jwt_capacity_allowed('l3',$1)r`,[tradeId(1)])).r,false);
 assert.equal((await f.q(`select ongoing_copy_access('l3',$1,true)r`,[tradeId(1)])).r,true);await f.add(2);assert.equal((await f.claim(2)).r.ok,false);
 }finally{await f.db.close()}});
