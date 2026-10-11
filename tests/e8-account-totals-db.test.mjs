import fs from'node:fs';import test from'node:test';import assert from'node:assert/strict';import {pathToFileURL}from'node:url';
test('account snapshots are private and immutable, cannot become trade net evidence and retain missing costs',{skip:!process.env.DEMO_TEST_DEPS},async()=>{
 const {PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href),db=new PGlite();
 try{await db.exec(`create role anon;create role authenticated;create role service_role;create table e8_monitor_profiles(account_id bigint primary key);insert into e8_monitor_profiles values(1);
 create function e8_revision_immutable() returns trigger language plpgsql as $$begin raise exception 'append-only';end$$;`);
 const sql=fs.readFileSync(new URL('../supabase/migrations/20261012003000_e8_account_totals.sql',import.meta.url),'utf8').split('-- LIVE_DEFINITIONS_FOLLOW')[0];await db.exec(sql);
 await db.exec(`insert into e8_account_snapshots(account_id,requested_at,received_at,amounts,period_basis,reconciliation) values(1,now(),now(),'{"todayNet":null,"todayFees":0}','BROKER_TODAY_BOUNDARY_UNCONFIRMED','{"status":"INCOMPLETE"}')`);
 assert.equal((await db.query('select amounts from e8_account_snapshots')).rows[0].amounts.todayNet,null);
 for(const statement of['update e8_account_snapshots set currency=\'USD\'','delete from e8_account_snapshots'])await assert.rejects(db.exec(statement),/append-only/);
 await assert.rejects(db.exec(`insert into e8_account_snapshots(account_id,requested_at,received_at,amounts,period_basis,reconciliation,trade_net_verified) values(1,now(),now(),'{}','BROKER_TODAY_BOUNDARY_UNCONFIRMED','{}',true)`),/check constraint/);
 await db.exec('set role authenticated');await assert.rejects(db.query('select * from e8_account_snapshots'),/permission denied/);
 }finally{await db.close();}
});
