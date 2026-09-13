// IPFX Capital challenge-specific trader detector.
//
// This module is deliberately deterministic, dependency-free, and shared by
// the Supabase worker and the owner-dashboard test suite. It recommends review
// states only. It cannot enable live copying, deny a payout, or modify challenge
// rules. Default policies are SHADOW_UNCALIBRATED until prospective validation.

export type ChallengeType = "infinity" | "traditional" | "futures" | "pac";
export type DetectorState =
  | "INSUFFICIENT_EVIDENCE"
  | "OBSERVE"
  | "HIGH_POTENTIAL"
  | "PROFITABILITY_CONFIRMED"
  | "LIVE_REVIEW_REQUIRED"
  | "RISK_NO_GO";

export type GateStatus = "PASS" | "FAIL" | "UNKNOWN";

export interface RawDetectorTrade {
  id: string;
  accountId: string;
  stage: number;
  symbol: string;
  side: "buy" | "sell";
  openedAt: Date;
  closedAt: Date;
  pnl: number;
  /** Fill-based PnL; execution shortfall is diagnostic, never charged twice. */
  pnlBasis?: "NET_AFTER_COSTS" | "GROSS_BEFORE_COSTS";
  startingBalance: number;
  commission?: number;
  financing?: number;
  executionShortfall?: number;
  session?: string;
  regime?: string | null;
}

export interface DetectorIdea {
  id: string;
  accountId?: string;
  accountingVerified?: boolean;
  sourceTradeIds: string[];
  stage: number;
  cluster: string;
  side: "buy" | "sell";
  openedAt: Date;
  closedAt: Date;
  netPnl: number;
  returnBps: number;
  session: string;
  regime: string | null;
}

export interface CopyabilityEvidence {
  shadowIdeas: number;
  fillRate: number;
  rejectRate: number;
  medianSlippageBps: number;
  p95LatencyMs: number;
  sourceNetPnl: number;
  destinationNetPnl: number;
}

export interface PacValidationEvidence {
  strategyDisclosed: boolean;
  trackRecordVerified: boolean;
  outOfSampleReplicated: boolean;
  stressTestPassed: boolean;
}

export interface DetectorContext {
  challengeType: ChallengeType;
  currentStage: number;
  accountStatus: "active" | "passed" | "breached";
  dataQuality: number;
  unresolvedSevereFlags: number;
  unresolvedCriticalFlags: number;
  ruleBreach: boolean;
  regimeDataAvailable: boolean;
  calibrationPassed: boolean;
  /** Reconciled equity including open positions and cash transfers. */
  markToMarketRiskVerified?: boolean;
  ruleSnapshotVerified?: boolean;
  tradeStageVerified?: boolean;
  calibrationEvidenceVerified?: boolean;
  /** Held-out empirical prediction for the declared future outcome, not the posterior below. */
  calibratedProbability?: number;
  calibratedForecastId?: string;
  providerAuthorised: boolean;
  reserveCapacityAvailable: boolean;
  portfolioCorrelation: number | null;
  copyability: CopyabilityEvidence | null;
  copyabilityVerified?: boolean;
  pacValidation?: PacValidationEvidence;
}

export interface DetectorPolicy {
  key: string;
  version: number;
  inferenceUnit: "UTC_TRADING_DAY";
  challengeType: ChallengeType;
  calibrated: boolean;
  minPotentialEss: number;
  minPotentialDays: number;
  minPotentialProbability: number;
  minConfirmedEss: number;
  minConfirmedDays: number;
  minConfirmedProbability: number;
  minConfirmedEdgeBps: number;
  minConfirmedStage: number;
  minPositiveStages: number;
  minRegimes: number;
  minStageDays?: number;
  minRegimeDays?: number;
  maxSymbolHhi: number;
  maxBestIdeaShare: number;
  maxDrawdownFraction: number;
  maxTailLossMultiple: number;
  maxPortfolioCorrelation: number;
  minCopyIdeas: number;
  minCopyability: number;
  priorMeanBps: number;
  priorStdBps: number;
}

export interface DetectorGate {
  key: string;
  status: GateStatus;
  observed: number | boolean | string | null;
  required: number | boolean | string;
  explanation: string;
}

export interface DetectorMetrics {
  independentIdeas: number;
  inferenceUnit: "UTC_TRADING_DAY";
  activeTradingDays: number;
  effectiveSampleSize: number;
  meanReturnBps: number | null;
  posteriorMeanBps: number | null;
  posteriorSdBps: number | null;
  lower90Bps: number | null;
  probabilityEdgePositive: number | null;
  probabilityTarget: "MEAN_NET_EDGE_ABOVE_FLOOR";
  calibratedFutureProbability: number | null;
  calibratedForecastId: string | null;
  predictiveProbabilityStatus: "UNAVAILABLE" | "CALIBRATED";
  probabilityStatus: "INSUFFICIENT_EVIDENCE" | "DESCRIPTIVE_UNCALIBRATED" | "CALIBRATED";
  maxDrawdownFraction: number | null;
  expectedShortfall95Bps: number | null;
  tailLossMultiple: number | null;
  bestIdeaProfitShare: number | null;
  bestDayProfitShare: number | null;
  symbolHhi: number | null;
  positiveStages: number;
  totalStagesObserved: number;
  regimesObserved: number;
  lateVsEarlyMeanBps: number | null;
  recentMeanBps: number | null;
  copyabilityScore: number | null;
}

