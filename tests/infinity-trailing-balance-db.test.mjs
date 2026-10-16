// Real SQL: the Infinity quote guard with the closed-balance trailing drawdown (Terms 2.2).
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { pathToFileURL } from 'node:url';
const skip = !process.env.DEMO_TEST_DEPS;
const read = (n) => fs.readFileSync(new URL('../supabase/migrations/' + n, import.meta.url), 'utf8');

async function guardDb() {
  const { PGlite } = await import(pathToFileURL(process.env.DEMO_TEST_DEPS + '/node_modules/@electric-sql/pglite/dist/index.js').href), db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create table trading_accounts(id uuid primary key,user_id uuid,challenge_type text,venue text,phase text,status text,access_revoked_at timestamptz,balance numeric,starting_balance numeric,
    max_drawdown_pct numeric,daily_loss_pct numeric,drawdown_mode text constraint trading_accounts_drawdown_mode_check check(drawdown_mode = any(array['static','trailing_intraday','trailing_eod'])),
    trailing_peak numeric,trailing_peak_date date,day_start_equity numeric,day_start_date date,total_paid_out numeric,breach_reason text,created_at timestamptz default now(),updated_at timestamptz,
    breached_at timestamptz,breach_equity numeric,breach_floor numeric);
   create table trades(id uuid primary key,account_id uuid,symbol text,side text,volume numeric,open_price numeric,status text,pnl numeric,closed_at timestamptz);
   create table symbol_specs(symbol text primary key,contract_size numeric,quote_currency text);insert into symbol_specs values('XAUUSD',100,'USD');
   create table live_quotes(symbol text primary key,bid numeric,ask numeric,mid numeric,received_at timestamptz);
   create table claims(account uuid,why text,eq numeric,floor numeric);
   create function fn_claim_account_breach(p uuid,why text,eq numeric,fl numeric)returns boolean language plpgsql as $$begin insert into public.claims values(p,why,eq,fl);update public.trading_accounts set status='breached',breach_reason=why where id=p;return true;end $$;
   create table challenge_presets(id text,challenge_type text,drawdown_mode text);insert into challenge_presets values('infinity_s1','infinity','trailing_intraday');
   create table platform_legal_documents(version text,kind text,source_sha256 text,document_url text);create table platform_legal_current(kind text,version text);insert into platform_legal_current values('terms','2026-10-12-2.1');`);
  const g = read('20261008132001_infinity_quote_drawdown_guard.sql');
  await db.exec(g.slice(g.indexOf('create function public.fn_infinity_quote_equity'), g.indexOf('create function public.fn_infinity_on_persisted_quotes')));
  return db;
}
const acct = (db, id, mode, balance, peak) => db.query(`insert into trading_accounts(id,challenge_type,venue,phase,status,balance,starting_balance,max_drawdown_pct,daily_loss_pct,drawdown_mode,trailing_peak,day_start_equity,day_start_date)
  values($1,'infinity','ipfx','evaluation','active',$2,1000,5,2.5,$3,$4,$2,(now() at time zone 'utc')::date)`, [id, balance, mode, peak]);
const openBuy = (db, id, acc, price) => db.query(`insert into trades values($1,$2,'XAUUSD','buy',.01,$3,'open',null,null)`, [id, acc, price]);
const quote = (db, bid) => db.query(`insert into live_quotes values('XAUUSD',$1,$1,$1,clock_timestamp()) on conflict(symbol) do update set bid=excluded.bid,ask=excluded.ask,mid=excluded.mid,received_at=excluded.received_at`, [bid]);
const check = async (db, id) => (await db.query('select public.fn_enforce_infinity_from_quotes($1) r', [id])).rows[0].r;

test('giving back open profit never breaches under the closed-balance rule; under the old rule it did', { skip }, async () => {
  const db = await guardDb();
  try {
    await db.exec(read('20261016120000_infinity_trailing_closed_balance.sql').replace(/^begin;|commit;$/gm, ''));
    // Old rule (as Yagyawalkya): open trade took equity to $1,133, now back to $1,081: breached.
    await acct(db, '00000000-0000-4000-8000-000000000001', 'trailing_intraday', 1000, 1133.26);
    await openBuy(db, '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 4000); await quote(db, 4081);
    assert.equal((await check(db, '00000000-0000-4000-8000-000000000001')).breach_reason, 'max_drawdown');
    // New rule, same trade: the floor stays $50 below the best closed balance ($1,000), so $1,081 is fine.
    await acct(db, '00000000-0000-4000-8000-000000000002', 'trailing_balance', 1000, 1000);
    await openBuy(db, '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000002', 4000);
    let r = await check(db, '00000000-0000-4000-8000-000000000002');
    assert.equal(r.checked, true); assert.equal(r.breach_reason, null); assert.equal(Number(r.dd_floor), 950); assert.equal(Number(r.equity), 1081);
    // Even at $1,133 open profit the peak stays at the closed balance.
    await quote(db, 4133); r = await check(db, '00000000-0000-4000-8000-000000000002'); assert.equal(Number(r.trailing_peak), 1000);
  } finally { await db.close(); }
});

test('a real loss below the best closed balance still breaches mid-trade, and closed profit raises the floor', { skip }, async () => {
  const db = await guardDb();
  try {
    await db.exec(read('20261016120000_infinity_trailing_closed_balance.sql').replace(/^begin;|commit;$/gm, ''));
    // Closed balance $1,060 (best ever): floor $1,010. Open trade now -$51 => equity $1,009: breach.
    await acct(db, '00000000-0000-4000-8000-000000000003', 'trailing_balance', 1060, 1000);
    await openBuy(db, '00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-000000000003', 4000); await quote(db, 3949);
    const r = await check(db, '00000000-0000-4000-8000-000000000003');
    assert.equal(r.breach_reason, 'max_drawdown'); assert.equal(Number(r.dd_floor), 1010); assert.equal(Number(r.trailing_peak), 1060);
    const presets = (await db.query("select drawdown_mode from challenge_presets where id='infinity_s1'")).rows[0];
    assert.equal(presets.drawdown_mode, 'trailing_balance');
  } finally { await db.close(); }
});
