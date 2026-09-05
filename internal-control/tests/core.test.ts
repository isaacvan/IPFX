#!/usr/bin/env -S node --loader ts-node/esm
// ============================================================
// IPFX Capital — internal-control core test suite
//
// Zero test-framework dependency (uses Node's built-in assert), same
// pattern as tests/indicator-registry.test.js elsewhere in this repo.
// Mirrors the acceptance criteria in docs/risk-framework/
// deepseek-ipfx-report.md §19.1 as closely as pure-logic unit tests can
// (the auth/RLS/dashboard acceptance items need a running Supabase
// project + deployed app and are NOT testable from this file — see
// docs/risk-framework/phase-0-3-runbook.md for how to run those).
//
// NOT EXECUTED IN THIS ENVIRONMENT: no Node.js/ts-node is installed on
// the machine this was authored on. Run with:
//   npx ts-node internal-control/tests/core.test.ts
// once a Node environment is available. Reviewed by hand for logical
// correctness in the meantime.
// ============================================================

import assert from "node:assert/strict";
import {
  netTradePnl, profitFactor, expectancy, winRate, payoffRatio,
  sharpeRatio, sortinoRatio, maxDrawdown, dailyReturnSeries, type ClosedTrade, type EquityPoint,
} from "../lib/metrics";
import {
  makeRng, probabilityPositiveOverHorizon, benjaminiHochberg, wilsonInterval, evidenceConfidence, dataQualityScore,
} from "../lib/probability";
import { transition, assertIndependentReviewer, computeReviewDueDate } from "../lib/review-state-machine";
import { similarityScore, applySimilarityFDR, clusterBySimilarity, DEFAULT_SIMILARITY_WEIGHTS, PLACEHOLDER_LAMBDAS } from "../lib/similarity";
import { decideAlertSend, dedupKey, DEFAULT_ALERT_POLICY, type AlertRecord } from "../lib/alerts";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`ok:   ${name}`); }
  catch (e) { failed++; console.error(`FAIL: ${name}\n      ${(e as Error).message}`); }
}

function mkTrade(pnl: number, costsKnown = true): ClosedTrade {
  return { id: crypto.randomUUID(), openedAt: new Date("2026-01-01T00:00:00Z"), closedAt: new Date("2026-01-01T01:00:00Z"), pnlGross: pnl, commission: 0, swap: 0, spreadCost: 0, slippageCost: 0, costsKnown };
}

// ---- metrics / missing-data behavior (report §19.1 "Metrics and statistics") ----
test("known fixture returns expected profit factor", () => {
  const trades = [mkTrade(100), mkTrade(50), mkTrade(-40), mkTrade(-10)];
  const pf = profitFactor(trades);
  assert.equal(pf.status, "ok");
  assert.ok(Math.abs((pf.value as number) - 3) < 1e-9, `expected PF=3, got ${pf.value}`);
});

test("profit factor is null (not Infinity) with no losses", () => {
  const pf = profitFactor([mkTrade(10), mkTrade(20)]);
  assert.equal(pf.value, null);
  assert.equal(pf.status, "insufficient_evidence");
  assert.ok(pf.warnings.includes("no_losses"));
});

test("Sharpe is undefined (null) when variance is zero", () => {
  const s = sharpeRatio([0.01, 0.01, 0.01, 0.01]);
  assert.equal(s.value, null);
  assert.ok(s.warnings.includes("zero_variance"));
});

test("Sortino is undefined when downside deviation is zero (all-positive returns)", () => {
  const s = sortinoRatio([0.01, 0.02, 0.015, 0.03]);
  assert.equal(s.value, null);
});

test("dailyReturnSeries halts (returns null) on non-positive prior equity", () => {
  const points: EquityPoint[] = [
    { t: new Date("2026-01-01"), equity: 1000, externalFlow: 0 },
    { t: new Date("2026-01-02"), equity: -50, externalFlow: 0 },   // breach/capital loss
    { t: new Date("2026-01-03"), equity: 100, externalFlow: 0 },
  ];
  const r = dailyReturnSeries(points);
  assert.equal(r.status, "insufficient_evidence");
});

test("max drawdown matches a known fixture", () => {
  const points: EquityPoint[] = [
    { t: new Date("2026-01-01"), equity: 1000, externalFlow: 0 },
    { t: new Date("2026-01-02"), equity: 1200, externalFlow: 0 }, // new peak
    { t: new Date("2026-01-03"), equity: 900, externalFlow: 0 },  // -25% from peak
    { t: new Date("2026-01-04"), equity: 1300, externalFlow: 0 }, // recovers above peak
  ];
  const dd = maxDrawdown(points);
  assert.equal(dd.status, "ok");
  assert.ok(Math.abs((dd.value!.maxDrawdownPct) - -0.25) < 1e-9, `expected -0.25, got ${dd.value!.maxDrawdownPct}`);
});

