-- Infinity v2 red-team fixes (30 Oct 2026, evidence: infinity-selection-study/v1_vs_v2/REPORT.md).
-- 1. v1 -> v2 switch: the v2 target is measured from the switch (v1 profit no longer counts toward it).
-- 2. Best day by the day a counted trade opened (closing either side of midnight no longer splits a winner).
-- 3. Stage 2 -> 3 requires a verified identity (setting, default on). Trading is never blocked.
-- Score thresholds (1.0 / 1.65 / 2.0 combined) are in the version row (20261029090000), not here.
begin;
alter table public.infinity_v2_settings add column if not exists stage3_requires_kyc boolean not null default true;
create or replace function public.infinity_v2_progress(p_account uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts;policy jsonb;stats record;combined record;unmet text[]:='{}';profit numeric;best numeric;target numeric;hold boolean;bad boolean;perf boolean:=false;out jsonb;
 pre_switch numeric;baseline numeric;id_required boolean:=false;
begin
 select * into a from public.trading_accounts where id=p_account;
 if a.rules_version is distinct from 'infinity_v2' then return jsonb_build_object('applies',false);end if;
 policy:=a.infinity_rules_snapshot;
 select count(*) filter(where valid) n,coalesce(avg(x.r),0) mean,coalesce(stddev_samp(x.r),0) sd,bool_or(not valid) bad into stats from public.infinity_v2_groups_result(a.id) x;
 with recursive chain as(select id,funded_from_account_id,user_id,stage from public.trading_accounts where id=a.id
 union all select p.id,p.funded_from_account_id,p.user_id,p.stage from public.trading_accounts p join chain c on p.id=c.funded_from_account_id
 where p.user_id=a.user_id and p.stage<c.stage)
 select count(*) n,coalesce(avg(g.r),0) mean,coalesce(stddev_samp(g.r),0) sd into combined from chain c
 join public.trading_accounts v on v.id=c.id and v.rules_version='infinity_v2'
 cross join lateral public.infinity_v2_groups_result(c.id) g where g.valid;
 -- Red-team fixes (30 Oct 2026):
 --  * Switch: only trades opened under v2 count toward the target and best day; the balance test starts from the higher of the
 --    starting balance and the closed balance at the switch, so v1 profit carried over cannot pay for the v2 target.
 --  * Best day: a counted trade's profit (partials included) belongs to the UTC day the counted trade OPENED, so closing one
 --    winner either side of midnight cannot split it into two days.
 select coalesce(sum(d),0),greatest(0,coalesce(max(d),0)) into profit,best from (
 select sum(case when t.pnl>0 and (t.closed_at-t.opened_at)<make_interval(secs=>(policy->>'min_hold_seconds')::int) then 0 else coalesce(t.pnl,0) end) d
 from public.trades t
 left join lateral(select min(g.opened_at) opened from public.trades g where g.account_id=a.id and g.infinity_group_id=t.infinity_group_id) grp on t.infinity_group_id is not null
 where t.account_id=a.id and t.status='closed' and t.opened_at>=a.rules_effective_at
 group by (coalesce(grp.opened,t.opened_at) at time zone 'UTC')::date) days;
 select coalesce(sum(t.pnl),0) into pre_switch from public.trades t where t.account_id=a.id and t.status='closed' and t.opened_at<a.rules_effective_at;
 baseline:=a.starting_balance+greatest(pre_switch,0);
 target:=round(a.starting_balance*(policy->>'target_pct')::numeric/100,2);
 hold:=coalesce(public.infinity_v2_review_hold(a.id),true);
 if exists(select 1 from public.trades where account_id=a.id and status='open') or exists(select 1 from public.pending_orders where account_id=a.id and status='pending') then unmet:=array_append(unmet,'NOT_FLAT');end if;
 if exists(select 1 from public.trades t where t.account_id=a.id and t.parent_trade_id is null and t.status='closed' and t.opened_at>=a.rules_effective_at and t.initial_risk_usd is null and t.close_reason is distinct from 'no_stop_loss') then unmet:=array_append(unmet,'OPENING_RISK_UNAVAILABLE');end if;
 if profit<target or a.balance<baseline+target then unmet:=array_append(unmet,'PROFIT_TARGET');end if;
 if stats.n<(policy->>'min_counted_trades')::int then unmet:=array_append(unmet,'COUNTED_TRADES');end if;
 if policy->>'stage_score' is not null and stats.mean*sqrt(stats.n)/greatest(stats.sd,(policy->>'sd_floor')::numeric)<(policy->>'stage_score')::numeric then unmet:=array_append(unmet,'STAGE_SCORE');end if;
 if policy->>'combined_score' is not null and combined.mean*sqrt(combined.n)/greatest(combined.sd,(policy->>'sd_floor')::numeric)<(policy->>'combined_score')::numeric then unmet:=array_append(unmet,'COMBINED_SCORE');end if;
 if policy->>'best_day_share' is not null and (profit<=0 or best/profit>(policy->>'best_day_share')::numeric) then unmet:=array_append(unmet,'BEST_DAY');end if;
 if hold then unmet:=array_append(unmet,'INTEGRITY_REVIEW');end if;
 -- Stage 3 needs a verified identity (setting stage3_requires_kyc). The account keeps trading; only the pass waits.
 if a.stage=2 and coalesce((select s.stage3_requires_kyc from public.infinity_v2_settings s where s.singleton),true)
    and not exists(select 1 from public.trader_kyc k where k.user_id=a.user_id and k.status='verified') then
   id_required:=true;unmet:=array_append(unmet,'IDENTITY_VERIFICATION');
 end if;
 if a.stage=4 then
   select exists(select 1 from(select sum(g.pnl) over(order by g.closed_at,g.group_id rows between ((policy->>'performance_window')::int-1) preceding and current row) loss,
    count(*) over(order by g.closed_at,g.group_id rows between ((policy->>'performance_window')::int-1) preceding and current row) n from public.infinity_v2_groups_result(a.id) g where g.valid) w
    where w.n=(policy->>'performance_window')::int and w.loss<=-a.starting_balance*(policy->>'performance_loss_pct')::numeric/100) into perf;
   if perf then unmet:=array_append(unmet,'PERFORMANCE_BREACH');end if;
 end if;
 out:=jsonb_build_object('applies',true,'eligible',cardinality(unmet)=0,'unmet',unmet,'n',stats.n,'score',stats.mean*sqrt(stats.n)/greatest(stats.sd,(policy->>'sd_floor')::numeric),
 'combined_score',combined.mean*sqrt(combined.n)/greatest(combined.sd,(policy->>'sd_floor')::numeric),'counted_profit',profit,'target',target,
 'best_day_share',case when profit>0 then best/profit end,'rules',policy,'performance_breach',perf,'integrity_hold',hold,
 'target_baseline',baseline,'identity_required',id_required);
 insert into public.infinity_v2_progress_cache(account_id,result,dirty,updated_at) values(a.id,out,false,clock_timestamp())
 on conflict(account_id) do update set result=excluded.result,dirty=false,updated_at=excluded.updated_at;
 return out;
end $$;
-- Every cached result was computed by the old rules: recompute before anything reads it.
update public.infinity_v2_progress_cache set dirty=true where dirty is distinct from true;
commit;
