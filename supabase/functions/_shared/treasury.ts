// Treasury forecaster (pure, no I/O). Day 4 of the A/B-book build.
//
// For every open Infinity account it estimates the chance the trader reaches the paid stage, when, and what
// IPFX then owes; summed, that is the payout liability over the next 7 / 30 / 60 / 90 days.
//   * Skill: posterior over the trader's true net expectancy per trade (mu, in R) on a grid, from a population
//     prior (85% losing, 13% break-even, 2% skilled) and the trader's own ledger results (trader_r).
//   * Stage odds (Stage 2 re-run 2026-10-08 for the 6% / 8% targets): a table of P(pass) and trading days per stage, from Monte Carlo on the live presets
//     (+1.2R/-1R, 3 trades per active day, 70% active, daily loss, trailing drawdown, daily cap, minimums).
//   * In-progress accounts: Brownian first-passage with a trailing drawdown (Lehoczky) on the remaining
//     distances, rescaled so a fresh start reproduces the table exactly.
// Calibrated on 600 synthetic traders: predicted 3.1% vs actual 2.2% graduation, i.e. errs high, which is
// the safe direction for a reserve.

export const STAGE_TABLE = {"grid": [-0.4, -0.38, -0.36, -0.34, -0.32, -0.3, -0.28, -0.26, -0.24, -0.22, -0.2, -0.18, -0.16, -0.14, -0.12, -0.1, -0.08, -0.06, -0.04, -0.02, 0.0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.14, 0.16, 0.18, 0.2, 0.22, 0.24, 0.26, 0.28, 0.3, 0.32, 0.34, 0.36, 0.38, 0.4, 0.42, 0.44, 0.46, 0.48, 0.5, 0.52, 0.54, 0.56, 0.58, 0.6], "p_pass": {"1": [0.0007, 0.0003, 0.0027, 0.003, 0.0033, 0.0057, 0.0083, 0.0133, 0.017, 0.024, 0.0393, 0.0453, 0.065, 0.0847, 0.1027, 0.16, 0.198, 0.2513, 0.2957, 0.3463, 0.4137, 0.4767, 0.555, 0.6303, 0.6857, 0.7357, 0.762, 0.8283, 0.862, 0.8867, 0.9167, 0.9343, 0.947, 0.9603, 0.9777, 0.977, 0.982, 0.9917, 0.9923, 0.993, 0.9943, 0.9963, 0.996, 0.9973, 0.998, 0.9997, 0.9993, 0.999, 1.0, 0.9997, 1.0], "2": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0003, 0.0003, 0.0008, 0.0012, 0.0018, 0.003, 0.0065, 0.0125, 0.02, 0.0325, 0.054, 0.0843, 0.1217, 0.1647, 0.2383, 0.3098, 0.3847, 0.4748, 0.5532, 0.647, 0.7203, 0.7872, 0.8317, 0.8678, 0.9057, 0.9298, 0.9525, 0.962, 0.9742, 0.9823, 0.9878, 0.992, 0.9937, 0.9943, 0.9962, 0.9985, 0.9988, 0.9992, 0.9997, 0.9997, 1.0, 0.9998, 0.9998, 1.0, 0.9997], "3": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0002, 0.0, 0.0002, 0.0007, 0.0015, 0.0028, 0.0057, 0.0133, 0.0223, 0.0387, 0.0567, 0.0955, 0.1427, 0.1998, 0.2877, 0.368, 0.4573, 0.5563, 0.6458, 0.724, 0.7867, 0.8383, 0.876, 0.9157, 0.9355, 0.9553, 0.9693, 0.977, 0.9875, 0.9915, 0.9945, 0.994, 0.9977, 0.9973, 0.9978, 0.9988, 0.9988, 0.9998, 0.9997, 0.9997, 1.0, 1.0, 1.0]}, "days_if_pass": {"1": [22.0, 16.0, 21.2, 23.0, 18.2, 18.8, 19.8, 19.9, 22.9, 20.5, 22.9, 24.5, 23.9, 25.9, 26.8, 26.4, 27.5, 28.2, 27.7, 29.0, 28.9, 28.0, 27.1, 26.9, 26.1, 25.6, 25.3, 24.3, 23.4, 22.3, 21.2, 20.5, 19.7, 18.9, 18.2, 17.8, 17.2, 16.7, 16.5, 15.9, 15.7, 15.3, 15.2, 15.0, 15.0, 14.7, 14.7, 14.5, 14.4, 14.5, 14.4], "2": [null, null, null, null, null, null, 41.0, 50.0, 40.8, 54.7, 37.5, 47.6, 45.6, 46.2, 50.0, 51.9, 53.8, 56.6, 57.2, 56.3, 58.3, 58.6, 56.9, 56.1, 54.0, 52.4, 50.9, 48.1, 45.5, 43.8, 41.2, 39.1, 37.4, 35.7, 35.0, 33.4, 32.5, 31.4, 31.0, 30.4, 29.8, 29.6, 29.3, 29.1, 29.0, 28.7, 28.7, 28.7, 28.7, 28.6, 28.6], "3": [null, null, null, null, null, null, null, null, 34.0, null, 25.0, 47.5, 59.8, 56.7, 67.1, 64.8, 65.8, 69.2, 72.1, 70.1, 70.0, 71.9, 71.4, 70.0, 67.4, 66.0, 62.8, 60.3, 56.7, 53.2, 49.8, 47.5, 44.7, 41.6, 39.6, 37.0, 35.1, 33.2, 31.6, 30.2, 28.7, 27.7, 26.7, 25.6, 24.7, 24.1, 23.5, 22.8, 22.4, 21.9, 21.5]}} as const;

