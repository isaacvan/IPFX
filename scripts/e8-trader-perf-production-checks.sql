-- Read-only deployment evidence. Run after all feature migrations in README order.
-- The management query endpoint returns only the final statement's result.
-- Run statements separately when collecting every diagnostic below.
select now() checked_at,c.computed_at,c.source_computed_at,
 now()-c.computed_at cache_age,c.metadata->'reconciliation' reconciliation,
 c.metadata->'timings_ms' timings_ms,c.metadata->>'version' code_version
from public.ab_e8_trader_perf_cache c where c.id=1;

select status,count(*) runs,max(finished_at) latest,
 max(extract(epoch from finished_at-started_at)) max_runtime_seconds
from public.ab_e8_trader_perf_runs group by status;

select count(*) people,
 count(*) filter(where (row_data->>'inference_trades')::int<30) insufficient_sample,
 count(*) filter(where (row_data->>'inference_trades')::int>=100) reportable_sample,
 count(*) filter(where row_data->>'evidence_class'='COPY_CANDIDATE') copy_candidates,
 count(*) filter(where row_data->>'evidence_class'='REVERSE_CANDIDATE') reverse_candidates
from public.ab_e8_trader_perf_trader_cache where latency=2 and slippage=0;

select role,has_function_privilege(role,'public.ab_e8_trader_perf_read(integer,integer,integer,integer,text,text,text,integer,text,boolean)','execute') can_read_rpc,
 has_function_privilege(role,'public.ab_e8_trader_perf_refresh_private(boolean)','execute') can_heavy_refresh,
 has_table_privilege(role,'public.ab_e8_trader_perf_trade_cache','SELECT') can_read_trade_table
from unnest(array['anon','authenticated','service_role'])role;

select octet_length(public.ab_e8_trader_perf_read()::text) first_page_bytes;

select jobname,schedule,active from cron.job where jobname in
('ipfx-e8-trader-perf','ipfx-e8-trader-perf-nightly','ipfx-e8-trader-perf-watchdog','ipfx-e8-trader-followup');

-- A cron SELECT may "succeed" even when a caught refresh failed. Match the
-- actual successful feature run to the autonomous cron interval as well.
select count(distinct d.runid) autonomous_successes,min(d.start_time) first_success,max(d.end_time) latest_success
from cron.job j join cron.job_run_details d on d.jobid=j.jobid
join public.ab_e8_trader_perf_runs r on r.started_at>=d.start_time and r.finished_at<=d.end_time
where j.jobname='ipfx-e8-trader-perf' and d.status='succeeded' and r.status='success'
and d.start_time>=(select updated_at from public.ab_e8_trader_perf_config where id=1);
