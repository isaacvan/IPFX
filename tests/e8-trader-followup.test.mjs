import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const skip = !process.env.DEMO_TEST_DEPS;
const id='22222222-2222-4222-8222-222222222222', tid='11111111-1111-4111-8111-111111111111';
async function setup() {
 const {PGlite}=await import(pathToFileURL(`${process.env.DEMO_TEST_DEPS}/node_modules/@electric-sql/pglite/dist/index.js`).href),db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table public.ab_e8_trader_perf_history(id bigint generated always as identity primary key,trader_id uuid,latency int,slippage int,
 captured_at timestamptz,input_cutoff timestamptz,config_version int,config jsonb,row_data jsonb,snapshot_kind text);
 create table public.ab_e8_trader_perf_trade_cache(trade_id uuid,trader_id uuid,latency int,slippage int,computed_at timestamptz,payload jsonb);
 create table public.ab_e8_trader_perf_cache(id int primary key,metadata jsonb);insert into public.ab_e8_trader_perf_cache values(1,'{}');`);
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261019110000_e8_trader_prospective_followup.sql',import.meta.url),'utf8'));
 return db;
}
async function history(db,at,cls='COPY_CANDIDATE',kind='captured_live') {
 return db.query(`insert into public.ab_e8_trader_perf_history(trader_id,latency,slippage,captured_at,input_cutoff,config_version,config,row_data,snapshot_kind)
 values($1,2,0,$2,$2,1,'{"embargo_seconds":30}',$3,$4)`,[id,at,JSON.stringify({evidence_class:cls}),kind]);
}
async function trade(db,entry='2026-10-02T10:00:00Z') {
 await db.query(`insert into public.ab_e8_trader_perf_trade_cache values($1,$2,2,0,'2026-10-03', $3)`,[tid,id,JSON.stringify({opened_at:entry,closed_at:'2026-10-02T11:00:00Z',reason:null,a_net:12,b_net:-16})]);
}
async function forward(db){return (await db.query("select public.ab_e8_trader_perf_forward('2026-10-04') r")).rows[0].r['2:0'];}
test('only captured classifications before entry plus embargo evaluate subsequent trades', {skip},async()=>{
 const db=await setup();try {
 await trade(db);await history(db,'2026-10-02T10:01Z');
 assert.equal((await forward(db)).observed_followups,0,'later winners cannot rewrite earlier entry eligibility');
 await history(db,'2026-10-02T09:59:45Z');
 assert.equal((await forward(db)).observed_followups,0,'publication embargo must mature');
 await history(db,'2026-10-02T09:59:29Z','REVERSE_CANDIDATE','reconstructed');
 assert.equal((await forward(db)).observed_followups,0,'reconstruction is not live captured evidence');
 await history(db,'2026-10-02T09:59Z');
 const r=await forward(db);assert.equal(r.observed_followups,1);assert.equal(r.copy_traders,1);assert.equal(r.a_net,12);assert.equal(r.trades,1);assert.equal(r.hit_rate,1);
 assert.equal(r.flip_share,0);
 }finally{await db.close();}
});
test('future outcomes and later labels cannot change prior decisions; immutable and idempotent', {skip},async()=>{
 const db=await setup();try {
 await history(db,'2026-10-01');await trade(db);const initial=await forward(db);
 await db.query(`update public.ab_e8_trader_perf_trade_cache set payload=jsonb_set(payload,'{a_net}','99999') where trade_id=$1`,[tid]);
 await history(db,'2026-10-03','REVERSE_CANDIDATE');const later=await forward(db);
 assert.equal(later.a_net,initial.a_net);assert.equal(later.copy_traders,1);assert.equal(later.trades,1);assert.equal(later.flip_share,1);
 assert.equal((await db.query('select count(*) n from public.ab_e8_trader_perf_decisions')).rows[0].n,1);
 await assert.rejects(db.query("update public.ab_e8_trader_perf_decisions set a_net=5 where true"),/append-only/);
 await assert.rejects(db.query('delete from public.ab_e8_trader_perf_history where true'),/append-only/);
 for(const role of ['anon','authenticated','service_role']) assert.equal((await db.query("select has_function_privilege($1,'public.ab_e8_trader_perf_forward(timestamptz)','execute') yes",[role])).rows[0].yes,false);
 }finally{await db.close();}
});
