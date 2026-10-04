// A/B-book classification engine (pure, no I/O). Day 2 of the A/B-book build.
//
// States: BB_DEMO (everyone starts here) -> BB_LIVE (reverse-copy with real money once proven)
//         -> AB_DEMO (test copying the trader directly) -> AB_LIVE (same-direction with real money);
//         SUSPENDED for integrity problems (human release only).
// Evidence is deliberately simple and conservative:
//   * net R per trade from the ledger replay (costs and latency already included),
//   * a lower confidence bound on DAILY results (trades on one day are not independent),
//   * an anytime-valid mixture e-value (safe to check after every fill without inflating false positives),
//   * an exponentially weighted recent mean as the early-warning signal.
// A live state never changes size here; sizing is the allocator's job (Day 3).

export type BookState = "BB_DEMO" | "BB_LIVE" | "AB_DEMO" | "AB_LIVE" | "SUSPENDED";

export type LedgerPoint = { closedAt: number; sameR: number; reverseR: number; holdSeconds: number };

export type Policy = {
  version: number;
  minDays: number;            // trading days of evidence before any promotion
  minTrades: number;          // replayed trades before any promotion
  minEdgeR: number;           // break-even margin per trade the edge must beat (after costs)
  zLower: number;             // one-sided z for the daily lower bound
  eValuePromote: number;      // e-value needed to promote to a demo test state
  eValueLive: number;         // e-value needed for a live state
  maxBestTradeShare: number;  // best single trade's share of positive result
  minMedianHoldSeconds: number;
  maxShareUnder60s: number;   // E8-style HFT limit
  dwellDays: number;          // minimum calendar days in a state before a promotion
  coolOffDays: number;        // after leaving an A-book state, wait before B-book live
  liveFlipMinTrades: number;  // trades in BB_LIVE before the "trader turned profitable" flip can fire
  abFailTrades: number;       // prospective AB_DEMO trades before a failing test returns to BB_DEMO
  ewmaAlpha: number;
  abDemoteEwma: number;       // AB_LIVE early-warning threshold on recent same-direction R
  stage2AutoPct: number;      // the board's 2.75% Stage 2 rule
  stage2AutoTarget: "AB_DEMO" | "AB_LIVE";
  stage2AutoMinTrades: number;  // replayed trades needed before the 2.75% rule may fire (0 = off)
  stage2AutoMinCopyR: number;   // their copy results (after costs) must average at least this (-Infinity = off)
};

export const POLICY_V1: Policy = {
  version: 1, minDays: 20, minTrades: 40, minEdgeR: 0.02, zLower: 1.645, eValuePromote: 10, eValueLive: 10,
  maxBestTradeShare: 0.30, minMedianHoldSeconds: 60, maxShareUnder60s: 0.50, dwellDays: 5, coolOffDays: 10,
  liveFlipMinTrades: 10, abFailTrades: 80, ewmaAlpha: 0.1, abDemoteEwma: -0.05,
  stage2AutoPct: 2.75, stage2AutoTarget: "AB_DEMO", stage2AutoMinTrades: 0, stage2AutoMinCopyR: -Infinity,
};

export type Evidence = {
  trades: number; days: number; mean: number; dayMean: number; dayLower: number; eValue: number;
  ewma: number; bestShare: number; medianHold: number; shareUnder60s: number;
};

const DAY = 86_400_000;
const LAMBDAS = [0.1, 0.2, 0.3, 0.4, 0.6];
const CLIP_R = 1.5;

// Mixture betting e-value against H0: mean(x) <= delta. Each bet multiplies wealth by 1 + lambda*y with
// y = clip(x - delta, -1.5, 1.5) / 1.5, so wealth stays positive; under H0 its expectation does not grow.
// By Ville's inequality, P(e-value ever reaches 1/a | H0) <= a, however often it is checked.
export function eValue(xs: number[], delta: number): number {
  let total = 0;
  for (const l of LAMBDAS) {
    let logW = 0;
    for (const x of xs) logW += Math.log(1 + l * Math.max(-1, Math.min(1, (x - delta) / CLIP_R)));
    total += Math.exp(Math.min(logW, 700));
  }
  return total / LAMBDAS.length;
}

