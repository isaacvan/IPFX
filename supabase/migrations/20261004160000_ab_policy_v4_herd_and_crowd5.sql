-- Policy v4 + crowding cap 5 (overnight stress tests 2026-10-04, digital twin with correlated same-instrument
-- outcomes, 8 seeds x 6 months):
--   herd scenario:  cap 3 +$2,013 | cap 3 + herd block +$2,925 | cap 5 + herd block +$4,758 (0 account breaches)
--   normal markets: no cap +$25,945 | cap 3 +$18,961 | cap 5 +$24,951 (cap 3 blocked too many independent trades)
--   news shocks:    cap 3 -$540     | cap 5 + herd block -$176
update public.ab_risk_limits set crowd_max = 5 where crowd_max = 3;
alter table public.ab_risk_limits alter column crowd_max set default 5;
update public.ab_policy_versions set status = 'RETIRED' where version = 3 and status = 'ACTIVE';
insert into public.ab_policy_versions (version, status, thresholds, note) values (4, 'ACTIVE',
  '{"minDays":20,"minTrades":40,"minEdgeR":0.02,"zLower":1.645,"eValuePromote":10,"eValueLive":10,"maxBestTradeShare":0.3,
    "minMedianHoldSeconds":60,"maxShareUnder60s":0.5,"dwellDays":5,"coolOffDays":10,"liveFlipMinTrades":10,"abFailTrades":80,
    "ewmaAlpha":0.1,"abDemoteEwma":-0.05,"stage2AutoPct":2.75,"stage2AutoTarget":"AB_LIVE",
    "stage2AutoMinTrades":15,"stage2AutoMinCopyR":0,"maxCopyGapR":0.1,"herdBlocksAuto":true}',
  'Overnight stress tests: members of a co-trading cluster (3+ people opening the same trades) need full evidence, not the 2.75% rule.')
on conflict (version) do nothing;
