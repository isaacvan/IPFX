// A/B-book Day 1: data layer, detector repair, outbox dispatcher auth, schema parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('rule snapshots are written by the database for every challenge account, and backfilled', () => {
  const sql = read('supabase/migrations/20261003140000_rule_snapshots_automatic.sql');
  assert.match(sql, /create trigger trading_accounts_rule_snapshot_insert after insert on public\.trading_accounts/);
  assert.match(sql, /create trigger trading_accounts_rule_snapshot_update after update of stage, phase on public\.trading_accounts/);
  assert.match(sql, /'MIDNIGHT_UTC', 'EQUITY'/);
  assert.match(sql, /'source', 'backfill:2026-10-03'/);
  assert.match(sql, /on conflict \(trading_account_id, effective_at\) do nothing/);
});

test('detector leaves out and counts trades it cannot stage instead of failing the account', () => {
  const fn = read('supabase/functions/trader-detector/index.ts');
  assert.match(fn, /const stagedTrades = rawTrades\.filter\(\(trade\) => trade\.stage > 0\);/);
  assert.match(fn, /const ideas = collapseTradeIdeas\(stagedTrades\);/);
  assert.match(fn, /excludedTrades,/);
  // The stage gate still reports unverified when any trade was left out.
  assert.match(fn, /tradeStageVerified: rawTrades\.length > 0 && rawTrades\.every\(\(trade\) => trade\.stage > 0\)/);
});

test('outbox dispatcher authenticates the cron kicker with a dedicated secret, never a committed key', () => {
  const fn = read('supabase/functions/mirror-dispatch/index.ts');
  assert.match(fn, /constantTimeEqual\(req\.headers\.get\("x-dispatch-secret"\) \?\? "", dispatchSecret\)/);
  assert.match(fn, /dispatchSecret\.length >= 32/);
  const sql = read('supabase/migrations/20261003130000_mirror_dispatch_kicker_secret.sql');
  assert.match(sql, /where name = 'ipfx_mirror_dispatch_secret'/);
  assert.match(sql, /status = 'pending' and next_attempt_at <= now\(\)/);
  assert.doesNotMatch(sql, /[0-9a-f]{40,}/);
});

test('ledger replays both directions at bid/ask with costs; reverse is never assumed to be minus the trader', () => {
  const sql = read('supabase/migrations/20261003150000_ab_data_layer.sql');
  // same direction: buy at ask, sell at bid; reverse: the opposite
  assert.match(sql, /case when s\.dir = 1 then s\.o_ask else s\.o_bid end as so, case when s\.dir = 1 then s\.c_bid else s\.c_ask end as sc/);
  assert.match(sql, /case when s\.dir = 1 then s\.o_bid else s\.o_ask end as ro, case when s\.dir = 1 then s\.c_ask else s\.c_bid end as rc/);
  assert.match(sql, /\(\(p\.sc - p\.so\) \* p\.dir \* p\.k - p\.bcost\)/);
  assert.match(sql, /\(\(p\.ro - p\.rc\) \* p\.dir \* p\.k - p\.bcost\)/);
  assert.match(sql, /q\.ts between r\.at - interval '120 seconds' and r\.at \+ interval '60 seconds'/);
  assert.match(sql, /create table if not exists public\.ab_trader_profiles/);
  assert.match(sql, /default 'BB_DEMO'/);
  assert.match(sql, /raw_app_meta_data -> 'suspension' ->> 'kept_user_id'/);
  assert.match(sql, /cron\.schedule\('ipfx-ab-ledger', '\*\/5 \* \* \* \*'/);
  for (const t of ['ab_trader_profiles', 'trade_quote_windows', 'trade_quote_capture', 'ab_trade_ledger']) {
    assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`));
  }
});

test('every table live-mirror reads has a definition in the repo', () => {
  const lm = read('supabase/functions/live-mirror/index.ts') + read('supabase/functions/mirror-dispatch/index.ts');
  const used = new Set([...lm.matchAll(/from\("([a-z_]+)"\)/g)].map((m) => m[1]));
  const sql = readdirSync(new URL('../supabase/migrations/', import.meta.url)).map((f) => read('supabase/migrations/' + f)).join('\n') +
    readdirSync(new URL('../', import.meta.url)).filter((f) => f.endsWith('.sql')).map(read).join('\n');
  const missing = [...used].filter((t) => !new RegExp(`create (table|or replace view|view)( if not exists)? (public\\.)?"?${t}"?[\\s(]`, 'i').test(sql));
  assert.deepEqual(missing, [], 'tables without a repo definition: ' + missing.join(', '));
});