// ---- probability / bootstrap determinism ----
test("bootstrap CI is deterministic with a fixed seed", () => {
  const returns = Array.from({ length: 200 }, (_, i) => Math.sin(i) * 0.01);
  const a = probabilityPositiveOverHorizon(returns, 20, { seed: 7, resamples: 500 });
  const b = probabilityPositiveOverHorizon(returns, 20, { seed: 7, resamples: 500 });
  assert.equal(a.value, b.value, "same seed must produce identical value");
  assert.equal(a.credibleLow, b.credibleLow);
  assert.equal(a.credibleHigh, b.credibleHigh);
});

test("probability with insufficient data is null", () => {
  const r = probabilityPositiveOverHorizon([0.01, -0.02, 0.03], 10);
  assert.equal(r.value, null);
  assert.equal(r.status, "insufficient_evidence");
});

test("Wilson interval matches the report's 8/10 example (~49%-94%)", () => {
  const { low, high } = wilsonInterval(8, 10);
  assert.ok(low > 0.44 && low < 0.53, `low=${low}`);
  assert.ok(high > 0.9 && high < 0.98, `high=${high}`);
});

test("Benjamini-Hochberg FDR: fewer significant results at a stricter target", () => {
  const pValues = [0.001, 0.01, 0.02, 0.04, 0.2, 0.5, 0.8];
  const loose = benjaminiHochberg(pValues, 0.10).filter((r) => r.significant).length;
  const strict = benjaminiHochberg(pValues, 0.01).filter((r) => r.significant).length;
  assert.ok(strict <= loose, `expected strict(${strict}) <= loose(${loose})`);
});

test("data quality: missing cost data lowers the score", () => {
  const clean = dataQualityScore({});
  const missingCosts = dataQualityScore({ missingCommissionOrSwap: true });
  assert.ok(missingCosts.score < clean.score);
});

test("evidence confidence increases with more trades/days, all else equal", () => {
  const low = evidenceConfidence({ nIdeas: 5, tradingDays: 3, effectiveN: 5, regimeCoverage0to1: 0.2, dataMissingRate0to1: 0.5 });
  const high = evidenceConfidence({ nIdeas: 500, tradingDays: 200, effectiveN: 400, regimeCoverage0to1: 0.9, dataMissingRate0to1: 0.05 });
  assert.ok(high > low);
});

test("makeRng is deterministic for a given seed", () => {
  const r1 = makeRng(99), r2 = makeRng(99);
  assert.equal(r1(), r2());
  assert.equal(r1(), r2());
});

// ---- review state machine (report §19.1 "Review and rules") ----
test("a model may never directly produce a rejection", () => {
  const res = transition({ from: "in_review", to: "rejected", actor: { kind: "model", modelVersion: "v1" } });
  assert.equal(res.ok, false);
  assert.match(res.error!, /human_required/);
});

test("a human may reject", () => {
  const res = transition({ from: "in_review", to: "rejected", actor: { kind: "human", userId: "u1" }, reasonCode: "BREACH_MAX_DRAWDOWN" });
  assert.equal(res.ok, true);
});

test("NOT_ELIGIBLE_CAPITAL_INTERNAL cannot justify an eligibility rejection", () => {
  const res = transition({ from: "in_review", to: "rejected", actor: { kind: "human", userId: "u1" }, reasonCode: "NOT_ELIGIBLE_CAPITAL_INTERNAL" });
  assert.equal(res.ok, false);
});

test("illegal transitions are refused (cannot skip pending_review)", () => {
  const res = transition({ from: "active", to: "in_review", actor: { kind: "human", userId: "u1" } });
  assert.equal(res.ok, false);
});

test("independent-reviewer rule rejects the same reviewer on appeal", () => {
  const res = assertIndependentReviewer("reviewer-A", "reviewer-A");
  assert.equal(res.ok, false);
  const ok = assertIndependentReviewer("reviewer-A", "reviewer-B");
  assert.equal(ok.ok, true);
});

test("review due date is business-day aware (skips weekends)", () => {
  // 2026-01-02 is a Friday (UTC) in this fixture year context.
  const due = computeReviewDueDate(new Date("2026-01-02T00:00:00Z"));
  const dow = due.getUTCDay();
  assert.ok(dow !== 0 && dow !== 6, `due date landed on a weekend: ${due.toISOString()}`);
});