// Evidence that the mean is BELOW delta (H0: mean >= delta). Used for demotions and flips, so a single
// bad patch cannot move a trader; only accumulated evidence can.
export function eValueBelow(xs: number[], delta: number): number {
  return eValue(xs.map((x) => -x), -delta);
}

// Early warning for the allocator (cut size, do not change state): recent results turning negative.
export function earlyWarning(points: LedgerPoint[], pick: (p: LedgerPoint) => number, policy: Policy = POLICY_V1): boolean {
  if (points.length < 10) return false;
  let ew = 0;
  for (const p of points) ew = (1 - policy.ewmaAlpha) * ew + policy.ewmaAlpha * pick(p);
  return ew < policy.abDemoteEwma;
}

export function evidence(points: LedgerPoint[], pick: (p: LedgerPoint) => number, delta: number, policy: Policy): Evidence {
  const xs = points.map(pick);
  const n = xs.length;
  if (n === 0) return { trades: 0, days: 0, mean: 0, dayMean: 0, dayLower: -Infinity, eValue: 1, ewma: 0, bestShare: 1, medianHold: 0, shareUnder60s: 0 };
  const byDay = new Map<number, number>();
  points.forEach((p, i) => { const d = Math.floor(p.closedAt / DAY); byDay.set(d, (byDay.get(d) ?? 0) + xs[i]); });
  const days = [...byDay.values()];
  const dm = days.reduce((a, b) => a + b, 0) / days.length;
  const dsd = days.length > 1 ? Math.sqrt(days.reduce((a, b) => a + (b - dm) ** 2, 0) / (days.length - 1)) : Infinity;
  let ew = 0;
  for (const x of xs) ew = (1 - policy.ewmaAlpha) * ew + policy.ewmaAlpha * x;
  const pos = xs.filter((x) => x > 0);
  const posSum = pos.reduce((a, b) => a + b, 0);
  const holds = points.map((p) => p.holdSeconds).sort((a, b) => a - b);
  return {
    trades: n, days: days.length, mean: xs.reduce((a, b) => a + b, 0) / n, dayMean: dm,
    dayLower: dm - policy.zLower * dsd / Math.sqrt(days.length), eValue: eValue(xs, delta), ewma: ew,
    bestShare: posSum > 0 ? Math.max(...pos) / posSum : 1, medianHold: holds[Math.floor(holds.length / 2)],
    shareUnder60s: points.filter((p) => p.holdSeconds < 60).length / n,
  };
}

export type ClassifierInput = {
  state: BookState; stateSince: number; lastAbExitAt: number | null; now: number;
  points: LedgerPoint[];                   // full person history (all accounts, all restarts), oldest first
  suspend?: string | null;                 // integrity reason, if any
  stage2ProfitPct?: number | null;         // best open Infinity Stage 2 progress, if any
};
export type Decision = { to: BookState; reason: string; evidence: Record<string, unknown> } | null;

function strong(e: Evidence, p: Policy, eNeeded: number): boolean {
  return e.trades >= p.minTrades && e.days >= p.minDays && e.dayLower > 0 && e.mean > p.minEdgeR &&
    e.eValue >= eNeeded && e.bestShare <= p.maxBestTradeShare;
}

