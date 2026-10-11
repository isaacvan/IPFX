// Owner recommendations only. Uses the unchanged classifier; cannot dispatch or enable accounts.
import { decide, evidence, copyGap, type ClassifierInput, type Policy } from './ab-classifier.ts';
export function bLiveReview(input: ClassifierInput, policy: Policy, manual = false) {
  const valid = Number.isFinite(input.now) && Number.isFinite(input.stateSince) &&
    (input.lastAbExitAt == null || Number.isFinite(input.lastAbExitAt)) && input.points.every(p =>
      [p.closedAt,p.sameR,p.reverseR,p.holdSeconds].every(Number.isFinite) && p.closedAt <= input.now);
  const base = { policy_version: policy.version, basis: 'IPFX_QUOTE_REPLAY_NOT_E8_EXECUTION',
    broker_net_verified: false, can_enable_live: false, manual_override: manual };
  if (!valid) return { ...base, status: 'UNAVAILABLE', checks: [], reason: 'Invalid or future-dated evidence' };
  const rev = evidence(input.points,p=>p.reverseR,policy.minEdgeR,policy);
  const same = evidence(input.points,p=>p.sameR,policy.minEdgeR,policy);
  const gap = copyGap(input.points), day=86400000;
  const checks = [
    { label: 'Replayed trades', value: rev.trades, target: policy.minTrades, passed: rev.trades >= policy.minTrades },
    { label: 'Trading days', value: rev.days, target: policy.minDays, passed: rev.days >= policy.minDays },
    { label: 'Average reverse R', value: rev.mean, target: policy.minEdgeR, passed: rev.mean > policy.minEdgeR },
    { label: 'Daily lower bound', value: Number.isFinite(rev.dayLower)?rev.dayLower:null, target: 0, passed: rev.dayLower > 0 },
    { label: 'Evidence score', value: Math.min(rev.eValue,1e6), target: policy.eValueLive, passed: rev.eValue >= policy.eValueLive },
    { label: 'Largest reverse win share', value: rev.bestShare, target: policy.maxBestTradeShare, passed: rev.bestShare <= policy.maxBestTradeShare },
    { label: 'Days in current state', value: (input.now-input.stateSince)/day, target: policy.dwellDays, passed: input.now-input.stateSince >= policy.dwellDays*day },
    { label: 'A-book cool-off', value: input.lastAbExitAt == null ? null : (input.now-input.lastAbExitAt)/day,
      target: policy.coolOffDays, passed: input.lastAbExitAt == null || input.now-input.lastAbExitAt >= policy.coolOffDays*day },
    { label: 'Median hold seconds', value: same.medianHold, target: policy.minMedianHoldSeconds, passed: same.medianHold >= policy.minMedianHoldSeconds },
    { label: 'Share under 60 seconds', value: same.shareUnder60s, target: policy.maxShareUnder60s, passed: same.shareUnder60s <= policy.maxShareUnder60s },
    { label: 'Price-delay guard', value: gap.trades?gap.gap:null, target: Number.isFinite(policy.maxCopyGapR)?policy.maxCopyGapR:null,
      passed: !(gap.trades>=15 && gap.gap>policy.maxCopyGapR) },
  ];
  if (input.suspend || input.state==='SUSPENDED') return { ...base,status:'BLOCKED',checks,reason:'Integrity review takes priority' };
  if (input.state==='BB_LIVE') return { ...base,status:'SELECTED',checks,reason:'B-book live is selected; check destination and broker net separately' };
  if (input.state!=='BB_DEMO') return { ...base,status:'OTHER_MODEL',checks,reason:'Trader is currently in an A-book model' };
  // Reuse exact precedence, including A-demo and Stage 2 shortcut, rather than a second promotion policy.
  const decision=decide(input,policy);
  if (decision?.to==='BB_LIVE') return { ...base,status:'POLICY_REVIEW',checks,
    reason:manual?'Replay criteria met; your manual demo choice remains in place':'Replay criteria met; verify broker costs, destination and risk before live execution' };
  if (decision) return { ...base,status:'OTHER_MODEL',checks,reason:decision.reason };
  // Early watch uses the existing ten-trade trend window, not a new live threshold.
  const watch=input.points.length>=10 && same.mean<0 && rev.mean>policy.minEdgeR && rev.ewma>0;
  return { ...base,status:watch?'WATCH':'BUILDING',checks,
    reason:watch?'Trader loses in the replay while estimated reverse results are positive; more proof is needed':'Not enough consistent positive reverse evidence yet' };
}
