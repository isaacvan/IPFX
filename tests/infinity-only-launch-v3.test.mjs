import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const migration = read('supabase/migrations/20260920173000_infinity_only_october_launch.sql');
const home = read('index.html');
const infinity = read('infinity.html');
const terms = read('terms.html');
const start = read('start-challenge.html');

test('Infinity v3 publishes the prospective two-stage skill filter', () => {
  for (const fragment of [
    "profit_target_pct = 8",
    "max_drawdown_pct = 5",
    "daily_loss_pct = 2.5",
    "min_trading_days = 10",
    "min_trades = 30",
    "daily_profit_cap_pct = 1.50",
    "profit_target_pct = 6",
    "min_trading_days = 15",
    "min_trades = 60",
    "max_risk_per_trade_pct = 0.35",
    "min_profitable_days_pct = 55",
    "('infinity-v3-s1','infinity',1,'published',14,10,30,0.35",
    "('infinity-v3-s2','infinity',2,'published',21,15,60,0.25",
  ]) assert.ok(migration.includes(fragment), fragment);
});

test('database authority permits only Infinity publicly from 1 October', () => {
  assert.match(migration, /PROGRAMME_PAUSED_INFINITY_ONLY/);
  assert.match(migration, /INFINITY_LAUNCHES_OCTOBER_1/);
  assert.match(migration, /2026-10-01 00:00:00 Europe\/London/);
  assert.match(migration, /challenge_application_programme_launch/);
  assert.match(migration, /update public\.commerce_catalog[\s\S]*enabled = false/);
});

test('public pages state the same launch and block paid-programme CTAs', () => {
  assert.match(start, /Infinity is the only programme launching on 1 October/);
  assert.match(home, /Traditional &amp; Futures — On Hold/);
  assert.match(home, /Infinity Challenge opens 1 October 2026/);
  assert.doesNotMatch(home, /onclick="openPricingModal\('(25k|50k|100k|200k)'\)">Get Started/);
  assert.match(read('futures.html'), /Futures Challenge applications and payments are on hold/);
  assert.match(read('personalised-challenge.html'), /Personalised Application Challenge applications and payments are on hold/);
});

test('checkout and provisioning paths reject paused programmes', () => {
  const stripe = read('supabase/functions/create-payment-intent/index.ts');
  const crypto = read('supabase/functions/nowpayments-checkout/index.ts');
  const engine = read('supabase/functions/trading-engine/index.ts');
  for (const source of [stripe, crypto]) {
    assert.match(source, /Traditional, Futures and PAC are on hold/);
    assert.match(source, /ownerPreview/);
  }
  assert.match(engine, /ownerPreviewAllowed/);
  assert.match(engine, /claim_infinity/);
});

test('payout milestone is review-only and live allocation is not promised', () => {
  for (const source of [home, infinity, terms]) {
    assert.match(source, /5%/);
    assert.match(source, /review/i);
  }
  assert.doesNotMatch(infinity, /releases the moment you hit 3%/);
  assert.doesNotMatch(infinity, /A-Book \(Real Markets\)/);
  assert.match(infinity, /does not guarantee a live account/);
});

test('the deterministic funnel model carries the published candidate rules', () => {
  const model = read('scripts/infinity-rule-model.mjs');
  assert.match(model, /targetPct: 8/);
  assert.match(model, /trailingDrawdownPct: 5/);
  assert.match(model, /minSessions: 30/);
  assert.match(model, /targetPct: 6/);
  assert.match(model, /minSessions: 60/);
  assert.match(model, /maxBestDayShare: 0\.25/);
});
