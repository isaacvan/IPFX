// Statistics for telling real edges from luck. Zero dependencies; every function is covered by
// tests/strategy-engine-stats.test.mjs against the published formulas and known values.
//
// References
//   PSR, MinTRL ........ Bailey & López de Prado, "The Sharpe Ratio Efficient Frontier" (2012)
//   DSR ................ Bailey & López de Prado, "The Deflated Sharpe Ratio" (2014)
//   E[max SR], MinBTL .. Bailey, Borwein, López de Prado & Zhu, "Pseudo-Mathematics and Financial
//                        Charlatanism" (2014); López de Prado & Bailey, "The False Strategy Theorem"
//   PBO (CSCV) ......... Bailey, Borwein, López de Prado & Zhu, "The Probability of Backtest Overfitting"
//   CPCV ............... López de Prado, "Advances in Financial Machine Learning" (2018), ch. 12
//   Reality Check, StepM White (2000); Romano & Wolf (2005), with the stationary bootstrap of
//                        Politis & Romano (1994)

export const EULER_GAMMA = 0.5772156649015329;

// ---------------------------------------------------------------- basics
export const sum = (x) => x.reduce((a, b) => a + b, 0);
export const mean = (x) => (x.length ? sum(x) / x.length : NaN);
export function variance(x, ddof = 1) {
  if (x.length <= ddof) return NaN;
  const m = mean(x);
  return x.reduce((a, v) => a + (v - m) ** 2, 0) / (x.length - ddof);
}
export const std = (x, ddof = 1) => Math.sqrt(variance(x, ddof));
// Sample skewness and raw (non-excess) kurtosis, population moments as in Bailey & López de Prado.
export function moments(x) {
  const n = x.length, m = mean(x);
  let m2 = 0, m3 = 0, m4 = 0;
  for (const v of x) { const d = v - m; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
  m2 /= n; m3 /= n; m4 /= n;
  return { mean: m, skew: m2 > 0 ? m3 / m2 ** 1.5 : 0, kurt: m2 > 0 ? m4 / (m2 * m2) : 3 };
}
// Per-period Sharpe ratio (no annualisation, no risk-free rate).
export function sharpe(x) { const s = std(x); return s > 0 ? mean(x) / s : 0; }
export function tStat(x) { const s = std(x); return s > 0 ? (mean(x) / s) * Math.sqrt(x.length) : 0; }

// ---------------------------------------------------------------- normal distribution
// erf by Abramowitz & Stegun 7.1.26 is too coarse for tail work; use a series/continued fraction.
export function normCdf(z) {
  if (z < -8) return 0;
  if (z > 8) return 1;
  // Cody-style: Phi(z) = 0.5 * erfc(-z / sqrt 2)
  return 0.5 * erfc(-z / Math.SQRT2);
}
function erfc(x) {
  // Numerical Recipes erfcc, fractional error < 1.2e-7
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
// Inverse normal CDF (Acklam), relative error ~1e-9.
export function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425, hi = 1 - lo;
  let q, r;
  if (p < lo) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > hi) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------------------------------------------------------------- Sharpe-ratio inference
// Probabilistic Sharpe Ratio: probability the true per-period SR exceeds `benchmark`, allowing for
// sample length, skew and fat tails.
export function psr(sr, n, skew = 0, kurt = 3, benchmark = 0) {
  const denom = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  if (n < 2 || denom <= 0) return NaN;
  return normCdf(((sr - benchmark) * Math.sqrt(n - 1)) / Math.sqrt(denom));
}
export function psrOf(returns, benchmark = 0) {
  const { skew, kurt } = moments(returns);
  return psr(sharpe(returns), returns.length, skew, kurt, benchmark);
}
// Expected maximum of N independent standard normals (False Strategy Theorem).
export function expectedMaxZ(n) {
  if (n <= 1) return 0;
  return (1 - EULER_GAMMA) * normInv(1 - 1 / n) + EULER_GAMMA * normInv(1 - 1 / (n * Math.E));
}
// Expected maximum Sharpe ratio across N trials whose Sharpe ratios have variance `trialSrVariance`.
export const expectedMaxSharpe = (nTrials, trialSrVariance) => Math.sqrt(Math.max(0, trialSrVariance)) * expectedMaxZ(nTrials);
// Deflated Sharpe Ratio: PSR against the Sharpe ratio the best of N useless trials would reach.
export function dsr(returns, nTrials, trialSrVariance) {
  return psrOf(returns, expectedMaxSharpe(nTrials, trialSrVariance));
}
// Minimum Track Record Length: observations needed to be `1 - alpha` confident SR > benchmark.
export function minTrackRecord(sr, skew = 0, kurt = 3, alpha = 0.05, benchmark = 0) {
  if (sr <= benchmark) return Infinity;
  return 1 + (1 - skew * sr + ((kurt - 1) / 4) * sr * sr) * (normInv(1 - alpha) / (sr - benchmark)) ** 2;
}
// Minimum Backtest Length in years for N independent trials, for a target annualised in-sample SR.
export const minBacktestYears = (nTrials, targetAnnualSharpe = 1) => (expectedMaxZ(nTrials) / targetAnnualSharpe) ** 2;
// Largest number of independent trials `years` of history can support at a target annual SR.
export function maxTrialsForYears(years, targetAnnualSharpe = 1) {
  let lo = 1, hi = 1e12;
  if (minBacktestYears(2, targetAnnualSharpe) > years) return 1;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (minBacktestYears(mid, targetAnnualSharpe) <= years) lo = mid; else hi = mid; }
  return lo;
}

