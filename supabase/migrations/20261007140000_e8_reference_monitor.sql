-- Independent read-only E8 reference monitoring. No demo-pool or MT5 migration dependency.
begin;
alter table public.cost_samples add column if not exists requested_at timestamptz;
alter table public.cost_samples add column if not exists received_at timestamptz;
alter table public.cost_samples add column if not exists ipfx_received_at timestamptz;
alter table public.cost_fills add column if not exists fee numeric;
alter table public.cost_fills add column if not exists costs_complete boolean not null default false;
alter table public.cost_fills add column if not exists observed_at timestamptz not null default now();
create table public.e8_monitor_profiles (
 account_id bigint primary key references public.ladder_accounts(id), enabled boolean not null default false,
 symbols text[] not null default array['EURUSD','GBPUSD','USDJPY','XAUUSD'],
 interval_ms int not null default 10000 check(interval_ms between 1000 and 60000),
 max_quote_age_ms int not null default 15000 check(max_quote_age_ms between 1000 and 60000),
 broker_config jsonb, rate_rules jsonb not null default '[]', config_at timestamptz,
 lease uuid, lease_until timestamptz, last_run timestamptz, last_quote_at timestamptz, last_history_at timestamptz,
 next_run timestamptz not null default now(), status text not null default 'NOT_CONFIGURED', error_code text, history_error_code text,
 scope text not null, instrument_costs jsonb not null default '{}', updated_at timestamptz not null default now()
);
create table public.e8_reference_quotes (
 id bigint generated always as identity primary key, account_id bigint not null references public.e8_monitor_profiles,
 symbol text not null, bid numeric not null check(bid>0), ask numeric not null check(ask>=bid),
 requested_at timestamptz not null, received_at timestamptz not null check(received_at>=requested_at),
 broker_quote_at timestamptz, source text not null default 'E8_TRADELOCKER_OBSERVED_QUOTE',
 unique(account_id,symbol,received_at)
);
create index e8_reference_lookup on public.e8_reference_quotes(account_id,symbol,received_at desc);
create table public.e8_fill_revisions (
 id bigint generated always as identity primary key, account_id bigint not null references public.ladder_accounts,
 ref text not null, revision_sha256 text not null, data jsonb not null, observed_at timestamptz not null default now(),
 unique(account_id,ref,revision_sha256)
);
create table public.e8_monitor_requests (scope text not null,route text not null,at timestamptz not null default clock_timestamp());
create index e8_monitor_request_window on public.e8_monitor_requests(scope,at);
-- Estimates are immutable and separate from actual broker fills/classification evidence.
create table public.e8_reference_projections (
 id uuid primary key, account_id bigint not null references public.e8_monitor_profiles,
 actor_id uuid not null, assumptions jsonb not null, result jsonb not null,
 created_at timestamptz not null default now()
);
create function public.e8_monitor_role_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.ladder_accounts where id=new.account_id and role='monitor' and not execution_enabled and platform='tradelocker') then
  raise exception 'E8 reference requires a read-only TradeLocker monitor account';
 end if;
 return new;
end $$;
create trigger e8_monitor_role_guard before insert or update on public.e8_monitor_profiles for each row execute function public.e8_monitor_role_guard();
create function public.e8_monitor_account_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.e8_monitor_profiles where account_id=new.id) and
  (new.role is distinct from 'monitor' or new.execution_enabled is distinct from false or new.platform is distinct from 'tradelocker') then
  raise exception 'An E8 reference account cannot be converted into an execution account';
 end if;
 return new;
end $$;
create trigger e8_monitor_account_guard before update on public.ladder_accounts for each row execute function public.e8_monitor_account_guard();
create function public.e8_monitor_claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.e8_monitor_profiles;
begin
 select m.* into p from public.e8_monitor_profiles m join public.ladder_accounts a on a.id=m.account_id
 where m.enabled and m.next_run<=now() and (m.lease_until is null or m.lease_until<now())
 and a.role='monitor' and not a.execution_enabled and a.platform='tradelocker'
 order by m.next_run,m.account_id for update of m skip locked limit 1;
 if not found then return null; end if;
 update public.e8_monitor_profiles set lease=gen_random_uuid(),lease_until=now()+interval '45 seconds',
 next_run=now()+make_interval(secs=>interval_ms/1000.0) where account_id=p.account_id returning * into p;
 return to_jsonb(p);
end $$;
create function public.e8_monitor_take(p_scope text,p_route text,p_rules jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb; lim int; win int; used int; oldest timestamptz; t timestamptz:=clock_timestamp(); wait_ms numeric:=0;
begin
 if p_scope is null or length(p_scope)>200 or p_route is null or p_route not in('QUOTES','ORDERS_HISTORY','CONFIG','REFRESH') or
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
end $$;
create function public.e8_reference_summary() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('basis','OBSERVED_QUOTES_AND_BROKER_HISTORY_NOT_CONFIRMED_SIMULATOR_FILLS',
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
$$;
create function public.kick_e8_reference() returns void language plpgsql security definer set search_path='' as $$
declare secret text;
begin
 if not exists(select 1 from public.e8_monitor_profiles where enabled and next_run<=now() and (lease_until is null or lease_until<now())) then return; end if;
 select decrypted_secret into secret from vault.decrypted_secrets where name='ipfx_cost_monitor_secret' limit 1;
 if secret is null then raise warning 'E8 monitor authentication not configured';return;end if;
 perform net.http_post(url:='https://agulweemteoeagscmppy.supabase.co/functions/v1/e8-reference',
 headers:=jsonb_build_object('Content-Type','application/json','x-cost-secret',secret),body:='{}',timeout_milliseconds:=40000);
end $$;
do $$ declare n text; begin
 foreach n in array array['e8_monitor_profiles','e8_reference_quotes','e8_fill_revisions','e8_monitor_requests','e8_reference_projections'] loop
  execute format('alter table public.%I enable row level security',n);
  execute format('revoke all on public.%I from public,anon,authenticated',n);
  execute format('grant select,insert,update,delete on public.%I to service_role',n);
 end loop;
end $$;
create function public.e8_revision_immutable() returns trigger language plpgsql as $$begin raise exception 'E8 fill history is append-only';end$$;
create trigger e8_revision_immutable before update or delete on public.e8_fill_revisions for each row execute function public.e8_revision_immutable();
create trigger e8_projection_immutable before update or delete on public.e8_reference_projections for each row execute function public.e8_revision_immutable();
revoke update,delete on public.e8_fill_revisions from service_role;
revoke update,delete on public.e8_reference_projections from service_role;
grant usage,select on sequence public.e8_reference_quotes_id_seq,public.e8_fill_revisions_id_seq to service_role;
revoke all on function public.e8_monitor_role_guard(),public.e8_monitor_account_guard(),public.e8_monitor_claim(),public.e8_monitor_take(text,text,jsonb),public.e8_reference_summary(),public.kick_e8_reference(),public.e8_revision_immutable() from public,anon,authenticated;
grant execute on function public.e8_monitor_claim(),public.e8_monitor_take(text,text,jsonb),public.e8_reference_summary(),public.kick_e8_reference() to service_role;
select cron.schedule('ipfx-e8-reference','10 seconds','select public.kick_e8_reference()');
select cron.schedule('ipfx-e8-reference-retention','43 3 * * *',
 $job$delete from public.e8_reference_quotes where received_at<now()-interval '7 days';delete from public.e8_monitor_requests where at<now()-interval '1 day';delete from public.cost_samples where account_id in(select account_id from public.e8_monitor_profiles) and sampled_at<now()-interval '7 days';$job$);
commit;
