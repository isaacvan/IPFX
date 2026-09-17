const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('database migration enforces launch protections', () => {
  const sql = read('supabase/migrations/20260917103000_launch_protection_hardening.sql');
  assert.match(sql, /create table if not exists public\.api_rate_limits/i);
  assert.match(sql, /security_invoker = true/i);
  assert.match(sql, /revoke all on function public\.fn_adjust_balance/i);
  assert.match(sql, /alter function public\.fn_verify_audit_chain\(\) set search_path = ''/i);
  assert.match(sql, /file_size_limit = 52428800/i);
  assert.match(sql, /trades_closed_account_time_idx/i);
  assert.match(sql, /trade_safety_flags_status_time_idx/i);
});

test('checkout has bounded input, rate, timeout, and traceable errors', () => {
  const edge = read('supabase/functions/create-payment-intent/index.ts');
  const browser = read('assets/js/checkout-flow.js');
  assert.match(edge, /readJsonObject\(req\)/);
  assert.match(edge, /allowRequest\(db, `checkout:/);
  assert.match(edge, /timeout: 10_000/);
  assert.match(edge, /X-Request-ID/);
  assert.match(edge, /idempotencyKey: "ipfx-commerce-" \+ order\.id/);
  assert.match(browser, /REQUEST_TIMEOUT_MS = 12000/);
  assert.match(browser, /controller\.abort\(\)/);
});

test('growing admin logs use cursor pagination and request limits', () => {
  const admin = read('supabase/functions/admin-console/index.ts');
  assert.match(admin, /allowRequest\(db, "admin:request"/);
  assert.match(admin, /readJsonObject\(req, 32_768\)/);
  assert.match(admin, /next_cursor/);
  assert.match(admin, /has_more/);
  assert.match(admin, /\.lt\("created_at", before\)/);
});

test('operations include uptime, concurrency, and restore checks', () => {
  const uptime = read('.github/workflows/uptime-monitor.yml');
  const load = read('scripts/concurrency-smoke.mjs');
  const restore = read('scripts/backup-restore-verification.sql');
  assert.match(uptime, /cron: '\*\/15 \* \* \* \*'/);
  assert.match(uptime, /--max-time 15/);
  assert.match(load, /IPFX_ALLOW_PRODUCTION_LOAD_TEST/);
  assert.match(load, /Math\.min\(50/);
  assert.match(restore, /orphaned_trades/);
  assert.match(restore, /duplicate_provider_intents/);
});