const SIGMA = 1.1;
const GRID: number[] = STAGE_TABLE.grid as unknown as number[];
function npdf(x: number, m: number, s: number) { return Math.exp(-0.5 * ((x - m) / s) ** 2) / s; }
export const PRIOR: number[] = (() => {
  const w = GRID.map((g) => 0.85 * npdf(g, -0.15, 0.10) + 0.13 * npdf(g, -0.02, 0.05) + 0.02 * npdf(g, 0.10, 0.06));
  const s = w.reduce((a, b) => a + b, 0); return w.map((x) => x / s);
})();

export function posterior(rs: number[]): number[] {
  const n = rs.length, m = n ? rs.reduce((a, b) => a + b, 0) / n : 0;
  const w = PRIOR.map((p, i) => n ? p * Math.exp(-n * (m - GRID[i]) ** 2 / (2 * SIGMA * SIGMA)) : p);
  const s = w.reduce((a, b) => a + b, 0) || 1; return w.map((x) => x / s);
}

// P(reach +a before a drawdown of b from the running peak) for Brownian motion with drift mu per trade.
export function passAnalytic(a: number, b: number, mu: number): number {
  if (a <= 0) return 1; if (b <= 0) return 0;
  const k = 2 * mu / (SIGMA * SIGMA);
  const lambda = Math.abs(k) < 1e-9 ? 1 / b : k / Math.expm1(k * b);
  return Math.exp(-lambda * a);
}

// Infinity payout constants (challenge_presets infinity_s2 = 6% of $5,000, infinity_s3 = 8% of $10,000).
export const STAGE2_TARGET_USD = 300, STAGE3_TARGET_USD = 800, STAGE3_MIN_PAYOUT = 500, STAGE3_MAX_PAYOUT = 700;
export type StageRules = { stage: 1 | 2 | 3; target: number; maxDd: number; riskPct: number };
const FRESH: Record<number, { a: number; b: number }> = { 1: { a: 8, b: 10 }, 2: { a: 17.1429, b: 11.4286 }, 3: { a: 22.8571, b: 11.4286 } };

export type AccountState = {
  accountId: string; personId: string; stage: number; startingBalance: number; balance: number; peak: number;
  targetPct: number; maxDdPct: number; riskPct: number; s2Profit?: number | null; traderR: number[];
};
export type AccountForecast = { accountId: string; personId: string; stage: number; pGraduate: number; expectedDays: number;
  payoutIfGraduate: number; expectedPayout: number; s4MonthlyPayout: number; muMean: number; trades: number };