// ---- similarity / flags (report §19.1 "Flags and alerts") ----
test("similarity score is 1.0 for a trade compared with itself", () => {
  const t = { id: "a", accountId: "acc1", symbol: "EURUSD", side: "buy" as const, entryTime: new Date("2026-01-01T10:00:00Z"), exitTime: new Date("2026-01-01T10:30:00Z"), entryPrice: 1.1, atr: 0.001, size: 1, stopDistance: 0.001, targetDistance: 0.002 };
  const s = similarityScore(t, t, PLACEHOLDER_LAMBDAS, DEFAULT_SIMILARITY_WEIGHTS);
  assert.ok(Math.abs(s - 1) < 1e-9, `expected ~1.0, got ${s}`);
});

test("FDR correction on similarity candidates never marks more significant than the raw p<0.05 count", () => {
  const candidates = [
    { pairKey: "a-b", zScore: 3.5, pValue: 0.0002 },
    { pairKey: "c-d", zScore: 0.5, pValue: 0.6 },
    { pairKey: "e-f", zScore: 0.2, pValue: 0.8 },
  ];
  const result = applySimilarityFDR(candidates, 0.05);
  const rawSig = candidates.filter((c) => c.pValue < 0.05).length;
  const fdrSig = result.filter((r) => r.significant).length;
  assert.ok(fdrSig <= rawSig);
});

test("graph clustering is deterministic across repeated calls", () => {
  const edges = [{ a: "acc1", b: "acc2", zScore: 5 }, { a: "acc2", b: "acc3", zScore: 6 }, { a: "acc9", b: "acc10", zScore: 1 }];
  const c1 = clusterBySimilarity(edges, 3);
  const c2 = clusterBySimilarity(edges, 3);
  assert.deepEqual(c1, c2);
  assert.deepEqual(c1, [["acc1", "acc2", "acc3"]]); // acc9/acc10 below threshold, excluded
});

// ---- alerts (report §19.1 "Flags and alerts") ----
test("repeated identical alerts are deduplicated (cooldown)", () => {
  const input = { alertType: "severe_drawdown", scope: "trading_account:1", severity: "high" as const, evidenceHash: "h1", recipientId: "owner1", channel: "email" as const };
  const now = new Date("2026-01-01T12:00:00Z");
  const existing: AlertRecord = { dedupKey: dedupKey(input), severity: "high", firstSentAt: now, lastSentAt: now, ackAt: null, ackBy: null, retryCount: 0, deadLettered: false };
  const soon = new Date(now.getTime() + 60000); // 1 minute later, well within the 15-min high cooldown
  const decision = decideAlertSend(input, existing, 1, soon, DEFAULT_ALERT_POLICY);
  assert.equal(decision.action, "suppress_cooldown");
});

test("a severity increase breaks cooldown", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const existing: AlertRecord = { dedupKey: "k", severity: "medium", firstSentAt: now, lastSentAt: now, ackAt: null, ackBy: null, retryCount: 0, deadLettered: false };
  const input = { alertType: "severe_drawdown", scope: "trading_account:1", severity: "critical" as const, evidenceHash: "h1", recipientId: "owner1", channel: "email" as const };
  const soon = new Date(now.getTime() + 60000);
  const decision = decideAlertSend(input, existing, 1, soon, DEFAULT_ALERT_POLICY);
  assert.equal(decision.action, "send");
});

test("critical alert retries and eventually dead-letters", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const input = { alertType: "reconciliation_mismatch", scope: "broker_account:1", severity: "critical" as const, evidenceHash: "h1", recipientId: "owner1", channel: "sms" as const };
  const existing: AlertRecord = { dedupKey: dedupKey(input), severity: "critical", firstSentAt: now, lastSentAt: now, ackAt: null, ackBy: null, retryCount: DEFAULT_ALERT_POLICY.maxRetries, deadLettered: false };
  const later = new Date(now.getTime() + 3600000);
  const decision = decideAlertSend(input, existing, 0, later, DEFAULT_ALERT_POLICY);
  assert.equal(decision.action, "dead_letter");
});

test("throttle caps alerts per channel per hour", () => {
  const input = { alertType: "near_failure", scope: "trading_account:2", severity: "medium" as const, evidenceHash: "h2", recipientId: "owner1", channel: "email" as const };
  const now = new Date("2026-01-01T12:00:00Z");
  const decision = decideAlertSend(input, null, DEFAULT_ALERT_POLICY.maxPerChannelPerHour, now, DEFAULT_ALERT_POLICY);
  assert.equal(decision.action, "suppress_throttled");
});

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
