// A/B-book Day 4: treasury forecaster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRIOR, STAGE_TABLE, coverageStatus, forecastAccount, liabilityWithin, passAnalytic, posterior } from '../supabase/functions/_shared/treasury.ts';

const s2 = (over = {}) => ({ accountId: 'x', personId: 'p', stage: 2, startingBalance: 5000, balance: 5000, peak: 5000, targetPct: 6, maxDdPct: 4, riskPct: 0.0035, traderR: [], ...over }); // Stage 2 target is 6% since 2026-10-08

test('prior-only graduation odds match the Monte Carlo chain the table was built from', () => {
  const g = STAGE_TABLE.grid;
  const chain = PRIOR.reduce((a, w, i) => a + w * STAGE_TABLE.p_pass['1'][i] * STAGE_TABLE.p_pass['2'][i] * STAGE_TABLE.p_pass['3'][i], 0);
  assert.ok(Math.abs(chain - 0.0153) < 0.003, `single-attempt graduation ${chain}`);
  assert.equal(g.length, PRIOR.length);
});

test('a fresh account reproduces the table exactly (the in-progress model is calibrated to it)', () => {
  const f = forecastAccount(s2(), 'cash_at_stage3');
  const post = posterior([]);
  const expected = post.reduce((a, w, i) => a + w * STAGE_TABLE.p_pass['2'][i] * STAGE_TABLE.p_pass['3'][i], 0);
  assert.ok(Math.abs(f.pGraduate - expected) < 1e-6);
});

test('progress and evidence move the forecast in the right direction', () => {
  const fresh = forecastAccount(s2(), 'cash_at_stage3').pGraduate;
  const ahead = forecastAccount(s2({ balance: 5200, peak: 5200 }), 'cash_at_stage3').pGraduate;
  const nearDd = forecastAccount(s2({ balance: 4850, peak: 5000 }), 'cash_at_stage3').pGraduate;
  const winner = forecastAccount(s2({ traderR: Array.from({ length: 120 }, (_, i) => (i % 5 < 3 ? 1.2 : -1)) }), 'cash_at_stage3').pGraduate;
  assert.ok(ahead > fresh && nearDd < fresh && winner > fresh * 3, `${fresh} ${ahead} ${nearDd} ${winner}`);
});

test('payout per graduate follows the payout model', () => {
  assert.equal(forecastAccount(s2(), 'cash_at_stage3').payoutIfGraduate, 700, '85% of ($300 + $800) = $935, capped at $700');
  assert.equal(forecastAccount(s2({ stage: 3, startingBalance: 10000, balance: 10000, peak: 10000, targetPct: 8, s2Profit: 0 }), 'cash_at_stage3').payoutIfGraduate, 680, '85% of $800 when Stage 2 earned nothing, under the cap');
  assert.equal(forecastAccount(s2(), 'sponsored_account', 350).payoutIfGraduate, 350);
  const s4 = forecastAccount({ ...s2(), stage: 4, startingBalance: 25000, riskPct: 0.0025, traderR: Array(80).fill(0).map((_, i) => (i % 2 ? 1.2 : -1)) }, 'cash_at_stage3');
  assert.ok(s4.s4MonthlyPayout > 0);
  assert.equal(forecastAccount({ ...s2(), stage: 4, startingBalance: 25000, riskPct: 0.0025 }, 'sponsored_account').s4MonthlyPayout, 0);
});

test('liability grows with the horizon; P90 sits above the mean; coverage bands', () => {
  const fs = Array.from({ length: 200 }, (_, k) => forecastAccount(s2({ accountId: String(k), balance: 5000 + (k % 10) * 20, peak: 5000 + (k % 10) * 20 }), 'cash_at_stage3'));
  const a = liabilityWithin(fs, 30), b = liabilityWithin(fs, 90);
  assert.ok(b.expected >= a.expected && b.p90 >= b.expected);
  assert.equal(coverageStatus(null, 100), 'unknown');
  assert.equal(coverageStatus(130, 100), 'healthy');
  assert.equal(coverageStatus(110, 100), 'tight');
  assert.equal(coverageStatus(90, 100), 'short');
});

test('drawdown first-passage: driftless closed form exp(-a/b)', () => {
  assert.ok(Math.abs(passAnalytic(5, 10, 0) - Math.exp(-0.5)) < 1e-9);
  assert.ok(passAnalytic(5, 10, 0.1) > passAnalytic(5, 10, 0) && passAnalytic(5, 10, -0.1) < passAnalytic(5, 10, 0));
});

test('wiring: treasury worker, tilt within caps, B-book pause when short, loud integrity failures', () => {
  const x = readFileSync(new URL('../supabase/functions/book-executor/index.ts', import.meta.url), 'utf8');
  assert.match(x, /if \(book === "b" && treasury === "short"\)/);
  const a = readFileSync(new URL('../supabase/functions/_shared/ab-allocator.ts', import.meta.url), 'utf8');
  assert.match(a, /if \(treasury === "tight" \|\| treasury === "short"\) weight \*= progress === "EARLY" \? 0\.5 : progress === "STAGE3_COMPLETE" \? 1\.2 : 1;/);
  const c = readFileSync(new URL('../supabase/functions/ab-classifier/index.ts', import.meta.url), 'utf8');
  assert.match(c, /if \(sigErr\) return json\(\{ error: "integrity signals unavailable: "/);
  const sql = readFileSync(new URL('../supabase/migrations/20261004100500_ab_person_of_grant.sql', import.meta.url), 'utf8');
  assert.match(sql, /grant execute on function public\.ab_person_of\(uuid\) to service_role;/);
});