export function forecastAccount(acc: AccountState, model: "cash_at_stage3" | "sponsored_account", sponsorFee = 350): AccountForecast {
  const post = posterior(acc.traderR);
  const muMean = post.reduce((a, w, i) => a + w * GRID[i], 0);
  const base = { accountId: acc.accountId, personId: acc.personId, stage: acc.stage, muMean, trades: acc.traderR.length };
  if (acc.stage >= 4) {
    // Already at the paid stage: Stage 4 profit share (cash model only; sponsored graduates are paid by the prop firm).
    const eMuPos = post.reduce((a, w, i) => a + w * Math.max(GRID[i], 0), 0);
    const r4 = acc.startingBalance * acc.riskPct;
    const monthly = model === "cash_at_stage3" ? 0.85 * eMuPos * r4 * 44 * 0.9 : 0;
    return { ...base, pGraduate: 1, expectedDays: 0, payoutIfGraduate: 0, expectedPayout: 0, s4MonthlyPayout: monthly };
  }
  const R = acc.startingBalance * acc.riskPct;
  const aRem = Math.max(0, (acc.targetPct / 100 * acc.startingBalance - (acc.balance - acc.startingBalance)) / R);
  const bRem = Math.max(0, (acc.balance - (acc.peak - acc.maxDdPct / 100 * acc.startingBalance)) / R);
  const f = FRESH[acc.stage] ?? FRESH[1];
  let pG = 0, eDays = 0;
  for (let i = 0; i < GRID.length; i++) {
    if (post[i] < 1e-9) continue;
    const mu = GRID[i];
    const tbl = (s: number) => (STAGE_TABLE.p_pass as Record<string, readonly number[]>)[String(s)][i];
    const dys = (s: number) => Number((STAGE_TABLE.days_if_pass as Record<string, readonly (number | null)[]>)[String(s)][i] ?? 60);
    const ratio = tbl(acc.stage) / Math.max(1e-6, passAnalytic(f.a, f.b, mu));
    let p = Math.min(1, Math.max(0, passAnalytic(aRem, bRem, mu) * ratio));
    let d = dys(acc.stage) * Math.max(0.25, aRem / f.a);
    for (let s = acc.stage + 1; s <= 3; s++) { p *= tbl(s); d += dys(s); }
    pG += post[i] * p; eDays += post[i] * p * d;
  }
  const expectedDays = pG > 0 ? eDays / pG : 0;
  // Stage 3 payout: 85% of (Stage 2 profit + Stage 3 profit) at the 6% / 8% targets, capped at $700, $500 minimum.
  const rawPayout = 0.85 * ((acc.stage >= 3 ? (acc.s2Profit ?? STAGE2_TARGET_USD) : STAGE2_TARGET_USD) + STAGE3_TARGET_USD);
  const payoutIfGraduate = model === "sponsored_account" ? sponsorFee : rawPayout >= STAGE3_MIN_PAYOUT ? Math.min(rawPayout, STAGE3_MAX_PAYOUT) : 0;
  return { ...base, pGraduate: pG, expectedDays, payoutIfGraduate, expectedPayout: pG * payoutIfGraduate, s4MonthlyPayout: 0 };
}

function ncdf(z: number) { return 0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z ** 3))); }
// Trading days to calendar days (~21 trading days per 30 calendar days).
export function liabilityWithin(fs: AccountForecast[], calendarDays: number): { expected: number; p90: number; graduates: number } {
  const tdays = calendarDays * 21 / 30;
  let e = 0, v = 0, g = 0;
  for (const f of fs) {
    const pIn = f.stage >= 4 ? 0 : f.pGraduate * ncdf((tdays - f.expectedDays) / (0.35 * f.expectedDays + 1));
    e += pIn * f.payoutIfGraduate + f.s4MonthlyPayout * (calendarDays / 30);
    v += pIn * (1 - pIn) * f.payoutIfGraduate ** 2;
    g += pIn;
  }
  // P90 under independence plus a 1.5x factor for common market regimes (traders are not independent).
  return { expected: e, p90: e + 1.2816 * Math.sqrt(v) * 1.5, graduates: g };
}

export function coverageStatus(assets: number | null, liability90P90: number): "unknown" | "healthy" | "tight" | "short" {
  if (assets == null) return "unknown";
  if (liability90P90 <= 0) return "healthy";
  const c = assets / liability90P90;
  return c >= 1.25 ? "healthy" : c >= 1.0 ? "tight" : "short";
}
