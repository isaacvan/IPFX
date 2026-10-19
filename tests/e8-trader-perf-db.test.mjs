import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const skip = !process.env.DEMO_TEST_DEPS;
const migration = fs.readFileSync(new URL('../supabase/migrations/20261019100000_e8_trader_performance.sql', import.meta.url), 'utf8');
const controlSQL = fs.readFileSync(new URL('../supabase/migrations/20261018190000_e8_copy_backtest.sql', import.meta.url), 'utf8');
const cacheSQL = fs.readFileSync(new URL('../supabase/migrations/20261018200000_e8_copy_backtest_cache.sql', import.meta.url), 'utf8');
const U = '22222222-2222-4222-8222-222222222222', V = '55555555-5555-4555-8555-555555555555';
const EMPTY = '77777777-7777-4777-8777-777777777777', UNPRICED = '88888888-8888-4888-8888-888888888888';
const ACC = '33333333-3333-4333-8333-333333333333', ACC2 = '66666666-6666-4666-8666-666666666666';
const T1 = '11111111-1111-4111-8111-111111111111', T2 = '99999999-9999-4999-8999-999999999999';

async function fixture({ tick = true } = {}) {
  const { PGlite } = await import(pathToFileURL(`${process.env.DEMO_TEST_DEPS}/node_modules/@electric-sql/pglite/dist/index.js`).href);
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create table auth.users(id uuid primary key,email text);
    insert into auth.users values('${U}','one@example.invalid'),('${V}','two@example.invalid'),('${EMPTY}','empty@example.invalid'),('${UNPRICED}','missing@example.invalid');
    create function public.ab_person_of(uuid) returns uuid language sql as 'select $1';
    create table public.trading_accounts(id uuid primary key,user_id uuid,challenge_type text,phase text);
    insert into public.trading_accounts values('${ACC}','${U}','infinity','evaluation'),('${ACC2}','${V}','infinity','evaluation'),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${EMPTY}','infinity','evaluation'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${UNPRICED}','infinity','evaluation');
    create table public.trades(id uuid primary key default gen_random_uuid(),account_id uuid,user_id uuid,symbol text,side text,
      opened_at timestamptz,closed_at timestamptz,pnl numeric,status text,volume numeric,sl numeric,tp numeric);
    create table public.ab_trade_ledger(trade_id uuid primary key,created_at timestamptz);
    create table public.e8_monitor_profiles(account_id bigint primary key,enabled boolean);insert into public.e8_monitor_profiles values(3,true);
    create table public.e8_reference_quotes(id bigint generated always as identity,account_id bigint,symbol text,bid numeric,ask numeric,received_at timestamptz);
    create index on public.e8_reference_quotes(account_id,symbol,received_at);
    create table public.e8_instrument_evidence(id bigint generated always as identity,account_id bigint,symbol text,lot_size numeric,quote_currency text,details jsonb,observed_at timestamptz);
    insert into public.e8_instrument_evidence(account_id,symbol,lot_size,quote_currency,details,observed_at) values(3,'XAUUSD',100,'USD',
      '${tick ? '{"leverage":"30","tickSize":"0.1"}' : '{"leverage":"30"}'}','2026-10-11');
    create table public.symbol_specs(symbol text primary key,contract_size numeric,quote_currency text);insert into public.symbol_specs values('XAUUSD',100,'USD');
    create table public.cost_symbol_model(symbol text primary key,e8_commission_per_lot numeric);insert into public.cost_symbol_model values('XAUUSD',6);
    create table public.book_orders(id bigint,source_trade_id uuid,fill_price numeric,event text,side text,symbol text,created_at timestamptz);
    create table public.ab_alerts(id bigint generated always as identity,key text unique,severity text check(severity in('critical','warning','good','info')),
      category text check(category in('system','book','money','trader','rules','move')),title text,detail text,first_seen timestamptz default now(),last_seen timestamptz default now(),resolved_at timestamptz);
    insert into public.e8_reference_quotes(account_id,symbol,bid,ask,received_at) values(3,'XAUUSD',3990,3990.4,'2026-10-11T09:00Z');
    insert into public.trades values('${T1}','${ACC}','${U}','XAUUSD','buy','2026-10-12T10:00Z','2026-10-12T10:10Z',5,'closed',1,3998,4004.4),
      ('${T2}','${ACC2}','${V}','XAUUSD','buy','2026-10-12T10:00Z','2026-10-12T10:10Z',-5,'closed',1,null,null),
      ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${UNPRICED}','XAUUSD','sell','2026-10-12T14:00Z','2026-10-12T14:01Z',1,'closed',1,null,null);
    insert into public.ab_trade_ledger values('${T1}','2026-10-12T10:14Z');
    insert into public.e8_reference_quotes(account_id,symbol,bid,ask,received_at) values
      (3,'XAUUSD',4000,4000.4,'2026-10-12T10:00:01Z'),(3,'XAUUSD',4000.5,4000.9,'2026-10-12T10:00:03Z'),
      (3,'XAUUSD',4000.6,4001,'2026-10-12T10:00:05Z'),(3,'XAUUSD',4000.7,4001.1,'2026-10-12T10:00:08Z'),
      (3,'XAUUSD',4001,4001.4,'2026-10-12T10:00:15Z'),(3,'XAUUSD',4001.2,4001.6,'2026-10-12T10:00:33Z'),
      (3,'XAUUSD',4001.4,4001.8,'2026-10-12T10:01:03Z'),(3,'XAUUSD',4001.5,4001.9,'2026-10-12T10:05:03Z'),
      (3,'XAUUSD',4003,4003.4,'2026-10-12T10:10:06Z'),(3,'XAUUSD',4002,4002.4,'2026-10-12T10:15:03Z'),
      (3,'XAUUSD',4004,4004.4,'2026-10-12T11:00:03Z');
    insert into public.book_orders values(1,'${T1}',4001,'open','buy','XAUUSD','2026-10-12T10:00:04Z'),
      (2,'${T1}',4002.9,'close','sell','XAUUSD','2026-10-12T10:10:07Z');`);
  await db.exec(controlSQL);
  await db.exec(cacheSQL);
  await db.query('select public.ab_e8_copy_backtest_refresh()');
  // Production integration uses the real helper; no JS implementation or stub of inference.
  try {
    await db.exec(migration);
    await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261019090000_e8_trader_statistics.sql', import.meta.url), 'utf8'));
  } catch (error) {
    await db.close();
    if (error.position) throw new Error(`${error.message}: ${migration.slice(Math.max(0, Number(error.position)-90),Number(error.position)+90)}`);
    throw error;
  }
  return db;
}
async function rpc(db, sql = 'select public.ab_e8_trader_perf_refresh_private() r', params = []) {
  return (await db.query(sql, params)).rows[0].r;
}
async function refresh(db) {
  const r = await rpc(db);
  if (!r.ok) r.diagnostics=(await db.query('select detail from public.ab_e8_trader_perf_runs order by id desc limit 1')).rows[0].detail;
  assert.equal(r.ok, true, JSON.stringify(r)); return r;
}
async function using(fn, options) { const db = await fixture(options); try { await fn(db); } finally { await db.close(); } }

test('raw global control lots and A/B reconcile; all people and all stress cells survive the real helpers', { skip }, async () => using(async db => {
  assert.equal((await refresh(db)).repriced, 3);
  const read = await rpc(db, 'select public.ab_e8_trader_perf_read() r');
  assert.equal(read.available, true); assert.equal(read.total, 4); assert.equal(read.reconciliation.ok, true);
  const detail = await rpc(db, 'select public.ab_e8_trader_perf_detail($1,2,0) r', [U]);
  assert.equal(detail.sensitivity.length, 12);
  assert.equal(detail.row.evidence_class, 'INSUFFICIENT_DATA');
  assert.equal(detail.row.details.fdr.hypotheses, 4 * 12 * 2, 'one family includes every person, side and displayed execution scenario');
  const t = detail.trades[0];
  assert.equal(t.lots, .06); assert.ok(Math.abs(t.a_net - 12.24) < 1e-8); assert.ok(Math.abs(t.b_net + 17.76) < 1e-8);
  const second = await rpc(db, 'select public.ab_e8_trader_perf_detail($1,2,0) r', [V]);
  assert.equal(second.trades[0].lots, .07, 'second person keeps the second GLOBAL lot, not a new .06');
  for (const cell of (await db.query('select payload from public.ab_e8_trader_perf_trade_cache')).rows) {
    const t = cell.payload;
    if (t.reason == null) assert.ok(Math.abs(t.a_net + t.b_net + 2 * (t.spread + t.commission + t.slippage)) < 1e-8);
  }
  const sums = (await db.query("select sum((payload->>'a_net')::numeric) a,sum((payload->>'b_net')::numeric) b from public.ab_e8_trader_perf_trade_cache where latency=2 and slippage=0")).rows[0];
  const control = (await db.query('select result from public.ab_e8_copy_backtest_cache')).rows[0].result;
  assert.equal(Math.round(Number(sums.a) * 100), Math.round(control.books.a.summary.net_pnl * 100));
  assert.equal(Math.round(Number(sums.b) * 100), Math.round(control.books.b.summary.net_pnl * 100));
  assert.equal(read.traders.find(x => x.trader_id === EMPTY).trades, 0);
  assert.equal(read.traders.find(x => x.trader_id === UNPRICED).not_priced, 1);
  assert.equal(read.traders.find(x => x.trader_id === UNPRICED).a_net,null,'missing-price P&L is unknown, not zero');
  assert.equal(read.rows,undefined,'one compact table payload, not duplicated row aliases');
  assert.equal(read.walkforward.available, false); assert.equal(read.walkforward.status, 'since deployment forward-only');
  assert.equal(read.calibration.n, 2); assert.deepEqual(read.calibration.real_fill_check.map(x => Number(x.adverse_difference)), [.1, .1]);
  assert.equal(read.calibration.model.fitted, false);
  if (process.env.E8_TRADER_UI_FIXTURE) {
    const portfolio = await rpc(db, "select public.ab_e8_trader_perf_portfolio($1,'a',2,0) r", [[U,V]]);
    const details = Object.fromEntries(await Promise.all(read.traders.map(async r => [r.trader_id,
      await rpc(db,'select public.ab_e8_trader_perf_detail($1,2,0) r',[r.trader_id])])));
    fs.mkdirSync(path.dirname(process.env.E8_TRADER_UI_FIXTURE), { recursive:true });
    fs.writeFileSync(process.env.E8_TRADER_UI_FIXTURE, JSON.stringify({performance:read,detail,details,portfolio,trader_id:U}));
  }
}));

test('recent unpublished closes count in displayed cash but never in inference', { skip }, async () => using(async db => {
  await db.exec(`insert into public.trades(id,account_id,user_id,symbol,side,opened_at,closed_at,pnl,status,volume,sl,tp)
    values('dddddddd-dddd-4ddd-8ddd-dddddddddddd','${ACC}','${U}','XAUUSD','buy',now()-interval '100 seconds',now()-interval '50 seconds',1,'closed',1,3998,4004);
    insert into public.e8_reference_quotes(account_id,symbol,bid,ask,received_at) values
    (3,'XAUUSD',4000,4000.4,now()-interval '98 seconds'),(3,'XAUUSD',4001,4001.4,now()-interval '45 seconds');`);
  await rpc(db,'select public.ab_e8_copy_backtest_refresh() r'); await refresh(db);
  const d=await rpc(db,'select public.ab_e8_trader_perf_detail($1,2,0) r',[U]);
  assert.equal(d.row.trades,2); assert.equal(d.row.inference_trades,1);
  assert.ok(Math.abs(d.row.a_net-d.trades.reduce((s,t)=>s+(t.a_net??0),0))<.005);
  assert.ok(d.row.a_net!==d.row.raw.a_net,'display cash is separate from eligible statistical observations');
}));

test('markouts, real publication lag, stop/target risk reversal and swaps retain missingness', { skip }, async () => using(async db => {
  await refresh(db);
  const d = await rpc(db, 'select public.ab_e8_trader_perf_detail($1,2,0) r', [U]), t = d.trades[0];
  assert.equal(new Date(t.available_at).toISOString(), '2026-10-12T10:14:00.000Z', 'helper applies embargo once after actual publication');
  assert.equal(t.ledger_publication_identified, true);
  assert.deepEqual(t.markouts.map(x => x.seconds), [5, 30, 60, 300, 900, 3600]);
  assert.ok(Math.abs(t.markouts[0].price - .2) < 1e-8);
  assert.ok(t.risk_b_lots > 0 && t.risk_b_lots < t.lots); assert.ok(t.risk_b_net < 0);
  assert.equal(t.swaps.available, false);
  const missing = await rpc(db, 'select public.ab_e8_trader_perf_detail($1,2,0) r', [V]);
  assert.equal(missing.trades[0].risk_b_net, null); assert.equal(missing.trades[0].r_multiple, null);
  assert.equal(missing.trades[0].ledger_publication_identified, false);
  assert.equal(new Date(missing.trades[0].available_at).toISOString(), '2026-10-12T10:12:00.000Z');
  const slip = await rpc(db, 'select public.ab_e8_trader_perf_detail($1,2,2) r', [U]);
  assert.ok(Math.abs(t.a_net - slip.trades[0].a_net - 2.4) < 1e-8);
}));

test('unknown tick size makes nonzero slip cells unavailable, never silently zero', { skip }, async () => using(async db => {
  await refresh(db);
  const d = await rpc(db, 'select public.ab_e8_trader_perf_detail($1,2,1) r', [U]);
  assert.match(d.trades[0].reason, /tick size unavailable/); assert.equal(d.trades[0].a_net, null); assert.equal(d.trades[0].slippage, null);
  assert.equal(d.row.trades, 0);
}, { tick: false }));

test('incremental cache reprices only relevant changes; nightly flag rebuilds; public refresh only schedules', { skip }, async () => using(async db => {
  await refresh(db);
  const before = (await db.query('select computed_at from public.ab_e8_trader_perf_trade_cache where trade_id=$1 and latency=2 and slippage=0', [T1])).rows[0].computed_at;
  const inferredBefore = (await db.query('select computed_at from public.ab_e8_trader_perf_trader_cache where trader_id=$1 and latency=2 and slippage=0', [U])).rows[0].computed_at;
  assert.equal((await refresh(db)).repriced, 0);
  assert.equal(new Date((await db.query('select computed_at from public.ab_e8_trader_perf_trader_cache where trader_id=$1 and latency=2 and slippage=0', [U])).rows[0].computed_at).getTime(), new Date(inferredBefore).getTime(), 'unchanged person inference is reused');
  await db.exec("insert into public.e8_reference_quotes(account_id,symbol,bid,ask,received_at) values(3,'UNRELATED',1,2,now())");
  assert.equal((await refresh(db)).repriced, 0);
  await db.query('update public.trades set sl=3997 where id=$1', [T1]);
  assert.equal((await refresh(db)).repriced, 1);
  const after = (await db.query('select computed_at from public.ab_e8_trader_perf_trade_cache where trade_id=$1 and latency=2 and slippage=0', [T2])).rows[0].computed_at;
  assert.equal(new Date(before).getTime(), new Date(after).getTime(), 'unchanged second trade was not rewritten');
  const runs = (await db.query('select count(*) n from public.ab_e8_trader_perf_runs')).rows[0].n;
  assert.equal((await rpc(db, 'select public.ab_e8_trader_perf_refresh() r')).scheduled, true);
  assert.equal((await db.query('select count(*) n from public.ab_e8_trader_perf_runs')).rows[0].n, runs);
  await db.query('select public.ab_e8_trader_perf_nightly()');
  assert.equal((await refresh(db)).repriced, 3);
  await db.exec(`update public.ab_e8_trader_perf_cache set metadata=metadata||'{"walkforward_cells":{"5:1":{"status":"saved prospective result"}},"walkforward":{"status":"base saved prospective"}}'::jsonb where id=1`);
  await refresh(db);
  assert.equal((await rpc(db,'select public.ab_e8_trader_perf_read(5,1) r')).walk_forward.status,'saved prospective result');
  assert.equal((await rpc(db,'select public.ab_e8_trader_perf_read() r')).walk_forward.status,'base saved prospective');
}));

test('failed refresh atomically retains previous trade/trader/history caches and logs valid alert; ambiguous identities fail closed', { skip }, async () => using(async db => {
  await refresh(db);
  const before = (await db.query('select metadata from public.ab_e8_trader_perf_cache')).rows[0].metadata;
  const history = (await db.query('select count(*) n from public.ab_e8_trader_perf_history')).rows[0].n;
  await db.query(`insert into public.trades select gen_random_uuid(),account_id,user_id,symbol,side,opened_at,closed_at,pnl,status,volume,sl,tp from public.trades where id=$1`, [T1]);
  const result = await rpc(db);
  assert.equal(result.ok, false); assert.equal(result.retained_previous_cache, true); assert.match(result.error, /cent reconciliation/);
  assert.deepEqual((await db.query('select metadata from public.ab_e8_trader_perf_cache')).rows[0].metadata, before);
  assert.equal((await db.query('select count(*) n from public.ab_e8_trader_perf_history')).rows[0].n, history);
  const alert = (await db.query("select category,resolved_at from public.ab_alerts where key='e8_trader_perf_refresh'")).rows[0];
  assert.equal(alert.category, 'system'); assert.equal(alert.resolved_at, null);
  assert.equal((await db.query('select status from public.ab_e8_trader_perf_runs order by id desc limit 1')).rows[0].status, 'failed');
}));

test('selected-set portfolio reads saved minute paths, catches shared E8 limits and resets daily baseline', { skip }, async () => using(async db => {
  await refresh(db);
  // Independent saved loss paths: each person loses $400; their shared account loses $800.
  await db.query(`update public.ab_e8_trader_perf_trade_cache set minute_path=$1::jsonb where trade_id=any($2::uuid[]) and latency=2 and slippage=0`, [JSON.stringify([
    { at:'2026-10-12T10:01Z',a_float:-400,b_float:400,a_delta:0,b_delta:0,open:1,mark_missing:false },
    { at:'2026-10-12T10:11Z',a_float:0,b_float:0,a_delta:-400,b_delta:400,open:0,mark_missing:false },
  ]), [T1,T2]]);
  for (const id of [U,V]) assert.equal((await rpc(db, 'select public.ab_e8_trader_perf_portfolio($1,\'a\',2,0) r', [[id]])).breached, false);
  const together = await rpc(db, 'select public.ab_e8_trader_perf_portfolio($1,\'a\',2,0) r', [[U,V]]);
  assert.equal(together.breached, true); assert.equal(together.pnl_at_breach, -800); assert.equal(together.breach_kind, 'daily_loss');
  assert.equal(together.max_drawdown,800);
  assert.equal(together.crowding.max_same_symbol_side_traders, 2);
  await db.exec('drop table public.e8_reference_quotes');
  assert.equal((await rpc(db, 'select public.ab_e8_trader_perf_portfolio($1,\'b\',2,0) r', [[U,V]])).net, 800, 'API requires no quotes');
  await db.query(`update public.ab_e8_trader_perf_trade_cache set minute_path=jsonb_set(minute_path,'{1,a_delta}','600') where trade_id=any($1::uuid[]) and latency=2 and slippage=0`,[[T1,T2]]);
  const recovered=await rpc(db,"select public.ab_e8_trader_perf_portfolio($1,'a',2,0) r",[[U,V]]);
  assert.equal(recovered.net,-800);assert.equal(recovered.unconstrained_net,1200);
  assert.deepEqual(recovered.contributions.map(c=>c.marginal_net),[-1400,-1400], 'leave-one-out captures recovery excluded by the combined breach');
  await db.query(`update public.ab_e8_trader_perf_trade_cache set minute_path=$1::jsonb where trade_id=$2 and latency=2 and slippage=0`, [JSON.stringify([
    { at:'2026-10-12T23:59Z',a_float:0,b_float:0,a_delta:-500,b_delta:500,open:0,mark_missing:false },
    { at:'2026-10-13T00:01Z',a_float:0,b_float:0,a_delta:-500,b_delta:500,open:0,mark_missing:false },
  ]), T1]);
  const overnight = await rpc(db, 'select public.ab_e8_trader_perf_portfolio($1,\'a\',2,0) r', [[U]]);
  assert.equal(overnight.breached, false); assert.equal(overnight.worst_day, -500); assert.equal(overnight.net, -1000);
}));

test('service read RPCs are allowed but source tables, private compute and anonymous access are denied; cron is off-minute', { skip }, async () => using(async db => {
  await refresh(db);
  for (const role of ['anon','authenticated']) {
    assert.equal((await db.query("select has_function_privilege($1,'public.ab_e8_trader_perf_read(integer,integer,integer,integer,text,text,text,integer,text,boolean)','execute') yes", [role])).rows[0].yes, false);
    assert.equal((await db.query("select has_table_privilege($1,'public.ab_e8_trader_perf_trade_cache','select') yes", [role])).rows[0].yes, false);
  }
  assert.equal((await db.query("select has_function_privilege('service_role','public.ab_e8_trader_perf_refresh_private(boolean)','execute') yes")).rows[0].yes, false);
  await db.exec('set role service_role');
  assert.equal((await rpc(db, 'select public.ab_e8_trader_perf_read(2,0,0,1,\'one@\',\'INSUFFICIENT_DATA\',\'XAUUSD\',0,\'a_net\',true) r')).total, 1);
  assert.equal((await rpc(db, 'select public.ab_e8_trader_perf_refresh() r')).scheduled, true);
  await assert.rejects(db.query('select public.ab_e8_trader_perf_refresh_private()'), /permission denied/);
  await db.exec('reset role');
  assert.equal((await rpc(db,'select public.ab_e8_trader_perf_watchdog() r')).ok,true);
  await db.exec("update public.ab_e8_trader_perf_cache set computed_at=now()-interval '31 minutes' where id=1");
  assert.equal((await rpc(db,'select public.ab_e8_trader_perf_watchdog() r')).ok,false);
  assert.equal((await db.query("select category from public.ab_alerts where key='e8_trader_perf_stale' and resolved_at is null")).rows[0].category,'system');
  await db.exec('update public.ab_e8_trader_perf_cache set computed_at=clock_timestamp() where id=1');
  assert.equal((await rpc(db,'select public.ab_e8_trader_perf_watchdog() r')).ok,true);
  assert.ok((await db.query("select resolved_at from public.ab_alerts where key='e8_trader_perf_stale'")).rows[0].resolved_at);
  assert.match(migration, /'3,13,23,33,43,53 \* \* \* \*'/);
  assert.match(migration, /'1 2 \* \* \*'/);
}));

test('mutation scope remains additive and every direct UPDATE has a WHERE', () => {
  const code = migration.replace(/--.*$/gm, '');
  for (const m of code.matchAll(/\b(?:insert into|update|delete from|truncate)\s+([a-z_][a-z_0-9.]*)/gi)) {
    if (m[1].toLowerCase() === 'set') continue; // ON CONFLICT DO UPDATE SET
    assert.match(m[1], /^(?:public\.ab_e8_trader_perf_|public\.ab_alerts$|_ep_|public\.ab_e8_trader_perf_trader_cache$)/, m[0]);
  }
  for (const m of code.matchAll(/(?:^|;)\s*update\s+[\s\S]*?;/gi)) assert.match(m[0], /\bwhere\b/i);
  const portfolio = migration.slice(migration.indexOf('create or replace function public.ab_e8_trader_perf_portfolio'), migration.indexOf('create or replace function public.ab_e8_trader_perf_nightly'));
  assert.doesNotMatch(portfolio, /e8_reference_quotes/);
  assert.match(migration, /create index _ep_quotes_lookup on _ep_quotes\(symbol,received_at,id\)/);
});
