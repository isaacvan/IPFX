// Real SQL: the Books page E8 copy backtest prices copies at E8's own bid/ask after the copy delay, alternates
// 0.06/0.07 lots, charges E8 commission, applies E8's daily-loss rule on separate A and B accounts, and never guesses a
// price. Every expected number below is worked out by hand.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { pathToFileURL } from 'node:url';
const skip = !process.env.DEMO_TEST_DEPS;
const sql = fs.readFileSync(new URL('../supabase/migrations/20261018190000_e8_copy_backtest.sql', import.meta.url), 'utf8');
const U = '22222222-2222-4222-8222-222222222222', ACC = '33333333-3333-4333-8333-333333333333', DEMO = '44444444-4444-4444-8444-444444444444';

async function db0() {
  const { PGlite } = await import(pathToFileURL(process.env.DEMO_TEST_DEPS + '/node_modules/@electric-sql/pglite/dist/index.js').href), db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create table auth.users(id uuid primary key,email text);insert into auth.users values('${U}','trader@example.invalid');
    create table public.trading_accounts(id uuid primary key,challenge_type text,phase text);
    insert into public.trading_accounts values('${ACC}','infinity','evaluation'),('${DEMO}','infinity','demo');
    create table public.trades(id uuid primary key default gen_random_uuid(),account_id uuid,user_id uuid,symbol text,side text,
      opened_at timestamptz,closed_at timestamptz,pnl numeric,status text);
    create table public.e8_monitor_profiles(account_id bigint primary key,enabled boolean);insert into public.e8_monitor_profiles values(3,true);
    create table public.e8_reference_quotes(id bigint generated always as identity,account_id bigint,symbol text,bid numeric,ask numeric,received_at timestamptz);
    create table public.e8_instrument_evidence(id bigint generated always as identity,account_id bigint,symbol text,lot_size numeric,quote_currency text,details jsonb,observed_at timestamptz);
    insert into public.e8_instrument_evidence(account_id,symbol,lot_size,quote_currency,details,observed_at) values(3,'XAUUSD',100,'USD','{"leverage":"30.01"}','2026-10-11');
    create table public.symbol_specs(symbol text primary key,contract_size numeric,quote_currency text);insert into public.symbol_specs values('XAUUSD',100,'USD');
    create table public.cost_symbol_model(symbol text primary key,e8_commission_per_lot numeric);insert into public.cost_symbol_model values('XAUUSD',6);
    create table public.book_orders(id bigint,source_trade_id uuid,fill_price numeric,event text,side text,symbol text,created_at timestamptz);`);
  const trade = (acc, side, o, c, pnl) => db.query(`insert into public.trades(account_id,user_id,symbol,side,opened_at,closed_at,pnl,status) values($1,$2,'XAUUSD',$3,$4,$5,$6,'closed')`, [acc, U, side, o, c, pnl]);
  const q = (at, bid, ask) => db.query(`insert into public.e8_reference_quotes(account_id,symbol,bid,ask,received_at) values(3,'XAUUSD',$1,$2,$3)`, [bid, ask, at]);
  // First E8 quote (2026-10-11 09:00) sets where E8 prices start.
  await q('2026-10-11T09:00:00Z', 3990, 3990.4);
  // T1 buy 10:00 -> 10:10. Quote at +1s is BEFORE the 2s copy delay and must be ignored.
  await trade(ACC, 'buy', '2026-10-12T10:00:00Z', '2026-10-12T10:10:00Z', 5);
  await q('2026-10-12T10:00:01Z', 4000, 4000.4); await q('2026-10-12T10:00:03Z', 4000.5, 4000.9); await q('2026-10-12T10:10:06Z', 4003, 4003.4);
  // T2 buy 11:00 -> 11:30, a $700 loser on A (breaks E8's $625 daily limit), a winner on B.
  await trade(ACC, 'buy', '2026-10-12T11:00:00Z', '2026-10-12T11:30:00Z', -60);
  await q('2026-10-12T11:00:02Z', 3999.6, 4000); await q('2026-10-12T11:20:30Z', 3950, 3950.4); await q('2026-10-12T11:30:05Z', 3900, 3900.4);
  // T3 buy 12:00 -> 12:05, after A's breach.
  await trade(ACC, 'buy', '2026-10-12T12:00:00Z', '2026-10-12T12:05:00Z', 0);
  await q('2026-10-12T12:00:02Z', 4000, 4000.4); await q('2026-10-12T12:05:05Z', 4000.4, 4000.8);
  // T4: no E8 quote within 30s of entry -> not priced. T5: practice (demo) account -> excluded entirely.
  await trade(ACC, 'sell', '2026-10-12T14:00:00Z', '2026-10-12T14:01:00Z', 1);
  await q('2026-10-12T14:00:40Z', 4000, 4000.4); await q('2026-10-12T14:01:10Z', 4000, 4000.4);
  await trade(DEMO, 'buy', '2026-10-12T10:00:00Z', '2026-10-12T10:10:00Z', 99);
  await db.exec(sql.replace(/^begin;|commit;$/gm, ''));
  return db;
}

test('copies price at E8 bid/ask after the delay, at 0.06/0.07 lots, with commission, on separate A and B accounts', { skip }, async () => {
  const db = await db0();
  try {
    const r = (await db.query(`select public.ab_e8_copy_backtest('2026-10-12','2026-10-12') r`)).rows[0].r;
    assert.equal(r.available, true);
    assert.deepEqual([r.coverage.source_trades, r.coverage.priced, r.coverage.not_priced], [4, 3, 1], 'the demo trade is excluded and T4 is listed, not guessed');
    const t = Object.fromEntries(r.trades.filter((x) => x.reason == null).map((x) => [x.opened_at.slice(11, 16), x]));
    // T1, 0.06 lots: A buys the 10:00:03 ask 4000.9, sells the 10:10:06 bid 4003: (4003-4000.9)*100*0.06 = 12.60, minus 6*0.06 = 0.36.
    assert.equal(Number(t['10:00'].lots), 0.06); assert.equal(Number(t['10:00'].a_entry), 4000.9); assert.equal(Number(t['10:00'].a_net), 12.24);
    // B sells the bid 4000.5, buys back the ask 4003.4: -2.9*6 = -17.40 - 0.36.
    assert.equal(Number(t['10:00'].b_entry), 4000.5); assert.equal(Number(t['10:00'].b_net), -17.76);
    // T2, 0.07 lots: A (3900-4000)*7 = -700 - 0.42; B (3999.6-3900.4)*7 = 694.40 - 0.42.
    assert.equal(Number(t['11:00'].lots), 0.07); assert.equal(Number(t['11:00'].a_net), -700.42); assert.equal(Number(t['11:00'].b_net), 693.98);
    // T3, 0.06 lots: A flat -0.36; B -0.8*6 - 0.36.
    assert.equal(Number(t['12:00'].a_net), -0.36); assert.equal(Number(t['12:00'].b_net), -5.16);
    const A = r.books.a, B = r.books.b;
    assert.equal(Number(A.summary.net_pnl), -688.54); assert.equal(Number(B.summary.net_pnl), 671.06);
    assert.equal(A.summary.trades, 3); assert.equal(Number(A.summary.win_rate), 0.3333); assert.equal(Number(A.summary.profit_factor), 0.017);
    assert.equal(Number(A.summary.commission), 1.14);
  } finally { await db.close(); }
});

test('E8 daily loss closes the A account; later trades are marked as not takeable; B (the winner) stays inside the rules', { skip }, async () => {
  const db = await db0();
  try {
    const r = (await db.query(`select public.ab_e8_copy_backtest('2026-10-12','2026-10-12') r`)).rows[0].r;
    const A = r.books.a.e8, B = r.books.b.e8;
    assert.equal(A.breached, true); assert.equal(A.breach_kind, 'daily_loss');
    assert.equal(new Date(A.breach_at).toISOString(), '2026-10-12T11:31:00.000Z');
    assert.deepEqual([A.trades_before_breach, A.trades_blocked_after_breach], [2, 1]);
    assert.equal(Number(A.pnl_at_breach), -688.18, '12.24 - 700.42');
    assert.equal(B.breached, false);
    const t3 = r.trades.find((x) => x.opened_at.startsWith('2026-10-12T12:00'));
    assert.equal(t3.a_after_breach, true); assert.equal(t3.b_after_breach, false);
    // Floating at 11:21 (E8 bid 3950) is marked to market: -$350 on A, inside the limit until the 11:30 exit.
    assert.ok(Number(r.books.a.daily[0].worst_intraday) <= -625);
  } finally { await db.close(); }
});

test('read-only and owner-only: only temp tables are written, and only the service role (owner edge function) can run it', () => {
  const noComments = sql.replace(/--.*$/gm, '');
  for (const m of noComments.matchAll(/\b(insert into|update|delete from|truncate)\s+([a-z_.]+)/gi)) assert.match(m[2], /^_bt_/, `${m[1]} ${m[2]} must be a temp table`);
  assert.match(sql, /security definer set search_path to ''/);
  assert.match(sql, /revoke all on function public\.ab_e8_copy_backtest\(date, date\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.ab_e8_copy_backtest\(date, date\) to service_role;/);
  const fn = fs.readFileSync(new URL('../supabase/functions/brain-monitor/index.ts', import.meta.url), 'utf8');
  const at = fn.indexOf('action === "e8_copy_backtest"');
  assert.ok(at > fn.indexOf('Owner access only'), 'the action sits behind the owner + MFA check');
  const page = fs.readFileSync(new URL('../workspace/books.html', import.meta.url), 'utf8');
  assert.match(page, /<div id="e8bt"><\/div>/);
  assert.ok(page.indexOf('ws-books-backtest.js') > page.indexOf('ws-books.js'));
});

const cacheSql = fs.readFileSync(new URL('../supabase/migrations/20261018200000_e8_copy_backtest_cache.sql', import.meta.url), 'utf8');

test('the API session rejects an UPDATE without WHERE (safeupdate) and cuts queries off at 8s: every UPDATE has a WHERE and the page only reads a saved result', () => {
  // Statement-level check: each UPDATE in the function must reach a top-level WHERE before its terminating semicolon.
  for (const m of sql.replace(/--.*$/gm, '').matchAll(/\n\s*update\s+[\s\S]*?;/gi)) {
    let depth = 0, top = false;
    for (const t of m[0].matchAll(/\(|\)|\bwhere\b/gi)) { if (t[0] === '(') depth++; else if (t[0] === ')') depth--; else if (depth === 0) top = true; }
    assert.ok(top, 'UPDATE without a top-level WHERE would be refused over the API: ' + m[0].trim().slice(0, 80));
  }
  const fn = fs.readFileSync(new URL('../supabase/functions/brain-monitor/index.ts', import.meta.url), 'utf8');
  const at = fn.indexOf('action === "e8_copy_backtest"'), block = fn.slice(at, fn.indexOf('action === "solution_context"'));
  assert.ok(!/rpc\("ab_e8_copy_backtest"/.test(block), 'the ~25s calculation must not run inside an API request (8s limit)');
  assert.match(block, /from\("ab_e8_copy_backtest_cache"\)/);
  assert.match(cacheSql, /cron\.schedule\('ipfx-e8-copy-backtest', '\*\/10 \* \* \* \*', 'select public\.ab_e8_copy_backtest_refresh\(\)'\)/);
  assert.match(cacheSql, /revoke all on public\.ab_e8_copy_backtest_cache from public, anon, authenticated;/);
  assert.match(cacheSql, /grant execute on function public\.ab_e8_copy_backtest_refresh\(\) to service_role;/);
});

test('the scheduled refresh saves the result the page reads, and refreshing again replaces it', { skip }, async () => {
  const db = await db0();
  try {
    await db.exec(cacheSql.replace(/^begin;|commit;$/gm, ''));
    assert.equal((await db.query('select count(*)n from public.ab_e8_copy_backtest_cache')).rows[0].n, 0);
    const a = (await db.query('select public.ab_e8_copy_backtest_refresh() r')).rows[0].r;
    assert.equal(a.ok, true);
    const row = (await db.query('select computed_at, took_ms, result from public.ab_e8_copy_backtest_cache where id = 1')).rows[0];
    assert.equal(row.result.available, true); assert.equal(row.result.coverage.priced, 3);
    assert.equal(row.result.trades.length, 4, 'all four non-practice trades are listed, priced or not');
    await db.query('select public.ab_e8_copy_backtest_refresh()');
    assert.equal((await db.query('select count(*)n from public.ab_e8_copy_backtest_cache')).rows[0].n, 1, 'one saved row, replaced in place');
  } finally { await db.close(); }
});


// ---- Profit-filtered books (owner request 2026-10-19): A-book only traders in profit, B-book only traders not in profit ----
const U2 = '55555555-5555-4555-8555-555555555555', ACC2 = '66666666-6666-4666-8666-666666666666';
async function dbProfit() {
  const db = await db0();
  await db.exec(`insert into auth.users values('${U2}','winner@example.invalid');insert into public.trading_accounts values('${ACC2}','infinity','evaluation');`);
  // U1 (db0): T1 buy 10:00 +5, T2 buy 11:00 -60, T3 buy 12:00 0, T4 unpriced +1  -> final result -54 (not in profit).
  // U2: W1 at 13:00 (+30, no history before it), then W2 at 15:00 -> final result +30 (ended in profit).
  await db.query(`insert into public.trades(account_id,user_id,symbol,side,opened_at,closed_at,pnl,status) values($1,$2,'XAUUSD','buy','2026-10-12T13:00:00Z','2026-10-12T13:10:00Z',30,'closed'),($1,$2,'XAUUSD','buy','2026-10-12T15:00:00Z','2026-10-12T15:10:00Z',0,'closed')`, [ACC2, U2]);
  await db.query(`insert into public.e8_reference_quotes(account_id,symbol,bid,ask,received_at) values(3,'XAUUSD',4000,4000.4,'2026-10-12T13:00:03Z'),(3,'XAUUSD',4002,4002.4,'2026-10-12T13:10:06Z'),(3,'XAUUSD',4010,4010.4,'2026-10-12T15:00:03Z'),(3,'XAUUSD',4012,4012.4,'2026-10-12T15:10:06Z')`);
  return db;
}

test('A-book copies only traders more than $20 in profit and B-book reverses only traders in loss, using only what was known at the time', { skip }, async () => {
  const db = await dbProfit();
  try {
    const r = (await db.query(`select public.ab_e8_copy_backtest('2026-10-12','2026-10-12') r`)).rows[0].r;
    const t = Object.fromEntries(r.trades.filter((x) => x.reason == null).map((x) => [x.opened_at.slice(11, 16), x]));
    // Closed P&L the trader had BEFORE each trade (2 minute publication lag): T1 0, T2 +5, T3 +5-60 = -55, W1 0, W2 +30.
    const K = ['10:00', '11:00', '12:00', '13:00', '15:00'];
    assert.deepEqual(K.map((k) => Number(t[k].trader_before)), [0, 5, -55, 0, 30]);
    assert.deepEqual(K.map((k) => Number(t[k].trader_total)), [-54, -54, -54, 30, 30]);
    // Copied only when MORE than $20 in profit before the trade: W2 (+30). T2 (+5) is in profit but under the bar; W1 has no history.
    assert.deepEqual(K.map((k) => t[k].ap_net != null), [false, false, false, false, true]);
    // In loss when reversed: only T3 (the trader was -55). Exactly $0 / no history / in profit is in neither.
    assert.deepEqual(K.map((k) => t[k].bp_net != null), [false, false, true, false, false]);
    // Ended in profit / not in profit split every priced trade into exactly one of the two.
    assert.deepEqual(K.map((k) => [t[k].ah_net != null, t[k].bh_net != null]), [[false, true], [false, true], [false, true], [true, false], [true, false]]);
    const B = r.books;
    // ap: W2 alone is that book's first copy, so 0.06 lots (0.06 here too in the all-traders book is the 5th, so 0.06): (4012-4010.4)*100*0.06 - 0.36.
    assert.equal(Number(t['15:00'].ap_lots), 0.06);
    assert.equal(Number(B.ap.summary.net_pnl), 9.24); assert.equal(B.ap.summary.trades, 1); assert.equal(B.ap.e8.breached, false);
    // ah: both of the winner's trades: W1 0.06 lots 9.24, W2 0.07 lots (4012-4010.4)*100*0.07 - 0.42 = 10.78.
    assert.equal(Number(B.ah.summary.net_pnl), 20.02); assert.equal(B.ah.summary.trades, 2);
    // bp: T3 reversed, sell at the bid 4000, buy back at the ask 4000.8: -0.8*6 - 0.36 = -5.16.
    assert.equal(Number(B.bp.summary.net_pnl), -5.16); assert.equal(B.bp.summary.trades, 1);
    // bh: all three of U1's priced trades reversed: -17.76 + 693.98 - 5.16.
    assert.equal(Number(B.bh.summary.net_pnl), 671.06); assert.equal(B.bh.summary.trades, 3);
    // The all-traders books still take every priced trade.
    assert.equal(B.a.summary.trades, 5); assert.equal(B.b.summary.trades, 5);
  } finally { await db.close(); }
});

test('a profit filter that matches nobody gives an empty book, not an error', { skip }, async () => {
  const db = await db0();
  try {
    // Only U1 exists: nobody ended in profit, so the hindsight A-book is empty.
    const r = (await db.query(`select public.ab_e8_copy_backtest('2026-10-12','2026-10-12') r`)).rows[0].r;
    assert.equal(r.books.ah.summary.trades, 0); assert.equal(r.books.ah.e8.breached, false);
    assert.deepEqual(r.books.ah.traders, []); assert.deepEqual(r.books.ah.daily, []);
  } finally { await db.close(); }
});

test('the equity timeline uses the precomputed day-start balances (a per-row subquery made it take over a minute)', () => {
  assert.match(sql, /join _bt_ds ds on ds\.book = tl\.book/);
  assert.match(sql, /insert into _bt_ds/);
  assert.ok(!/ds as \(/.test(sql), 'no inline day-start subquery in the timeline');
});
