// A/B-book Day 3: risk allocation and execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emergencyStop, legSide, lotsFor, sizeMultiplier } from '../supabase/functions/_shared/ab-allocator.ts';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const DAY = 86_400_000, T0 = Date.parse('2026-10-09T08:00:00Z');
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function points(seed, days, mu, perDay = 3, start = T0) {
  const r = rng(seed), out = [];
  for (let d = 0; d < days; d++) for (let k = 0; k < perDay; k++) {
    const s = r() < (1 + mu) / 2.2 ? 1.2 : -1.0;
    out.push({ closedAt: start + d * DAY + k * 3_600_000, sameR: s, reverseR: -s - 0.15, holdSeconds: 600 });
  }
  return out;
}

test('A-book size steps up only as the live record confirms, and drops to 1x on an early warning', () => {
  assert.equal(sizeMultiplier('a', points(1, 5, 0.35), T0, 6).multiplier, 1);
  let three = 0, six = 0;
  for (let s = 0; s < 30; s++) {
    if (sizeMultiplier('a', points(10 + s, 20, 0.35), T0, 6).multiplier >= 3) three++;
    if (sizeMultiplier('a', points(50 + s, 60, 0.35), T0, 6).multiplier === 6) six++;
  }
  assert.ok(three >= 20, `3x after 60 good live trades: ${three}/30`);
  assert.ok(six >= 20, `6x after 180 good live trades: ${six}/30`);
  const fading = [...points(3, 40, 0.35), ...points(4, 4, -0.9, 3, T0 + 40 * DAY)];
  assert.equal(sizeMultiplier('a', fading, T0, 6).multiplier, 1);
  assert.ok(sizeMultiplier('a', points(5, 40, 0.35), T0, 3).multiplier <= 3, 'book maximum caps the multiplier');
});

test('B-book size grows with stronger evidence that reversing the trader pays', () => {
  const weak = sizeMultiplier('b', points(6, 20, -0.4), T0, 3).multiplier;
  const strong = sizeMultiplier('b', points(7, 60, -0.6), T0, 3).multiplier;
  assert.ok(strong >= weak && strong >= 2, `weak ${weak}, strong ${strong}`);
});

test('lots scale with reserved risk and round down to the broker step', () => {
  assert.equal(lotsFor(0.1, 50, 300, 0.01, 0.01), 0.6);
  assert.equal(lotsFor(0.1, 50, 125, 0.01, 0.01), 0.25);
  assert.equal(lotsFor(0.03, 50, 10, 0.01, 0.01), 0, 'below broker minimum sends nothing');
  assert.equal(lotsFor(0.1, 0, 100, 0.01, 0.01), 0, 'no stop loss = no measurable risk = no order');
});

test('B-book reverses the trade and puts its emergency stop on the trader\'s profit side', () => {
  assert.equal(legSide('b', 'buy'), 'sell');
  assert.equal(legSide('a', 'buy'), 'buy');
  assert.ok(Math.abs(emergencyStop('b', 'buy', 1.1, 1.099) - 1.103) < 1e-9);
  assert.ok(Math.abs(emergencyStop('a', 'buy', 1.1, 1.099) - 1.097) < 1e-9);
});

test('hard caps: reserved atomically before every order, only a migration can change them', () => {
  const sql = read('supabase/migrations/20261003180000_ab_allocator_execution.sql');
  assert.match(sql, /select \* into lim from public\.ab_risk_limits where book = p_book for update;/);
  assert.match(sql, /grant select on public\.ab_risk_limits to service_role;/);
  assert.doesNotMatch(sql, /grant [a-z, ]*update[a-z, ]* on public\.ab_risk_limits/i);
  assert.match(sql, /'daily loss stop reached'/);
  assert.match(sql, /'symbol net exposure cap'/);
  assert.match(sql, /if s\.book_halt or halted then/);
  assert.match(sql, /p_book text, p_trade uuid/);
});

test('engine routes A-book live hedge-first, B-book live reversed after the fill, and passes partial closes', () => {
  const e = read('supabase/functions/trading-engine/index.ts');
  assert.match(e, /const abBook = await abRoute\(db, user\.id\);\s*\n\s*if \(abBook === "a" \|\| await hedgeOpenArmed\(db, A\)\)/);
  assert.match(e, /if \(abBook === "b"\) bookLater\(\{ event: "open", book: "b"/);
  assert.match(e, /const legs = await bookLegs\(db, t\.id\);/);
  assert.match(e, /if \(legs\.b \|\| \(legs\.a && hedge\.state !== "filled"\)\) bookLater\(\{ event: "close"/);
  assert.match(e, /bookLater\(\{ event: "partial_close", source_trade_id: target\.id, fraction: vol \/ full/);
  assert.match(e, /done = await closeTrade\(db, acct, t, ex, "no_stop_loss", q\);/);
  const x = read('supabase/functions/book-executor/index.ts');
  assert.match(x, /\.eq\("environment", "demo"\)/);
  assert.match(x, /Never resubmit an ambiguous order/);
  assert.match(x, /db\.rpc\("ab_reserve_risk"/);
});