// ---------------------------------------------------------------- resampling
// Small, fast, seedable generator (mulberry32) so every result can be reproduced.
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Stationary bootstrap indices (Politis & Romano): random blocks with mean length `meanBlock`,
// which keeps the autocorrelation that i.i.d. resampling would destroy.
export function stationaryBootstrapIndices(n, meanBlock, random) {
  const out = new Array(n), p = 1 / Math.max(1, meanBlock);
  let i = Math.floor(random() * n);
  for (let t = 0; t < n; t++) {
    if (t > 0) i = random() < p ? Math.floor(random() * n) : (i + 1) % n;
    out[t] = i;
  }
  return out;
}
export function bootstrapMeanCI(x, { reps = 2000, meanBlock = 5, level = 0.95, seed = 7 } = {}) {
  const r = rng(seed), means = [];
  for (let b = 0; b < reps; b++) { const idx = stationaryBootstrapIndices(x.length, meanBlock, r); let s = 0; for (const i of idx) s += x[i]; means.push(s / x.length); }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(((1 - level) / 2) * reps)], hi: means[Math.ceil((1 - (1 - level) / 2) * reps) - 1] };
}

// ---------------------------------------------------------------- data-snooping tests
// White's Reality Check and Romano-Wolf StepM on a T x K matrix of per-period performance
// differentials (strategy return minus benchmark; use the raw return for a zero benchmark).
// Returns the Reality Check p-value and the strategies StepM rejects (genuinely beat the benchmark)
// at family-wise error `alpha`.
export function stepM(matrix, { alpha = 0.05, reps = 1000, meanBlock = 5, seed = 11 } = {}) {
  const T = matrix.length, K = matrix[0].length, sqrtT = Math.sqrt(T);
  const means = new Array(K).fill(0);
  for (const row of matrix) for (let k = 0; k < K; k++) means[k] += row[k] / T;
  const stat = means.map((m) => sqrtT * m);
  // bootstrap distribution of sqrt(T) * (mean* - mean) per strategy
  const r = rng(seed), boot = [];
  for (let b = 0; b < reps; b++) {
    const idx = stationaryBootstrapIndices(T, meanBlock, r), bm = new Array(K).fill(0);
    for (const i of idx) { const row = matrix[i]; for (let k = 0; k < K; k++) bm[k] += row[k]; }
    boot.push(bm.map((v, k) => sqrtT * (v / T - means[k])));
  }
  const maxOver = (row, active) => { let m = -Infinity; for (const k of active) if (row[k] > m) m = row[k]; return m; };
  const all = [...Array(K).keys()], best = Math.max(...stat);
  const rcP = boot.filter((row) => maxOver(row, all) >= best).length / reps;
  const rejected = new Set();
  let active = all.slice();
  for (;;) {
    const maxes = boot.map((row) => maxOver(row, active)).sort((a, b) => a - b);
    const crit = maxes[Math.min(reps - 1, Math.ceil((1 - alpha) * reps) - 1)];
    const newly = active.filter((k) => stat[k] > crit);
    if (!newly.length) break;
    for (const k of newly) rejected.add(k);
    active = active.filter((k) => !rejected.has(k));
    if (!active.length) break;
  }
  return { realityCheckP: rcP, rejected: [...rejected].sort((a, b) => a - b), stat };
}

