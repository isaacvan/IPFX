// A/B-book risk allocation (pure, no I/O). Decides HOW MUCH to risk on a trader who is already in a live
// state; the classifier decides WHERE they belong. Hard caps are applied afterwards by ab_reserve_risk in the
// database, which a model can never raise.
//
// A-book live: start at 1x the trader's own risk; 3x once the live record since promotion is positive with
// confidence; up to the book maximum once it is strongly confirmed. Any early warning drops back to 1x.
// B-book live: "the more unprofitable, the more we scale" - 1x / 2x / 3x as the evidence that reversing the
// trader pays gets stronger; an early warning (reverse turning negative) drops back to 1x.
import { earlyWarning, evidence, POLICY_V1, type LedgerPoint, type Policy } from "./ab-classifier.ts";

// probation (A-book only): share of the normal live size used while a trader is new to live copying
// (owner decision 2026-10-12): 25% for the first 10 live copies, 50% until 20 copies with a positive live
// average, then full size. Applies to every route into A-book live, including the 2.75% Stage 2 rule.
export type Sizing = { multiplier: number; reason: string; probation?: number };

export function liveProbation(liveTrades: number, liveMeanR: number): number {
  if (liveTrades < 10) return 0.25;
  if (liveTrades < 20 || !(liveMeanR > 0)) return 0.5;
  return 1;
}

export function sizeMultiplier(book: "a" | "b", all: LedgerPoint[], stateSince: number, maxMultiplier: number,
  policy: Policy = POLICY_V1): Sizing {
  if (book === "a") {
    const live = all.filter((p) => p.closedAt >= stateSince);
    const e = evidence(live, (p) => p.sameR, policy.minEdgeR, policy);
    const probation = liveProbation(e.trades, e.mean);
    if (earlyWarning(live, (p) => p.sameR, policy)) return { multiplier: 1, reason: "early warning: recent live results negative", probation };
    if (e.trades >= 80 && e.dayLower > 0 && e.eValue >= 100) return { multiplier: Math.min(6, maxMultiplier), reason: "strongly confirmed live edge", probation };
    if (e.trades >= 40 && e.dayLower > 0) return { multiplier: Math.min(3, maxMultiplier), reason: "confirmed live edge", probation };
    return { multiplier: 1, reason: "new to A-book live", probation };
  }
  const recent = all.filter((p) => p.closedAt >= stateSince);
  if (earlyWarning(recent, (p) => p.reverseR, policy)) return { multiplier: 1, reason: "early warning: reverse results turning negative" };
  const e = evidence(all, (p) => p.reverseR, policy.minEdgeR, policy);
  if (e.eValue >= 1000 && e.dayLower > 0) return { multiplier: Math.min(3, maxMultiplier), reason: "very strong reverse evidence" };
  if (e.eValue >= 100 && e.dayLower > 0) return { multiplier: Math.min(2, maxMultiplier), reason: "strong reverse evidence" };
  return { multiplier: 1, reason: "reverse evidence at entry level" };
}

// Lots to send: scale the trader's own volume by the risk actually reserved, rounded DOWN to the broker step.
export function lotsFor(traderVolume: number, traderRiskUsd: number, reservedRiskUsd: number, lotStep: number, minQty: number): number {
  if (!(traderVolume > 0) || !(traderRiskUsd > 0) || !(reservedRiskUsd > 0)) return 0;
  const step = lotStep > 0 ? lotStep : 0.01;
  const raw = traderVolume * (reservedRiskUsd / traderRiskUsd);
  const lots = Math.floor((raw + 1e-9) / step) * step;
  return lots + 1e-9 >= minQty ? Number(lots.toFixed(6)) : 0;
}

// The broker leg's own emergency stop (IPFX decides every normal close). A-book: beyond the trader's stop.
// B-book: the reverse position loses when the trader wins, so the stop sits on the trader's profit side.
export function emergencyStop(book: "a" | "b", traderSide: "buy" | "sell", entry: number, traderSl: number, multiple = 3): number | null {
  const dist = Math.abs(entry - traderSl);
  if (!(dist > 0) || !(entry > 0)) return null;
  const legSide = book === "a" ? traderSide : (traderSide === "buy" ? "sell" : "buy");
  const stop = legSide === "buy" ? entry - multiple * dist : entry + multiple * dist;
  return stop > 0 ? stop : null;
}

export function legSide(book: "a" | "b", traderSide: "buy" | "sell"): "buy" | "sell" {
  return book === "a" ? traderSide : (traderSide === "buy" ? "sell" : "buy");
}

// ---------- funded-account sizing (v2) ----------
// Risk per copied trade is a share of the destination account's daily risk budget (about 2.5% of a $50K
// funded account, the simulated profit-maximising line), split across the signals expected per day and
// weighted by confidence, then held between the per-trade floor and ceiling. It is independent of the
// trader's own (smaller) account: a Stage 2 trader risking $17.50 is copied at about $125 (~7x).
export type Progress = "EARLY" | "STAGE2_PASSED" | "STAGE3_COMPLETE";
export type FundedLimits = { accountSizeUsd: number; dailyBudgetPct: number; perTradeMinPct: number; perTradeMaxPct: number };
export const PROGRESS_WEIGHT: Record<Progress, number> = { EARLY: 0.5, STAGE2_PASSED: 1.0, STAGE3_COMPLETE: 1.5 };

export function fundedRiskUsd(book: "a" | "b", lim: FundedLimits, expectedSignalsPerDay: number, progress: Progress, sizing: Sizing,
  treasury: "unknown" | "healthy" | "tight" | "short" = "unknown"):
  { riskUsd: number; weight: number; reason: string } {
  const base = lim.accountSizeUsd * (lim.dailyBudgetPct / 100) / Math.max(4, expectedSignalsPerDay);
  const warning = sizing.reason.startsWith("early warning");
  let weight: number;
  if (book === "a") {
    const confirmed = sizing.multiplier >= 6 ? 1.5 : sizing.multiplier >= 3 ? 1.25 : 1;
    weight = PROGRESS_WEIGHT[progress] * confirmed * (warning ? 1 / 3 : 1);
    // Treasury tilt (board rule, bounded): when cash for payouts is tight or short, move risk from the
    // least proven traders to the most proven ones. The per-trade ceiling and every hard cap still apply.
    if (treasury === "tight" || treasury === "short") weight *= progress === "EARLY" ? 0.5 : progress === "STAGE3_COMPLETE" ? 1.2 : 1;
  } else {
    weight = (sizing.multiplier >= 3 ? 1 : sizing.multiplier >= 2 ? 0.75 : 0.5) * (warning ? 1 / 3 : 1);
  }
  const floor = lim.accountSizeUsd * lim.perTradeMinPct / 100, ceil = lim.accountSizeUsd * lim.perTradeMaxPct / 100;
  // New-to-live probation is applied after the floor, so a new trader really is copied small.
  const probation = book === "a" ? Math.min(1, Math.max(0, sizing.probation ?? 1)) : 1;
  const riskUsd = Math.round(Math.min(ceil, Math.max(floor, base * weight)) * probation * 100) / 100;
  const note = probation < 1 ? `; new to live: ${Math.round(probation * 100)}% size` : "";
  return { riskUsd, weight: Number((weight * probation).toFixed(3)), reason: `${progress}; ${sizing.reason}${note}; ${expectedSignalsPerDay.toFixed(1)} signals/day; treasury ${treasury}` };
}
