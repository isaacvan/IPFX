-- Policy v3 (overnight stress tests 2026-10-04). Same as v2 plus two guards on the automatic 2.75% rule:
--  * the trader needs 15 replayed trades whose copies (after broker costs) average >= 0R, and
--  * the feed-lag fingerprint (IPFX result minus copy result > 0.10R over 15+ trades) blocks any promotion.
-- Digital twin, 8 seeds x 6 months: latency gamers -$2,646 -> +$1,541 (gamers promoted 58 -> 0); honest base unchanged.
update public.ab_policy_versions set status = 'RETIRED' where version = 2 and status = 'ACTIVE';
insert into public.ab_policy_versions (version, status, thresholds, note) values (3, 'ACTIVE',
  '{"minDays":20,"minTrades":40,"minEdgeR":0.02,"zLower":1.645,"eValuePromote":10,"eValueLive":10,"maxBestTradeShare":0.3,
    "minMedianHoldSeconds":60,"maxShareUnder60s":0.5,"dwellDays":5,"coolOffDays":10,"liveFlipMinTrades":10,"abFailTrades":80,
    "ewmaAlpha":0.1,"abDemoteEwma":-0.05,"stage2AutoPct":2.75,"stage2AutoTarget":"AB_LIVE",
    "stage2AutoMinTrades":15,"stage2AutoMinCopyR":0,"maxCopyGapR":0.1}',
  'Overnight stress tests: 2.75% rule only for traders whose copies are profitable after costs; feed-lag fingerprint blocks promotion.')
on conflict (version) do nothing;
