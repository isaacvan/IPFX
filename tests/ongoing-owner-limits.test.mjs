import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{ongoingDb,owner,person,tradeId}from'./helpers/ongoing-copy-db.mjs';
const skip=!process.env.DEMO_TEST_DEPS;
const migration=fs.readFileSync(new URL('../supabase/migrations/20261015230000_ongoing_owner_limits.sql',import.meta.url),'utf8');
async function limitsDb(){const f=await ongoingDb();await f.db.exec(migration);await f.connect();await f.select();await f.control('on');return f;}
const version=f=>f.q('select version from ongoing_copy_connections where id=1').then(r=>r.version);
const limits=async(f,lots,posOn,posUsd,dayOn,dayUsd)=>f.q(`select ongoing_copy_limits(1,$1,'${owner}',$2,$3,$4,$5,$6,'Synthetic owner limits')r`,[await version(f),lots,posOn,posUsd,dayOn,dayUsd]);
const reserve=(f,i,risk)=>f.q(`select ab_reserve_risk('l3',$1,'${person}','XAUUSD',.01,$2)r`,[tradeId(i),risk]).then(x=>x.r);

test('owner limits change while execution stays ON, are versioned and audited',{skip},async()=>{const f=await limitsDb();try{
 const before=await version(f);const r=(await limits(f,.05,true,25,true,60)).r;
 assert.equal(r.ok,true);assert.equal(Number(r.broker_lots),.05);assert.equal(r.position_loss_cap_on,true);assert.equal(r.daily_loss_on,true);assert.equal(r.version,before+1);
 const c=await f.q('select execution_on,position_loss_cap_usd,daily_loss_usd from ongoing_copy_connections');assert.equal(c.execution_on,true);assert.equal(Number(c.position_loss_cap_usd),25);assert.equal(Number(c.daily_loss_usd),60);
 assert.equal((await f.q("select count(*)n from admin_audit_log where action='ongoing_copy_limits'")).n,1);
 await assert.rejects(f.q(`select ongoing_copy_limits(1,$1,'${owner}',.01,false,null,false,null,'Stale review')`,[before]),/STALE_CONNECTION_VERSION/);
 await assert.rejects(limits(f,2,false,null,false,null),/LIMITS_OUT_OF_RANGE/);
 await assert.rejects(limits(f,.01,true,null,false,null),/LIMITS_OUT_OF_RANGE/);
 await assert.rejects(f.q(`select ongoing_copy_limits(1,$1,'99999999-9999-4999-8999-999999999999',.01,false,null,false,null,'Not the owner')`,[await version(f)]),/OWNER_PERMISSION_REQUIRED/);
 // Switching a limit off keeps the saved amount for next time.
 await limits(f,.05,false,null,false,null);const off=await f.q('select position_loss_cap_on,position_loss_cap_usd from ongoing_copy_connections');assert.equal(off.position_loss_cap_on,false);assert.equal(Number(off.position_loss_cap_usd),25);
}finally{await f.db.close()}});

test('admission returns the trader’s own lot size and the position loss cap only while it is on',{skip},async()=>{const f=await limitsDb();try{
 await f.add(1);let c=(await f.claim(1)).r;assert.equal(Number(c.broker_lots),.01);assert.equal(c.position_loss_cap_usd,null);
 await f.q(`select ongoing_copy_trader_lots(1,'${person}',.03,'${owner}','Synthetic trader lots')`);await limits(f,.01,true,40,false,null);
 await f.add(2);c=(await f.claim(2)).r;assert.equal(Number(c.broker_lots),.03);assert.equal(Number(c.position_loss_cap_usd),40);
 await f.q(`select ongoing_copy_trader_lots(1,'${person}',null,'${owner}','Back to default')`);await limits(f,.02,false,null,false,null);
 await f.add(3);c=(await f.claim(3)).r;assert.equal(Number(c.broker_lots),.02);assert.equal(c.position_loss_cap_usd,null);
 await assert.rejects(f.q(`select ongoing_copy_trader_lots(1,'${person}',1.5,'${owner}','Too large')`),/LIMITS_OUT_OF_RANGE/);
 await assert.rejects(f.q(`select ongoing_copy_trader_lots(1,'55555555-5555-4555-8555-555555555555',.01,'${owner}','Not selected')`),/TRADER_NOT_SELECTED/);
 const view=(await f.q(`select ongoing_copy_summary('${owner}')r`)).r;assert.ok('lots' in view.selections[0]);assert.equal(view.connections[0].daily_loss_on,false);
}finally{await f.db.close()}});

test('daily loss limit: exact owner amount (loss + open risk + new risk), default 2% when off',{skip},async()=>{const f=await limitsDb();try{
 // Owner limit $20, $8 already lost today: room is exactly $12 (no 2.5x divisor).
 await limits(f,.01,false,null,true,20);await f.db.exec(`insert into book_daily_pnl values('l3',(now() at time zone 'utc')::date,-8)`);
 await f.add(1);await f.claim(1);let r=await reserve(f,1,10);assert.equal(r.ok,true);assert.equal(Number(r.allowed_usd),10);
 await f.add(2);await f.claim(2);r=await reserve(f,2,5);assert.equal(r.ok,false);assert.match(r.reason,/risk room/);
 // Off: back to the 2%-of-account default ($1,000 on $50k, with the safety divisor), so the same trade fits.
 await limits(f,.01,false,null,false,null);await f.add(3);await f.claim(3);r=await reserve(f,3,5);assert.equal(r.ok,true);
 // Loss already at the owner limit: refused outright.
 await limits(f,.01,false,null,true,8);await f.add(4);await f.claim(4);r=await reserve(f,4,1);assert.equal(r.ok,false);assert.equal(r.reason,'daily loss stop reached');
}finally{await f.db.close()}});

test('the migration patches only the anchored lines and leaves other books on their own limits',{skip},async()=>{const f=await limitsDb();try{
 const src=(await f.q(`select pg_get_functiondef('public.ab_reserve_risk(text,uuid,uuid,text,numeric,numeric)'::regprocedure)s`)).s;
 assert.match(src,/coalesce\(public\.ongoing_copy_owner_daily_loss\(la\.id\), la\.size_usd \* 0\.02\)/);
 assert.match(src,/stop_usd := lim\.daily_loss_stop_usd/);
 await f.db.exec('set role authenticated');for(const fn of['ongoing_copy_limits(1,1,null,.01,false,null,false,null,null)','ongoing_copy_owner_daily_loss(3)'])await assert.rejects(f.q('select '+fn),/permission denied/);
}finally{await f.db.close()}});
