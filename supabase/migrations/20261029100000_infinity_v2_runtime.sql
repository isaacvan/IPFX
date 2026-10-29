begin;
-- All v2 enforcement is server-side. Legacy functions remain the v1 branches.
alter table public.trades add column infinity_group_id uuid, add column initial_volume numeric,add column execution_rules_version text,add column infinity_pending_id uuid;
create table public.infinity_v2_groups(id uuid primary key default gen_random_uuid(),account_id uuid not null references public.trading_accounts,
 symbol text not null,side text not null,last_entry timestamptz not null);
create index infinity_v2_group_stream on public.infinity_v2_groups(account_id,symbol,side,last_entry desc);
create index infinity_v2_trade_group on public.trades(infinity_group_id);
create table public.infinity_v2_pauses(account_id uuid not null references public.trading_accounts,symbol text not null,until_at timestamptz not null,primary key(account_id,symbol));
create table public.infinity_v2_progress_cache(account_id uuid primary key references public.trading_accounts,result jsonb not null,dirty boolean not null default true,updated_at timestamptz not null default now());
create table public.infinity_v2_review_clearances(account_id uuid not null references public.trading_accounts,alert_key text not null,evidence_at timestamptz not null,reviewed_by uuid not null,reason text not null,created_at timestamptz not null default now(),primary key(account_id,alert_key,evidence_at));
create trigger infinity_v2_clearances_frozen before update or delete on public.infinity_v2_review_clearances for each row execute function public.infinity_v2_append_only();

