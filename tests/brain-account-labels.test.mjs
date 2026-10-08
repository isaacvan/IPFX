import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{pathToFileURL}from'node:url';
import'../assets/js/brain-account-labels.js';const a=globalThis.IPFXBrainAccountLabels;
test('practice is distinct from routing and wins over a retained Infinity type',()=>{
 assert.equal(a.label({phase:'demo',challenge_type:'infinity',stage:1,status:'demo'}),'Demo practice');
 assert.equal(a.label({phase:'evaluation',challenge_type:'infinity',stage:2,status:'active'}),'Infinity · Stage 2');
 assert.equal(a.label({phase:'funded',challenge_type:'traditional',stage:4,status:'active'}),'Traditional · Stage 4');
 assert.equal(a.kind({book_state:'BB_DEMO'}),'unknown');assert.equal(a.visible(null),null);
 assert.equal(a.matches(null,'unknown'),true);
});
test('mixed active accounts and last entry are explicit; failed accounts with outstanding positions remain visible',()=>{
 const demo={phase:'demo',status:'demo',created_at:'2026-10-08',last_order_at:'2026-10-08T09:00:00Z'};
 const infinity={phase:'evaluation',status:'active',challenge_type:'infinity',stage:2,created_at:'2026-10-07',last_order_at:'2026-10-08T10:00:00Z'};
 assert.equal(a.visible([demo,infinity]).length,2);assert.equal(a.latest([demo,infinity]),infinity);
 assert.equal(a.matches([demo,infinity],'demo'),true);assert.equal(a.matches([demo,infinity],'infinity'),true);
 const failed={...infinity,status:'breached',access_revoked_at:'2026-10-08',open_positions:1};assert.equal(a.visible([demo,failed]).length,2);
 assert.deepEqual(a.visible([demo,{...failed,open_positions:0}]),[demo]);assert.equal(a.matches([demo,{...failed,open_positions:0}],'infinity'),false);
});
test('account context aggregates duplicate identities, preserves phase and reports real trade/pending timestamps; public access denied',async()=>{
 const{PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href),db=new PGlite();
 const person='11111111-1111-4111-8111-111111111111',alias='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create function ab_person_of(uuid)returns uuid language sql immutable as 'select case when $1=''${alias}''::uuid then ''${person}''::uuid else $1 end';
 create table trading_accounts(id uuid,user_id uuid,label text,phase text,challenge_type text,stage int,status text,balance numeric,starting_balance numeric,
 access_revoked_at timestamptz,investigation_hold bool,breach_reason text,breached_at timestamptz,created_at timestamptz);
 create table trades(account_id uuid,status text,opened_at timestamptz);create table pending_orders(account_id uuid,created_at timestamptz);
 insert into trading_accounts values('${id}','${alias}','Synthetic practice','demo','infinity',1,'demo',1000,1000,null,false,null,null,'2026-10-08');
 insert into trades values('${id}','open','2026-10-08T09:00:00Z');insert into pending_orders values('${id}','2026-10-08T10:00:00Z');`);
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261008180023_brain_account_context.sql',import.meta.url),'utf8'));
 const rows=(await db.query('select * from ab_brain_account_context($1)',[[person]])).rows;
 assert.equal(rows[0].person_id,person);assert.equal(rows[0].accounts[0].phase,'demo');assert.equal(rows[0].accounts[0].open_positions,1);
 assert.equal(Date.parse(rows[0].accounts[0].last_order_at),Date.parse('2026-10-08T10:00:00Z'));
 assert.equal((await db.query('select * from ab_brain_account_context($1)',[[]])).rows.length,0);
 await db.exec('set role authenticated');await assert.rejects(db.query('select * from ab_brain_account_context($1)',[[person]]),/permission denied/);
 }finally{await db.close();}
});
