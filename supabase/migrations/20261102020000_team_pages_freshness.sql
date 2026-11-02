-- Team workspace freshness (owner request, 2 Nov 2026): Queues / Books / Treasury were not showing current data.
--  1. e8_event_quote_demands references e8_reference_quotes twice (ON DELETE SET NULL) with no index on either column, so every deleted
--     quote scanned that table twice and the nightly clean-up (ipfx-e8-reference-retention) timed out on 30, 31 Oct and 1 Nov.
--     The quote table then kept growing. Two indexes fix the clean-up.
--  2. e8_reference_summary() found "latest quote per symbol" with DISTINCT ON over the whole quote table (5.7 s, about 224,000 rows), which is
--     most of the 15 s the Treasury and Settings pages took to open. It now reads one row per symbol through the (account, symbol, time) index.
--     Same output, same order.
--  3. Treasury forecast every 15 minutes instead of hourly (the page was showing a figure up to an hour old); snapshots kept 3 days instead
--     of 30 so the larger number of snapshots does not pile up.
--  4. ipfx-e8-copy-backtest back on: the "Copied on E8" A-book / B-book results on the Books page were frozen at 24 Oct 23:20 because this
--     job was paused. It takes about 14 s every 10 minutes. The heavier individual-trader jobs stay paused (see the Books page notice).
begin;

create index if not exists e8_event_quote_demands_decision_quote_idx on public.e8_event_quote_demands(decision_quote_id);
create index if not exists e8_event_quote_demands_observed_quote_idx on public.e8_event_quote_demands(observed_quote_id);

create or replace function public.e8_reference_summary() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('account_totals',
 coalesce((select jsonb_agg(jsonb_build_object('account_id',p.account_id,'label',a.label,'last_attempt',p.last_state_attempt_at,'last_success',p.last_state_at,'error',p.state_error_code,
  'received_at',x.received_at,'age_seconds',extract(epoch from now()-x.received_at),
  'fresh',x.received_at<=now() and x.received_at>now()-interval '3 minutes',
  'amounts',x.amounts,'currency',x.currency,'period_basis',x.period_basis,'reconciliation',x.reconciliation,'trade_net_verified',false))
 from public.e8_monitor_profiles p join public.ladder_accounts a on a.id=p.account_id
 left join lateral(select * from public.e8_account_snapshots x where x.account_id=p.account_id order by received_at desc,id desc limit 1)x on true),'[]'::jsonb),
 'basis','OBSERVED_QUOTES_AND_BROKER_HISTORY_NOT_CONFIRMED_SIMULATOR_FILLS',
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',p.account_id,'label',a.label,'enabled',p.enabled,'status',p.status,
 'error_code',p.error_code,'history_error_code',p.history_error_code,'interval_ms',p.interval_ms,'last_run',p.last_run,'last_quote_at',p.last_quote_at,'last_history_at',p.last_history_at,
 'symbols',p.symbols,'instrument_costs',p.instrument_costs)) from public.e8_monitor_profiles p join public.ladder_accounts a on a.id=p.account_id),'[]'::jsonb),
 'quotes',coalesce((select jsonb_agg(to_jsonb(x) order by x.account_id,x.symbol) from (
   select q.account_id,q.symbol,q.bid,q.ask,q.ask-q.bid spread,q.received_at,q.requested_at,
    extract(epoch from now()-q.received_at)*1000 age_ms,p.max_quote_age_ms,
    (p.enabled and q.received_at<=now() and q.received_at>=now()-make_interval(secs=>p.max_quote_age_ms/1000.0)) fresh
   from public.e8_monitor_profiles p
   cross join lateral (
     with recursive s(symbol) as (
       (select min(r.symbol) from public.e8_reference_quotes r where r.account_id=p.account_id)
       union all
       select (select min(r.symbol) from public.e8_reference_quotes r where r.account_id=p.account_id and r.symbol>s.symbol) from s where s.symbol is not null)
     select s.symbol from s where s.symbol is not null) syms
   cross join lateral (select r.* from public.e8_reference_quotes r where r.account_id=p.account_id and r.symbol=syms.symbol order by r.received_at desc limit 1) q
 ) x),'[]'::jsonb),
 'fills',(select count(*) from public.cost_fills where role='monitor'),
 'fee_complete_fills',(select count(*) from public.cost_fills where role='monitor' and costs_complete),
 'revisions',(select count(*) from public.e8_fill_revisions));
$$;

select cron.alter_job(jobid, schedule := '7,22,37,52 * * * *') from cron.job where jobname='ipfx-treasury';
select cron.alter_job(jobid, command := $q$delete from public.treasury_snapshots where as_of < now() - interval '3 days'$q$) from cron.job where jobname='ipfx-treasury-purge';
select cron.alter_job(jobid, active := true) from cron.job where jobname='ipfx-e8-copy-backtest';
commit;
