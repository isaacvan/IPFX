// ============================================================
// IPFX Capital — probabilistic estimates (Phase 2/3)
//
// report §6.5 (block bootstrap, Monte Carlo path simulation),
// §6.6 (evidence confidence), §6.7 (effective sample size),
// §6.8 (data quality), §7.3 (Bayesian shrinkage), §7.4 (block
// bootstrap detail), §9.3/§9.6 (Benjamini-Hochberg FDR).
//
// Every function that would otherwise need to guess returns null +
// a status rather than fabricate a number, per report §6.10.
// A seeded PRNG is used throughout so any of this is exactly
// reproducible given the same seed (required by the acceptance test
// "Bootstrap CI reproducibility is deterministic with set seed").
//
// NOT EXECUTED IN THIS ENVIRONMENT — see metrics.ts header note.
// ============================================================

export interface ProbEstimate {
  value: number | null;
  credibleLow: number | null;
  credibleHigh: number | null;
  ciLevel: number;
  sampleSize: number;
  effectiveSampleSize: number | null;
  status: "ok" | "insufficient_evidence";
  warnings: string[];
}

// ---- seeded PRNG (mulberry32) — deterministic, no external dependency ----
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/** report §6.7 effective sample size from lag-k autocorrelation. */
export function effectiveSampleSize(series: number[], maxLag = 20): number {
  const n = series.length;
  if (n < 3) return n;
  const m = series.reduce((a, b) => a + b, 0) / n;
  const c0 = series.reduce((s, x) => s + (x - m) ** 2, 0) / n;
  if (c0 === 0) return n;
  let sumRho = 0;
  const K = Math.min(maxLag, n - 2);
  for (let k = 1; k <= K; k++) {
    let ck = 0;
    for (let t = 0; t < n - k; t++) ck += (series[t] - m) * (series[t + k] - m);
    ck /= n;
    const rho = ck / c0;
    if (Math.abs(rho) < 0.05) break; // stop at first negligible lag, per report's "significant autocorrelation" guidance
    sumRho += rho;
  }
  const nEff = n / (1 + 2 * sumRho);
  return Math.max(1, Math.min(n, nEff));
}

/** report §7.4 — moving block bootstrap resample of a series. */
function blockBootstrapResample(series: number[], blockLength: number, rng: () => number): number[] {
  const n = series.length;
  const out: number[] = [];
  while (out.length < n) {
    const start = Math.floor(rng() * (n - blockLength + 1));
    for (let i = 0; i < blockLength && out.length < n; i++) out.push(series[start + i]);
  }
  return out;
}

/** Auto block-length selection (report §7.4 "select block length by
 * autocorrelation") — a simplified Politis-White-style heuristic: the
 * smallest k such that lag-k autocorrelation is negligible, floored at 5. */
export function selectBlockLength(series: number[]): number {
  const n = series.length;
  if (n < 10) return Math.max(1, Math.floor(n / 2));
  const m = series.reduce((a, b) => a + b, 0) / n;
  const c0 = series.reduce((s, x) => s + (x - m) ** 2, 0) / n;
  if (c0 === 0) return 5;
  for (let k = 1; k <= Math.min(30, n - 2); k++) {
    let ck = 0;
    for (let t = 0; t < n - k; t++) ck += (series[t] - m) * (series[t + k] - m);
    ck /= n;
    if (Math.abs(ck / c0) < 0.1) return Math.max(5, k);
  }
  return Math.max(5, Math.floor(Math.sqrt(n)));
}

/** report §6.5 — probability of positive net return over horizon H via
 * overlapping block bootstrap. Returns insufficient_evidence below a
 * hard floor rather than reporting a falsely narrow interval on noise. */
