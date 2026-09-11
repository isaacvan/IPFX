// IPFX Capital — interpretable trader strategy fingerprinting.
// Descriptive evidence only: this module never blocks trades, fails accounts,
// or claims intent. Labels describe repeatable behaviour visible in trade history.

export interface StrategyTrade {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  openedAt: Date;
  closedAt: Date;
  volume: number;
  entryPrice: number;
  exitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  pnl: number | null;
}

export type StrategyLabel =
  | "scalping" | "intraday" | "swing"
  | "instrument_specialist" | "directional_long" | "directional_short"
  | "session_specialist" | "systematic_sizing" | "adaptive_sizing"
  | "stop_defined" | "target_defined" | "scale_in"
  | "rapid_post_loss_resizing";

export interface LabelEvidence {
  label: StrategyLabel;
  score: number;
  confidence: "low" | "medium" | "high";
  summary: string;
  metrics: Record<string, number | string>;
}

export interface StrategyFingerprint {
  version: 1;
  status: "insufficient_evidence" | "descriptive";
  sampleSize: number;
  coverage: number;
  primaryStyle: "scalping" | "intraday" | "swing" | "mixed" | "insufficient_evidence";
  labels: LabelEvidence[];
  features: {
    medianHoldMinutes: number | null;
    p90HoldMinutes: number | null;
    tradesPerActiveDay: number | null;
    longShare: number | null;
    topSymbol: string | null;
    topSymbolShare: number | null;
    symbolConcentrationHhi: number | null;
    topSession: string | null;
    topSessionShare: number | null;
    stopUseRate: number | null;
    targetUseRate: number | null;
    medianRewardRisk: number | null;
    sizeCoefficientVariation: number | null;
    scaleInRate: number | null;
    rapidPostLossRate: number | null;
    medianPostLossSizeRatio: number | null;
  };
  limitations: string[];
}

const finite = (n: number) => Number.isFinite(n);
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i]! : (s[i - 1]! + s[i]!) / 2;
};
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const ratio = (n: number, d: number) => d > 0 ? n / d : 0;

function sessionName(date: Date): string {
  const h = date.getUTCHours();
  if (h >= 13 && h < 16) return "London / New York overlap";
  if (h >= 7 && h < 13) return "London";
  if (h >= 16 && h < 22) return "New York";
  if (h >= 0 && h < 7) return "Asia";
  return "Off-hours";
}

function confidence(score: number, n: number, coverage: number): "low" | "medium" | "high" {
  const support = clamp01(n / 40) * coverage * score;
  return support >= 0.7 ? "high" : support >= 0.4 ? "medium" : "low";
}

