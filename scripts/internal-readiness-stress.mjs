// Local only: actual capacity SQL and Risk queue, synthetic accounts/providers, no network or broker calls.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL}from 'node:url';
import {Risk}from '../hub/risk.mjs';import {riskJournal}from '../hub/risk-journal.mjs';
const output=process.argv[2];if(!output)throw Error('Pass an isolated output directory for synthetic evidence.');
fs.mkdirSync(output,{recursive:true});
const uuid=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
const {PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href);
const db=new PGlite();const started=performance.now();let admission;
try{
 await db.exec('create role anon;create role authenticated;create role service_role;');
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261009073000_destination_capacity.sql',import.meta.url),'utf8'));
 for(let n=0;n<10;n++){
  await db.query(`insert into book_capacity_limits values($1,50,1000,'Synthetic limit only; not a provider claim',now())`,['s'+(n+1)]);
  await db.query(`insert into book_capacity_state values($1,now(),0,0,1000)`,['s'+(n+1)]);
 }
 // One transaction provides a stable timestamp for the 5s inventory freshness gate.
 await db.exec('begin');
 const rows=await Promise.all(Array.from({length:2000},(_,n)=>db.query('select fn_reserve_book_slot($1,$2,$3) r',['s'+(n%10+1),uuid(n+1),.01]).then(r=>r.rows[0].r)));
 await db.exec('commit');
 const accepted=rows.filter(r=>r.ok).length,rejected=rows.filter(r=>r.reason==='POSITION_CAPACITY_FULL').length;
 assert.equal(accepted,500);assert.equal(rejected,1500);
 const counts=(await db.query('select book,count(*) n from book_position_slots group by book order by book')).rows;
 assert.ok(counts.every(r=>Number(r.n)===50));
 const duplicate=(await db.query('select fn_reserve_book_slot($1,$2,$3) r',['s1',uuid(1),.01])).rows[0].r;
 assert.equal(duplicate.reason,'EXISTING_ORDER_REQUIRES_RECONCILIATION');
 admission={requests:2000,destinations:10,syntheticLimitPerDestination:50,accepted,capacityRejected:rejected,duplicateBlocked:true,elapsedMs:Math.round(performance.now()-started),basis:'PGlite serialises requests in one process; not proof of multi-backend PostgreSQL concurrency or a real provider limit'};
}finally{await db.close();}
const accounts=Array.from({length:2000},(_,n)=>({id:uuid(n+1),status:'active',challenge_type:'infinity',revoked:false,balance:100000,starting_balance:100000,max_drawdown_pct:10,daily_loss_pct:5}));
const trades=accounts.flatMap(a=>Array.from({length:3},(_,k)=>({id:a.id+':'+k,account_id:a.id,symbol:'EURUSD',side:'buy',volume:.01,open_price:1,sl:.999,tp:1.1,opened_at:new Date().toISOString()})));
const byId=new Map(accounts.map(a=>[a.id,a])),attempts=new Map(),closed=new Set();let calls=0;
const rpc=async(_name,{p_account})=>({accounts:[byId.get(p_account)],trades:closed.has(p_account)?[]:trades.filter(t=>t.account_id===p_account),pending:[]});
const engine=async body=>{
 calls++;if(calls===1)throw Error('Synthetic lost response');
 return {ok:true,results:body.account_ids.map(id=>{const n=(attempts.get(id)??0)+1;attempts.set(id,n);if(Number(id.slice(-12))%10===0&&n===1)return {id,error:'Synthetic per-account failure'};closed.add(id);return{id,open:0,status:'active'};})};
};
const journal=riskJournal(path.join(output,'synthetic-risk-queue.json'));
let risk=new Risk({quotes:new Map(),rpc,engine,mode:'active',log(){},journal});risk.specs={EURUSD:{contract:100000,quote:'USD',digits:5}};
risk.apply({accounts,trades,pending:[],sl_deadline_seconds:null},null);
const q={s:'EURUSD',b:.998,a:.9982,at:Date.now()};risk.quotes.set(q.s,q);const quoteStart=performance.now();risk.onQuote(q);
assert.equal(risk.queue.size,2000);const triggerMs=performance.now()-quoteStart;
await risk.flush();assert.equal(risk.queue.size,2000);assert.equal(journal.load().length,2000);
// Restart with the persisted unresolved jobs; recovery happens without requiring another quote.
risk=new Risk({quotes:new Map(),rpc,engine,mode:'active',log(){},journal});risk.apply({accounts,trades,pending:[],sl_deadline_seconds:null},null);
const recoveryStart=performance.now();let flushes=0;
while(risk.queue.size&&flushes<150){for(const j of risk.jobs.values())j.dueAt=0;await risk.flush();flushes++;}
assert.equal(risk.queue.size,0);assert.equal(closed.size,2000);assert.equal(risk.stats.checkedAccounts,2000);assert.equal(journal.load().length,0);
const result={at:new Date().toISOString(),productionCapacityVerified:false,admission,risk:{accounts:2000,positions:6000,triggerMs:+triggerMs.toFixed(2),engineCalls:calls,recoveryFlushes:flushes,checkedAccounts:risk.stats.checkedAccounts,failedAccountResponses:risk.stats.responseErrors,recoveryMs:Math.round(performance.now()-recoveryStart),queueAfterRestart:2000,remaining:0,basis:'Actual Risk class; mock zero-latency engine and inventory; retry due times advanced; no real orders, provider latency or hosted capacity measured'}};
fs.writeFileSync(path.join(output,'internal-readiness-stress.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