export function probabilityPositiveOverHorizon(
  dailyReturns: number[], horizonDays: number, opts?: { resamples?: number; seed?: number; minSamples?: number }
): ProbEstimate {
  const minSamples = opts?.minSamples ?? 30;
  const B = opts?.resamples ?? 5000;
  const warnings: string[] = [];
  if (dailyReturns.length < minSamples) {
    return { value: null, credibleLow: null, credibleHigh: null, ciLevel: 0.95, sampleSize: dailyReturns.length, effectiveSampleSize: null, status: "insufficient_evidence", warnings: ["below_min_samples"] };
  }
  const rng = makeRng(opts?.seed ?? 42);
  const blockLen = selectBlockLength(dailyReturns);
  const nEff = effectiveSampleSize(dailyReturns);
  if (nEff < minSamples / 2) warnings.push("low_effective_sample_size");

  let posCount = 0;
  for (let b = 0; b < B; b++) {
    const resample = blockBootstrapResample(dailyReturns, blockLen, rng);
    let sum = 0;
    for (let h = 0; h < horizonDays && h < resample.length; h++) sum += resample[h];
    if (sum > 0) posCount++;
  }
  const pHat = posCount / B;
  // P_pos itself is a proportion estimated from B resamples, so its own
  // uncertainty is a binomial CI on that proportion (Wilson interval) —
  // not the spread of the underlying horizon-sum distribution, which
  // would conflate "how uncertain is the trader's future" with "how
  // precise was our B=5000 simulation," two different things.
  const ci = wilsonInterval(posCount, B);
  return {
    value: pHat,
    credibleLow: ci.low,
    credibleHigh: ci.high,
    ciLevel: 0.95,
    sampleSize: dailyReturns.length,
    effectiveSampleSize: nEff,
    status: "ok",
    warnings,
  };
}

// ---- report §7.3 Bayesian shrinkage ----

/** Shrinks a trader's mean daily return toward a cohort prior mean,
 * weighted by relative precision — report §7.3. */
export function shrinkMeanReturn(
  observedMean: number, observedVariance: number, n: number, cohortPriorMean: number, cohortPriorVariance: number
): number {
  if (n <= 0) return cohortPriorMean;
  const precisionData = n / Math.max(observedVariance, 1e-12);
  const precisionPrior = 1 / Math.max(cohortPriorVariance, 1e-12);
  return (precisionData * observedMean + precisionPrior * cohortPriorMean) / (precisionData + precisionPrior);
}

/** Beta-Binomial shrinkage for win rate — report §7.3. */
export function shrinkWinRate(wins: number, n: number, alpha0: number, beta0: number): number {
  return (alpha0 + wins) / (alpha0 + beta0 + n);
}

// ---- report §6.5 Monte Carlo challenge-path simulation ----

export interface ChallengePathInputs {
  startEquity: number;
  targetEquity: number | null;      // null = no profit target (e.g. Infinity Stage 4)
  drawdownFloor: number;            // absolute equity level that breaches
  remainingTradingDays: number;
  dailyReturnMean: number;          // from the trader's own shrunk estimate
  dailyReturnStd: number;
  simulations?: number;
  seed?: number;
}

export interface ChallengePathResult {
  probPass: number | null;
  probBreach: number | null;
  probExpiry: number | null; // neither hit target nor breached within remainingTradingDays
  standardErrorPct: number | null;
  simulations: number;
  status: "ok" | "insufficient_evidence";
  warnings: string[];
}

/** report §6.5 — Monte Carlo simulation of the challenge path given the
 * CURRENT rule snapshot (target/floor/remaining time), not a static
 * trade-count threshold. M chosen so MC standard error is small; caller
 * should widen `simulations` if standardErrorPct comes back too high. */