export function detectStrategyFingerprint(input: StrategyTrade[]): StrategyFingerprint {
  const trades = input
    .filter((t) => t.openedAt instanceof Date && t.closedAt instanceof Date && finite(t.openedAt.getTime()) && finite(t.closedAt.getTime()) && t.closedAt >= t.openedAt && finite(t.volume) && t.volume > 0)
    .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
  const n = trades.length;
  const complete = trades.filter((t) => finite(t.entryPrice) && t.entryPrice > 0 && t.pnl !== null && finite(t.pnl)).length;
  const coverage = n ? complete / n : 0;
  const limitations = [
    "Labels describe observed execution behaviour, not a trader's intent or skill.",
    "Trend-following, breakout and mean-reversion claims require timestamped market-context features that are not available here.",
    "Use the profile for review and segmentation only; never as an automatic failure or accusation.",
  ];

  const empty: StrategyFingerprint = {
    version: 1, status: "insufficient_evidence", sampleSize: n, coverage,
    primaryStyle: "insufficient_evidence", labels: [],
    features: { medianHoldMinutes:null,p90HoldMinutes:null,tradesPerActiveDay:null,longShare:null,topSymbol:null,topSymbolShare:null,symbolConcentrationHhi:null,topSession:null,topSessionShare:null,stopUseRate:null,targetUseRate:null,medianRewardRisk:null,sizeCoefficientVariation:null,scaleInRate:null,rapidPostLossRate:null,medianPostLossSizeRatio:null },
    limitations,
  };
  if (!n) return empty;

  const holds = trades.map((t) => (t.closedAt.getTime() - t.openedAt.getTime()) / 60000);
  const medianHold = median(holds)!;
  const p90Hold = percentile(holds, .9)!;
  const activeDays = new Set(trades.map((t) => t.openedAt.toISOString().slice(0, 10))).size;
  const longShare = trades.filter((t) => t.side === "buy").length / n;
  const stopRate = trades.filter((t) => t.stopLoss !== null && finite(t.stopLoss)).length / n;
  const targetRate = trades.filter((t) => t.takeProfit !== null && finite(t.takeProfit)).length / n;

  const bySymbol = new Map<string, number>();
  const bySession = new Map<string, number>();
  for (const t of trades) {
    bySymbol.set(t.symbol, (bySymbol.get(t.symbol) ?? 0) + 1);
    const session = sessionName(t.openedAt);
    bySession.set(session, (bySession.get(session) ?? 0) + 1);
  }
  const top = (m: Map<string, number>): [string | null, number] => {
    const first = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return first ? [first[0], first[1] / n] : [null, 0];
  };
  const [topSymbol, topSymbolShare] = top(bySymbol);
  const [topSession, topSessionShare] = top(bySession);
  const hhi = [...bySymbol.values()].reduce((sum, count) => sum + (count / n) ** 2, 0);

  const sizes = trades.map((t) => t.volume);
  const sizeMean = mean(sizes);
  const sizeVariance = sizes.length > 1 ? sizes.reduce((s, x) => s + (x - sizeMean) ** 2, 0) / (sizes.length - 1) : 0;
  const sizeCv = sizeMean > 0 ? Math.sqrt(sizeVariance) / sizeMean : null;

  const rr = trades.flatMap((t) => {
    if (t.stopLoss === null || t.takeProfit === null) return [];
    const risk = Math.abs(t.entryPrice - t.stopLoss), reward = Math.abs(t.takeProfit - t.entryPrice);
    return risk > 0 && finite(risk) && finite(reward) ? [reward / risk] : [];
  });

  let scaleIn = 0, comparableSequence = 0, rapidPostLoss = 0;
  const postLossRatios: number[] = [];
  for (let i = 1; i < trades.length; i++) {
    const prev = trades[i - 1]!, cur = trades[i]!;
    const gapMinutes = (cur.openedAt.getTime() - prev.openedAt.getTime()) / 60000;
    comparableSequence++;
    if (cur.symbol === prev.symbol && cur.side === prev.side && gapMinutes >= 0 && gapMinutes <= 30 && cur.openedAt < prev.closedAt) scaleIn++;
    if (prev.pnl !== null && prev.pnl < 0) {
      const sinceClose = (cur.openedAt.getTime() - prev.closedAt.getTime()) / 60000;
      if (sinceClose >= 0 && sinceClose <= 15) rapidPostLoss++;
      if (prev.volume > 0) postLossRatios.push(cur.volume / prev.volume);
    }
  }
  const scaleInRate = ratio(scaleIn, comparableSequence);
  const losingTradesWithSuccessor = postLossRatios.length;
  const rapidPostLossRate = ratio(rapidPostLoss, losingTradesWithSuccessor);
  const postLossSizeRatio = median(postLossRatios);

  const labels: LabelEvidence[] = [];
  const add = (label: StrategyLabel, score: number, summary: string, metrics: Record<string, number | string>) => {
    const normalized = clamp01(score);
    labels.push({ label, score: normalized, confidence: confidence(normalized, n, coverage), summary, metrics });
  };

  const scalpShare = holds.filter((m) => m <= 15).length / n;
  const intradayShare = holds.filter((m) => m <= 24 * 60).length / n;
  let primaryStyle: StrategyFingerprint["primaryStyle"] = "mixed";
  if (n >= 8 && scalpShare >= .65) { primaryStyle = "scalping"; add("scalping", scalpShare, `${Math.round(scalpShare*100)}% of trades closed within 15 minutes.`, { scalpShare, medianHoldMinutes: medianHold }); }
  else if (n >= 8 && intradayShare >= .7) { primaryStyle = "intraday"; add("intraday", intradayShare, `${Math.round(intradayShare*100)}% of trades closed within one day.`, { intradayShare, medianHoldMinutes: medianHold }); }
  else if (n >= 8 && medianHold >= 24 * 60) { primaryStyle = "swing"; add("swing", clamp01(medianHold / (3*24*60)), `Median holding time is ${(medianHold/1440).toFixed(1)} days.`, { medianHoldMinutes: medianHold, p90HoldMinutes: p90Hold }); }

  if (n >= 8 && topSymbol && topSymbolShare >= .6) add("instrument_specialist", topSymbolShare, `${Math.round(topSymbolShare*100)}% of trades use ${topSymbol}.`, { topSymbol, topSymbolShare, hhi });
  if (n >= 8 && longShare >= .75) add("directional_long", longShare, `${Math.round(longShare*100)}% of trades are long.`, { longShare });
  if (n >= 8 && longShare <= .25) add("directional_short", 1-longShare, `${Math.round((1-longShare)*100)}% of trades are short.`, { shortShare:1-longShare });
  if (n >= 8 && topSession && topSessionShare >= .6) add("session_specialist", topSessionShare, `${Math.round(topSessionShare*100)}% of entries occur in the ${topSession} session.`, { topSession, topSessionShare });
  if (n >= 10 && sizeCv !== null && sizeCv <= .25) add("systematic_sizing", 1-sizeCv, `Position size is highly consistent (CV ${sizeCv.toFixed(2)}).`, { sizeCoefficientVariation:sizeCv });
  if (n >= 10 && sizeCv !== null && sizeCv >= .75) add("adaptive_sizing", clamp01(sizeCv/1.5), `Position size varies materially (CV ${sizeCv.toFixed(2)}).`, { sizeCoefficientVariation:sizeCv });
  if (n >= 8 && stopRate >= .8) add("stop_defined", stopRate, `${Math.round(stopRate*100)}% of trades record a stop loss.`, { stopUseRate:stopRate });
  if (n >= 8 && targetRate >= .8) add("target_defined", targetRate, `${Math.round(targetRate*100)}% of trades record a take-profit target.`, { targetUseRate:targetRate });
  if (n >= 10 && scaleInRate >= .2) add("scale_in", clamp01(scaleInRate*2), `${Math.round(scaleInRate*100)}% of adjacent trades add to an overlapping same-direction position.`, { scaleInRate });
  if (losingTradesWithSuccessor >= 5 && rapidPostLossRate >= .3 && (postLossSizeRatio ?? 0) >= 1.5) add("rapid_post_loss_resizing", clamp01((rapidPostLossRate + Math.min((postLossSizeRatio ?? 1)/3,1))/2), `After losses, ${Math.round(rapidPostLossRate*100)}% of next entries occur within 15 minutes and median size rises ${postLossSizeRatio!.toFixed(2)}×. Review context before drawing conclusions.`, { rapidPostLossRate, medianPostLossSizeRatio:postLossSizeRatio! });

  labels.sort((a,b)=>b.score-a.score || a.label.localeCompare(b.label));
  return {
    version:1, status:n>=8 ? "descriptive" : "insufficient_evidence", sampleSize:n, coverage,
    primaryStyle:n>=8 ? primaryStyle : "insufficient_evidence", labels:n>=8 ? labels : [],
    features:{medianHoldMinutes:medianHold,p90HoldMinutes:p90Hold,tradesPerActiveDay:ratio(n,activeDays),longShare,topSymbol,topSymbolShare,symbolConcentrationHhi:hhi,topSession,topSessionShare,stopUseRate:stopRate,targetUseRate:targetRate,medianRewardRisk:median(rr),sizeCoefficientVariation:sizeCv,scaleInRate,rapidPostLossRate,medianPostLossSizeRatio:postLossSizeRatio},
    limitations,
  };
}