export interface DetectorAssessment {
  state: DetectorState;
  policyKey: string;
  policyVersion: number;
  challengeType: ChallengeType;
  metrics: DetectorMetrics;
  gates: DetectorGate[];
  reasons: string[];
  liveEnabled: false;
}

export interface DetectorAlert {
  type: "HIGH_POTENTIAL" | "PROFITABILITY_CONFIRMED" | "LIVE_REVIEW_REQUIRED" | "RISK_DETERIORATION";
  severity: "medium" | "high" | "critical";
  title: string;
  body: string;
}

const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * a);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
  return 0.5 * (1 + erf);
}

function percentile(values: number[], probability: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function utcSession(date: Date): string {
  const hour = date.getUTCHours();
  if (hour < 7) return "ASIA";
  if (hour < 13) return "LONDON";
  if (hour < 21) return "NEW_YORK";
  return "OVERNIGHT";
}

export function riskCluster(symbol: string): string {
  const value = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const futures = value.match(/^([A-Z]{1,4})[FGHJKMNQUVXZ]\d{1,4}$/);
  if (futures) return futures[1]!;
  return value;
}

/** Collapse overlapping same-thesis positions into independent ideas. */
export function collapseTradeIdeas(trades: RawDetectorTrade[], cooldownHours = 8): DetectorIdea[] {
  if (!Number.isFinite(cooldownHours) || cooldownHours < 0) throw new Error("INVALID_IDEA_COOLDOWN");
  const sourceIds = new Set<string>();
  for (const trade of trades) {
    if (sourceIds.has(trade.id)) throw new Error("DUPLICATE_SOURCE_TRADE");
    sourceIds.add(trade.id);
  }
  const valid = trades.filter((trade) =>
    trade.id && Number.isFinite(trade.startingBalance) && trade.startingBalance > 0 && Number.isFinite(trade.pnl) &&
    Boolean(trade.accountId) && Number.isInteger(trade.stage) && trade.stage > 0 &&
    typeof trade.symbol === "string" && Boolean(riskCluster(trade.symbol)) && ["buy", "sell"].includes(trade.side) &&
    trade.openedAt instanceof Date && trade.closedAt instanceof Date &&
    [trade.commission, trade.financing, trade.executionShortfall].every((value) => value === undefined || Number.isFinite(value)) &&
    Number.isFinite(trade.openedAt.getTime()) && Number.isFinite(trade.closedAt.getTime()) &&
    trade.closedAt >= trade.openedAt
  ).sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime() || a.id.localeCompare(b.id));
  if (valid.length !== trades.length) throw new Error("INVALID_SOURCE_TRADE");

  const ideas: DetectorIdea[] = [];
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  for (const trade of valid) {
    const cluster = riskCluster(trade.symbol);
    if (ideas.some((idea) => idea.accountId === trade.accountId && idea.sourceTradeIds.includes(trade.id))) continue;
    const previous = [...ideas].reverse().find((idea) => idea.accountId === trade.accountId && idea.stage === trade.stage && idea.cluster === cluster);
    const canMerge = previous && trade.openedAt.getTime() <= previous.closedAt.getTime() + cooldownMs;
    // Cost fields are signed cashflows: a charge is negative, a rebate positive.
    // Unknown legacy basis remains descriptive and cannot confirm profitability.
    const accountingVerified = trade.pnlBasis === "NET_AFTER_COSTS" ||
      (trade.pnlBasis === "GROSS_BEFORE_COSTS" && Number.isFinite(trade.commission) && Number.isFinite(trade.financing));
    const netPnl = trade.pnlBasis === "GROSS_BEFORE_COSTS"
      ? trade.pnl + (Number.isFinite(trade.commission) ? trade.commission! : 0) + (Number.isFinite(trade.financing) ? trade.financing! : 0)
      : trade.pnl;
    if (canMerge) {
      previous.sourceTradeIds.push(trade.id);
      previous.closedAt = new Date(Math.max(previous.closedAt.getTime(), trade.closedAt.getTime()));
      previous.netPnl += netPnl;
      previous.accountingVerified = previous.accountingVerified === true && accountingVerified;
      previous.returnBps += (netPnl / trade.startingBalance) * 10_000;
      previous.stage = Math.max(previous.stage, trade.stage);
      if (previous.regime !== trade.regime) previous.regime = null;
      continue;
    }
    ideas.push({
      id: `idea:${trade.id}`,
      accountId: trade.accountId,
      accountingVerified,
      sourceTradeIds: [trade.id],
      stage: trade.stage,
      cluster,
      side: trade.side,
      openedAt: trade.openedAt,
      closedAt: trade.closedAt,
      netPnl,
      returnBps: (netPnl / trade.startingBalance) * 10_000,
      session: trade.session ?? utcSession(trade.openedAt),
      regime: trade.regime ?? null,
    });
  }
  return ideas;
}

