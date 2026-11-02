// Team workspace freshness (2 Nov 2026): the faster e8_reference_summary must return exactly what the old one did, the clean-up indexes
// exist, and the schedules are what the pages promise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const mig = read('supabase/migrations/20261102020000_team_pages_freshness.sql');
const opts = { skip: !process.env.DEMO_TEST_DEPS };

test('migration: indexes on both foreign keys, 15-minute treasury, 3-day snapshots, E8 copy refresh back on, heavy trader jobs untouched', () => {
  assert.match(mig, /create index if not exists e8_event_quote_demands_decision_quote_idx on public\.e8_event_quote_demands\(decision_quote_id\)/);
  assert.match(mig, /create index if not exists e8_event_quote_demands_observed_quote_idx on public\.e8_event_quote_demands\(observed_quote_id\)/);
  assert.match(mig, /schedule := '7,22,37,52 \* \* \* \*'\) from cron\.job where jobname='ipfx-treasury'/);
  assert.match(mig, /interval '3 days'.*\) from cron\.job where jobname='ipfx-treasury-purge'/s);
  assert.match(mig, /active := true\) from cron\.job where jobname='ipfx-e8-copy-backtest'/);
  for (const heavy of ['ipfx-e8-trader-perf', 'ipfx-e8-trader-followup', 'ipfx-e8-trader-perf-nightly', 'ipfx-trade-lows', 'ipfx-validation-paper'])
    assert.ok(!mig.includes("'" + heavy + "'"), heavy + ' stays paused');
});

test('e8_reference_summary: same output as the old DISTINCT ON version, in the same order, on a realistic quote table', opts, async () => {
  const { PGlite } = await import(pathToFileURL(process.env.DEMO_TEST_DEPS + '/node_modules/@electric-sql/pglite/dist/index.js').href);
  const db = new PGlite();
  try {
    await db.exec(`create table public.ladder_accounts(id int primary key,label text);
      create table public.e8_monitor_profiles(account_id int primary key,enabled boolean,status text,error_code text,history_error_code text,interval_ms int,max_quote_age_ms int,last_run timestamptz,
        last_quote_at timestamptz,last_history_at timestamptz,symbols text[],instrument_costs jsonb,last_state_attempt_at timestamptz,last_state_at timestamptz,state_error_code text);
      create table public.e8_account_snapshots(id bigserial primary key,account_id int,received_at timestamptz,amounts jsonb,currency text,period_basis text,reconciliation text);
      create table public.e8_reference_quotes(id bigserial primary key,account_id int,symbol text,bid numeric,ask numeric,requested_at timestamptz,received_at timestamptz,unique(account_id,symbol,received_at));
      create index e8_reference_lookup on public.e8_reference_quotes(account_id,symbol,received_at desc);
      create table public.cost_fills(role text,costs_complete boolean);create table public.e8_fill_revisions(id int);
      insert into public.ladder_accounts values (3,'E8 funded reference'),(4,'Second account');
      insert into public.e8_monitor_profiles(account_id,enabled,status,max_quote_age_ms,symbols) values (3,true,'READY',15000,'{EURUSD,XAUUSD}'),(4,false,'READY',15000,'{GBPUSD}');
      insert into public.cost_fills values ('monitor',true),('monitor',false),('trader',true);`);
    const symbols = ['ADAUSD', 'AUDCAD', 'BTCUSD', 'EURGBP', 'EURUSD', 'GBPJPY', 'GBPUSD', 'GER40', 'NSXUSD', 'USDJPY', 'XAUUSD'];
    for (const acct of [3, 4]) for (const [i, s] of symbols.entries())
      await db.exec(`insert into public.e8_reference_quotes(account_id,symbol,bid,ask,requested_at,received_at)
        select ${acct},'${s}',100+g+${i},100.5+g+${i},now()-(g||' minutes')::interval-'1 second'::interval,now()-(g||' minutes')::interval from generate_series(${s === 'ADAUSD' ? 700 : 0},${s === 'ADAUSD' ? 710 : 40}) g`);
    // symbol with quotes for an account that has no monitor profile: must not appear
    await db.exec(`insert into public.e8_reference_quotes(account_id,symbol,bid,ask,requested_at,received_at) values (9,'EURUSD',1,2,now(),now())`);
    await db.exec(mig.match(/create or replace function public\.e8_reference_summary\(\)[\s\S]*?\n\$\$;/)[0]);
    const r = (await db.query(`with old as (select coalesce((select jsonb_agg(x) from (select distinct on(q.account_id,q.symbol) q.account_id,q.symbol,q.bid,q.ask,q.ask-q.bid spread,
        q.received_at,q.requested_at,extract(epoch from now()-q.received_at)*1000 age_ms,p.max_quote_age_ms,
        (p.enabled and q.received_at<=now() and q.received_at>=now()-make_interval(secs=>p.max_quote_age_ms/1000.0)) fresh
        from public.e8_reference_quotes q join public.e8_monitor_profiles p using(account_id) order by q.account_id,q.symbol,q.received_at desc)x),'[]'::jsonb) v),
      nw as (select public.e8_reference_summary()->'quotes' v)
      select (old.v = nw.v) same, jsonb_array_length(nw.v) n, nw.v->0->>'symbol' first_symbol, nw.v->(jsonb_array_length(nw.v)-1)->>'symbol' last_symbol from old, nw`)).rows[0];
    assert.equal(r.same, true, 'identical rows, identical order');
    assert.equal(Number(r.n), 22, '11 symbols x 2 monitored accounts; account 9 has no profile');
    assert.equal(r.first_symbol, 'ADAUSD'); assert.equal(r.last_symbol, 'XAUUSD');
    const s = (await db.query(`select public.e8_reference_summary() s`)).rows[0].s;
    assert.deepEqual(Object.keys(s).sort(), ['account_totals', 'accounts', 'basis', 'fee_complete_fills', 'fills', 'quotes', 'revisions']);
    assert.equal(Number(s.fills), 2); assert.equal(Number(s.fee_complete_fills), 1);
    const eur = s.quotes.find((q) => q.account_id === 3 && q.symbol === 'EURUSD');
    assert.equal(eur.fresh, true, 'a quote inside the profile age limit is fresh'); assert.equal(s.quotes.find((q) => q.account_id === 4 && q.symbol === 'EURUSD').fresh, false, 'a disabled profile is never fresh');
    assert.equal(s.quotes.find((q) => q.symbol === 'ADAUSD' && q.account_id === 3).fresh, false, 'an old quote is not fresh');
  } finally { await db.close(); }
});

