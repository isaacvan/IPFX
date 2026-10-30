-- Copy-book policy v5 (red-team fixes, 30 Oct 2026; evidence: infinity-selection-study/v1_vs_v2/REPORT.md).
--  * Start gate: the Stage 2 "2.75% profit" rule is replaced by a run-wide consistency score >= 2.33 over >= 80 counted trades
--    (every counted trade since the current Infinity run began, across stages). Copying at Stage 2 entry picked 52% traders who
--    lose money when copied; the gate picks Stage 3 quality (5.7%, +0.18R) about 40 days sooner.
--  * Identity verified before any A-book state.
--  * Kill switch: stop copying when the copies score <= -1.0 after 40 copied trades, or fall 12R from their peak.
--  * The gate starts a DEMO copy test (AB_DEMO), not live copying: walk-forward on E8 shadow prices (copy_check.py) found that
--    traders profitable on their earlier trades did not stay profitable when copied (later copies -0.40R; persistence 0.05).
--    Live copying (AB_LIVE) still needs the existing prospective test: 40 copied trades over 20 days with e-value >= 10.
-- Inserted as DRAFT: nothing changes until the owner activates it (see docs/infinity-v2/GO-LIVE.md):
--   update public.ab_policy_versions set status='RETIRED' where status='ACTIVE';
--   update public.ab_policy_versions set status='ACTIVE' where version=5;
begin;

-- Inputs for the gate, read by the ab-classifier every run. Current run = the person's most recent Infinity Stage 1 account and
-- every stage created from it (funded_from_account_id chain). Service role only.
create or replace function public.ab_copy_gate_inputs()
returns table(person_id uuid, run_started_at timestamptz, run_accounts uuid[], kyc_verified boolean)
language sql stable security definer set search_path = '' as $$
  with recursive starts as (
    select distinct on (public.ab_person_of(a.user_id)) public.ab_person_of(a.user_id) as person, a.id, a.created_at
    from public.trading_accounts a
    where a.challenge_type = 'infinity' and a.stage = 1
    order by public.ab_person_of(a.user_id), a.created_at desc, a.id
  ), runs as (
    select s.person, s.created_at as started, s.id as acct, 1 as depth from starts s
    union all
    select r.person, r.started, c.id, r.depth + 1 from runs r
    join public.trading_accounts c on c.funded_from_account_id = r.acct
    where r.depth < 6
  ), kyc as (
    select distinct public.ab_person_of(k.user_id) as person from public.trader_kyc k where k.status = 'verified'
  )
  select r.person, min(r.started), array_agg(distinct r.acct), exists(select 1 from kyc where kyc.person = r.person)
  from runs r group by r.person;
$$;
revoke all on function public.ab_copy_gate_inputs() from public, anon, authenticated;
grant execute on function public.ab_copy_gate_inputs() to service_role;

insert into public.ab_policy_versions (version, status, thresholds, note) values (5, 'DRAFT',
  '{"minDays":20,"minTrades":40,"minEdgeR":0.02,"zLower":1.645,"eValuePromote":10,"eValueLive":10,"maxBestTradeShare":0.3,
    "minMedianHoldSeconds":60,"maxShareUnder60s":0.5,"dwellDays":5,"coolOffDays":10,"liveFlipMinTrades":10,"abFailTrades":80,
    "ewmaAlpha":0.1,"abDemoteEwma":-0.05,"stage2AutoPct":2.75,"stage2AutoTarget":"AB_DEMO",
    "stage2AutoMinTrades":15,"stage2AutoMinCopyR":0,"maxCopyGapR":0.1,"herdBlocksAuto":true,
    "gateRunScore":2.33,"gateRunMinCounted":80,"gateRequireKyc":true,"killCopyScore":-1,"killMinCopied":40,"killDrawdownR":12}',
  'Red team 30 Oct 2026: run-wide score gate (2.33 over 80 counted trades) replaces the 2.75% Stage 2 rule and starts a demo copy test; identity before copying; copy kill switch (score <= -1 after 40, or -12R).')
on conflict (version) do nothing;
commit;