export function effectiveSampleSize(values: number[], maxLag = 10): number {
  if (values.length < 3) return values.length;
  const m = mean(values);
  const c0 = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length;
  if (c0 <= 1e-12) return values.length;
  let sumPositiveRho = 0;
  for (let lag = 1; lag <= Math.min(maxLag, values.length - 2); lag++) {
    let covariance = 0;
    for (let i = 0; i < values.length - lag; i++) covariance += (values[i]! - m) * (values[i + lag]! - m);
    const rho = covariance / ((values.length - lag) * c0);
    // Alternating returns may hide dependence at lag 2 or later.
    sumPositiveRho += Math.max(0, rho) * (1 - lag / (maxLag + 1));
  }
  return Math.max(1, Math.min(values.length, values.length / (1 + 2 * sumPositiveRho)));
}

function copyabilityScore(evidence: CopyabilityEvidence | null): number | null {
  if (!evidence || evidence.shadowIdeas <= 0 || evidence.sourceNetPnl <= 0) return null;
  if (!Object.values(evidence).every(Number.isFinite) || evidence.fillRate < 0 || evidence.fillRate > 1 ||
    evidence.rejectRate < 0 || evidence.rejectRate > 1 || evidence.p95LatencyMs < 0) return null;
  const pnlRetention = clamp(evidence.destinationNetPnl / evidence.sourceNetPnl);
  const executionPenalty = Math.exp(-Math.max(0, evidence.medianSlippageBps) / 4) *
    Math.exp(-Math.max(0, evidence.p95LatencyMs - 250) / 1500);
  return clamp(evidence.fillRate * (1 - evidence.rejectRate) * pnlRetention * executionPenalty);
}

/** Equal-weight concurrent accounts, then aggregate all ideas sharing a market day.
 * Trade count and symbol aliases cannot manufacture independent observations.
 * These are closed-PnL daily blocks; reconciled equity remains a separate gate. */
function dailyBlocks(ideas: DetectorIdea[]): number[] {
  const days = new Map<string, Map<string, number>>();
  for (const idea of ideas) {
    const day = idea.closedAt.toISOString().slice(0, 10);
    const accounts = days.get(day) ?? new Map<string, number>();
    const account = idea.accountId ?? `stage:${idea.stage}`;
    accounts.set(account, (accounts.get(account) ?? 0) + idea.returnBps);
    days.set(day, accounts);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([, accounts]) => mean([...accounts.values()]));
}

