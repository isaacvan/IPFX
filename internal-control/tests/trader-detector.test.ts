import assert from "node:assert/strict";
import test from "node:test";
import {
  collapseTradeIdeas, DEFAULT_SHADOW_POLICIES, deriveAlerts, evaluateTrader,
  type ChallengeType, type DetectorContext, type DetectorPolicy, type RawDetectorTrade,
} from "../lib/trader-detector.ts";

function rawTrades(options: {
  challenge: ChallengeType; stages: number[]; countPerStage: number; pnl?: (i: number) => number;
  symbols?: string[]; startDay?: number; overlapping?: boolean; regimes?: string[];
}): RawDetectorTrade[] {
  const output: RawDetectorTrade[] = [];
  let index = 0;
  for (const stage of options.stages) {
    for (let i = 0; i < options.countPerStage; i++, index++) {
      const day = (options.startDay ?? 1) + index;
      const openedAt = new Date(Date.UTC(2026, 0, day, 8 + (i % 3) * 5));
      const closedAt = new Date(openedAt.getTime() + 60 * 60 * 1000);
      output.push({
        id: `${options.challenge}-${stage}-${i}`,
        accountId: `${options.challenge}-${stage}`,
        stage,
        symbol: options.symbols?.[i % options.symbols.length] ?? ["EURUSD", "XAUUSD", "GBPJPY"][i % 3]!,
        side: i % 2 ? "sell" : "buy",
        openedAt: options.overlapping ? new Date(Date.UTC(2026, 0, stage, 9, i)) : openedAt,
        closedAt: options.overlapping ? new Date(Date.UTC(2026, 0, stage, 10, i)) : closedAt,
        pnl: options.pnl?.(index) ?? (Math.sin((index + 1) * 127.1) * 43758.5453 % 1 > 0.3 ? -20 : 35),
        pnlBasis: "NET_AFTER_COSTS",
        startingBalance: 10_000,
        regime: options.regimes?.[i % options.regimes.length] ?? (i % 2 ? "HIGH_VOL" : "LOW_VOL"),
      });
    }
  }
  return output;
}

function context(challengeType: ChallengeType, stage: number, overrides: Partial<DetectorContext> = {}): DetectorContext {
  return {
    challengeType, currentStage: stage, accountStatus: "active", dataQuality: 1,
    unresolvedSevereFlags: 0, unresolvedCriticalFlags: 0, ruleBreach: false,
    regimeDataAvailable: true, calibrationPassed: false, providerAuthorised: false,
    reserveCapacityAvailable: false, portfolioCorrelation: null, copyability: null,
    markToMarketRiskVerified: true, ruleSnapshotVerified: true, tradeStageVerified: true,
    calibrationEvidenceVerified: true, calibratedProbability: 0.97,
    calibratedForecastId: "fixture-out-of-sample-forecast",
    ...overrides,
  };
}

function calibrated(challenge: ChallengeType): DetectorPolicy {
  return { ...DEFAULT_SHADOW_POLICIES[challenge], calibrated: true };
}

test("overlapping scale-ins collapse into independent ideas", () => {
  const ideas = collapseTradeIdeas(rawTrades({ challenge: "infinity", stages: [1], countPerStage: 20, overlapping: true, symbols: ["EURUSD"] }));
  assert.ok(ideas.length <= 2);
  assert.equal(ideas.reduce((sum, idea) => sum + idea.sourceTradeIds.length, 0), 20);
});

test("ten lucky trades do not trigger a high-potential alert", () => {
  const ideas = collapseTradeIdeas(rawTrades({ challenge: "traditional", stages: [1], countPerStage: 10, pnl: () => 50 }));
  const assessment = evaluateTrader(ideas, context("traditional", 1), DEFAULT_SHADOW_POLICIES.traditional);
  assert.ok(["OBSERVE", "INSUFFICIENT_EVIDENCE"].includes(assessment.state));
  assert.deepEqual(deriveAlerts(null, assessment), []);
});

