// Brain control room: per-person performance metrics and plain-language tags, computed by the classifier
// worker every 5 minutes and stored in ab_trader_metrics. Pure functions only (tested in tests/brain.test.mjs).
// Tags drive the owner's alerts (ab_alerts_scan) and watchlists, so their thresholds live here and nowhere else.
import { copyGap, evidence, type BookState, type LedgerPoint, type Policy } from "./ab-classifier.ts";

export type LedgerRow = {
  closedAt: number; pnlUsd: number; traderR: number | null; holdSeconds: number; riskBasis: string | null;
};
export type PersonContext = {
  state: BookState; herd: boolean; hold: boolean; criticalFlag: boolean; breaches7d: number;
  expectedPayout: number | null; pGraduate: number | null;
};
export type Tag = "SUSPENDED" | "HOLD" | "FLAG" | "BREACHED" | "BIG_LOSS" | "NO_SL" | "FAST" | "SPEED" | "HERD"
  | "RINSE" | "FADING" | "TURNING" | "STAR" | "EARNER" | "NEW";

export const TAG_RULES = {
  rinsePayoutUsd: 250,     // expected payout (probability x amount) worth watching
  bigLossR: -3,            // a single loss of 3R or more in the last 30 days
  noSlShare: 0.5, noSlMinTrades: 10,
  fastShare: 0.5, fastMinTrades: 20,
  speedMinTrades: 15, speedGapR: 0.1,
  trendMinTrades: 10, newBelowTrades: 10,
  curvePoints: 60,
};

const DAY = 86_400_000;
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const round = (x: number | null, d = 4) => x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
const capped = (x: number) => Number.isFinite(x) ? Math.min(x, 1e6) : 1e6;

export function personMetrics(rows: LedgerRow[], points: LedgerPoint[], ctx: PersonContext, policy: Policy, now = Date.now()) {
  const sorted = [...rows].sort((a, b) => a.closedAt - b.closedAt);
  const n = sorted.length;
  const rs = sorted.map((r) => r.traderR).filter((x): x is number => x != null && Number.isFinite(x));
  const avgR = mean(rs);
  const sdR = rs.length > 1 ? Math.sqrt(rs.reduce((a, x) => a + (x - (avgR as number)) ** 2, 0) / (rs.length - 1)) : null;
  const gains = sorted.filter((r) => r.pnlUsd > 0).reduce((a, r) => a + r.pnlUsd, 0);
  const losses = -sorted.filter((r) => r.pnlUsd < 0).reduce((a, r) => a + r.pnlUsd, 0);
  const best = sorted.reduce((m, r) => Math.max(m, r.pnlUsd), 0);
  let cum = 0, peak = 0, maxDd = 0; const curve: number[] = [];
  for (const x of rs) { cum += x; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum); curve.push(Math.round(cum * 100) / 100); }
  const holds = sorted.map((r) => r.holdSeconds).sort((a, b) => a - b);
  const recent = sorted.filter((r) => r.closedAt >= now - 30 * DAY);
  const recentR = recent.map((r) => r.traderR).filter((x): x is number => x != null && Number.isFinite(x));
  const noSl30 = recent.length ? recent.filter((r) => r.riskBasis !== "STOP_LOSS").length / recent.length : 0;
  const under60 = n ? sorted.filter((r) => r.holdSeconds < 60).length / n : 0;

  const copy = evidence(points, (p) => p.sameR, policy.minEdgeR, policy);
  const rev = evidence(points, (p) => p.reverseR, policy.minEdgeR, policy);
  const gap = copyGap(points);
  const m = {
    trades: n, days: new Set(sorted.map((r) => Math.floor(r.closedAt / DAY))).size,
    wins: sorted.filter((r) => r.pnlUsd > 0).length,
    win_rate: n ? round(sorted.filter((r) => r.pnlUsd > 0).length / n) : null,
    pnl_usd: round(sorted.reduce((a, r) => a + r.pnlUsd, 0), 2), avg_r: round(avgR), sd_r: round(sdR),
    profit_factor: losses > 0 ? round(gains / losses, 3) : null, max_dd_r: round(maxDd, 3),
    worst_r: rs.length ? round(Math.min(...rs), 3) : null, best_share: gains > 0 ? round(best / gains) : null,
    no_sl_share: n ? round(sorted.filter((r) => r.riskBasis !== "STOP_LOSS").length / n) : null,
    under_60s_share: round(under60), median_hold_s: holds.length ? holds[Math.floor(holds.length / 2)] : null,
    trades_30d: recent.length, pnl_30d: round(recent.reduce((a, r) => a + r.pnlUsd, 0), 2),
    last_trade_at: n ? new Date(sorted[n - 1].closedAt).toISOString() : null,
    replayed: points.length, copy_r: points.length ? round(copy.mean) : null, reverse_r: points.length ? round(rev.mean) : null,
    proof_copy: points.length ? round(capped(copy.eValue), 3) : null, proof_reverse: points.length ? round(capped(rev.eValue), 3) : null,
    day_lb_copy: Number.isFinite(copy.dayLower) ? round(copy.dayLower) : null, day_lb_reverse: Number.isFinite(rev.dayLower) ? round(rev.dayLower) : null,
    ewma_copy: points.length ? round(copy.ewma) : null, ewma_reverse: points.length ? round(rev.ewma) : null,
    copy_gap: gap.trades ? round(gap.gap) : null, herd: ctx.herd,
    expected_payout: round(ctx.expectedPayout, 2), p_graduate: round(ctx.pGraduate), breaches_7d: ctx.breaches7d,
    curve: curve.slice(-TAG_RULES.curvePoints),
  };

  const T = TAG_RULES, tags: Tag[] = [];
  const ab = ctx.state === "AB_DEMO" || ctx.state === "AB_LIVE";
  if (ctx.state === "SUSPENDED") tags.push("SUSPENDED");
  if (ctx.hold) tags.push("HOLD");
  if (ctx.criticalFlag) tags.push("FLAG");
  if (ctx.breaches7d > 0) tags.push("BREACHED");
  if (recentR.length && Math.min(...recentR) <= T.bigLossR) tags.push("BIG_LOSS");
  if (recent.length >= T.noSlMinTrades && noSl30 > T.noSlShare) tags.push("NO_SL");
  if (n >= T.fastMinTrades && under60 > T.fastShare) tags.push("FAST");
  if (gap.trades >= T.speedMinTrades && gap.gap > (Number.isFinite(policy.maxCopyGapR) ? policy.maxCopyGapR : T.speedGapR)) tags.push("SPEED");
  if (ctx.herd) tags.push("HERD");
  if ((ctx.expectedPayout ?? 0) >= T.rinsePayoutUsd && ctx.state !== "AB_LIVE") tags.push("RINSE");
  if (ctx.state === "AB_LIVE" && points.length >= T.trendMinTrades && copy.ewma < policy.abDemoteEwma) tags.push("FADING");
  if (ctx.state === "BB_LIVE" && points.length >= T.trendMinTrades && rev.ewma < policy.abDemoteEwma) tags.push("TURNING");
  if (ab && copy.eValue >= policy.eValueLive && copy.dayLower > 0) tags.push("STAR");
  if (ctx.state === "BB_LIVE" && rev.eValue >= policy.eValuePromote && rev.dayLower > 0) tags.push("EARNER");
  if (n < T.newBelowTrades) tags.push("NEW");
  return { ...m, tags };
}