test('Queues: a count on every tab, refresh every 15 s and whenever you come back to the tab, seconds in the stamp', () => {
  const js = read('assets/js/ws-queues.js');
  assert.match(js, /counts\.kyc = ov\.queue_counts\.kyc_pending/);
  assert.match(js, /setInterval\(tick, 15000\)/); assert.match(js, /visibilitychange[\s\S]*tick\(\)/); assert.match(js, /addEventListener\('focus', tick\)/);
  assert.match(js, /minute: '2-digit', second: '2-digit' \}\)\)/);
  assert.match(read('workspace/queues.html'), /ws-queues\.js\?v=20261102a/);
  const ac = read('supabase/functions/admin-console/index.ts');
  assert.match(ac, /queue_counts: \{ kyc_pending: \(kycRows \?\? \[\]\)\.filter\(\(k: \{ status: string \}\) => k\.status === "pending"\)\.length \}/);
  assert.match(ac, /pendingRows\.slice\(i, i \+ 8\)\.map\(async/, 'identity queue looks traders up 8 at a time');
  assert.match(ac, /kyc_queue_identity_view/, 'the audit entry for viewing identities is still written');
});

test('Treasury: forecast age is shown and flagged past 45 minutes; refreshes every 30 s and on return', () => {
  const js = read('assets/js/ws-treasury.js');
  assert.match(js, /const forecastAge = /); assert.match(js, /m > 45 \? t \+ ' · OUT OF DATE' : t/); assert.match(js, /runs every 15 minutes/);
  assert.match(js, /setInterval\(tick, 30000\)/); assert.match(js, /visibilitychange[\s\S]*tick\(\)/);
  assert.match(read('workspace/treasury.html'), /ws-treasury\.js\?v=20261102a/);
});

test('Books: the Copied-on-E8 panel refreshes quietly and says plainly when it is out of date', () => {
  const js = read('assets/js/ws-books-backtest.js');
  assert.match(js, /const isStale = \(\) => \{ const m = ageMin\(\); return m === null \|\| m > 30; \}/);
  assert.match(js, /OUT OF DATE: last calculated \$\{esc\(agoText\(ageMin\(\)\)\)\}\. The refresh job is not running\./);
  assert.match(js, /setInterval\(quietRefresh, 60000\)/); assert.match(js, /\/\^\(INPUT\|SELECT\|TEXTAREA\)\$\/\.test\(ae\.tagName\)\) return/, 'never redraws while someone is typing');
  assert.match(read('workspace/books.html'), /ws-books-backtest\.js\?v=20261102a/);
  assert.match(read('assets/js/ws-books.js'), /visibilitychange/);
});

test('the stale-text helpers behave: 20 minutes is fine, 31 minutes and 8 days are flagged in plain words', async () => {
  const js = read('assets/js/ws-books-backtest.js');
  const grab = (name) => js.match(new RegExp('const ' + name + ' = [^\n]*'))[0];
  const ctx = {}; const vm = await import('node:vm'); vm.createContext(ctx);
  vm.runInContext(`let saved = null, r = null; ${grab('ageMin')}\n${grab('isStale')}\n${grab('agoText')}\nglobalThis.t = { ageMin, isStale, agoText, set(v){ saved = v; } };`, ctx);
  const t = ctx.t, ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  t.set(ago(20)); assert.equal(t.isStale(), false);
  t.set(ago(31)); assert.equal(t.isStale(), true);
  t.set(ago(60 * 24 * 8)); assert.equal(t.isStale(), true); assert.equal(t.agoText(t.ageMin()), '8 days ago');
  assert.equal(t.agoText(180), '3 hours ago'); assert.equal(t.agoText(45), '45 minutes ago'); assert.equal(t.agoText(null), 'at an unknown time');
  t.set(null); assert.equal(t.isStale(), true, 'no timestamp counts as out of date');
});