export function simulateChallengePath(inputs: ChallengePathInputs): ChallengePathResult {
  const warnings: string[] = [];
  if (inputs.dailyReturnStd <= 0) {
    return { probPass: null, probBreach: null, probExpiry: null, standardErrorPct: null, simulations: 0, status: "insufficient_evidence", warnings: ["zero_variance"] };
  }
  if (inputs.remainingTradingDays <= 0) {
    return { probPass: null, probBreach: null, probExpiry: null, standardErrorPct: null, simulations: 0, status: "insufficient_evidence", warnings: ["no_time_remaining"] };
  }
  const M = inputs.simulations ?? 20000;
  const rng = makeRng(inputs.seed ?? 1234);
  // Box-Muller for approx-normal daily return draws — a simplification
  // vs. the report's fuller cost/gap-jump distribution; flagged so this
  // is never mistaken for the full production model.
  const gaussian = () => {
    const u1 = Math.max(rng(), 1e-12), u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  warnings.push("simplified_gaussian_model_no_gap_jumps");

  let pass = 0, breach = 0, expiry = 0;
  for (let m = 0; m < M; m++) {
    let equity = inputs.startEquity;
    let hit: "pass" | "breach" | null = null;
    for (let d = 0; d < inputs.remainingTradingDays; d++) {
      equity *= 1 + (inputs.dailyReturnMean + inputs.dailyReturnStd * gaussian());
      if (equity <= inputs.drawdownFloor) { hit = "breach"; break; }
      if (inputs.targetEquity !== null && equity >= inputs.targetEquity) { hit = "pass"; break; }
    }
    if (hit === "pass") pass++;
    else if (hit === "breach") breach++;
    else expiry++;
  }
  const p = pass / M;
  // binomial standard error of the pass-probability estimate
  const se = Math.sqrt((p * (1 - p)) / M);
  return {
    probPass: p, probBreach: breach / M, probExpiry: expiry / M,
    standardErrorPct: se * 100, simulations: M, status: "ok", warnings,
  };
}

// ---- report §9.3/§9.6 Benjamini-Hochberg FDR ----

export interface FDRResult { pValue: number; qValue: number; significant: boolean; }

/** Standard Benjamini-Hochberg step-up procedure. Returns q-values and
 * a significance flag per the caller's chosen FDR target (report:
 * routine monitoring 5%, capital-allocation gate flags 1%). */
export function benjaminiHochberg(pValues: number[], fdrTarget: number): FDRResult[] {
  const n = pValues.length;
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const qValues = new Array(n).fill(1);
  let minQ = 1;
  for (let rank = n; rank >= 1; rank--) {
    const { p, i } = indexed[rank - 1];
    const q = Math.min(minQ, (p * n) / rank);
    minQ = q;
    qValues[i] = q;
  }
  return pValues.map((p, i) => ({ pValue: p, qValue: qValues[i], significant: qValues[i] <= fdrTarget }));
}

// ---- report §6.6 evidence confidence & §6.8 data quality ----

export interface EvidenceConfidenceInputs {
  nIdeas: number; tradingDays: number; effectiveN: number;
  regimeCoverage0to1: number; dataMissingRate0to1: number;
  kN?: number; kD?: number; kE?: number;
}

/** report §6.6 — a continuous confidence score in [0,1]. Never a
 * pass/fail cutoff by itself; combine with calibration + CI width
 * before using this for anything decision-grade. */
export function evidenceConfidence(inputs: EvidenceConfidenceInputs): number {
  const kN = inputs.kN ?? 100, kD = inputs.kD ?? 30, kE = inputs.kE ?? 80;
  return (
    0.30 * (1 - Math.exp(-inputs.nIdeas / kN)) +
    0.25 * (1 - Math.exp(-inputs.tradingDays / kD)) +
    0.20 * (1 - Math.exp(-inputs.effectiveN / kE)) +
    0.15 * inputs.regimeCoverage0to1 +
    0.10 * (1 - inputs.dataMissingRate0to1)
  );
}

export interface DataQualityFlags {
  duplicateIds?: boolean; missingCriticalTimestamp?: boolean; reconciliationMismatchUnresolved?: boolean;
  missingCommissionOrSwap?: boolean; missingDecisionOrMidPrice?: boolean; staleEquitySnapshot?: boolean;
  symbolUnmapped?: boolean;
}

/** report §6.8 — data-quality score with fixed penalties; classification thresholds as specified. */
export function dataQualityScore(flags: DataQualityFlags): { score: number; classification: "high" | "medium" | "low" } {
  let penalty = 0;
  if (flags.duplicateIds) penalty += 0.30;
  if (flags.missingCriticalTimestamp) penalty += 0.25;
  if (flags.reconciliationMismatchUnresolved) penalty += 0.30;
  if (flags.missingCommissionOrSwap) penalty += 0.20;
  if (flags.missingDecisionOrMidPrice) penalty += 0.15;
  if (flags.staleEquitySnapshot) penalty += 0.20;
  if (flags.symbolUnmapped) penalty += 0.30;
  const score = Math.max(0, 1 - penalty);
  const classification = score >= 0.90 ? "high" : score >= 0.70 ? "medium" : "low";
  return { score, classification };
}

/** report §6.4 (Wilson interval, referenced throughout §7.1) — the
 * approximately-49%-94% example for 8/10 wins comes from this. Used
 * anywhere a raw win-rate CI is shown instead of the shrunk estimate. */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: (center - margin) / denom, high: (center + margin) / denom };
}