test("Infinity can flag potential during the challenge but cannot confirm on an uncalibrated policy", () => {
  const ideas = collapseTradeIdeas(rawTrades({ challenge: "infinity", stages: [1, 2, 3], countPerStage: 24 }));
  const assessment = evaluateTrader(ideas, context("infinity", 3), DEFAULT_SHADOW_POLICIES.infinity);
  assert.equal(assessment.state, "HIGH_POTENTIAL");
  assert.ok(assessment.reasons.includes("UNCALIBRATED_CONFIRMATION_BLOCKED"));
  assert.equal(deriveAlerts("OBSERVE", assessment)[0]?.type, "HIGH_POTENTIAL");
});

test("Traditional confirmation requires repeatable positive phases and calibrated regime evidence", () => {
  const ideas = collapseTradeIdeas(rawTrades({ challenge: "traditional", stages: [1, 2, 3], countPerStage: 22 }));
  const assessment = evaluateTrader(ideas, context("traditional", 3, { calibrationPassed: true }), calibrated("traditional"));
  assert.equal(assessment.state, "PROFITABILITY_CONFIRMED");
  assert.equal(deriveAlerts("HIGH_POTENTIAL", assessment)[0]?.type, "PROFITABILITY_CONFIRMED");
});

test("Futures confirmation uses the tighter drawdown and two-stage policy", () => {
  const ideas = collapseTradeIdeas(rawTrades({ challenge: "futures", stages: [1, 2], countPerStage: 30, symbols: ["MESZ6", "MGCZ6", "MCLZ6"] }));
  const assessment = evaluateTrader(ideas, context("futures", 2, { calibrationPassed: true }), calibrated("futures"));
  assert.equal(assessment.state, "PROFITABILITY_CONFIRMED");
  assert.equal(assessment.policyKey, "futures_detector");
});

test("PAC cannot be confirmed without disclosed, replicated, stress-tested evidence", () => {
  const ideas = collapseTradeIdeas(rawTrades({ challenge: "pac", stages: [1], countPerStage: 70 }));
  const assessment = evaluateTrader(ideas, context("pac", 1, { calibrationPassed: true }), calibrated("pac"));
  assert.equal(assessment.state, "HIGH_POTENTIAL");
  assert.ok(assessment.gates.some((gate) => gate.key === "pac_validation" && gate.status === "FAIL"));
});

test("catastrophic tail losses block a high win-rate trader", () => {
  const ideas = collapseTradeIdeas(rawTrades({
    challenge: "traditional", stages: [1, 2, 3], countPerStage: 20,
    pnl: (i) => i % 20 === 19 ? -900 : 55,
  }));
  const assessment = evaluateTrader(ideas, context("traditional", 3, { calibrationPassed: true }), calibrated("traditional"));
  assert.notEqual(assessment.state, "PROFITABILITY_CONFIRMED");
  assert.ok(assessment.gates.some((gate) => gate.key === "tail_risk" && gate.status === "FAIL"));
});

test("live review alert requires copyability, provider, reserve, and portfolio gates", () => {
  const ideas = collapseTradeIdeas(rawTrades({ challenge: "traditional", stages: [1, 2, 3], countPerStage: 24 }));
  const assessment = evaluateTrader(ideas, context("traditional", 3, {
    calibrationPassed: true, providerAuthorised: true, reserveCapacityAvailable: true, copyabilityVerified: true,
    portfolioCorrelation: 0.2,
    copyability: { shadowIdeas: 50, fillRate: 0.99, rejectRate: 0.001, medianSlippageBps: 0.05, p95LatencyMs: 200, sourceNetPnl: 10_000, destinationNetPnl: 9_800 },
  }), calibrated("traditional"));
  assert.equal(assessment.state, "LIVE_REVIEW_REQUIRED");
  const alert = deriveAlerts("PROFITABILITY_CONFIRMED", assessment)[0]!;
  assert.equal(alert.type, "LIVE_REVIEW_REQUIRED");
  assert.equal(alert.severity, "critical");
  assert.equal(assessment.liveEnabled, false);
});

