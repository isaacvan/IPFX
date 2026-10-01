import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const engine = read('supabase/functions/trading-engine/index.ts');
const mirror = read('supabase/functions/live-mirror/index.ts');
const admin = read('supabase/functions/admin-console/index.ts');
const platform = read('trading.html');

test('breach claim failure still freezes the account (fail closed)', () => {
  const m = read('supabase/migrations/20260930120000_breach_freeze_repair.sql');
  assert.match(m, /account_breach_events/);
  assert.match(m, /breached_at/);
  assert.match(engine, /breach_claim_fallback/);
  assert.match(engine, /\.eq\("status", "active"\)[\s\S]{0,400}mirror_enabled: false|mirror_enabled: false[\s\S]{0,400}\.eq\("status", "active"\)/);
});

test('order placement is idempotent on client_order_id', () => {
  const m = read('supabase/migrations/20260930121000_trade_client_order_id.sql');
  assert.match(m, /unique index[\s\S]*\(account_id, client_order_id\)[\s\S]*where client_order_id is not null/i);
  assert.match(engine, /client_order_id/);
  assert.match(engine, /error\.code === "23505" && clientOrderId/);
  assert.match(engine, /duplicate_order: true/);
  assert.match(platform, /action:'open'[^;]*client_order_id:/);
});