// ---------------------------------------------------------------- overfitting
function* combinations(n, k, start = 0, prefix = []) {
  if (prefix.length === k) { yield prefix; return; }
  for (let i = start; i <= n - (k - prefix.length); i++) yield* combinations(n, k, i + 1, [...prefix, i]);
}
export function nChooseK(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); }

// Probability of Backtest Overfitting via combinatorially symmetric cross-validation.
// `matrix` is T x N: per-period returns of N strategy configurations over the same T periods.
// PBO is the share of splits in which the in-sample winner ranks in the bottom half out of sample.
export function pbo(matrix, blocks = 16) {
  const T = matrix.length, N = matrix[0].length;
  if (N < 2) throw new Error("PBO needs at least two configurations");
  const S = blocks % 2 ? blocks - 1 : blocks, size = Math.floor(T / S);
  if (size < 2) throw new Error("not enough periods for " + S + " blocks");
  // per block and configuration: count, sum, sum of squares, so any set of blocks is O(blocks)
  const agg = [...Array(S)].map((_, s) => {
    const a = s * size, b = s === S - 1 ? T : (s + 1) * size, n = new Array(N).fill(0), s1 = new Array(N).fill(0), s2 = new Array(N).fill(0);
    for (let t = a; t < b; t++) for (let k = 0; k < N; k++) { const v = matrix[t][k]; n[k]++; s1[k] += v; s2[k] += v * v; }
    return { n, s1, s2 };
  });
  const perf = (blocksSet, k) => {
    let n = 0, s1 = 0, s2 = 0;
    for (const s of blocksSet) { n += agg[s].n[k]; s1 += agg[s].s1[k]; s2 += agg[s].s2[k]; }
    const m = s1 / n, v = (s2 - n * m * m) / (n - 1);
    return v > 0 ? m / Math.sqrt(v) : 0;
  };
  const logits = [];
  for (const isBlocks of combinations(S, S / 2)) {
    const isSet = new Set(isBlocks), oosBlocks = [...Array(S).keys()].filter((s) => !isSet.has(s));
    let bestN = 0, bestV = -Infinity;
    for (let n = 0; n < N; n++) { const v = perf(isBlocks, n); if (v > bestV) { bestV = v; bestN = n; } }
    const oos = [...Array(N).keys()].map((n) => perf(oosBlocks, n));
    const rank = oos.filter((v) => v < oos[bestN]).length + 1; // 1 = worst, N = best
    const w = rank / (N + 1);
    logits.push(Math.log(w / (1 - w)));
  }
  return { pbo: logits.filter((l) => l <= 0).length / logits.length, splits: logits.length, logits };
}

// Combinatorial purged cross-validation splits over nGroups consecutive time groups, kTest per split.
// Returns the splits and, for each backtest path, which split supplies each group's test result.
export function cpcvPlan(nGroups, kTest) {
  const splits = [...combinations(nGroups, kTest)].map((g) => g.slice());
  const nPaths = (nChooseK(nGroups, kTest) * kTest) / nGroups;
  const used = new Array(nGroups).fill(0), paths = [...Array(nPaths)].map(() => new Array(nGroups).fill(-1));
  splits.forEach((groups, si) => { for (const g of groups) { paths[used[g]][g] = si; used[g]++; } });
  return { splits, paths };
}
// Remove training observations whose [start, end] window overlaps a test window, plus an embargo
// after each test window, so labels that straddle the boundary cannot leak.
export function purgeTrain(trainItems, testWindows, embargoSeconds = 0) {
  return trainItems.filter((it) => !testWindows.some(([a, b]) => it.end >= a && it.start <= b + embargoSeconds));
}