function calculateMetrics(ideas: DetectorIdea[], context: DetectorContext, policy: DetectorPolicy): DetectorMetrics {
  const returns = dailyBlocks(ideas);
  if (!returns.length) {
    return {
      independentIdeas: 0, inferenceUnit: "UTC_TRADING_DAY", activeTradingDays: 0, effectiveSampleSize: 0,
      meanReturnBps: null, posteriorMeanBps: null, posteriorSdBps: null,
      lower90Bps: null, probabilityEdgePositive: null,
      probabilityTarget: "MEAN_NET_EDGE_ABOVE_FLOOR", calibratedFutureProbability: null, calibratedForecastId: null, predictiveProbabilityStatus: "UNAVAILABLE",
      probabilityStatus: "INSUFFICIENT_EVIDENCE", maxDrawdownFraction: null,
      expectedShortfall95Bps: null, tailLossMultiple: null,
      bestIdeaProfitShare: null, bestDayProfitShare: null, symbolHhi: null, positiveStages: 0,
      totalStagesObserved: 0, regimesObserved: 0, lateVsEarlyMeanBps: null, recentMeanBps: null,
      copyabilityScore: copyabilityScore(context.copyability),
    };
  }

  const ess = effectiveSampleSize(returns);
  const observedMean = mean(returns);
  // A constant short run is not evidence of zero risk. Use a conservative
  // heuristic variance floor so identical early wins cannot create an
  // absurdly certain posterior.
  const observedVariance = Math.max(variance(returns), (policy.priorStdBps ** 2) * 0.25);
  const priorVariance = policy.priorStdBps ** 2;
  const posteriorPrecision = ess / observedVariance + 1 / priorVariance;
  const posteriorVariance = 1 / posteriorPrecision;
  const posteriorMean = ((ess * observedMean) / observedVariance + policy.priorMeanBps / priorVariance) / posteriorPrecision;
  const posteriorSd = Math.sqrt(posteriorVariance);
  const lower90 = posteriorMean - 1.644853626951 * posteriorSd;
  const probability = normalCdf((posteriorMean - policy.minConfirmedEdgeBps) / posteriorSd);

  let maxDrawdown = 0;
  const equityByAccount = new Map<string, { equity: number; peak: number }>();
  for (const idea of [...ideas].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime())) {
    const key = idea.accountId ?? `stage:${idea.stage}`;
    const curve = equityByAccount.get(key) ?? { equity: 1, peak: 1 };
    // Returns use fixed initial capital, so add; compounding invents capital.
    curve.equity += idea.returnBps / 10_000;
    curve.peak = Math.max(curve.peak, curve.equity);
    maxDrawdown = Math.max(maxDrawdown, Math.min(1, (curve.peak - curve.equity) / curve.peak));
    equityByAccount.set(key, curve);
  }

  const worstCount = Math.max(1, Math.ceil(returns.length * 0.05));
  const expectedShortfall = Math.max(0, -mean([...returns].sort((a, b) => a - b).slice(0, worstCount)));
  const positives = returns.filter((value) => value > 0);
  const negatives = returns.filter((value) => value < 0);
  const grossPositive = positives.reduce((sum, value) => sum + value, 0);
  const bestDayShare = grossPositive > 0 ? Math.max(...positives) / grossPositive : null;
  const positiveIdeas = ideas.map((idea) => idea.returnBps).filter((value) => value > 0);
  const grossIdeaPositive = positiveIdeas.reduce((sum, value) => sum + value, 0);
  const bestIdeaShare = grossIdeaPositive > 0 ? Math.max(...positiveIdeas) / grossIdeaPositive : null;
  const tailLossMultiple = positives.length && negatives.length
    ? Math.abs(mean(negatives.filter((value) => value <= percentile(negatives, 0.1)))) / Math.max(mean(positives), 1e-6)
    : null;

  const counts = new Map<string, number>();
  for (const idea of ideas) counts.set(idea.cluster, (counts.get(idea.cluster) ?? 0) + 1);
  const hhi = [...counts.values()].reduce((sum, count) => sum + (count / ideas.length) ** 2, 0);
  const activeDays = new Set(ideas.map((idea) => idea.closedAt.toISOString().slice(0, 10))).size;
  const byStage = new Map<number, DetectorIdea[]>();
  const byRegime = new Map<string, DetectorIdea[]>();
  for (const idea of ideas) {
    byStage.set(idea.stage, [...(byStage.get(idea.stage) ?? []), idea]);
    if (idea.regime) byRegime.set(idea.regime, [...(byRegime.get(idea.regime) ?? []), idea]);
  }
  const positiveStages = [...byStage.values()].map(dailyBlocks)
    .filter((blocks) => blocks.length >= (policy.minStageDays ?? 5) && mean(blocks) > 0).length;
  const regimesObserved = context.regimeDataAvailable ? [...byRegime.values()].map(dailyBlocks)
    .filter((blocks) => blocks.length >= (policy.minRegimeDays ?? 5) && mean(blocks) > 0).length : 0;
  const midpoint = Math.floor(returns.length / 2);
  const lateVsEarly = midpoint >= 3 ? mean(returns.slice(midpoint)) - mean(returns.slice(0, midpoint)) : null;

  return {
    independentIdeas: ideas.length,
    inferenceUnit: "UTC_TRADING_DAY",
    activeTradingDays: activeDays,
    effectiveSampleSize: ess,
    meanReturnBps: observedMean,
    posteriorMeanBps: posteriorMean,
    posteriorSdBps: posteriorSd,
    lower90Bps: lower90,
    probabilityEdgePositive: probability,
    probabilityTarget: "MEAN_NET_EDGE_ABOVE_FLOOR",
    calibratedFutureProbability: context.calibrationEvidenceVerified === true && Number.isFinite(context.calibratedProbability) && context.calibratedProbability! >= 0 && context.calibratedProbability! <= 1 ? context.calibratedProbability! : null,
    calibratedForecastId: context.calibratedForecastId ?? null,
    predictiveProbabilityStatus: context.calibrationEvidenceVerified === true && Boolean(context.calibratedForecastId) && Number.isFinite(context.calibratedProbability) && context.calibratedProbability! >= 0 && context.calibratedProbability! <= 1 && context.calibrationPassed && policy.calibrated ? "CALIBRATED" : "UNAVAILABLE",
    probabilityStatus: "DESCRIPTIVE_UNCALIBRATED",
    maxDrawdownFraction: maxDrawdown,
    expectedShortfall95Bps: expectedShortfall,
    tailLossMultiple,
    bestIdeaProfitShare: bestIdeaShare,
    bestDayProfitShare: bestDayShare,
    symbolHhi: hhi,
    positiveStages,
    totalStagesObserved: byStage.size,
    regimesObserved,
    lateVsEarlyMeanBps: lateVsEarly,
    recentMeanBps: returns.length >= 6 ? mean(returns.slice(-Math.min(20, Math.max(5, Math.floor(returns.length / 3))))) : null,
    copyabilityScore: copyabilityScore(context.copyability),
  };
}

