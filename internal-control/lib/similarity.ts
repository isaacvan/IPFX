// ============================================================
// IPFX Capital — pair-similarity, cohort normalization, flags (Phase 3)
//
// report §9: a flag is evidence for review, never proof, never an
// automatic failure. This module computes similarity scores and
// cohort-normalized z-scores/FDR; it does NOT and must never decide
// an outcome — the caller creates a flag_case row from a significant
// result and a human takes it from there (enforced structurally: this
// file has no dependency on review-state-machine.ts at all).
//
// NOT EXECUTED IN THIS ENVIRONMENT — see metrics.ts header note.
// ============================================================

import { benjaminiHochberg } from "./probability";

export interface TradeForSimilarity {
  id: string;
  accountId: string;
  symbol: string;
  side: "buy" | "sell";
  entryTime: Date;
  exitTime: Date;
  entryPrice: number;
  atr: number;              // volatility normalizer for price/stop proximity
  size: number;
  stopDistance: number | null;
  targetDistance: number | null;
}

export interface SimilarityWeights {
  time: number; price: number; size: number; stop: number; hold: number;
}
export const DEFAULT_SIMILARITY_WEIGHTS: SimilarityWeights = { time: 0.3, price: 0.25, size: 0.15, stop: 0.15, hold: 0.15 };

export interface SimilarityLambdas {
  time: number; price: number; size: number; stop: number; hold: number;
}
// Decay constants: NOT tuned/validated here (report §9.2: "must be
// chosen by cohort permutation to control false-positive rate, not by
// intuition"). These are placeholders that must be replaced by the
// output of a real cohort-permutation calibration before this is used
// for anything beyond a labelled offline test — see the sqrt(2) note
// in similarityScore()'s doc comment.
export const PLACEHOLDER_LAMBDAS: SimilarityLambdas = { time: 1 / 300, price: 2, size: 1, stop: 2, hold: 1 };

const holdingMinutes = (t: TradeForSimilarity) => (t.exitTime.getTime() - t.entryTime.getTime()) / 60000;

/** report §9.2 — pairwise similarity score, s_ij in [0,1]. Requires
 * `lambdas` to be supplied explicitly (no silent default in the
 * decision path) so a caller can never accidentally score real pairs
 * against un-calibrated placeholder constants without it being visible
 * in the call site. */
export function similarityScore(a: TradeForSimilarity, b: TradeForSimilarity, lambdas: SimilarityLambdas, weights: SimilarityWeights = DEFAULT_SIMILARITY_WEIGHTS): number {
  const dtSeconds = Math.abs(a.entryTime.getTime() - b.entryTime.getTime()) / 1000;
  const sTime = Math.exp(-lambdas.time * dtSeconds);

  const atr = (a.atr + b.atr) / 2 || 1;
  const sPrice = Math.exp(-lambdas.price * Math.abs(a.entryPrice - b.entryPrice) / atr);

  const sSize = a.size > 0 && b.size > 0 ? Math.exp(-lambdas.size * Math.abs(Math.log(a.size / b.size))) : 0;

  const da = a.stopDistance, db = b.stopDistance;
  const sStop = da !== null && db !== null && atr > 0
    ? Math.exp(-lambdas.stop * Math.max(Math.abs(da - db) / atr, 0))
    : 0.5; // neutral, not zero — missing stop data isn't evidence of dissimilarity

  const ha = holdingMinutes(a), hb = holdingMinutes(b);
  const sHold = ha > 0 && hb > 0 ? Math.exp(-lambdas.hold * Math.abs(Math.log(ha / hb))) : 0;

  return weights.time * sTime + weights.price * sPrice + weights.size * sSize + weights.stop * sStop + weights.hold * sHold;
}

/** report §9.3 — cohort z-score: compare an observed similarity to the
 * null distribution built from matched (same instrument/session/
 * volatility-bucket) pairs that have NO reason to be coordinated. */