test('live mirror has kill switches that never block closes', () => {
  assert.match(mirror, /IPFX_MIRROR_HALT/);
  assert.match(mirror, /IPFX_LIVE_CAPITAL_MIRROR/);
  assert.match(mirror, /trading_halted/);
  assert.match(mirror, /if \(event === "open"\) \{\s*const blocked = await mirrorOpenBlocked/);
  assert.match(mirror, /constantTimeEqual\(supplied/);
  assert.doesNotMatch(mirror, /supplied !== `Bearer/);
});

test('payouts cannot be requested twice or approved over an already-paid period', () => {
  const m = read('supabase/migrations/20260930122000_payout_double_spend_guard.sql');
  assert.match(m, /raise exception 'payout_pending'/);
  assert.match(m, /raise exception 'period_already_paid'/);
  assert.match(m, /payouts_one_open_request_per_account[\s\S]*where status = 'requested'/);
  assert.match(engine, /payout_pending:/);
});

test('admin money actions require owner + MFA and write the audit row first', () => {
  assert.match(admin, /ownerMoneyActions = new Set\(\["payout_approve", "payout_mark_paid"\]\)/);
  assert.match(admin, /sensitiveActions[\s\S]{0,400}"payout_create", "payout_approve", "payout_mark_paid", "payout_void"/);
  assert.match(admin, /Only the owner can resume trading/);
  for (const a of ['payout_create', 'payout_approve', 'payout_mark_paid', 'payout_void']) {
    assert.ok(admin.includes(`logAdminStrict("${a}_intent"`), a);
  }
  const m = read('supabase/migrations/20260930123000_admin_audit_append_only.sql');
  assert.match(m, /revoke update, delete, truncate on public\.admin_audit_log from service_role/);
});

test('anon has no grants on trader analytics views', () => {
  const m = read('supabase/migrations/20260930124000_rls_audit_view_grants.sql');
  assert.match(m, /revoke all on public\.trader_risk\s+from anon/);
  assert.match(m, /revoke all on public\.trader_stats from anon/);
});

test('trailing stops only ever tighten and respect the risk cap', () => {
  const m = read('supabase/migrations/20260930130000_trailing_oco_alerts.sql');
  assert.match(m, /trail_distance numeric/);
  assert.match(engine, /upd\.lt\("sl", cand\) : upd\.gt\("sl", cand\)/);
  assert.match(engine, /action === "set_trailing"/);
  assert.match(engine, /That trailing stop would start/);
  assert.match(platform, /action:'set_trailing'/);
});

test('OCO legs cancel each other and can never both fill', () => {
  const m = read('supabase/migrations/20260930130000_trailing_oco_alerts.sql');
  assert.match(m, /pending_orders_one_fill_per_oco[\s\S]*status = 'filled'/);
  assert.match(engine, /OCO: other leg filled/);
  assert.match(engine, /body\.oco_with/);
  assert.match(platform, /p\.oco_with=oco/);
});

test('price alerts are server-evaluated (sweep + state) and statements never replace trading state', () => {
  const m = read('supabase/migrations/20260930130000_trailing_oco_alerts.sql');
  assert.match(m, /create table if not exists public\.price_alerts/);
  assert.match(m, /enable row level security/);
  assert.match(engine, /alertsFired = await evaluateAlerts\(db, null\)/);
  assert.match(engine, /action === "statement"/);
  assert.match(platform, /engineRequest\(\{action:'statement'/);
  assert.doesNotMatch(platform, /engineCall\(\{action:'(statement|list_alerts|create_alert)'/);
});

test('keyboard trading is opt-in and guarded', () => {
  assert.match(platform, /localStorage\.getItem\('ipfx-hotkeys'\)==='on'/);
  assert.match(platform, /e\.repeat\)return/);
  assert.match(platform, /tag==='INPUT'\|\|tag==='TEXTAREA'/);
  assert.match(platform, /Press Shift\+X again/);
});

test('low-latency quote path: pump, batch warm, realtime push, region pinning, auth cache', () => {
  const m = read('supabase/migrations/20260930140000_quote_pump_realtime.sql');
  assert.match(m, /cron\.schedule\(\s*'ipfx-quote-pump', '10 seconds'/);
  assert.doesNotMatch(m, /[0-9a-f]{64}/, 'cron secret must never be written to the repo');
  assert.match(m, /for select to anon, authenticated/);
  assert.doesNotMatch(m, /for insert/i, 'clients must not be able to publish prices');
  assert.match(engine, /body\.action === "pump"/);
  assert.match(engine, /xml\.matchAll\(/);
  assert.match(engine, /await warmQuotes\(true\);\s*let later = await fetchQuote/);
  assert.match(engine, /authCache\.set\(cacheKey/);
  assert.match(engine, /claims\.exp \* 1000/);
  assert.match(engine, /"Server-Timing"/);
  assert.match(platform, /ENGINE_URL='[^']+\?forceFunctionRegion=eu-west-1'/);
  assert.match(platform, /channel\('quotes:'\+key,\{config:\{private:true\}\}\)/);
  assert.match(platform, /j\.received_ts<quoteAppliedRt/);
  assert.match(read('assets/js/ipfx-chart.js'), /forceFunctionRegion=eu-west-1&symbol=/);
});

test('Infinity: winning trades held under 1 minute are excluded from payouts, with a warning before closing early', () => {
  const m = read('supabase/migrations/20260930150000_infinity_min_hold_payouts.sql');
  assert.match(m, /t\.pnl > 0/);
  assert.match(m, /interval '60 seconds'/);
  assert.match(m, /opened_at >= timestamptz '2026-09-30 23:00:00\+00'/);
  assert.match(m, /v_acct\.challenge_type = 'infinity'/);
  assert.match(m, /s2_profit := s2_profit - public\.fn_infinity_quick_trade_profit/);
  assert.match(m, /s3_profit := s3_profit - public\.fn_infinity_quick_trade_profit/);
  assert.match(m, /raise exception 'payout_pending'/);
  assert.match(m, /raise exception 'period_already_paid'/);
  assert.match(engine, /payout_min_hold_seconds: \(acct\.challenge_type \?\? ""\) === "infinity" \? 60 : null/);
  assert.match(platform, /Trades must be longer than 1 minute/);
  assert.match(platform, /if\(before&&!\(await quickCloseConfirm\(\[before\]\)\)\)return false;/);
  assert.match(platform, /if\(!\(await quickCloseConfirm\(\(engineState&&engineState\.open_trades\)\|\|\[\]\)\)\)return;/);
  assert.match(platform, /if\(!\(await closeTradeById\(last\.id\)\)\)return;/);
});

test('a quiet FXCM symbol on a live feed is not stale; a dead feed or long-silent symbol still is', () => {
  const m = read('supabase/migrations/20260930160000_live_quotes_feed_heartbeat.sql');
  assert.match(m, /add column if not exists feed_ts timestamptz/);
  assert.match(engine, /function fxcmFeedHeartbeat\(xml: string, receivedTs: number\)/);
  assert.match(engine, /if \(now - q\.feedTs > limit\) return true;/);
  assert.match(engine, /return now - refTs > Math\.max\(limit, SYMBOL_QUIET_MAX_MS\);/);
  assert.match(engine, /const SYMBOL_QUIET_MAX_MS = 60_000;/);
  assert.match(engine, /feed_ts: feedTs \? new Date\(feedTs\)\.toISOString\(\) : null/);
});

test('1s / 15s / 30s timeframes are built from IPFX recorded price changes', () => {
  const m = read('supabase/migrations/20260930170000_quote_ticks_seconds_candles.sql');
  assert.match(m, /create table if not exists public\.quote_ticks/);
  assert.match(m, /interval '6 hours'/);
  assert.match(engine, /db\.from\("quote_ticks"\)\.insert\(/);
  const candles = read('supabase/functions/chart-candles/index.ts');
  assert.match(candles, /"1S": \{ seconds: 1/);
  assert.match(candles, /"15S": \{ seconds: 15/);
  assert.match(candles, /"30S": \{ seconds: 30/);
  assert.match(candles, /source: "ipfx-ticks"/);
  assert.match(read('assets/js/ipfx-chart.js'), /TF_SECONDS = \{ "1S": 1, "15S": 15, "30S": 30,/);
  assert.match(platform, /setTf\('1S',this\)/);
});

test('TradeLocker price source: only prices leave the server; probe is cron-secret gated', () => {
  const feed = read('supabase/functions/_shared/tradelocker-feed.ts');
  assert.match(feed, /Only prices ever leave the\s+\/\/ server/);
  assert.match(engine, /body\.action === "feed_probe"/);
  assert.match(engine, /if \(!expected \|\| secret !== expected\) return err\("Not authorized", 401\);/);
});

test('TradeLocker price source: switchable, leased, rate-adaptive, sticky, FXCM fallback', () => {
  const m = read('supabase/migrations/20261001000000_tradelocker_price_feed.sql');
  assert.match(m, /price_feed text not null default 'fxcm'/);
  assert.match(m, /check \(price_feed in \('fxcm','shadow','tradelocker'\)\)/);
  assert.match(m, /create table if not exists public\.price_feed_state/);
  assert.match(m, /revoke all on public\.price_feed_state from anon, authenticated/);
  assert.match(engine, /class TradeLockerFeed/);
  assert.match(engine, /or\(`lease_until\.is\.null,lease_until\.lt\.\$\{nowIso\}`\)/);
  assert.match(engine, /this\.rate = Math\.max\(TL_MIN_RATE, this\.rate \* 0\.5\)/);   // back off on 429
  assert.match(engine, /this\.rate = Math\.min\(this\.maxRate, this\.rate \+ 0\.25\)/); // ramp on success
  assert.match(engine, /now - this\.lastRampAt >= 5000 && now - this\.last429At >= 10_000/); // ramps after clean time, not a success count
  assert.match(engine, /now - q\.fetchedAt < TL_FRESH_MS/);                           // stale TL -> FXCM fallback
  assert.match(engine, /if \(this\.mode === "shadow"\) \{ this\.pending = \[\]; return \{ rows: fxRows, changed: fxChanged \}; \}/);
  assert.match(engine, /q\.source === "fxcm-basic" \|\| q\.source === "tradelocker"/);
});

test('cTrader Open API price source: streaming, all instruments, credentials server-side, FXCM fallback', () => {
  const ct = read('supabase/functions/_shared/ctrader-feed.ts');
  assert.match(ct, /SUBSCRIBE_SPOTS_REQ: 2127/);
  assert.match(ct, /SPOT_EVENT: 2131/);
  assert.match(ct, /Number\(p\.bid\) \/ 100000/);
  assert.match(ct, /NSXUSD: \["USTEC", "NAS100"/);
  assert.match(ct, /REFRESH_TOKEN_REQ/);
  const m = read('supabase/migrations/20261001010000_ctrader_price_feed.sql');
  assert.match(m, /'fxcm','shadow','tradelocker','ctrader'/);
  assert.match(engine, /class CTraderFeed/);
  assert.match(engine, /if \(!this\.alive\(\)\) \{ this\.pending = \[\]; return \{ rows: fxRows, changed: fxChanged \}; \}/);
  assert.match(engine, /q\.source === "ctrader"/);
});

test('Terms: Company may copy/route (A-book/B-book); traders may copy from outside but not between IPFX accounts', () => {
  const terms = read('terms.html'), privacy = read('privacy.html');
  assert.match(terms, /Company trading \(copying, A-book and B-book\)/);
  assert.match(terms, /may move any account between these models at any time/);
  assert.match(terms, /takes effect on 15 October 2026, in accordance with Section 18/);
  assert.doesNotMatch(terms, /does not have any right under these Terms to: place, mirror/);
  assert.doesNotMatch(terms, /Absolute Prohibition/);
  assert.match(terms, /You may copy trades onto your Evaluation or Funded Account from outside the Platform/);
  assert.match(terms, /Copying trades into or between IPFX accounts is prohibited/);
  assert.match(privacy, /move accounts between A-book and B-book models, as set out in Section 11\.3/);
  assert.doesNotMatch(privacy, /does not use your identifiable Trading Data to place, mirror/);
});