function gate(key: string, status: GateStatus, observed: DetectorGate["observed"], required: DetectorGate["required"], explanation: string): DetectorGate {
  return { key, status, observed, required, explanation };
}

export function evaluateTrader(ideas: DetectorIdea[], context: DetectorContext, policy: DetectorPolicy): DetectorAssessment {
  if (policy.challengeType !== context.challengeType) throw new Error("policy challenge type does not match account");
  if (policy.inferenceUnit !== "UTC_TRADING_DAY") throw new Error("UNSUPPORTED_INFERENCE_UNIT");
  if (!Object.values(policy).every((value) => typeof value !== "number" || Number.isFinite(value)) ||
    policy.priorStdBps <= 0 || policy.minPotentialEss < 1 || policy.minConfirmedEss < policy.minPotentialEss ||
    policy.minPotentialDays < 1 || policy.minConfirmedDays < 1 ||
    [policy.minPotentialProbability, policy.minConfirmedProbability, policy.maxBestIdeaShare,
      policy.maxDrawdownFraction, policy.minCopyability].some((value) => value < 0 || value > 1)) {
    throw new Error("INVALID_DETECTOR_POLICY");
  }
  const ideaIds = new Set<string>();
  const sourceIds = new Set<string>();
  let duplicateEvidence = false;
  for (const idea of ideas) {
    if (ideaIds.has(idea.id)) duplicateEvidence = true;
    ideaIds.add(idea.id);
    for (const id of idea.sourceTradeIds ?? []) {
      if (sourceIds.has(id)) duplicateEvidence = true;
      sourceIds.add(id);
    }
  }
  const validIdeas = ideas.filter((idea) => Number.isFinite(idea.returnBps) && Number.isFinite(idea.netPnl) &&
    Boolean(idea.id) && Boolean(idea.cluster) && Number.isInteger(idea.stage) && idea.stage > 0 &&
    ["buy", "sell"].includes(idea.side) && Array.isArray(idea.sourceTradeIds) && idea.sourceTradeIds.length > 0 &&
    idea.sourceTradeIds.every((id) => typeof id === "string" && Boolean(id)) &&
    idea.openedAt instanceof Date && idea.closedAt instanceof Date &&
    Number.isFinite(idea.openedAt.getTime()) && Number.isFinite(idea.closedAt.getTime()) && idea.closedAt >= idea.openedAt)
    .sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime() || a.id.localeCompare(b.id));
  const invalidEvidence = duplicateEvidence || validIdeas.length !== ideas.length || !Number.isFinite(context.dataQuality) || context.dataQuality < 0 || context.dataQuality > 1 ||
    !Number.isInteger(context.currentStage) || context.currentStage < 1 ||
    ![context.unresolvedSevereFlags, context.unresolvedCriticalFlags].every((count) => Number.isInteger(count) && count >= 0) ||
    !["active", "passed", "breached"].includes(context.accountStatus);
  const metrics = calculateMetrics(validIdeas, context, policy);
  const reasons: string[] = [];
  const severeRisk = invalidEvidence || context.accountStatus === "breached" || context.ruleBreach || context.unresolvedCriticalFlags > 0 || context.unresolvedSevereFlags > 0 || context.dataQuality < 0.5;
  const stageReady = context.currentStage >= policy.minConfirmedStage;
  const positiveStagesReady = metrics.positiveStages >= policy.minPositiveStages;
  const regimesReady = context.regimeDataAvailable && metrics.regimesObserved >= policy.minRegimes;
  // A specialist is not unskilled because they trade one instrument. Exposure
  // concentration belongs in portfolio sizing; single-win dependence does not.
  const concentrationReady = (metrics.bestDayProfitShare ?? 1) <= policy.maxBestIdeaShare;
  const stabilityReady = metrics.recentMeanBps !== null && metrics.recentMeanBps > 0 && metrics.lateVsEarlyMeanBps !== null &&
    metrics.posteriorMeanBps !== null && metrics.lateVsEarlyMeanBps >= -Math.max(5, Math.abs(metrics.posteriorMeanBps) * 1.5);
  const tailReady = (metrics.maxDrawdownFraction ?? 1) <= policy.maxDrawdownFraction &&
    (metrics.tailLossMultiple === null || metrics.tailLossMultiple <= policy.maxTailLossMultiple);
  const pacReady = context.challengeType !== "pac" || Boolean(
    context.pacValidation?.strategyDisclosed && context.pacValidation.trackRecordVerified &&
    context.pacValidation.outOfSampleReplicated && context.pacValidation.stressTestPassed
  );
  const decisionQualityReady = context.dataQuality >= 0.8;
  const accountingReady = validIdeas.length > 0 && validIdeas.every((idea) => idea.accountingVerified === true);
  const equityRiskReady = context.markToMarketRiskVerified === true;
  const ruleReady = context.ruleSnapshotVerified === true && context.tradeStageVerified === true;
  const validationReady = metrics.predictiveProbabilityStatus === "CALIBRATED";

  const gates: DetectorGate[] = [
    gate("accounting_basis", accountingReady ? "PASS" : "UNKNOWN", accountingReady, true, "Reconcile signed costs and establish whether source PnL already includes them."),
    gate("mark_to_market_risk", equityRiskReady ? "PASS" : "UNKNOWN", equityRiskReady, true, "Closed trades cannot establish floating drawdown or open-position tail risk."),
    gate("rule_snapshot", context.ruleSnapshotVerified === true ? "PASS" : "UNKNOWN", context.ruleSnapshotVerified === true, true, "The exact contractual rule version must be reconciled."),
    gate("trade_stage_provenance", context.tradeStageVerified === true ? "PASS" : "UNKNOWN", context.tradeStageVerified === true, true, "Historical phases must be established as of each trade."),
    gate("validation_evidence", validationReady ? "PASS" : "UNKNOWN", metrics.calibratedFutureProbability, policy.minConfirmedProbability, "Requires an independently validated future-outcome prediction. The descriptive mean-edge posterior is not this probability."),
    gate("data_quality", context.dataQuality >= 0.8 ? "PASS" : context.dataQuality >= 0.5 ? "UNKNOWN" : "FAIL", context.dataQuality, ">=0.80", "Clean, reconciled data is required for decision-grade evidence."),
    gate("no_critical_risk", severeRisk ? "FAIL" : "PASS", !severeRisk, true, "Rule breaches, critical flags, or invalid data stop progression."),
    gate("potential_effective_evidence", metrics.effectiveSampleSize >= policy.minPotentialEss ? "PASS" : "FAIL", metrics.effectiveSampleSize, policy.minPotentialEss, "Correlated trades count less than independent decisions."),
    gate("confirmed_effective_evidence", metrics.effectiveSampleSize >= policy.minConfirmedEss ? "PASS" : "FAIL", metrics.effectiveSampleSize, policy.minConfirmedEss, "Confirmation requires a larger effective sample."),
    gate("confirmed_days", metrics.activeTradingDays >= policy.minConfirmedDays ? "PASS" : "FAIL", metrics.activeTradingDays, policy.minConfirmedDays, "Evidence must span enough active days."),
    gate("challenge_stage", stageReady ? "PASS" : "FAIL", context.currentStage, policy.minConfirmedStage, "Challenge-specific progression must demonstrate repeatability."),
    gate("positive_stages", positiveStagesReady ? "PASS" : "FAIL", metrics.positiveStages, policy.minPositiveStages, `Each positive stage needs at least ${policy.minStageDays ?? 5} trading days; token winning trades do not establish repeatability.`),
    gate("regime_coverage", regimesReady ? "PASS" : context.regimeDataAvailable ? "FAIL" : "UNKNOWN", metrics.regimesObserved, policy.minRegimes, `Each supported positive regime needs at least ${policy.minRegimeDays ?? 5} trading days. Labels alone are not evidence.`),
    gate("concentration", concentrationReady ? "PASS" : "FAIL", metrics.bestDayProfitShare, policy.maxBestIdeaShare, "One market day's profit must not explain the record. Splitting it across tickets or symbols does not create diversification."),
    gate("stability", stabilityReady ? "PASS" : "FAIL", metrics.lateVsEarlyMeanBps, "no material recent collapse", "Recent performance is compared with earlier performance."),
    gate("tail_risk", tailReady ? "PASS" : "FAIL", metrics.maxDrawdownFraction, `DD<=${policy.maxDrawdownFraction}; tail multiple<=${policy.maxTailLossMultiple}`, "Martingale-like and catastrophic-loss profiles are rejected."),
    gate("pac_validation", pacReady ? "PASS" : context.challengeType === "pac" ? "FAIL" : "PASS", pacReady, true, "PAC requires verified track record, disclosure, holdout replication, and stress testing."),
    gate("calibration", context.calibrationPassed && policy.calibrated ? "PASS" : "FAIL", context.calibrationPassed && policy.calibrated, true, "Only prospectively calibrated policies may confirm profitability."),
  ];

  if (severeRisk) {
    reasons.push("RISK_OR_DATA_HARD_STOP");
    return { state: "RISK_NO_GO", policyKey: policy.key, policyVersion: policy.version, challengeType: context.challengeType, metrics, gates, reasons, liveEnabled: false };
  }
  if (metrics.independentIdeas === 0 || metrics.activeTradingDays === 0) {
    reasons.push("NO_CLOSED_INDEPENDENT_IDEAS");
    return { state: "INSUFFICIENT_EVIDENCE", policyKey: policy.key, policyVersion: policy.version, challengeType: context.challengeType, metrics, gates, reasons, liveEnabled: false };
  }

  const potential = metrics.effectiveSampleSize >= policy.minPotentialEss &&
    metrics.activeTradingDays >= policy.minPotentialDays &&
    (metrics.probabilityEdgePositive ?? 0) >= policy.minPotentialProbability &&
    (metrics.posteriorMeanBps ?? -Infinity) > 0 && tailReady && concentrationReady && stabilityReady && accountingReady && decisionQualityReady;
  if (!potential) {
    reasons.push("COLLECT_MORE_INDEPENDENT_EVIDENCE");
    return { state: "OBSERVE", policyKey: policy.key, policyVersion: policy.version, challengeType: context.challengeType, metrics, gates, reasons, liveEnabled: false };
  }

  const confirmedEvidence = metrics.effectiveSampleSize >= policy.minConfirmedEss &&
    metrics.activeTradingDays >= policy.minConfirmedDays &&
    (metrics.calibratedFutureProbability ?? 0) >= policy.minConfirmedProbability &&
    (metrics.lower90Bps ?? -Infinity) >= policy.minConfirmedEdgeBps &&
    stageReady && positiveStagesReady && regimesReady && concentrationReady && stabilityReady && tailReady && pacReady && decisionQualityReady && accountingReady && equityRiskReady && ruleReady && validationReady;

  if (!confirmedEvidence || !policy.calibrated || !context.calibrationPassed) {
    if (!confirmedEvidence) reasons.push("HIGH_POTENTIAL_NOT_YET_CONFIRMED");
    if (!policy.calibrated || !context.calibrationPassed) reasons.push("UNCALIBRATED_CONFIRMATION_BLOCKED");
    if (!regimesReady) reasons.push("REGIME_EVIDENCE_REQUIRED");
    return { state: "HIGH_POTENTIAL", policyKey: policy.key, policyVersion: policy.version, challengeType: context.challengeType, metrics, gates, reasons, liveEnabled: false };
  }

  const copyReady = context.copyabilityVerified === true && context.copyability !== null && context.copyability.shadowIdeas >= policy.minCopyIdeas &&
    (metrics.copyabilityScore ?? 0) >= policy.minCopyability;
  const portfolioReady = context.portfolioCorrelation !== null && Number.isFinite(context.portfolioCorrelation) && context.portfolioCorrelation >= -1 && context.portfolioCorrelation <= policy.maxPortfolioCorrelation;
  gates.push(
    gate("copyability", copyReady ? "PASS" : context.copyability ? "FAIL" : "UNKNOWN", metrics.copyabilityScore, policy.minCopyability, "Live review requires measured shadow-copy retention and execution quality."),
    gate("portfolio_correlation", portfolioReady ? "PASS" : context.portfolioCorrelation === null ? "UNKNOWN" : "FAIL", context.portfolioCorrelation, policy.maxPortfolioCorrelation, "A good trader can still be unsafe when crowded with the existing book."),
    gate("provider_authorisation", context.providerAuthorised ? "PASS" : "FAIL", context.providerAuthorised, true, "External replication requires written permission and controlled ownership."),
    gate("reserve_capacity", context.reserveCapacityAvailable ? "PASS" : "FAIL", context.reserveCapacityAvailable, true, "Payout liabilities and tail losses must remain independently reserved."),
  );

  if (copyReady && portfolioReady && context.providerAuthorised && context.reserveCapacityAvailable) {
    reasons.push("ALL_AUTOMATED_GATES_PASS_HUMAN_REVIEW_REQUIRED");
    return { state: "LIVE_REVIEW_REQUIRED", policyKey: policy.key, policyVersion: policy.version, challengeType: context.challengeType, metrics, gates, reasons, liveEnabled: false };
  }
  reasons.push("PROFITABILITY_CONFIRMED_LIVE_GATES_PENDING");
  return { state: "PROFITABILITY_CONFIRMED", policyKey: policy.key, policyVersion: policy.version, challengeType: context.challengeType, metrics, gates, reasons, liveEnabled: false };
}

