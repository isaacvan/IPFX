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
