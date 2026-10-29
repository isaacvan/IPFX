import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const migration=fs.readFileSync(new URL('../supabase/migrations/20261029090000_infinity_v2_versions.sql',import.meta.url),'utf8');
const id=i=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
async function fixture(){
 const {PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href);
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table trading_accounts(id uuid primary key,user_id uuid,challenge_type text,stage int,funded_from_account_id uuid,balance numeric,status text default 'active',phase text default 'evaluation');
 create table trades(id uuid primary key,opened_at timestamptz);
 insert into trading_accounts(id,user_id,challenge_type,stage,funded_from_account_id,balance) values('${id(1)}','${id(99)}','infinity',1,null,1000);`);
 await db.exec(migration); return db;
}
test('database backfill, default off, time gate, parent inheritance, restarts and immutability',{skip:!process.env.DEMO_TEST_DEPS},async()=>{
 const db=await fixture();
 const add=(i,stage=1,parent=null)=>db.query('insert into trading_accounts(id,user_id,challenge_type,stage,funded_from_account_id,balance) values($1,$2,\'infinity\',$3,$4,1000) returning rules_version',[id(i),id(99),stage,parent]);
 try{
  assert.equal((await db.query('select rules_version from trading_accounts')).rows[0].rules_version,'infinity_v1');
  assert.equal((await add(2)).rows[0].rules_version,'infinity_v1');
  await assert.rejects(db.exec('update infinity_v2_settings set infinity_v2_enabled=true where singleton'),/check constraint/);
  await db.exec("update infinity_v2_settings set integration_ready=true,terms_version='test-only',infinity_v2_enabled=true,cutover_at=now()+interval '1 day' where singleton");
  assert.equal((await add(3)).rows[0].rules_version,'infinity_v1');
  await db.exec("update infinity_v2_settings set cutover_at=now()-interval '1 day' where singleton");
  assert.equal((await add(4)).rows[0].rules_version,'infinity_v2');
  assert.equal((await add(5,2,id(1))).rows[0].rules_version,'infinity_v1');
  assert.equal((await add(6,2,id(4))).rows[0].rules_version,'infinity_v2');
  assert.equal((await add(7,1,id(1))).rows[0].rules_version,'infinity_v2');
  await assert.rejects(db.query("update trading_accounts set rules_version='infinity_v1' where id=$1",[id(4)]),/IMMUTABLE/);
  await assert.rejects(db.query("update trading_accounts set rules_version='infinity_v2' where id=$1",[id(1)]),/IMMUTABLE/);
  await db.exec('update infinity_v2_settings set infinity_v2_enabled=false where singleton');
  assert.equal((await add(8)).rows[0].rules_version,'infinity_v1');
  assert.equal((await add(9,2,id(4))).rows[0].rules_version,'infinity_v2','existing v2 stage inheritance survives disabling new starts');
 }finally{await db.close();}
});
test('switch requires published consent and flatness; retry is stable and preserves balance',{skip:!process.env.DEMO_TEST_DEPS},async()=>{
 const db=await fixture();try{
  await db.exec(`alter table trades add column account_id uuid,add column status text;
    create table pending_orders(account_id uuid,status text);
    create table platform_legal_documents(version text primary key,kind text);
    create table platform_legal_current(kind text,version text);
    create table platform_legal_acceptances(user_id uuid,terms_version text,privacy_version text,context jsonb);
    insert into platform_legal_documents values('test-only','terms'),('privacy','privacy');
    insert into platform_legal_current values('privacy','privacy');`);
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261029091000_infinity_v2_switch.sql',import.meta.url),'utf8'));
  const call=(request='request-123',accept=true)=>db.query('select fn_switch_infinity_v2($1,$2,$3,$4,$5) j',[id(1),id(99),request,'test-only',accept]);
  await assert.rejects(call(),/V2_NOT_LIVE/);
  await db.exec("update infinity_v2_settings set integration_ready=true,terms_version='test-only',infinity_v2_enabled=true,cutover_at=now()-interval '1 day' where singleton");
  await assert.rejects(call('request-123',false),/TERMS_NOT_ACCEPTED/);
  await db.query('insert into trades(id,opened_at,account_id,status) values($1,now(),$2,\'open\')',[id(2),id(1)]);
  await assert.rejects(call(),/CLOSE_OPEN/);
  await db.query("update trades set status='closed' where id=$1",[id(2)]);
  await db.query("insert into pending_orders values($1,'pending')",[id(1)]);
  await assert.rejects(call(),/CANCEL_PENDING/);
  await db.query("update pending_orders set status='cancelled' where account_id=$1",[id(1)]);
  const a=(await call()).rows[0].j,b=(await call()).rows[0].j;
  assert.deepEqual(a,b);
  await assert.rejects(call('different-request'),/ALREADY_SWITCHED/);
  const account=(await db.query('select * from trading_accounts where id=$1',[id(1)])).rows[0];
  assert.equal(Number(account.balance),1000);assert.equal(account.rules_version,'infinity_v2');
  assert.equal((await db.query('select * from platform_legal_acceptances')).rows.length,1);
  assert.equal((await db.query('select * from infinity_v2_switches')).rows.length,1);
  await assert.rejects(db.exec('delete from infinity_v2_switches where true'),/APPEND_ONLY/);
 }finally{await db.close();}
});
test('opening risk is set once within 30 seconds and cannot be erased',{skip:!process.env.DEMO_TEST_DEPS},async()=>{
 const db=await fixture();try{
  await db.query('insert into trades values($1,now(),null,null,null)',[id(1)]);
  await db.query('update trades set initial_sl=1,initial_sl_at=opened_at,initial_risk_usd=5 where id=$1',[id(1)]);
  await assert.rejects(db.query('update trades set initial_risk_usd=2 where id=$1',[id(1)]),/IMMUTABLE/);
  await assert.rejects(db.query('update trades set initial_sl=null,initial_sl_at=null,initial_risk_usd=null where id=$1',[id(1)]),/IMMUTABLE/);
  await assert.rejects(db.query("insert into trades values($1,now(),1,now()+interval '31 seconds',5)",[id(2)]),/TOO_LATE/);
 }finally{await db.close();}
});