export function decide(input: ClassifierInput, p: Policy = POLICY_V1): Decision {
  const { state, now } = input;
  if (input.suspend && state !== "SUSPENDED") return { to: "SUSPENDED", reason: "integrity: " + input.suspend, evidence: {} };
  if (state === "SUSPENDED") return null; // released by a person only

  const dwellOk = now - input.stateSince >= p.dwellDays * DAY;
  const all = input.points;
  const since = all.filter((x) => x.closedAt >= input.stateSince);
  const rev = evidence(all, (x) => x.reverseR, p.minEdgeR, p);
  const same = evidence(all, (x) => x.sameR, p.minEdgeR, p);
  const sameSince = evidence(since, (x) => x.sameR, p.minEdgeR, p);
  const revSince = evidence(since, (x) => x.reverseR, p.minEdgeR, p);
  const summary = (e: Evidence) => ({ trades: e.trades, days: e.days, mean: +e.mean.toFixed(4), dayLower: +e.dayLower.toFixed(4), eValue: +e.eValue.toFixed(2), ewma: +e.ewma.toFixed(4) });
  const recentSame = evidence(all.slice(-20), (x) => x.sameR, p.minEdgeR, p);
  const hftOk = same.shareUnder60s <= p.maxShareUnder60s && same.medianHold >= p.minMedianHoldSeconds;

  switch (state) {
    case "BB_DEMO": {
      if (dwellOk && strong(same, p, p.eValuePromote) && hftOk)
        return { to: "AB_DEMO", reason: "trader profitable on their own after costs: test copying them directly", evidence: { same: summary(same) } };
      // The 2.75% rule looks at IPFX profit. A profit that cannot be copied (feed-lag trading, or one of two
      // opposite accounts of the same person) must not trigger it, so from policy v3 the person's replayed copy
      // results must also be non-negative over a minimum number of trades.
      const copyableOk = same.trades >= p.stage2AutoMinTrades && same.mean >= p.stage2AutoMinCopyR;
      if (input.stage2ProfitPct != null && input.stage2ProfitPct >= p.stage2AutoPct && hftOk && copyableOk)
        return { to: p.stage2AutoTarget, reason: `Infinity Stage 2 profit ${input.stage2ProfitPct.toFixed(2)}% >= ${p.stage2AutoPct}% (automatic rule)`, evidence: { same: summary(same) } };
      const coolOk = input.lastAbExitAt == null || now - input.lastAbExitAt >= p.coolOffDays * DAY;
      if (dwellOk && coolOk && strong(rev, p, p.eValueLive) && hftOk)
        return { to: "BB_LIVE", reason: "reversing this trader is consistently profitable after costs", evidence: { reverse: summary(rev) } };
      return null;
    }
    case "BB_LIVE": {
      // The board's rule: once reverse trades keep losing because the trader is now winning, move at once.
      // "Keep losing" = evidence that reversing them is now below break-even, not one bad day.
      const revLosing = revSince.trades >= p.liveFlipMinTrades &&
        (eValueBelow(since.map((x) => x.reverseR), 0) >= p.eValuePromote || (revSince.trades >= p.minTrades && revSince.mean < 0));
      if (revLosing && recentSame.mean > 0)
        return { to: "AB_DEMO", reason: "reverse trades losing because the trader is now profitable", evidence: { reverse: summary(revSince), recentSame: summary(recentSame) } };
      if (rev.dayLower < 0 && rev.mean <= p.minEdgeR)
        return { to: "BB_DEMO", reason: "evidence for reversing this trader has faded", evidence: { reverse: summary(rev) } };
      return null;
    }
    case "AB_DEMO": {
      // Only trades after entering the test count: a lucky past cannot pass it.
      if (dwellOk && strong(sameSince, p, p.eValueLive) && hftOk)
        return { to: "AB_LIVE", reason: "copying this trader was profitable after costs during the A-book test", evidence: { prospective: summary(sameSince) } };
      if (sameSince.trades >= p.abFailTrades && sameSince.mean <= 0)
        return { to: "BB_DEMO", reason: "failed the A-book test: copying did not make money", evidence: { prospective: summary(sameSince) } };
      return null;
    }
    case "AB_LIVE": {
      // Confirmed decline only. A recent dip is the allocator's early warning (size cut), not a state change.
      if (sameSince.trades >= 20 && eValueBelow(since.map((x) => x.sameR), p.minEdgeR) >= p.eValuePromote)
        return { to: "AB_DEMO", reason: "live copying confirmed below break-even: back to the A-book test", evidence: { live: summary(sameSince) } };
      if (sameSince.trades >= p.minTrades && sameSince.mean < 0)
        return { to: "AB_DEMO", reason: "live copying losing over the test window", evidence: { live: summary(sameSince) } };
      return null;
    }
  }
  return null;
}
