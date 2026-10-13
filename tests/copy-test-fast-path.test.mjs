import test from 'node:test';
import assert from 'node:assert/strict';
import { bookOpenFixture } from './helpers/book-open-fixture.mjs';

test('fixed-lot test skips historical sizing and unrelated routes but retains every pre-send guard', async () => {
  const f = bookOpenFixture({ otherLadder: true }); const r = await f.run();
  assert.equal(r.legs.length, 1); assert.equal(r.legs[0].book, 'l7'); assert.equal(f.posts.length, 1); assert.equal(f.posts[0].qty, .01); assert.equal(f.posts[0].side, 'buy');
  for (const x of ['ab_route_for_user', 'ab_trade_ledger:select', 'ab_trader_profiles:select', 'ab_risk_limits:select', 'ab_settings:select', 'ab_policy_versions:select', 'ab_person_progress', 'treasury_status', 'ladder_settings:select', 'team_book_destinations:select']) assert.ok(!f.trace.includes(x), x);
  for (const x of ['copy_test_claim', 'ab_reserve_risk', 'destination-guard', 'capacity-guard', 'book_orders:insert']) assert.ok(f.trace.indexOf(x) < f.trace.indexOf('broker-submit') && f.trace.indexOf(x) >= 0, x);
  assert.equal(f.requests.find(x => x.name === 'capacity-guard').requireEmpty, true);
  const reservation = f.requests.find(x => x.name === 'ab_reserve_risk'); assert.equal(reservation.args.p_risk_usd, 3); assert.equal(reservation.args.p_signed_lots, .01);
  const target = f.requests.find(x => x.table === 'ladder_accounts');
  for (const pair of [['id', 7], ['role', 'ladder'], ['copy_test_only', true], ['execution_enabled', true], ['status', 'funded']]) assert.ok(target.filters.some(x => JSON.stringify(x) === JSON.stringify(pair)));
});

test('admission, duplicate, wrong-book, risk and capacity failures never dispatch a broker request', async () => {
  for (const o of [{ admissionError: true }, { trial: { ok: false, reason: 'DUPLICATE_TEST_NO_SEND' } }, { book: 'b' }, { riskRefused: true }, { capacityRefused: true }, { noDestination: true }]) {
    const f = bookOpenFixture(o); await f.run(); assert.equal(f.posts.length, 0, JSON.stringify(o));
  }
});

test('stale, foreign-currency, invalid-contract and excess emergency-stop risk refuse before broker dispatch', async () => {
  for (const o of [{ gold: { spec_observed_at: new Date(Date.now() - 7 * 3600000).toISOString() } }, { gold: { quote_currency: 'EUR' } }, { gold: { lot_size: 0 } }, { trial: { max_trade_risk_usd: 2 } }]) {
    const f = bookOpenFixture(o); await f.run(); assert.equal(f.posts.length, 0);
  }
});

test('ambiguous exact receipts stay reconciliation-required and are never resubmitted', async () => {
  const f = bookOpenFixture({ fill: { qty: .005 } }); const r = await f.run();
  assert.equal(f.posts.length, 1); assert.match(r.legs[0].error, /reconciliation/);
  assert.equal(f.requests.find(x => x.table === 'book_orders' && x.verb === 'update').value.status, 'reconciliation_required');
});

test('ordinary A-book retains routing, sizing, group selection and excludes other test-only destinations', async () => {
  const f = bookOpenFixture({ ordinary: true, otherLadder: true }); const r = await f.run();
  assert.equal(r.legs.length, 1); assert.equal(r.legs[0].book, 'l7');
  // New to live: 25% size (owner decision 2026-10-13). 0.02 lots x 25% is below the broker minimum, so nothing is sent.
  assert.equal(f.posts.length, 0);
  for (const x of ['ab_route_for_user', 'ab_trade_ledger:select', 'ab_person_progress', 'treasury_status', 'ladder_settings:select', 'ab_trader_profiles:select']) assert.ok(f.trace.includes(x), x);
  const guard = f.requests.find(x => x.name === 'capacity-guard'); assert.ok(!guard || guard.requireEmpty === false);
  const rejected = bookOpenFixture({ ordinary: true, route: 'b' }); await rejected.run(); assert.equal(rejected.posts.length, 0);
});

test('ordinary B-book still stops on insufficient treasury before any broker send', async () => {
  const f = bookOpenFixture({ ordinary: true, book: 'b', route: 'b', treasury: 'short' }); const r = await f.run();
  assert.match(r.skipped, /treasury short/); assert.equal(f.posts.length, 0);
});