create function public.infinity_v2_price(p_symbol text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare q public.live_quotes;r record;profile public.infinity_v2_pricing_profiles;width numeric;defaults jsonb;
begin
 select rules into defaults from public.infinity_rules_versions where id='infinity_v2';
 select * into q from public.live_quotes where symbol=p_symbol;
 if not found then return null;end if;
 select * into profile from public.infinity_v2_pricing_profiles where symbol=p_symbol;
 select e.* into r from public.e8_reference_quotes e join public.e8_monitor_profiles m on m.account_id=e.account_id and m.enabled
 where e.symbol=p_symbol and e.received_at between clock_timestamp()-make_interval(secs=>(defaults->>'reference_max_age_ms')::numeric/1000) and clock_timestamp()
 and e.requested_at>=clock_timestamp()-make_interval(secs=>(defaults->>'reference_max_age_ms')::numeric/1000) and e.ask>e.bid order by e.received_at desc limit 1;
 if found then width:=(r.ask-r.bid)*coalesce(profile.spread_markup,(defaults->>'default_spread_markup')::numeric);
 else width:=q.ask-q.bid;end if;
 return jsonb_build_object('bid',q.mid-width/2,'ask',q.mid+width/2,'spread',width,'fallback',r.id is null,
  'commission',profile.commission_round_turn_per_lot,'min_lot',coalesce(profile.min_lot,0.01));
end $$;
create function public.infinity_v2_usd_scale(p_symbol text) returns numeric language plpgsql stable security definer set search_path='' as $$
declare spec public.symbol_specs;fx public.live_quotes;v numeric;
begin
 select * into spec from public.symbol_specs where symbol=p_symbol;
 if not found or spec.contract_size<=0 then return null;end if;
 if spec.quote_currency='USD' then return spec.contract_size;end if;
 select * into fx from public.live_quotes where symbol=case spec.quote_currency
 when 'JPY' then 'USDJPY' when 'GBP' then 'GBPUSD' when 'CAD' then 'USDCAD' when 'CHF' then 'USDCHF'
 when 'EUR' then 'EURUSD' when 'AUD' then 'AUDUSD' when 'NZD' then 'NZDUSD' end;
 if not found or fx.mid<=0 or fx.received_at<clock_timestamp()-interval '8 seconds' or fx.received_at>clock_timestamp()+interval '2 seconds' then return null;end if;
 v:=case when spec.quote_currency in('GBP','EUR','AUD','NZD') then fx.mid else 1/fx.mid end;
 return spec.contract_size*v;
end $$;

create function public.infinity_v2_trade_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts;g public.infinity_v2_groups;root public.trades;p jsonb;scale numeric;mark numeric;eq numeric;
 lim numeric;room numeric;total numeric;margin numeric;group_risk numeric;proposed numeric;other record;r jsonb;
begin
 select * into a from public.trading_accounts where id=new.account_id;
 -- A legacy fill already in flight must serialize with a voluntary switch or
 -- restart too. Keep the legacy fast path while new v2 starts are disabled.
 if a.challenge_type='infinity' and (a.rules_version='infinity_v2' or exists(
   select 1 from public.infinity_v2_settings where singleton and infinity_v2_enabled and clock_timestamp()>=cutover_at)) then
   select * into a from public.trading_accounts where id=new.account_id for update;
 end if;
 if new.status='open' and a.access_revoked_reason='voluntary_infinity_v2_restart' then raise exception 'ACCOUNT_FROZEN';end if;
 if a.rules_version is distinct from 'infinity_v2' then return new;end if;
 r:=a.infinity_rules_snapshot;
 if new.parent_trade_id is not null then
   select * into root from public.trades where id=new.parent_trade_id and account_id=a.id;
   if not found or new.status<>'closed' or new.opened_at<>root.opened_at then raise exception 'INVALID_PARTIAL_LINEAGE';end if;
   new.infinity_group_id:=root.infinity_group_id;new.initial_volume:=null;
   new.initial_sl:=null;new.initial_sl_at:=null;new.initial_risk_usd:=null;
   return new;
 end if;
 if tg_op='INSERT' and new.execution_rules_version is distinct from a.rules_version then raise exception 'RULES_CHANGED_REFRESH_REQUIRED';end if;
 if tg_op='UPDATE' and (new.infinity_group_id is distinct from old.infinity_group_id or new.initial_volume is distinct from old.initial_volume
   or new.account_id is distinct from old.account_id or new.open_price is distinct from old.open_price or new.opened_at is distinct from old.opened_at
   or new.symbol is distinct from old.symbol or new.side is distinct from old.side) then raise exception 'OPENING_IDENTITY_IMMUTABLE';end if;
 if new.status<>'open' then return new;end if;
 if a.status<>'active' or a.access_revoked_at is not null then raise exception 'ACCOUNT_FROZEN';end if;
 if tg_op='UPDATE' and new.sl is not distinct from old.sl and new.volume<=old.volume and new.trail_distance is not distinct from old.trail_distance and new.tp is not distinct from old.tp then return new;end if;
 if tg_op='UPDATE' and new.volume>old.volume then raise exception 'POSITION_VOLUME_CANNOT_INCREASE';end if;
 p:=public.infinity_v2_price(new.symbol);
 if p is null or (p->>'spread')::numeric<=0 then raise exception 'LIVE_SPREAD_UNAVAILABLE';end if;
 scale:=public.infinity_v2_usd_scale(new.symbol);
 if scale is null then raise exception 'USD_CONVERSION_UNAVAILABLE';end if;
 mark:=case when new.side='buy' then (p->>'bid')::numeric else (p->>'ask')::numeric end;
 if tg_op='INSERT' then
   if (select count(*) from public.trades where account_id=a.id and status='open')>=(r->>'max_open_positions')::int then raise exception 'MAX_OPEN_POSITIONS';end if;
   if new.infinity_pending_id is null and ((select count(*) from public.trades where account_id=a.id and parent_trade_id is null and infinity_pending_id is null and opened_at between clock_timestamp()-make_interval(secs=>(r->>'order_burst_window_seconds')::int) and clock_timestamp())+
     (select count(*) from public.pending_orders where account_id=a.id and created_at between clock_timestamp()-make_interval(secs=>(r->>'order_burst_window_seconds')::int) and clock_timestamp())) >= (r->>'order_burst_limit')::int then raise exception 'ORDER_BURST_LIMIT';end if;
   if exists(select 1 from public.infinity_v2_pauses where account_id=a.id and symbol=new.symbol and until_at>clock_timestamp()) then raise exception 'STOP_OUT_PAUSE';end if;
   if new.volume<coalesce((p->>'min_lot')::numeric,0.01) or new.volume<>trunc(new.volume/coalesce((p->>'min_lot')::numeric,0.01))*coalesce((p->>'min_lot')::numeric,0.01) then raise exception 'INVALID_LOT_STEP';end if;
   select * into g from public.infinity_v2_groups x where x.account_id=a.id and x.symbol=new.symbol and x.side=new.side
    and (new.opened_at<=x.last_entry+make_interval(secs=>(r->>'group_gap_minutes')::int*60)
       or exists(select 1 from public.trades t where t.infinity_group_id=x.id and t.status='open')) order by x.last_entry desc limit 1;
   if not found then insert into public.infinity_v2_groups(account_id,symbol,side,last_entry) values(a.id,new.symbol,new.side,new.opened_at) returning * into g;
   else update public.infinity_v2_groups set last_entry=greatest(last_entry,new.opened_at) where id=g.id;end if;
   new.infinity_group_id:=g.id;new.initial_volume:=new.volume;
 else
   if old.sl is not null and (new.sl is null or (new.side='buy' and new.sl<old.sl) or (new.side='sell' and new.sl>old.sl)) then raise exception 'STOP_CANNOT_WIDEN';end if;
 end if;
 if new.sl is not null and (tg_op='INSERT' or new.sl is distinct from old.sl or new.tp is distinct from old.tp or new.trail_distance is distinct from old.trail_distance) then
   if (case when new.side='buy' then (case when tg_op='INSERT' then new.open_price else mark end)-new.sl
     else new.sl-(case when tg_op='INSERT' then new.open_price else mark end) end) < (p->>'spread')::numeric*(r->>'stop_spread_multiple')::numeric then raise exception 'STOP_TOO_CLOSE';end if;
   if new.initial_sl is null then
     if clock_timestamp()>new.opened_at+make_interval(secs=>(r->>'stop_deadline_seconds')::int) then raise exception 'OPENING_STOP_TOO_LATE';end if;
     new.initial_sl:=new.sl;new.initial_sl_at:=case when tg_op='INSERT' then new.opened_at else clock_timestamp() end;
     new.initial_risk_usd:=abs(new.open_price-new.sl)*new.initial_volume*scale;
   end if;
 end if;
 if new.trail_distance is not null and (tg_op='INSERT' or new.trail_distance is distinct from old.trail_distance)
 and new.trail_distance<(p->>'spread')::numeric*(r->>'stop_spread_multiple')::numeric then raise exception 'TRAIL_TOO_CLOSE';end if;
 if tg_op='UPDATE' and old.initial_sl is not null then return new;end if;
 eq:=public.fn_infinity_quote_equity(a.id);
 if eq is null then raise exception 'PORTFOLIO_MARK_UNAVAILABLE';end if;
 room:=least((eq-(greatest(coalesce(a.trailing_peak,a.starting_balance),a.balance)-a.starting_balance*a.max_drawdown_pct/100-coalesce(a.total_paid_out,0)))*0.20,
 (eq-(case when a.day_start_date is distinct from (clock_timestamp() at time zone 'UTC')::date then a.balance else a.day_start_equity end-a.starting_balance*a.daily_loss_pct/100))*0.25);
 lim:=round(greatest(0,least(a.starting_balance*(r->>'risk_pct')::numeric/100,room)),2);
 proposed:=case when new.sl is null then lim else greatest(0,case when new.side='buy' then new.open_price-new.sl else new.sl-new.open_price end)*new.volume*scale end;
 margin:=new.open_price*new.volume*scale/100;
 total:=proposed;group_risk:=coalesce(new.initial_risk_usd,lim);
 for other in select t.* from public.trades t where t.account_id=a.id and t.id<>new.id and t.parent_trade_id is null
  and (t.status='open' or t.infinity_group_id=new.infinity_group_id) loop
   if other.infinity_group_id=new.infinity_group_id then group_risk:=group_risk+coalesce(other.initial_risk_usd,lim);end if;
   if other.status='open' then
     scale:=public.infinity_v2_usd_scale(other.symbol);if scale is null then raise exception 'USD_CONVERSION_UNAVAILABLE';end if;
     margin:=margin+other.open_price*other.volume*scale/100;
     total:=total+case when other.sl is null then lim else greatest(0,case when other.side='buy' then other.open_price-other.sl else other.sl-other.open_price end)*other.volume*scale end;
   end if;
 end loop;
 if margin>eq then raise exception 'INSUFFICIENT_MARGIN';end if;
 if proposed>lim+0.000001 or group_risk>lim+0.000001 then raise exception 'COUNTED_TRADE_RISK_LIMIT';end if;
 if total>lim*(r->>'total_risk_multiple')::numeric+0.000001 then raise exception 'TOTAL_OPEN_RISK_LIMIT';end if;
 return new;
end $$;
-- z prefix follows legacy validation and immutable tuple checks. Constraints
-- are checked after BEFORE triggers, so captured opening fields are atomic.
create trigger z_infinity_v2_trade_guard before insert or update on public.trades for each row execute function public.infinity_v2_trade_guard();

create function public.infinity_v2_trade_changed() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts;
begin
 select * into a from public.trading_accounts where id=new.account_id;
 if a.rules_version is distinct from 'infinity_v2' then return new;end if;
 insert into public.infinity_v2_progress_cache(account_id,result,dirty) values(a.id,'{}',true)
 on conflict(account_id) do update set dirty=true;
 if new.status='closed' and new.close_reason='sl' and (tg_op='INSERT' or old.status is distinct from 'closed') then
 insert into public.infinity_v2_pauses(account_id,symbol,until_at) values(a.id,new.symbol,new.closed_at+make_interval(secs=>(a.infinity_rules_snapshot->>'stop_pause_seconds')::int))
 on conflict(account_id,symbol) do update set until_at=greatest(infinity_v2_pauses.until_at,excluded.until_at);
 end if;
 if a.stage=4 and new.status='closed' and (tg_op='INSERT' or old.status is distinct from 'closed') then
 if coalesce((public.infinity_v2_progress(a.id)->>'performance_breach')::boolean,false) then perform public.fn_claim_account_breach(a.id,'performance_rule',a.balance,a.starting_balance*(1-(a.infinity_rules_snapshot->>'performance_loss_pct')::numeric/100));end if;
 end if;return new;
end $$;
create trigger infinity_v2_trade_changed after insert or update on public.trades for each row execute function public.infinity_v2_trade_changed();

create function public.infinity_v2_review_hold(p_account uuid) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(a.investigation_hold,false) or exists(select 1 from public.ab_hedge_flags f where f.status='open' and public.ab_person_of(a.user_id) in(f.person_a,f.person_b)) or exists(select 1 from public.ab_alerts x
 where x.resolved_at is null and x.person_id in(a.user_id,public.ab_person_of(a.user_id)) and x.category in('rules','trader')
 and (x.key like 'ring:%' or x.key like 'ident:%' or x.title ilike '%herd%' or x.title ilike '%identical%' or x.title ilike '%linked account%')
 and not exists(select 1 from public.infinity_v2_review_clearances c where c.account_id=a.id and c.alert_key=x.key and c.evidence_at=x.last_seen))
 from public.trading_accounts a where a.id=p_account;
$$;
create function public.infinity_v2_groups_result(p_account uuid) returns table(group_id uuid,pnl numeric,r numeric,closed_at timestamptz,valid boolean)
language sql stable security definer set search_path='' as $$
 with roots as(select t.* from public.trades t join public.trading_accounts a on a.id=t.account_id
  where t.account_id=p_account and t.parent_trade_id is null and t.opened_at>=a.rules_effective_at),
 results as(select root.infinity_group_id gid,sum(coalesce(leg.pnl,0)) profit,max(leg.closed_at) finish,
  bool_and(leg.status='closed') flat from roots root join public.trades leg on leg.id=root.id or leg.parent_trade_id=root.id group by root.infinity_group_id),
 risks as(select infinity_group_id gid,sum(initial_risk_usd) risk,bool_and(initial_risk_usd>0 and initial_risk_usd is not null) valid
 from roots group by infinity_group_id)
 select x.gid,x.profit,case when y.valid and y.risk>0 then greatest(-(a.infinity_rules_snapshot->>'score_r_cap')::numeric,
 least((a.infinity_rules_snapshot->>'score_r_cap')::numeric,x.profit/y.risk)) end,x.finish,y.valid
 from results x join risks y on y.gid=x.gid join public.trading_accounts a on a.id=p_account where x.flat;
$$;
create function public.infinity_v2_progress(p_account uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts;policy jsonb;stats record;combined record;unmet text[]:='{}';profit numeric;best numeric;target numeric;hold boolean;bad boolean;perf boolean:=false;out jsonb;
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
 select coalesce(sum(d),0),greatest(0,coalesce(max(d),0)) into profit,best from (
 select sum(case when t.pnl>0 and (t.closed_at-t.opened_at)<make_interval(secs=>case when t.opened_at>=a.rules_effective_at then (policy->>'min_hold_seconds')::int else 60 end) then 0 else coalesce(t.pnl,0) end) d
 from public.trades t where t.account_id=a.id and t.status='closed' group by (t.closed_at at time zone 'UTC')::date) days;
 target:=round(a.starting_balance*(policy->>'target_pct')::numeric/100,2);
 hold:=coalesce(public.infinity_v2_review_hold(a.id),true);
 if exists(select 1 from public.trades where account_id=a.id and status='open') or exists(select 1 from public.pending_orders where account_id=a.id and status='pending') then unmet:=array_append(unmet,'NOT_FLAT');end if;
 if exists(select 1 from public.trades t where t.account_id=a.id and t.parent_trade_id is null and t.status='closed' and t.opened_at>=a.rules_effective_at and t.initial_risk_usd is null and t.close_reason is distinct from 'no_stop_loss') then unmet:=array_append(unmet,'OPENING_RISK_UNAVAILABLE');end if;
 if profit<target or a.balance<a.starting_balance+target then unmet:=array_append(unmet,'PROFIT_TARGET');end if;
 if stats.n<(policy->>'min_counted_trades')::int then unmet:=array_append(unmet,'COUNTED_TRADES');end if;
 if policy->>'stage_score' is not null and stats.mean*sqrt(stats.n)/greatest(stats.sd,(policy->>'sd_floor')::numeric)<(policy->>'stage_score')::numeric then unmet:=array_append(unmet,'STAGE_SCORE');end if;
 if policy->>'combined_score' is not null and combined.mean*sqrt(combined.n)/greatest(combined.sd,(policy->>'sd_floor')::numeric)<(policy->>'combined_score')::numeric then unmet:=array_append(unmet,'COMBINED_SCORE');end if;
 if policy->>'best_day_share' is not null and (profit<=0 or best/profit>(policy->>'best_day_share')::numeric) then unmet:=array_append(unmet,'BEST_DAY');end if;
 if hold then unmet:=array_append(unmet,'INTEGRITY_REVIEW');end if;
 if a.stage=4 then
   select exists(select 1 from(select sum(g.pnl) over(order by g.closed_at,g.group_id rows between ((policy->>'performance_window')::int-1) preceding and current row) loss,
    count(*) over(order by g.closed_at,g.group_id rows between ((policy->>'performance_window')::int-1) preceding and current row) n from public.infinity_v2_groups_result(a.id) g where g.valid) w
    where w.n=(policy->>'performance_window')::int and w.loss<=-a.starting_balance*(policy->>'performance_loss_pct')::numeric/100) into perf;
   if perf then unmet:=array_append(unmet,'PERFORMANCE_BREACH');end if;
 end if;
 out:=jsonb_build_object('applies',true,'eligible',cardinality(unmet)=0,'unmet',unmet,'n',stats.n,'score',stats.mean*sqrt(stats.n)/greatest(stats.sd,(policy->>'sd_floor')::numeric),
 'combined_score',combined.mean*sqrt(combined.n)/greatest(combined.sd,(policy->>'sd_floor')::numeric),'counted_profit',profit,'target',target,
 'best_day_share',case when profit>0 then best/profit end,'rules',policy,'performance_breach',perf,'integrity_hold',hold);
 insert into public.infinity_v2_progress_cache(account_id,result,dirty,updated_at) values(a.id,out,false,clock_timestamp())
 on conflict(account_id) do update set result=excluded.result,dirty=false,updated_at=excluded.updated_at;
 return out;
end $$;
create function public.infinity_v2_refresh_progress() returns int language plpgsql security definer set search_path='' as $$
declare a record;n int:=0;
begin
 for a in select v.id from public.trading_accounts v left join public.infinity_v2_progress_cache c on c.account_id=v.id
 where v.rules_version='infinity_v2' and v.status in('active','passed') and (c.account_id is null or c.dirty or c.updated_at<clock_timestamp()-interval '1 minute')
 order by c.updated_at nulls first limit 100 loop
 perform public.infinity_v2_progress(a.id);n:=n+1;
 end loop;return n;
end $$;

-- RLS and execute permissions: only the trusted engine and scheduled worker.
do $$declare t text;f record;begin
 foreach t in array array['infinity_v2_groups','infinity_v2_pauses','infinity_v2_progress_cache','infinity_v2_review_clearances'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select on public.%I to service_role',t);
 end loop;
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'infinity_v2_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.sig);
 execute format('grant execute on function %s to service_role',f.sig);
 end loop;
end $$;
select cron.schedule('ipfx-infinity-v2-progress','10 seconds','select public.infinity_v2_refresh_progress()');
commit;