export function cohortZScore(observed: number, nullMean: number, nullStd: number): number {
  if (nullStd === 0) return 0;
  return (observed - nullMean) / nullStd;
}

/** Two-sided normal-approximation p-value for a z-score, for feeding
 * into benjaminiHochberg(). */
export function zToPValue(z: number): number {
  const absZ = Math.abs(z);
  // Abramowitz-Stegun erf approximation (matches the pattern already
  // used elsewhere in this codebase's own admin-console readiness
  // scoring, for consistency).
  const t = 1 / (1 + 0.3275911 * (absZ / Math.SQRT2));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(absZ * absZ) / 2);
  const oneSided = 0.5 * (1 + y);
  return 2 * (1 - oneSided);
}

export interface SimilarityFlagCandidate { pairKey: string; zScore: number; pValue: number; }
export interface SimilarityFlagResult extends SimilarityFlagCandidate { qValue: number; significant: boolean; }

/** report §9.3/§9.6 — apply Benjamini-Hochberg across ALL pairs tested
 * today, not per-pair independently (the report's whole point: with
 * thousands of daily pairwise comparisons, per-pair alpha=0.05 would
 * flood review with false positives). fdrTarget: 0.05 for routine
 * monitoring, 0.01 for anything feeding a capital-allocation gate
 * (report §9.6) — the caller decides which, this function does not
 * default it to avoid silently picking the looser threshold. */
export function applySimilarityFDR(candidates: SimilarityFlagCandidate[], fdrTarget: number): SimilarityFlagResult[] {
  const results = benjaminiHochberg(candidates.map((c) => c.pValue), fdrTarget);
  return candidates.map((c, i) => ({ ...c, qValue: results[i].qValue, significant: results[i].significant }));
}

// ---- report §8 strategy-hypothesis contrast (evidence, not assertion) ----

export interface HypothesisEvidence {
  hypothesis: string;
  effectSize: number;
  ciLow: number;
  ciHigh: number;
  effectiveN: number;
  qValue: number;
  outOfSampleReplicated: boolean;
}

export type ConfidenceLabel = "no_signal" | "weak" | "moderate" | "strong";

/** report §8.3 — confidence label from CI/replication/q-value. Never
 * "proof of intent," always a label on an observed correlational
 * hypothesis. */
export function hypothesisConfidence(e: HypothesisEvidence, fdrTarget: number): ConfidenceLabel {
  const ciExcludesZero = e.ciLow > 0 || e.ciHigh < 0;
  if (!ciExcludesZero || e.qValue > fdrTarget) return "no_signal";
  if (!e.outOfSampleReplicated) return "weak";
  return e.effectiveN >= 100 ? "strong" : "moderate";
}

// ---- report §9.4 deterministic graph clustering ----

export interface SimilarityEdge { a: string; b: string; zScore: number; }

/** Deterministic connected-components clustering over edges whose
 * z-score exceeds the calibrated threshold — report §9.4 asks for
 * "deterministic and serializable" clustering. Full DBSCAN/Leiden are
 * out of scope for a dependency-free module; connected components over
 * a thresholded graph is the simplest deterministic clustering that
 * satisfies the stated requirement and is trivially serializable
 * (sorted array of sorted member arrays). Swap for Leiden/DBSCAN if a
 * graph library is added to the project later. */
export function clusterBySimilarity(edges: SimilarityEdge[], zThreshold: number): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next; }
    return root;
  };
  const union = (x: string, y: string) => { const rx = find(x), ry = find(y); if (rx !== ry) parent.set(rx, ry); };

  for (const e of edges) {
    if (e.zScore >= zThreshold) { find(e.a); find(e.b); union(e.a, e.b); }
  }
  const groups = new Map<string, Set<string>>();
  for (const node of parent.keys()) {
    const root = find(node);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root)!.add(node);
  }
  return [...groups.values()]
    .map((s) => [...s].sort())
    .filter((g) => g.length > 1) // singletons aren't a "cluster"
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
