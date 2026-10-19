-- Link subsequent observed trades to immutable classifications captured BEFORE entry.
-- Historical trades before first deployment never acquire a retrospective verdict.
begin;
create table if not exists public.ab_e8_trader_perf_decisions (
 trade_id uuid not null, latency int not null, slippage int not null,
 trader_id uuid not null, entry_at timestamptz not null, snapshot_id bigint not null references public.ab_e8_trader_perf_history(id),
 snapshot_captured_at timestamptz not null, config_version int not null, evidence_class text not null,
 decision jsonb not null, outcome_available_at timestamptz not null, a_net numeric, b_net numeric,
 primary key(trade_id,latency,slippage), check(snapshot_captured_at<entry_at)
);
create index if not exists ab_e8_trader_perf_decisions_person on public.ab_e8_trader_perf_decisions(trader_id,entry_at);
alter table public.ab_e8_trader_perf_decisions enable row level security;
revoke all on public.ab_e8_trader_perf_decisions from public,anon,authenticated;
grant select on public.ab_e8_trader_perf_decisions to service_role;

create or replace function public.ab_e8_trader_perf_immutable()
returns trigger language plpgsql set search_path to '' as $$
begin raise exception 'Captured trader evidence is append-only'; end $$;
create trigger ab_e8_trader_perf_decisions_frozen before update or delete on public.ab_e8_trader_perf_decisions
for each row execute function public.ab_e8_trader_perf_immutable();
create trigger ab_e8_trader_perf_history_frozen before update or delete on public.ab_e8_trader_perf_history
for each row execute function public.ab_e8_trader_perf_immutable();

create or replace function public.ab_e8_trader_perf_forward(p_asof timestamptz default now())
returns jsonb language plpgsql security definer set search_path to '' as $$
declare report jsonb;
begin
 insert into public.ab_e8_trader_perf_decisions(trade_id,latency,slippage,trader_id,entry_at,snapshot_id,
 snapshot_captured_at,config_version,evidence_class,decision,outcome_available_at,a_net,b_net)
 select c.trade_id,c.latency,c.slippage,c.trader_id,(c.payload->>'opened_at')::timestamptz,h.id,
 h.captured_at,h.config_version,h.row_data->>'evidence_class',h.row_data,p_asof,
 (c.payload->>'a_net')::numeric,(c.payload->>'b_net')::numeric
 from public.ab_e8_trader_perf_trade_cache c
 cross join lateral(select s.* from public.ab_e8_trader_perf_history s
 where s.trader_id=c.trader_id and s.latency=c.latency and s.slippage=c.slippage
 and s.snapshot_kind='captured_live' and s.input_cutoff<=s.captured_at
 and s.captured_at+make_interval(secs=>greatest(coalesce((s.config->>'embargo_seconds')::int,30),30))
 <=(c.payload->>'opened_at')::timestamptz
 order by s.captured_at desc,s.id desc limit 1)h
 where c.payload->>'reason' is null and (c.payload->>'closed_at')::timestamptz<=p_asof
 and c.computed_at<=p_asof
 on conflict(trade_id,latency,slippage) do nothing;

 with cells as(select l latency,s slippage from unnest(array[1,2,5,15])l cross join unnest(array[0,1,2])s),
 counts as(select c.latency,c.slippage,
 count(d.trade_id) observed_followups,
 count(distinct d.trader_id) filter(where d.evidence_class='COPY_CANDIDATE') copy_traders,
 count(distinct d.trader_id) filter(where d.evidence_class='REVERSE_CANDIDATE') reverse_traders,
 count(d.trade_id) filter(where d.evidence_class in('COPY_CANDIDATE','REVERSE_CANDIDATE')) trades,
 sum(d.a_net) filter(where d.evidence_class='COPY_CANDIDATE') a_net,
 sum(d.b_net) filter(where d.evidence_class='REVERSE_CANDIDATE') b_net,
 avg(case when d.evidence_class='COPY_CANDIDATE' then (d.a_net>0)::int
 when d.evidence_class='REVERSE_CANDIDATE' then (d.b_net>0)::int end) hit_rate,
 min(d.snapshot_captured_at) first_snapshot,
 avg(case when d.evidence_class in('COPY_CANDIDATE','REVERSE_CANDIDATE') then
 exists(select 1 from public.ab_e8_trader_perf_history later where later.trader_id=d.trader_id
 and later.latency=d.latency and later.slippage=d.slippage and later.captured_at>d.entry_at and later.captured_at<=p_asof
 and later.row_data->>'evidence_class'<>d.evidence_class)::int end) flip_share
 from cells c left join public.ab_e8_trader_perf_decisions d on d.latency=c.latency and d.slippage=c.slippage
 and d.outcome_available_at<=p_asof group by c.latency,c.slippage)
 select jsonb_object_agg(latency||':'||slippage,jsonb_build_object('available',true,
 'mode','Captured live classifications before subsequent entries; observed research follow-up',
 'reconstructed',false,'from',first_snapshot,'observed_followups',observed_followups,
 'copy_traders',copy_traders,'reverse_traders',reverse_traders,'trades',trades,
 'a_net',case when trades>0 then coalesce(a_net,0) end,'b_net',case when trades>0 then coalesce(b_net,0) end,
 'hit_rate',hit_rate,'flip_share',flip_share,
 'reason',case when trades=0 then 'No subsequent trades had a qualifying copy/reverse verdict captured before entry.' end,
 'limitations','Unconstrained research P&L, not live orders or a shared-account stopped portfolio. Outcomes are frozen at first observation.')) into report from counts;
 update public.ab_e8_trader_perf_cache set metadata=metadata||jsonb_build_object('walkforward_cells',report,
 'walkforward',report->'2:0') where id=1;
 return report;
end $$;
revoke all on function public.ab_e8_trader_perf_forward(timestamptz),public.ab_e8_trader_perf_immutable() from public,anon,authenticated,service_role;

-- A separate lightweight job links outcomes after the main calculation. It can be
-- retried safely: ON CONFLICT retains the first captured decision and outcome.
do $cron$ begin
 if exists(select 1 from pg_extension where extname='pg_cron') then
 perform cron.schedule('ipfx-e8-trader-followup','5,15,25,35,45,55 * * * *','select public.ab_e8_trader_perf_forward()');
 end if;
end $cron$;
commit;