export function deriveAlerts(previous: DetectorState | null, current: DetectorAssessment): DetectorAlert[] {
  if (previous === current.state) return [];
  const alerts: DetectorAlert[] = [];
  const rank: Record<DetectorState, number> = { INSUFFICIENT_EVIDENCE: 0, OBSERVE: 1, HIGH_POTENTIAL: 2, PROFITABILITY_CONFIRMED: 3, LIVE_REVIEW_REQUIRED: 4, RISK_NO_GO: -1 };
  const promotion = previous === null || rank[current.state] > rank[previous];
  if (current.state === "HIGH_POTENTIAL" && promotion) alerts.push({
    type: "HIGH_POTENTIAL", severity: "medium", title: "High-potential trader detected",
    body: `${current.challengeType} trader crossed the provisional evidence gate. This is not yet a calibrated profitability confirmation.`,
  });
  if (current.state === "PROFITABILITY_CONFIRMED" && promotion) alerts.push({
    type: "PROFITABILITY_CONFIRMED", severity: "high", title: "Trader profitability confirmed",
    body: `${current.challengeType} trader passed the calibrated skill and tail-risk gates. Live execution gates remain pending.`,
  });
  if (current.state === "LIVE_REVIEW_REQUIRED") alerts.push({
    type: "LIVE_REVIEW_REQUIRED", severity: "critical", title: "Live-model review required",
    body: `${current.challengeType} trader passed calibrated skill, copyability, portfolio, reserve, and permission gates. Human approval is required; live remains disabled.`,
  });
  const previouslyStrong = previous === "HIGH_POTENTIAL" || previous === "PROFITABILITY_CONFIRMED" || previous === "LIVE_REVIEW_REQUIRED";
  if (previouslyStrong && previous !== null && rank[current.state] < rank[previous]) alerts.push({
    type: "RISK_DETERIORATION", severity: current.state === "RISK_NO_GO" ? "critical" : "high",
    title: "Trader evidence deteriorated", body: `${current.challengeType} trader moved from ${previous} to ${current.state}. Review risk, drift, and data-quality gates.`,
  });
  return alerts;
}