test("critical flags fail closed and produce deterioration alerts", () => {
  const ideas = collapseTradeIdeas(rawTrades({ challenge: "infinity", stages: [1, 2, 3], countPerStage: 20 }));
  const assessment = evaluateTrader(ideas, context("infinity", 3, { unresolvedCriticalFlags: 1 }), DEFAULT_SHADOW_POLICIES.infinity);
  assert.equal(assessment.state, "RISK_NO_GO");
  assert.equal(deriveAlerts("HIGH_POTENTIAL", assessment)[0]?.type, "RISK_DETERIORATION");
});

test("one crowded winning day followed by 29 losing days cannot produce an alert", () => {
  const trades = rawTrades({ challenge: "traditional", stages: [1], countPerStage: 129, pnl: (i) => i < 100 ? 10 : -1 });
  for (const [i, trade] of trades.entries()) {
    const day = i < 100 ? 1 : i - 98;
    trade.symbol = `SYMBOL${i}`;
    trade.openedAt = new Date(Date.UTC(2026, 0, day, 8));
    trade.closedAt = new Date(Date.UTC(2026, 0, day, 9));
  }
  const result = evaluateTrader(collapseTradeIdeas(trades), context("traditional", 1), DEFAULT_SHADOW_POLICIES.traditional);
  assert.equal(result.state, "OBSERVE");
  assert.equal(result.metrics.inferenceUnit, "UTC_TRADING_DAY");
  assert.equal(result.metrics.bestDayProfitShare, 1);
  assert.equal(result.metrics.recentMeanBps, -1);
  assert.ok(result.metrics.probabilityEdgePositive! < 0.9);
  assert.deepEqual(deriveAlerts(null, result), []);
});

test("splitting daily PnL among symbols cannot increase posterior confidence", () => {
  const trades = rawTrades({ challenge: "traditional", stages: [1, 2, 3], countPerStage: 24 });
  const split = trades.flatMap((trade) => Array.from({ length: 10 }, (_,part) => ({
    ...trade, id: `${trade.id}-${part}`, symbol: `PART${part}`, pnl: trade.pnl / 10,
  })));
  const base = evaluateTrader(collapseTradeIdeas(trades), context("traditional", 3), DEFAULT_SHADOW_POLICIES.traditional);
  const crowded = evaluateTrader(collapseTradeIdeas(split), context("traditional", 3), DEFAULT_SHADOW_POLICIES.traditional);
  assert.equal(crowded.state, base.state);
  assert.ok(Math.abs(crowded.metrics.posteriorMeanBps! - base.metrics.posteriorMeanBps!) < 1e-10);
  assert.ok(Math.abs(crowded.metrics.probabilityEdgePositive! - base.metrics.probabilityEdgePositive!) < 1e-10);
  assert.equal(crowded.metrics.effectiveSampleSize, base.metrics.effectiveSampleSize);
  assert.equal(crowded.metrics.bestDayProfitShare, base.metrics.bestDayProfitShare);
});

test("a token profitable phase does not establish cross-phase repeatability", () => {
  const trades = rawTrades({ challenge: "traditional", stages: [1], countPerStage: 70 });
  trades.push(...rawTrades({ challenge: "traditional", stages: [2, 3], countPerStage: 1, startDay: 75, pnl: () => 1 }));
  const result = evaluateTrader(collapseTradeIdeas(trades), context("traditional", 3, { calibrationPassed: true }), calibrated("traditional"));
  assert.equal(result.metrics.positiveStages, 1);
  assert.notEqual(result.state, "PROFITABILITY_CONFIRMED");
  assert.ok(result.gates.some((gate) => gate.key === "positive_stages" && gate.status === "FAIL"));
});