export function fingerprintDistance(a: StrategyFingerprint, b: StrategyFingerprint): number | null {
  if (a.status !== "descriptive" || b.status !== "descriptive") return null;
  const keys: (keyof StrategyFingerprint["features"])[] = ["medianHoldMinutes","tradesPerActiveDay","longShare","topSymbolShare","symbolConcentrationHhi","topSessionShare","stopUseRate","targetUseRate","medianRewardRisk","sizeCoefficientVariation","scaleInRate","rapidPostLossRate"];
  const scales: Partial<Record<keyof StrategyFingerprint["features"],number>> = {medianHoldMinutes:1440,tradesPerActiveDay:10,medianRewardRisk:3,sizeCoefficientVariation:1.5};
  const diffs:number[]=[];
  for(const key of keys){const x=a.features[key],y=b.features[key];if(typeof x==="number"&&typeof y==="number"&&finite(x)&&finite(y)){diffs.push(Math.min(Math.abs(x-y)/(scales[key]??1),1));}}
  return diffs.length>=6 ? Math.sqrt(diffs.reduce((s,d)=>s+d*d,0)/diffs.length) : null;
}

export interface StrategyProfileRecord { traderId: string; profile: StrategyFingerprint; }
export interface StrategyCohort { memberIds: string[]; maximumWithinCohortDistance: number; }

/** Deterministic complete-link grouping. Every member must be within the
 * threshold of every other member, preventing a chain of weak matches from
 * merging two otherwise different strategy families. */
export function clusterStrategyCohorts(records: StrategyProfileRecord[], maxDistance = .25, minSize = 2): StrategyCohort[] {
  if (!(maxDistance >= 0 && maxDistance <= 1)) throw new RangeError("maxDistance must be within [0,1]");
  if (!Number.isInteger(minSize) || minSize < 2) throw new RangeError("minSize must be an integer >= 2");
  const eligible = [...records]
    .filter((r) => r.profile.status === "descriptive")
    .sort((a,b) => a.traderId.localeCompare(b.traderId));
  const cohorts: StrategyProfileRecord[][] = [];
  for (const candidate of eligible) {
    const cohort = cohorts.find((group) => group.every((member) => {
      const d = fingerprintDistance(candidate.profile, member.profile);
      return d !== null && d <= maxDistance;
    }));
    if (cohort) cohort.push(candidate); else cohorts.push([candidate]);
  }
  return cohorts.filter((group) => group.length >= minSize).map((group) => {
    let maximum = 0;
    for(let i=0;i<group.length;i++) for(let j=i+1;j<group.length;j++) maximum=Math.max(maximum,fingerprintDistance(group[i]!.profile,group[j]!.profile)??1);
    return {memberIds:group.map((r)=>r.traderId),maximumWithinCohortDistance:maximum};
  }).sort((a,b)=>a.memberIds[0]!.localeCompare(b.memberIds[0]!));
}

export interface StrategyDrift { distance: number; label: "stable" | "evolving" | "material_change"; }
export function strategyDrift(previous: StrategyFingerprint, current: StrategyFingerprint): StrategyDrift | null {
  const distance=fingerprintDistance(previous,current);
  if(distance===null) return null;
  return {distance,label:distance<.15?"stable":distance<.35?"evolving":"material_change"};
}