// These are detector evidence policies, not contractual challenge rules.
// They intentionally remain uncalibrated so confirmation/live states fail closed.
export const DEFAULT_SHADOW_POLICIES: Record<ChallengeType, DetectorPolicy> = {
  infinity: {
    key: "infinity_detector", version: 2, inferenceUnit: "UTC_TRADING_DAY", challengeType: "infinity", calibrated: false, minStageDays:5,minRegimeDays:5,
    minPotentialEss: 12, minPotentialDays: 5, minPotentialProbability: 0.78,
    minConfirmedEss: 40, minConfirmedDays: 20, minConfirmedProbability: 0.90,
    minConfirmedEdgeBps: 1, minConfirmedStage: 3, minPositiveStages: 2, minRegimes: 2,
    maxSymbolHhi: 0.65, maxBestIdeaShare: 0.35, maxDrawdownFraction: 0.08,
    maxTailLossMultiple: 4, maxPortfolioCorrelation: 0.35, minCopyIdeas: 30,
    minCopyability: 0.70, priorMeanBps: 0, priorStdBps: 8,
  },
  traditional: {
    key: "traditional_detector", version: 2, inferenceUnit: "UTC_TRADING_DAY", challengeType: "traditional", calibrated: false, minStageDays:5,minRegimeDays:5,
    minPotentialEss: 12, minPotentialDays: 5, minPotentialProbability: 0.78,
    minConfirmedEss: 30, minConfirmedDays: 12, minConfirmedProbability: 0.90,
    minConfirmedEdgeBps: 1, minConfirmedStage: 3, minPositiveStages: 2, minRegimes: 2,
    maxSymbolHhi: 0.65, maxBestIdeaShare: 0.35, maxDrawdownFraction: 0.06,
    maxTailLossMultiple: 4, maxPortfolioCorrelation: 0.35, minCopyIdeas: 30,
    minCopyability: 0.72, priorMeanBps: 0, priorStdBps: 8,
  },
  futures: {
    key: "futures_detector", version: 2, inferenceUnit: "UTC_TRADING_DAY", challengeType: "futures", calibrated: false, minStageDays:5,minRegimeDays:5,
    minPotentialEss: 15, minPotentialDays: 4, minPotentialProbability: 0.80,
    minConfirmedEss: 35, minConfirmedDays: 10, minConfirmedProbability: 0.92,
    minConfirmedEdgeBps: 1, minConfirmedStage: 2, minPositiveStages: 2, minRegimes: 2,
    maxSymbolHhi: 0.75, maxBestIdeaShare: 0.30, maxDrawdownFraction: 0.04,
    maxTailLossMultiple: 3.5, maxPortfolioCorrelation: 0.30, minCopyIdeas: 35,
    minCopyability: 0.78, priorMeanBps: 0, priorStdBps: 8,
  },
  pac: {
    key: "pac_detector", version: 2, inferenceUnit: "UTC_TRADING_DAY", challengeType: "pac", calibrated: false, minStageDays:5,minRegimeDays:5,
    minPotentialEss: 30, minPotentialDays: 15, minPotentialProbability: 0.82,
    minConfirmedEss: 60, minConfirmedDays: 30, minConfirmedProbability: 0.95,
    minConfirmedEdgeBps: 1.5, minConfirmedStage: 1, minPositiveStages: 1, minRegimes: 3,
    maxSymbolHhi: 0.60, maxBestIdeaShare: 0.25, maxDrawdownFraction: 0.08,
    maxTailLossMultiple: 3, maxPortfolioCorrelation: 0.30, minCopyIdeas: 40,
    minCopyability: 0.80, priorMeanBps: 0, priorStdBps: 8,
  },
};