test("a token regime label does not establish regime coverage", () => {
  const trades = rawTrades({ challenge: "traditional", stages: [1, 2, 3], countPerStage: 24, regimes: ["LOW_VOL"] });
  trades[0]!.regime = "HIGH_VOL";
  const result = evaluateTrader(collapseTradeIdeas(trades), context("traditional", 3, { calibrationPassed: true }), calibrated("traditional"));
  assert.equal(result.metrics.regimesObserved, 1);
  assert.equal(result.state, "HIGH_POTENTIAL");
  assert.ok(result.gates.some((gate) => gate.key === "regime_coverage" && gate.status === "FAIL"));
});

test("unverified accounting cannot produce a high-potential alert", () => {
  const trades = rawTrades({ challenge: "traditional", stages: [1, 2, 3], countPerStage: 24 });
  trades[0]!.pnlBasis = undefined;
  const result = evaluateTrader(collapseTradeIdeas(trades), context("traditional", 3), DEFAULT_SHADOW_POLICIES.traditional);
  assert.equal(result.state, "OBSERVE");
  assert.deepEqual(deriveAlerts(null, result), []);
});

test("invalid losing evidence cannot be silently discarded", () => {
  const trades = rawTrades({ challenge: "traditional", stages: [1], countPerStage: 20 });
  trades[0]!.closedAt = new Date("invalid");
  trades[0]!.pnl = -1_000;
  assert.throws(() => collapseTradeIdeas(trades), /INVALID_SOURCE_TRADE/);
});

test("duplicate raw trades and duplicate direct ideas fail closed", () => {
  const trades = rawTrades({ challenge: "traditional", stages: [1], countPerStage: 20 });
  assert.throws(() => collapseTradeIdeas([...trades, trades[0]!]), /DUPLICATE_SOURCE_TRADE/);
  const ideas = collapseTradeIdeas(trades);
  const result = evaluateTrader([...ideas, ideas[0]!], context("traditional", 1), DEFAULT_SHADOW_POLICIES.traditional);
  assert.equal(result.state, "RISK_NO_GO");
});

test("gross accounting uses signed costs and does not double-charge net PnL", () => {
  const [trade] = rawTrades({ challenge: "traditional", stages: [1], countPerStage: 1, pnl: () => 20 });
  const gross = collapseTradeIdeas([{ ...trade!, pnlBasis: "GROSS_BEFORE_COSTS", commission: -3, financing: -2 }]);
  const net = collapseTradeIdeas([{ ...trade!, pnlBasis: "NET_AFTER_COSTS", commission: -3, financing: -2 }]);
  assert.equal(gross[0]!.netPnl, 15);
  assert.equal(net[0]!.netPnl, 20);
});

test("calibration does not relabel the descriptive posterior as a future probability", () => {
  const ideas = collapseTradeIdeas(rawTrades({ challenge: "traditional", stages: [1, 2, 3], countPerStage: 24 }));
  const result = evaluateTrader(ideas, context("traditional", 3, { calibrationPassed: true, calibratedProbability: 0.1 }), calibrated("traditional"));
  assert.equal(result.metrics.probabilityStatus, "DESCRIPTIVE_UNCALIBRATED");
  assert.equal(result.metrics.calibratedFutureProbability, 0.1);
  assert.equal(result.state, "HIGH_POTENTIAL");
});

test("legacy policy units cannot be silently interpreted as daily thresholds", () => {
  assert.throws(() => evaluateTrader([], context("traditional", 3), {
    ...DEFAULT_SHADOW_POLICIES.traditional, inferenceUnit: undefined,
  } as unknown as DetectorPolicy), /UNSUPPORTED_INFERENCE_UNIT/);
  assert.equal(DEFAULT_SHADOW_POLICIES.traditional.version, 2);
});
