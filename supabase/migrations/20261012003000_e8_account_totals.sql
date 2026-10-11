-- Append-only, read-only broker totals. No fees invented per trade, policy or order changes.
alter table public.e8_monitor_profiles add column if not exists last_state_attempt_at timestamptz;
alter table public.e8_monitor_profiles add column if not exists last_state_at timestamptz;
alter table public.e8_monitor_profiles add column if not exists state_error_code text;
create table public.e8_account_snapshots (
 id bigint generated always as identity primary key,
 account_id bigint not null references public.e8_monitor_profiles(account_id),
 requested_at timestamptz not null,received_at timestamptz not null check(received_at>=requested_at),
 amounts jsonb not null check(jsonb_typeof(amounts)='object'),
 currency text check(currency ~ '^[A-Z]{3}$'),
 period_basis text not null check(period_basis='BROKER_TODAY_BOUNDARY_UNCONFIRMED'),
 reconciliation jsonb not null check(jsonb_typeof(reconciliation)='object'),
 trade_net_verified boolean not null default false check(not trade_net_verified)
);
create index e8_account_snapshots_latest on public.e8_account_snapshots(account_id,received_at desc,id desc);
alter table public.e8_account_snapshots enable row level security;
revoke all on public.e8_account_snapshots from public,anon,authenticated;
grant select,insert on public.e8_account_snapshots to service_role;
grant usage,select on sequence public.e8_account_snapshots_id_seq to service_role;
create trigger e8_account_snapshots_immutable before update or delete on public.e8_account_snapshots
 for each row execute function public.e8_revision_immutable();

-- LIVE_DEFINITIONS_FOLLOW
do $fence$ begin
 if md5(pg_get_functiondef('public.e8_monitor_take(text,text,jsonb)'::regprocedure))<>'d5756bf9588a51e6420d388d9827f393' or md5(pg_get_functiondef('public.e8_reference_summary()'::regprocedure))<>'669e2cba4e3d3f5310bb1bdc77e447bf' then raise exception 'E8_TOTALS_SOURCE_DRIFT';end if;
end $fence$;
CREATE OR REPLACE FUNCTION public.e8_monitor_take(p_scope text, p_route text, p_rules jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb; lim int; win int; used int; oldest timestamptz; t timestamptz:=clock_timestamp(); wait_ms numeric:=0;
begin
 if p_scope is null or length(p_scope)>200 or p_route is null or p_route not in('QUOTES','ORDERS_HISTORY','CONFIG','REFRESH','INSTRUMENT_DETAILS','ACCOUNT_STATE') or
 p_rules is null or jsonb_typeof(p_rules)<>'array' then return jsonb_build_object('ok',false,'wait_ms',10000); end if;
 if jsonb_array_length(p_rules)=0 then return jsonb_build_object('ok',false,'wait_ms',10000); end if;
 perform pg_advisory_xact_lock(hashtext('e8-monitor:'||p_scope));
 delete from public.e8_monitor_requests where scope=p_scope and at<t-interval '1 day';
 for r in select value from jsonb_array_elements(p_rules) loop
  if coalesce(r->>'limit','') !~ '^[1-9][0-9]{0,6}$' or coalesce(r->>'windowMs','') !~ '^[1-9][0-9]{0,7}$' or
   coalesce(r->>'type','')='' then return jsonb_build_object('ok',false,'wait_ms',10000); end if;
  lim:=greatest(1,floor((r->>'limit')::numeric*0.8)::int);win:=(r->>'windowMs')::int;
  if lim<1 or win<1 or win>86400000 then return jsonb_build_object('ok',false,'wait_ms',10000); end if;
  select count(*),min(at) into used,oldest from public.e8_monitor_requests
  where scope=p_scope and at>t-make_interval(secs=>win/1000.0)
  and ((r->>'type') in('GLOBAL','ALL','ALL_REQUESTS','GENERAL','TOTAL') or route=p_route);
  if used>=lim then wait_ms:=greatest(wait_ms,ceil(extract(epoch from oldest+make_interval(secs=>win/1000.0)-t)*1000)+10); end if;
 end loop;
 if wait_ms>0 then return jsonb_build_object('ok',false,'wait_ms',wait_ms); end if;
 insert into public.e8_monitor_requests(scope,route,at) values(p_scope,p_route,t);
 return jsonb_build_object('ok',true,'wait_ms',0);
end $function$
;
CREATE OR REPLACE FUNCTION public.e8_reference_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 'quotes',coalesce((select jsonb_agg(x) from (select distinct on(q.account_id,q.symbol) q.account_id,q.symbol,q.bid,q.ask,q.ask-q.bid spread,
 q.received_at,q.requested_at,extract(epoch from now()-q.received_at)*1000 age_ms,p.max_quote_age_ms,
 (p.enabled and q.received_at<=now() and q.received_at>=now()-make_interval(secs=>p.max_quote_age_ms/1000.0)) fresh
 from public.e8_reference_quotes q join public.e8_monitor_profiles p using(account_id) order by q.account_id,q.symbol,q.received_at desc)x),'[]'::jsonb),
 'fills',(select count(*) from public.cost_fills where role='monitor'),
 'fee_complete_fills',(select count(*) from public.cost_fills where role='monitor' and costs_complete),
 'revisions',(select count(*) from public.e8_fill_revisions));
$function$
;
