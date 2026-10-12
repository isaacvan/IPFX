import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {pathToFileURL} from 'node:url';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const engine=read('supabase/functions/trading-engine/index.ts');
const sql=read('supabase/migrations/20261012133000_infinity_daily_entry_limit.sql');
const account='11111111-1111-4111-8111-111111111111';
test('daily cap latches until UTC rollover without clipping P&L; only new exposure is blocked',async()=>{
 const {PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href);
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table trading_accounts(id uuid primary key,challenge_type text,phase text,venue text,daily_profit_cap_pct numeric,
 starting_balance numeric,balance numeric,day_start_equity numeric,day_start_date date,status text,access_revoked_at timestamptz);
 create table trades(account_id uuid,status text,pnl numeric);create table pending_orders(account_id uuid,status text);
 create function fn_infinity_quote_equity(uuid)returns numeric language sql as 'select nullif(current_setting(''test.equity'',true),'''')::numeric';
 insert into trading_accounts values('${account}','infinity','evaluation','ipfx',1.4,1000,1017,1000,(now() at time zone 'UTC')::date,'active',null);`);
 await db.exec(sql);
 const check=async equity=>{await db.query("select set_config('test.equity',$1,false)",[String(equity)]);return(await db.query('select fn_infinity_daily_entry_limit($1) as result',[account])).rows[0].result;};
 assert.equal((await check(1013.99)).blocked,false);
 assert.equal((await check(1014)).blocked,true);
 assert.equal((await check(1008)).blocked,true,'giving back profit does not re-enable entries');
 await assert.rejects(db.query("insert into trades values($1,'open',null)",[account]),/DAILY_PROFIT_CAP_REACHED/);
 await assert.rejects(db.query("insert into pending_orders values($1,'pending')",[account]),/DAILY_PROFIT_CAP_REACHED/);
 await db.query("insert into trades values($1,'closed',17)",[account]);
 assert.equal(Number((await db.query('select balance from trading_accounts')).rows[0].balance),1017);
 assert.equal(Number((await db.query('select pnl from trades')).rows[0].pnl),17);
 assert.equal((await db.query('select status from trading_accounts')).rows[0].status,'active');
 await db.exec("update infinity_daily_entry_pauses set utc_day=utc_day-1; update trading_accounts set day_start_equity=1017");
 assert.equal((await check(1017)).blocked,false,'yesterday pause does not apply today');
 await db.query("insert into trades values($1,'open',null)",[account]);
 await db.exec('set role authenticated');
 await assert.rejects(db.exec('select * from infinity_daily_entry_pauses'),/permission denied/);
 await assert.rejects(db.query('select fn_infinity_daily_entry_limit($1)',[account]),/permission denied/);
 }finally{await db.close();}
});
test('cap explanation includes the stage minimum and applies to market and pending entry paths',()=>{
 const from=engine.indexOf('function dailyProfitCapReason('),to=engine.indexOf('// Realized + floating',from);
 const ctx=vm.createContext({round2:n=>Math.round(n*100)/100,Number});vm.runInContext(stripTypeScriptTypes(engine.slice(from,to)),ctx);
 const a={starting_balance:1000,day_start_equity:1000,daily_profit_cap_pct:1.4,min_trading_days:10};
 assert.equal(ctx.dailyProfitCapReason(a,1013.99),null);
 assert.match(ctx.dailyProfitCapReason(a,1014),/at least 10 qualifying trading days/);
 assert.match(ctx.dailyProfitCapReason({...a,daily_profit_cap_blocked:true},1000),/00:00 UTC/);
 assert.equal(ctx.dailyProfitCapReason({...a,daily_profit_cap_pct:null},9000),null);
 const pending=engine.slice(engine.indexOf('if (action === "place_pending")'),engine.indexOf('if (action === "cancel_pending")'));
 assert.match(pending,/dailyProfitCapReason\(acct as Acct, state.equity\)/);
 assert.match(engine,/const dailyCap = dailyProfitCapReason\(A, state.equity\)/);
 assert.match(engine,/const dailyCap = dailyProfitCapReason\(acct, equityNow\)/);
});
test('trader sees a prominent cap notice and entry buttons stop while closes remain usable',()=>{
 const page=read('trading.html');
 assert.match(page,/id="dailyCapNotice" role="status" hidden/);
 assert.match(page,/document.querySelectorAll\('\.op-exec-btn,#qtBuy,#qtSell'\)/);
 assert.match(page,/if\(capMessage\)\{engineMsg\(capMessage\);return;\}/);
 assert.match(page,/Stage 1 requires at least 10 qualifying trading days and 14 elapsed calendar days/);
});
