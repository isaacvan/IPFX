-- Individual Infinity replay. No orders, source ledger or financial functions are mutated.
begin;
create table if not exists public.ab_e8_trader_perf_config (
 id int primary key check(id=1), version int not null default 1,
 settings jsonb not null default '{"min_trades":30,"reportable_trades":100,"actionable_trades":200,"min_days":10,"embargo_seconds":30,"q_max":0.05}',
 rebuild_requested boolean not null default true, requested_at timestamptz, updated_at timestamptz not null default now()
);
insert into public.ab_e8_trader_perf_config(id) values(1) on conflict do nothing;
create table if not exists public.ab_e8_trader_perf_runs (
 id bigint generated always as identity primary key, started_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz, status text not null, repriced int default 0, error text, detail jsonb
);
create table if not exists public.ab_e8_trader_perf_trade_cache (
 trade_id uuid not null, latency int not null check(latency in(1,2,5,15)), slippage int not null check(slippage in(0,1,2)),
 trader_id uuid not null, fingerprint text not null, computed_at timestamptz not null,
 payload jsonb not null, minute_path jsonb not null default '[]', primary key(trade_id,latency,slippage)
);
create index if not exists ab_e8_trader_perf_trade_person on public.ab_e8_trader_perf_trade_cache(trader_id,latency,slippage);
create table if not exists public.ab_e8_trader_perf_trader_cache (
 trader_id uuid not null, latency int not null, slippage int not null, computed_at timestamptz not null,
 row_data jsonb not null, primary key(trader_id,latency,slippage)
);
create table if not exists public.ab_e8_trader_perf_history (
 id bigint generated always as identity primary key, trader_id uuid not null, latency int not null, slippage int not null,
 captured_at timestamptz not null, input_cutoff timestamptz not null, config_version int not null,
 config jsonb not null, row_data jsonb not null, snapshot_kind text not null default 'captured_live'
);
create index if not exists ab_e8_trader_perf_history_person on public.ab_e8_trader_perf_history(trader_id,captured_at);
create table if not exists public.ab_e8_trader_perf_cache (
 id int primary key check(id=1), computed_at timestamptz not null, source_computed_at timestamptz not null,
 metadata jsonb not null
);
do $$ declare t text; begin
 foreach t in array array['config','runs','trade_cache','trader_cache','history','cache'] loop
 execute format('alter table public.ab_e8_trader_perf_%I enable row level security',t);
 execute format('revoke all on public.ab_e8_trader_perf_%I from public, anon, authenticated',t);
 execute format('grant select on public.ab_e8_trader_perf_%I to service_role',t);
 end loop;
end $$;

-- REST only requests work. The next off-minute cron performs it as postgres.
create or replace function public.ab_e8_trader_perf_refresh()
returns jsonb language plpgsql security definer set search_path to '' as $$
begin
 update public.ab_e8_trader_perf_config set requested_at=clock_timestamp() where id=1;
 return jsonb_build_object('ok',true,'scheduled',true);
end $$;

-- The sole quote materialization below is indexed; all per-trade lookups use it.
create or replace function public.ab_e8_trader_perf_refresh_private(p_rebuild boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
 rid bigint; t0 timestamptz:=clock_timestamp(); asof timestamptz:=statement_timestamp(); cfg jsonb; cv int;
 rebuild boolean; src jsonb; source_at timestamptz; meta jsonb; n int:=0; cell record; person record;
 tr jsonb; pop jsonb; inferred jsonb; err text; err_context text; tm jsonb:='{}'; stage timestamptz; risk_policy jsonb; pop_fingerprint text;
begin
 if not pg_try_advisory_xact_lock(819191000) then return jsonb_build_object('ok',false,'locked',true); end if;
 insert into public.ab_e8_trader_perf_runs(status) values('running') returning id into rid;
 begin
 select settings,version,rebuild_requested or p_rebuild into cfg,cv,rebuild from public.ab_e8_trader_perf_config where id=1;
 select result,computed_at into src,source_at from public.ab_e8_copy_backtest_cache where id=1;
 if to_regclass('public.ab_risk_limits') is not null then
 execute 'select coalesce(jsonb_object_agg(book,to_jsonb(r)),''{}''::jsonb) from public.ab_risk_limits r' into risk_policy;
 end if;
 if not coalesce((src->>'available')::boolean,false) then raise exception 'Existing E8 control cache is unavailable'; end if;
 if source_at < asof-interval '30 minutes' then raise exception 'Existing E8 control cache is stale'; end if;
 stage:=clock_timestamp();
 drop table if exists pg_temp._ep_source,pg_temp._ep_quotes,pg_temp._ep_windows,pg_temp._ep_changed,
   pg_temp._ep_cells,pg_temp._ep_calc,pg_temp._ep_paths,pg_temp._ep_inputs,pg_temp._ep_vols;
 -- Matching is deliberately cardinality checked: ambiguous copies are unpriced, never multiplied.
 create temp table _ep_source on commit drop as
 with control as (
   select x from jsonb_array_elements(coalesce(src->'trades','[]')) x
 ), source as (
 select t.id trade_id,coalesce(nullif(to_jsonb(l)->>'person_id','')::uuid,public.ab_person_of(t.user_id)) trader_id,coalesce(u.email,t.user_id::text) email,
 t.symbol,t.side,t.opened_at,t.closed_at,to_jsonb(t) raw,
 greatest(coalesce(l.created_at,t.closed_at+interval '120 seconds'),t.closed_at+interval '120 seconds') available_at,
 coalesce(l.created_at is not null,false) ledger_publication_identified,
 c.x control,c.k control_matches,
 coalesce(e.lot_size,sp.contract_size) contract,coalesce(e.quote_currency,sp.quote_currency) qccy,
 coalesce(nullif(e.details->>'leverage','')::numeric,30) lev,
 nullif(e.details->>'leverage','') is not null lev_measured,
 coalesce(nullif(cm.e8_commission_per_lot,0),5.5) comm,
 nullif(cm.e8_commission_per_lot,0) is null comm_assumed,
 coalesce(nullif(e.details->>'tickSize','')::numeric,nullif(e.details->>'tick_size','')::numeric,
          nullif(to_jsonb(sp)->>'tick_size','')::numeric) tick_size
 from public.trades t join public.trading_accounts a on a.id=t.account_id
 left join auth.users u on u.id=t.user_id left join public.ab_trade_ledger l on l.trade_id=t.id
 left join public.symbol_specs sp on sp.symbol=t.symbol
 left join public.cost_symbol_model cm on cm.symbol=t.symbol
 left join lateral(select ee.* from public.e8_instrument_evidence ee where ee.account_id=3 and ee.symbol=t.symbol
   and ee.lot_size>0 order by ee.observed_at desc,ee.id desc limit 1)e on true
 left join lateral(select (jsonb_agg(x))->0 x,count(*) k from control
   where x->>'trader'=coalesce(u.email,t.user_id::text) and (x->>'opened_at')::timestamptz=t.opened_at
   and (x->>'closed_at')::timestamptz=t.closed_at and x->>'symbol'=t.symbol and x->>'side'=t.side)c on true
 where a.challenge_type='infinity' and coalesce(a.phase,'')<>'demo' and t.status='closed'
 and t.closed_at is not null and t.closed_at<=asof-interval '35 seconds'
 ), counted as (
 select *,count(*) over(partition by email,opened_at,closed_at,symbol,side) identity_matches from source
 ) select *,null::text fingerprint,null::bigint global_priced_rank from counted;
 create index on _ep_source(trade_id);
 create temp table _ep_windows on commit drop as
 select symbol,min(opened_at)-interval '2 minutes' lo,
 greatest(max(closed_at)+interval '80 seconds',max(opened_at)+interval '3700 seconds') hi
 from _ep_source group by symbol
 union all
 select f.symbol,min(s.opened_at)-interval '1 day',greatest(max(s.closed_at)+interval '80 seconds',max(s.opened_at)+interval '3700 seconds')
 from _ep_source s cross join(values('USDJPY'),('USDCAD'),('USDCHF'),('GBPUSD'),('EURUSD'))f(symbol)
 where s.qccy<>'USD' group by f.symbol;
 create temp table _ep_quotes on commit drop as
 select q.id,q.symbol,q.received_at,q.bid,q.ask from public.e8_reference_quotes q
 where q.account_id=3 and q.received_at<=asof and exists(
 select 1 from _ep_windows w where w.symbol=q.symbol and q.received_at between w.lo and w.hi);
 create index _ep_quotes_lookup on _ep_quotes(symbol,received_at,id);
 analyze _ep_quotes;
 -- Ex ante regimes: completed quote minutes strictly before entry.
 create temp table _ep_vols on commit drop as
 with returns as(select symbol,received_at,ln(((bid+ask)/2)/lag((bid+ask)/2) over(partition by symbol order by received_at,id)) r
 from _ep_quotes where bid>0 and ask>=bid)
 select symbol,date_trunc('minute',received_at) bucket,sqrt(sum(r*r)) vol
 from returns where r is not null group by 1,2 having count(*)>=4 and max(received_at)-min(received_at)>=interval '30 seconds';
 create index on _ep_vols(symbol,bucket);
 alter table _ep_source add column entry_volatility numeric,add column volatility_regime text,add column regime_label_at timestamptz;
 update _ep_source s set entry_volatility=x.vol,
 volatility_regime=case when x.cuts is null then null when x.vol<=x.cuts[1] then 'low' when x.vol<=x.cuts[2] then 'medium' else 'high' end,
 regime_label_at=date_trunc('minute',s.opened_at)
 from(select ss.trade_id,v.vol,(select percentile_cont(array[.333333333,.666666667]) within group(order by p.vol)
 from _ep_vols p where p.symbol=ss.symbol and p.bucket<v.bucket and p.bucket>=v.bucket-interval '7 days' having count(*)>=30) cuts
 from _ep_source ss join _ep_vols v on v.symbol=ss.symbol and v.bucket=date_trunc('minute',ss.opened_at)-interval '1 minute')x
 where x.trade_id=s.trade_id;
 update _ep_source s set global_priced_rank=r.rnk from(
 select ss.trade_id,row_number() over(order by q.received_at,ss.trade_id) rnk from _ep_source ss
 cross join lateral(select qq.received_at from _ep_quotes qq where qq.symbol=ss.symbol
 and qq.received_at between ss.opened_at+interval '2 seconds' and ss.opened_at+interval '32 seconds'
 order by qq.received_at,qq.id limit 1)q where ss.control->>'reason' is null and ss.control->>'lots' is not null)r
 where s.trade_id=r.trade_id;
 -- Fingerprints include only relevant source, quote, model and configuration data. New unrelated ticks do not reprice.
 update _ep_source s set fingerprint=md5(concat_ws('|',s.raw::text,s.control::text,s.control_matches,s.identity_matches,
 s.available_at,s.contract,s.qccy,s.comm,s.tick_size,s.lev,s.lev_measured,s.global_priced_rank,s.entry_volatility,s.volatility_regime,cfg::text,
 (select md5(coalesce(string_agg(concat_ws(':',q.id,q.received_at,q.bid,q.ask),'|' order by q.received_at,q.id),''))
 from _ep_quotes q where q.symbol=s.symbol and q.received_at between s.opened_at-interval '2 minutes'
 and greatest(s.closed_at+interval '80 seconds',s.opened_at+interval '3700 seconds')),
 (select concat_ws(':',q.id,q.bid,q.ask) from _ep_quotes q where q.symbol=case s.qccy
 when 'JPY' then 'USDJPY' when 'CAD' then 'USDCAD' when 'CHF' then 'USDCHF' when 'GBP' then 'GBPUSD' when 'EUR' then 'EURUSD' end
 and q.received_at<=s.closed_at+interval '35 seconds' order by q.received_at desc,q.id desc limit 1))) where true;
 create temp table _ep_changed on commit drop as select s.* from _ep_source s
 where rebuild or (select count(*) from public.ab_e8_trader_perf_trade_cache c where c.trade_id=s.trade_id and c.fingerprint=s.fingerprint)<>12;
 select count(*) into n from _ep_changed;
 tm:=jsonb_build_object('source_and_indexed_quotes',round(extract(epoch from clock_timestamp()-stage)*1000));stage:=clock_timestamp();
 -- All stress cells share the control's global lots, never a per-person alternating sequence.
 create temp table _ep_cells on commit drop as
 select s.*,lat.latency,sl.slippage,case when s.side='buy' then 1 else -1 end dir,
 (s.control->>'lots')::numeric lots,qi.received_at in_at,qi.bid in_bid,qi.ask in_ask,
 qo.received_at out_at,qo.bid out_bid,qo.ask out_ask,
 case when s.qccy='USD' then 1 else fx.rate end fx,
 nullif(coalesce(s.raw->>'sl',s.raw->>'stop_loss'),'')::numeric source_sl,
 nullif(coalesce(s.raw->>'tp',s.raw->>'take_profit'),'')::numeric source_tp
 from _ep_changed s cross join(values(1),(2),(5),(15))lat(latency) cross join(values(0),(1),(2))sl(slippage)
 left join lateral(select q.* from _ep_quotes q where q.symbol=s.symbol and q.received_at>=s.opened_at+make_interval(secs=>lat.latency)
 and q.received_at<=s.opened_at+make_interval(secs=>lat.latency+30) order by q.received_at,q.id limit 1)qi on true
 left join lateral(select q.* from _ep_quotes q where q.symbol=s.symbol
 and q.received_at>=greatest(s.closed_at+interval '5 seconds',qi.received_at+interval '1 millisecond')
 and q.received_at<=greatest(s.closed_at+interval '5 seconds',qi.received_at)+interval '30 seconds'
 order by q.received_at,q.id limit 1)qo on qi.received_at is not null
 left join lateral(select case when s.qccy in('GBP','EUR') then (q.bid+q.ask)/2 else 2/(q.bid+q.ask) end rate
 from _ep_quotes q where q.symbol=case s.qccy when 'JPY' then 'USDJPY' when 'CAD' then 'USDCAD' when 'CHF' then 'USDCHF'
 when 'GBP' then 'GBPUSD' when 'EUR' then 'EURUSD' end and q.received_at<=qo.received_at
 order by q.received_at desc,q.id desc limit 1)fx on true;
 create temp table _ep_calc on commit drop as
 with prices as(select *, (in_bid+in_ask)/2 mid_in,(out_bid+out_ask)/2 mid_out,
 case when latency=2 and slippage=0 then (control->>'a_entry')::numeric end control_entry,
 case when control_matches<>1 or identity_matches<>1 then 'Ambiguous or missing source control identity'
 when control->>'reason' is not null then control->>'reason'
 when lots is null then 'No global control lot assignment'
 when in_at is null then 'No E8 entry quote within 30 seconds'
 when out_at is null then 'No E8 exit quote within 30 seconds'
 when contract is null or fx is null then 'Unknown contract or currency conversion'
 when slippage>0 and tick_size is null then 'E8 tick size unavailable for slippage stress'
 when in_bid<=0 or in_ask<in_bid or out_bid<=0 or out_ask<out_bid then 'Invalid E8 quote' end reason
 from _ep_cells), economics as(select *,
 (mid_out-mid_in)*dir*contract*lots*fx gross,
 ((in_ask-in_bid)+(out_ask-out_bid))/2*contract*lots*fx spread,
 round(comm*lots,4) commission,
 case when slippage=0 then 0 else 2*slippage*tick_size*contract*lots*fx end slip_cost,
 abs(mid_in-source_sl)*contract*lots*fx risk_usd,
 case when (mid_in-source_sl)*dir>0 and (source_tp-mid_in)*dir>0 then
 floor(lots*abs(mid_in-source_sl)/abs(source_tp-mid_in)*100)/100 end risk_lots
 from prices)
 select *,case when reason is null then gross-spread-commission-slip_cost end a_net,
 case when reason is null then -gross-spread-commission-slip_cost end b_net
 from economics;
 -- If source quote prices have changed, reject the base cell instead of silently claiming reconciliation.
 if exists(select 1 from _ep_calc where latency=2 and slippage=0 and reason is null and
 (abs(a_net-(control->>'a_net')::numeric)>0.0051 or abs(b_net-(control->>'b_net')::numeric)>0.0051
 or abs((case when dir=1 then in_ask else in_bid end)-control_entry)>0.00000001)) then
 raise exception 'Base replay differs from saved control; refresh source cache before repricing'; end if;
 -- Saved sparse event paths: minute floating marks and a realized delta at the first minute after exit.
 create temp table _ep_paths on commit drop as
 select c.trade_id,c.latency,c.slippage,
 jsonb_agg(jsonb_build_object('at',p.m,'a_float',p.af,'b_float',p.bf,'a_delta',p.ad,'b_delta',p.bd,
 'open',p.op,'mark_missing',p.missing) order by p.m) path
 from _ep_calc c cross join lateral(
 select g.m,
 case when q.bid is not null then ((case when c.dir=1 then q.bid else q.ask end)-(case when c.dir=1 then c.in_ask else c.in_bid end))*c.dir*c.contract*c.lots*c.fx-c.slip_cost/2 end af,
 case when q.bid is not null then ((case when c.dir=-1 then q.bid else q.ask end)-(case when c.dir=-1 then c.in_ask else c.in_bid end))*-c.dir*c.contract*c.lots*c.fx-c.slip_cost/2 end bf,
 0::numeric ad,0::numeric bd,1 op,q.bid is null missing
 from generate_series(date_trunc('minute',c.in_at)+interval '1 minute',date_trunc('minute',c.out_at),interval '1 minute')g(m)
 left join lateral(select qq.bid,qq.ask from _ep_quotes qq where qq.symbol=c.symbol and qq.received_at<g.m
 order by qq.received_at desc,qq.id desc limit 1)q on true
 union all select date_trunc('minute',c.out_at)+interval '1 minute',0,0,c.a_net,c.b_net,0,false
 )p where c.reason is null group by c.trade_id,c.latency,c.slippage;
 delete from public.ab_e8_trader_perf_trade_cache c where not exists(select 1 from _ep_source s where s.trade_id=c.trade_id);
 insert into public.ab_e8_trader_perf_trade_cache(trade_id,latency,slippage,trader_id,fingerprint,computed_at,payload,minute_path)
 select c.trade_id,c.latency,c.slippage,c.trader_id,c.fingerprint,asof,
 jsonb_build_object('trade_id',c.trade_id,'trader_id',c.trader_id,'trader',c.email,'symbol',c.symbol,'side',c.side,
 'opened_at',c.opened_at,'closed_at',c.closed_at,'available_at',c.available_at,'lots',c.lots,
 'gross',case when c.reason is null then c.gross end,'spread',case when c.reason is null then c.spread end,
 'commission',c.commission,'slippage',c.slip_cost,'a_net',c.a_net,'b_net',c.b_net,
 'hold_s',extract(epoch from c.out_at-c.in_at),'source_pnl',c.raw->'pnl','source_volume',c.raw->'volume',
 'source_sl',c.source_sl,'source_tp',c.source_tp,'mid_in',c.mid_in,'mid_out',c.mid_out,
 'tick_value',c.tick_size*c.contract*c.lots*c.fx,'spread_multiple',c.gross/nullif(c.spread,0),
 'r_multiple',case when (c.mid_in-c.source_sl)*c.dir>0 then c.gross/nullif(c.risk_usd,0) end,
 'markouts',mk.marks,'risk_b_net',case when c.reason is null and c.risk_lots>=0.01 then c.b_net*c.risk_lots/c.lots end,
 'reason',c.reason,'latency',c.latency,'slippage_ticks',c.slippage,'exit_latency',5,
 'in_at',c.in_at,'out_at',c.out_at,'risk_b_lots',c.risk_lots,
 'contract',c.contract,'fx',c.fx,'lev',c.lev,'leverage_label',case when c.lev_measured then 'MEASURED' else 'ASSUMED' end,
 'margin',(case when c.dir=1 then c.in_ask else c.in_bid end)*c.contract*c.lots*c.fx/nullif(c.lev,0),
 'risk_usd',case when (c.mid_in-c.source_sl)*c.dir>0 then c.risk_usd end,
 'source_stop_valid',(c.mid_in-c.source_sl)*c.dir>0,'source_target_valid',(c.source_tp-c.mid_in)*c.dir>0,
 'global_priced_rank',c.global_priced_rank)||jsonb_build_object(
 'entry_volatility',c.entry_volatility,'volatility_regime',c.volatility_regime,'regime_label_at',c.regime_label_at,
 'volatility_basis','Prior completed-minute squared log quote returns; terciles from at least 30 preceding complete minutes in trailing 7 days',
 'risk_b_available',c.reason is null and c.risk_lots>=0.01,
 'commission_label',case when c.comm_assumed then 'ASSUMED' else 'MEASURED' end,
 'ledger_publication_identified',c.ledger_publication_identified,
 'overnight',date_trunc('day',c.in_at at time zone 'UTC'+interval '3 hours')<date_trunc('day',c.out_at at time zone 'UTC'+interval '3 hours'),
 'swaps',jsonb_build_object('available',false,'reason','E8 swap rates unavailable'),
 'own_exit',jsonb_build_object('gross',c.gross,'price',(c.mid_out-c.mid_in)*c.dir,'spread_multiple',c.gross/nullif(c.spread,0),
 'r_multiple',case when (c.mid_in-c.source_sl)*c.dir>0 then c.gross/nullif(c.risk_usd,0) end)),coalesce(p.path,'[]')
 from _ep_calc c left join _ep_paths p using(trade_id,latency,slippage)
 left join lateral(select jsonb_agg(jsonb_build_object('seconds',h.seconds,
 'gross',(q.mid-c.mid_in)*c.dir*c.contract*c.lots*hf.rate,'price',(q.mid-c.mid_in)*c.dir,
 'spread_multiple',(q.mid-c.mid_in)*c.dir/nullif(c.in_ask-c.in_bid,0),
 'r_multiple',case when (c.mid_in-c.source_sl)*c.dir>0 then (q.mid-c.mid_in)*c.dir/nullif(abs(c.mid_in-c.source_sl),0) end,
 'a_net',(q.mid-c.mid_in)*c.dir*c.contract*c.lots*hf.rate-((c.in_ask-c.in_bid)+q.spread)/2*c.contract*c.lots*hf.rate-c.commission-c.slip_cost*hf.rate/nullif(c.fx,0),
 'b_net',-(q.mid-c.mid_in)*c.dir*c.contract*c.lots*hf.rate-((c.in_ask-c.in_bid)+q.spread)/2*c.contract*c.lots*hf.rate-c.commission-c.slip_cost*hf.rate/nullif(c.fx,0),
 'fx',hf.rate,'fx_at',q.horizon_at,'available',q.mid is not null and hf.rate is not null,
 'reason',case when q.mid is null then 'No E8 horizon quote within 30 seconds' when hf.rate is null then 'No fresh E8 currency conversion at horizon' end) order by h.seconds)marks
 from(values(5),(30),(60),(300),(900),(3600))h(seconds)
 left join lateral(select (qq.bid+qq.ask)/2 mid,qq.ask-qq.bid spread,qq.received_at as horizon_at from _ep_quotes qq where qq.symbol=c.symbol
 and qq.received_at>=c.in_at+make_interval(secs=>h.seconds) and qq.received_at<=c.in_at+make_interval(secs=>h.seconds+30)
 order by qq.received_at,qq.id limit 1)q on c.reason is null
 left join lateral(select case when c.qccy='USD' then 1 else
 (select case when c.qccy in('GBP','EUR') then (fq.bid+fq.ask)/2 else 2/(fq.bid+fq.ask) end
 from _ep_quotes fq where fq.symbol=case c.qccy when 'JPY' then 'USDJPY' when 'CAD' then 'USDCAD' when 'CHF' then 'USDCHF'
 when 'GBP' then 'GBPUSD' when 'EUR' then 'EURUSD' end and fq.received_at<=q.horizon_at and fq.received_at>=q.horizon_at-interval '60 seconds'
 order by fq.received_at desc,fq.id desc limit 1) end rate)hf on true)mk on true
 on conflict(trade_id,latency,slippage) do update set trader_id=excluded.trader_id,fingerprint=excluded.fingerprint,
 computed_at=excluded.computed_at,payload=excluded.payload,minute_path=excluded.minute_path;
 tm:=tm||jsonb_build_object('reprice_and_paths',round(extract(epoch from clock_timestamp()-stage)*1000));stage:=clock_timestamp();
 -- Compute only the gross moments needed for a prior, rather than running full inference twice.
 create temp table _ep_inputs on commit drop as
 with account_people as(select distinct public.ab_person_of(a.user_id) id
 from public.trading_accounts a where a.challenge_type='infinity' and a.user_id is not null
 union select distinct trader_id from _ep_source),
 people as(select p.id,coalesce(u.email,p.id::text) email from account_people p left join auth.users u on u.id=p.id),
 inputs as(select p.id,p.email,l.latency,s.slippage,
 coalesce(jsonb_agg(c.payload order by c.payload->>'opened_at',c.trade_id) filter(where c.trade_id is not null),'[]') trades,
 md5(concat_ws('|',p.email,cfg::text,cv,(asof at time zone 'UTC')::date,
 string_agg(c.fingerprint||case when (c.payload->>'available_at')::timestamptz+make_interval(secs=>coalesce((cfg->>'embargo_seconds')::int,30))<=asof then ':published' else ':pending' end,'|' order by c.trade_id))) input_fingerprint,
 public.ab_e8_trader_moments(coalesce(jsonb_agg(jsonb_build_object('v',c.payload->'gross','day',((c.payload->>'closed_at')::timestamptz at time zone 'UTC')::date))
 filter(where c.payload->>'reason' is null and c.payload->>'gross' is not null
 and (c.payload->>'ledger_publication_identified')::boolean is true
 and (c.payload->>'available_at')::timestamptz+make_interval(secs=>coalesce((cfg->>'embargo_seconds')::int,30))<=asof
 and ((c.payload->>'closed_at')::timestamptz at time zone 'UTC')::date<(asof at time zone 'UTC')::date),'[]'),
 coalesce((cfg->>'variance_floor')::double precision,0.000001)) moments
 from people p cross join(values(1),(2),(5),(15))l(latency) cross join(values(0),(1),(2))s(slippage)
 left join public.ab_e8_trader_perf_trade_cache c on c.trader_id=p.id and c.latency=l.latency and c.slippage=s.slippage
 group by p.id,p.email,l.latency,s.slippage) select * from inputs;
 delete from public.ab_e8_trader_perf_trader_cache c where not exists(select 1 from _ep_inputs i where i.id=c.trader_id);
 for cell in select l latency,s slippage from unnest(array[1,2,5,15])l cross join unnest(array[0,1,2])s loop
 select jsonb_build_object('asof',asof,'rows',coalesce(jsonb_agg(jsonb_build_object('trader_id',id,
 'mean',moments->'mean','variance',power((moments->>'se')::numeric,2),
 'trades',moments->'n','active_days',moments->'days') order by id),'[]')) into pop
 from _ep_inputs where latency=cell.latency and slippage=cell.slippage;
 pop_fingerprint:=md5((pop->'rows')::text);
 for person in select i.*,c.row_data old from _ep_inputs i left join public.ab_e8_trader_perf_trader_cache c
 on c.trader_id=i.id and c.latency=i.latency and c.slippage=i.slippage
 where i.latency=cell.latency and i.slippage=cell.slippage loop
 if rebuild or person.old is null or person.old->>'_input_fingerprint' is distinct from person.input_fingerprint
 or person.old->>'_population_fingerprint' is distinct from pop_fingerprint then
 tr:=person.trades;
 inferred:=public.ab_e8_trader_infer(tr,pop,cfg,asof)||jsonb_build_object('id',person.id,'trader_id',person.id,
 'email',person.email,'trader',person.email,'latency',cell.latency,'slippage',cell.slippage,
 '_input_fingerprint',person.input_fingerprint,'_population_fingerprint',pop_fingerprint,
 'a_net',(select case when count(*) filter(where x->>'reason' is null)=0 and count(*)>0 then null else coalesce(sum((x->>'a_net')::numeric),0) end from jsonb_array_elements(tr)x),
 'b_net',(select case when count(*) filter(where x->>'reason' is null)=0 and count(*)>0 then null else coalesce(sum((x->>'b_net')::numeric),0) end from jsonb_array_elements(tr)x),
 'trades',(select count(*) from jsonb_array_elements(tr)x where x->>'reason' is null),
 'gross_per_trade',(select avg((x->>'gross')::numeric) from jsonb_array_elements(tr)x where x->>'reason' is null),
 'cost_per_trade',(select avg((x->>'spread')::numeric+(x->>'commission')::numeric+(x->>'slippage')::numeric) from jsonb_array_elements(tr)x where x->>'reason' is null),
 'gross_spread_multiple',(select avg((x->>'spread_multiple')::numeric) from jsonb_array_elements(tr)x where x->>'reason' is null),
 'source_trades',jsonb_array_length(tr),'not_priced',(select count(*) from jsonb_array_elements(tr)x where x->>'reason' is not null),
 'symbols',(select coalesce(jsonb_agg(jsonb_build_object('symbol',symbol,'trades',k,'share',k::numeric/nullif(jsonb_array_length(tr),0)) order by symbol),'[]')
 from(select x->>'symbol' symbol,count(*) k from jsonb_array_elements(tr)x group by 1)s),
 'as_of',asof,'config_version',cv);
 insert into public.ab_e8_trader_perf_trader_cache values(person.id,cell.latency,cell.slippage,asof,inferred)
 on conflict(trader_id,latency,slippage) do update set computed_at=excluded.computed_at,row_data=excluded.row_data;
 end if;
 end loop;
 end loop;
 -- All displayed stress cells belong to ONE family: choosing a favorable
 -- scenario after looking at the grid must not escape multiplicity control.
 select public.ab_e8_trader_adjust(coalesce(jsonb_agg(row_data order by trader_id,latency,slippage),'[]'),cfg) into tr
 from public.ab_e8_trader_perf_trader_cache;
 update public.ab_e8_trader_perf_trader_cache c set row_data=x.r from jsonb_array_elements(tr)x(r)
 where c.trader_id=(x.r->>'trader_id')::uuid and c.latency=(x.r->>'latency')::int and c.slippage=(x.r->>'slippage')::int;
 insert into public.ab_e8_trader_perf_history(trader_id,latency,slippage,captured_at,input_cutoff,config_version,config,row_data)
 select c.trader_id,c.latency,c.slippage,asof,asof,cv,cfg,c.row_data from public.ab_e8_trader_perf_trader_cache c
 left join lateral(select h.* from public.ab_e8_trader_perf_history h where h.trader_id=c.trader_id and h.latency=c.latency
 and h.slippage=c.slippage order by h.id desc limit 1)prev on true
 where prev.id is null or prev.config_version<>cv or prev.captured_at<date_trunc('day',asof)
 or prev.row_data->>'evidence_class' is distinct from c.row_data->>'evidence_class'
 or prev.row_data->>'_input_fingerprint' is distinct from c.row_data->>'_input_fingerprint';
 -- Cent control compares unrounded raw sums against the existing book totals.
 if exists(select 1 from(values('a','a_net'),('b','b_net'))b(book,key) where abs(
 coalesce((select sum((payload->>b.key)::numeric) from public.ab_e8_trader_perf_trade_cache where latency=2 and slippage=0),0)
 -coalesce((src->'books'->b.book->'summary'->>'net_pnl')::numeric,0))>0.0051) then
 raise exception 'Global A/B cent reconciliation failed'; end if;
 meta:=jsonb_build_object('available',true,'as_of',asof,'source_computed_at',source_at,'config',cfg,'config_version',cv,'risk_policy',risk_policy,
 'settings',jsonb_build_object('entry_latencies',array[1,2,5,15],'slippage_ticks',array[0,1,2],'exit_latency',5,
 'daily_loss_limit',625,'max_drawdown_limit',3000,'account_size',50000,'live_broker',false),
 'calibration',jsonb_build_object('label','MEASURED','n',jsonb_array_length(coalesce(src->'real_fill_check','[]')),
 'real_fill_check',(select coalesce(jsonb_agg(x||jsonb_build_object('adverse_difference',
 (x->>'difference')::numeric*case when x->>'side'='buy' then 1 else -1 end)),'[]') from jsonb_array_elements(coalesce(src->'real_fill_check','[]'))x),
 'model',jsonb_build_object('label','ASSUMED','fitted',false,'reason','Six fills are insufficient for a reliable impact model; 0/1/2 tick scenarios are assumptions')),
 'real_fill_check',src->'real_fill_check','control',src->'books','reconciliation',jsonb_build_object('ok',true,'tolerance_usd',0.0051),
 'walkforward_cells',(select metadata->'walkforward_cells' from public.ab_e8_trader_perf_cache where id=1),
 'walkforward',jsonb_build_object('status','since deployment forward-only','available',false,'snapshots', '[]'::jsonb,
 'reason','No preexisting actionable point-in-time snapshots; prospective replay is separate'),
 'version',1,'coverage',jsonb_build_object('source_trades',(select count(*) from _ep_source),
 'priced',(select count(*) from public.ab_e8_trader_perf_trade_cache where latency=2 and slippage=0 and payload->>'reason' is null),
 'not_priced',(select count(*) from public.ab_e8_trader_perf_trade_cache where latency=2 and slippage=0 and payload->>'reason' is not null),
 'people',(select count(*) from public.ab_e8_trader_perf_trader_cache where latency=2 and slippage=0)),
 'availability',jsonb_build_object('swaps','unknown','margin_policy','unknown','crowding_policy','unknown','sequential_evidence','unavailable'),
 'repriced_trades',n,'timings_ms',tm||jsonb_build_object('inference',round(extract(epoch from clock_timestamp()-stage)*1000)));
 meta:=meta||jsonb_build_object('walkforward',coalesce((select metadata->'walkforward' from public.ab_e8_trader_perf_cache where id=1),meta->'walkforward'));
 insert into public.ab_e8_trader_perf_cache values(1,asof,source_at,meta)
 on conflict(id) do update set computed_at=excluded.computed_at,source_computed_at=excluded.source_computed_at,
 metadata=excluded.metadata||jsonb_build_object(
 'walkforward_cells',coalesce(public.ab_e8_trader_perf_cache.metadata->'walkforward_cells',excluded.metadata->'walkforward_cells'),
 'walkforward',coalesce(public.ab_e8_trader_perf_cache.metadata->'walkforward',excluded.metadata->'walkforward'));
 update public.ab_e8_trader_perf_config set rebuild_requested=false,requested_at=null where id=1;
 update public.ab_e8_trader_perf_runs set status='success',finished_at=clock_timestamp(),repriced=n,detail=meta where id=rid;
 update public.ab_alerts set resolved_at=clock_timestamp(),last_seen=clock_timestamp()
 where key='e8_trader_perf_refresh' and resolved_at is null;
 return jsonb_build_object('ok',true,'repriced',n,'run_id',rid);
 exception when others then
 get stacked diagnostics err=message_text,err_context=pg_exception_context;
 update public.ab_e8_trader_perf_runs set status='failed',finished_at=clock_timestamp(),error=err,detail=jsonb_build_object('context',err_context) where id=rid;
 insert into public.ab_alerts(key,severity,category,title,detail) values('e8_trader_perf_refresh','warning','system','Individual trader replay refresh failed',err)
 on conflict(key) do update set last_seen=clock_timestamp(),resolved_at=null,detail=excluded.detail;
 return jsonb_build_object('ok',false,'error',err,'retained_previous_cache',true,'run_id',rid);
 end;
end $$;

create or replace function public.ab_e8_trader_perf_read(p_latency int default 2,p_slippage int default 0,p_page int default 0,
 p_limit int default 100,p_query text default '',p_class text default '',p_symbol text default '',p_min_trades int default 0,
 p_sort text default 'a_net',p_desc boolean default true)
returns jsonb language sql stable security definer set search_path to '' as $$
 with filtered as(select c.row_data r from public.ab_e8_trader_perf_trader_cache c
 where latency=p_latency and slippage=p_slippage and (p_query='' or c.row_data->>'email' ilike '%'||p_query||'%')
 and (p_class='' or c.row_data->>'evidence_class'=p_class) and coalesce((c.row_data->>'trades')::int,0)>=greatest(p_min_trades,0)
 and (p_symbol='' or exists(select 1 from public.ab_e8_trader_perf_trade_cache t where t.trader_id=c.trader_id
 and t.latency=p_latency and t.slippage=p_slippage and t.payload->>'symbol'=p_symbol))),
 paged as(select r-array['details','posterior','raw','_input_fingerprint','_population_fingerprint'] as r from filtered order by
 case when p_desc then case when p_sort in('a_net','b_net','trades','active_days','gross_per_trade','cost_per_trade','p_copy','p_reverse','q_copy','q_reverse') then (r->>p_sort)::numeric end end desc nulls last,
 case when not p_desc then case when p_sort in('a_net','b_net','trades','active_days','gross_per_trade','cost_per_trade','p_copy','p_reverse','q_copy','q_reverse') then (r->>p_sort)::numeric end end asc nulls last,
 case when p_sort in('trader','evidence_class') and p_desc then r->>case when p_sort='trader' then 'email' else p_sort end end desc,
 case when p_sort in('trader','evidence_class') and not p_desc then r->>case when p_sort='trader' then 'email' else p_sort end end asc,
 r->>'email',r->>'trader_id' limit least(greatest(p_limit,1),100) offset greatest(p_page,0)*least(greatest(p_limit,1),100)),
 counts as(select coalesce(jsonb_object_agg(k,n),'{}') classes from(select row_data->>'evidence_class' k,count(*) n
 from public.ab_e8_trader_perf_trader_cache where latency=p_latency and slippage=p_slippage group by 1)x where k is not null),
 viewmeta as(select (metadata-'control')||jsonb_build_object('computed_at',computed_at,'stale',computed_at<now()-interval '30 minutes',
 'walk_forward',coalesce(metadata->'walkforward_cells'->(p_latency::text||':'||p_slippage::text),metadata->'walkforward'),
 'walkforward',coalesce(metadata->'walkforward_cells'->(p_latency::text||':'||p_slippage::text),metadata->'walkforward')) m from public.ab_e8_trader_perf_cache where id=1)
 select coalesce((select m from viewmeta),
 '{"available":false,"reason":"Awaiting scheduled refresh"}'::jsonb)||jsonb_build_object('latency',p_latency,'slippage',p_slippage,
 'total',(select count(*) from filtered),
 'traders',(select coalesce(jsonb_agg(r),'[]') from paged),'population',(select count(*) from public.ab_e8_trader_perf_trader_cache where latency=p_latency and slippage=p_slippage),
 'summary',(select jsonb_build_object('population',count(*),'enough_data',count(*) filter(where (row_data->>'inference_trades')::int>=100),
 'copy_candidates',count(*) filter(where row_data->>'evidence_class'='COPY_CANDIDATE'),
 'reverse_candidates',count(*) filter(where row_data->>'evidence_class'='REVERSE_CANDIDATE'),
 'classified',count(*) filter(where row_data->>'evidence_class'<>'INSUFFICIENT_DATA'),
 'expected_false_discovery_share',null,'reason','No actionable prospective evidence yet') from public.ab_e8_trader_perf_trader_cache where latency=p_latency and slippage=p_slippage),
 'classes',(select classes from counts),'class_counts',(select classes from counts))
$$;
create or replace function public.ab_e8_trader_perf_detail(p_trader_id uuid,p_latency int,p_slippage int)
returns jsonb language sql stable security definer set search_path to '' as $$
 with person as(select row_data r from public.ab_e8_trader_perf_trader_cache where trader_id=p_trader_id and latency=p_latency and slippage=p_slippage),
 trades as(select payload,minute_path,trade_id from public.ab_e8_trader_perf_trade_cache where trader_id=p_trader_id and latency=p_latency and slippage=p_slippage),
 events as(select (p->>'at')::timestamptz m,sum((p->>'a_float')::numeric) af,sum((p->>'b_float')::numeric) bf,
 sum((p->>'a_delta')::numeric) ad,sum((p->>'b_delta')::numeric) bd,bool_or((p->>'mark_missing')::boolean) missing
 from trades cross join lateral jsonb_array_elements(minute_path)p group by 1),
 curve as(select *,sum(ad) over(order by m)+af a,sum(bd) over(order by m)+bf b,
 sum(ad) over(partition by (m at time zone 'UTC')::date order by m)+af a_day,
 sum(bd) over(partition by (m at time zone 'UTC')::date order by m)+bf b_day from events),
 sampled as(select *,row_number() over(order by m) rn,count(*) over() cnt from curve),
 daily_counts as(select ((payload->>'out_at')::timestamptz at time zone 'UTC')::date as day,count(*) trades from trades where payload->>'reason' is null group by 1),
 daily as(select (c.m at time zone 'UTC')::date as day,sum(c.ad) a_net,sum(c.bd) b_net,min(c.a_day) a_worst,min(c.b_day) b_worst,
 coalesce(max(d.trades),0) trades from curve c left join daily_counts d on d.day=(c.m at time zone 'UTC')::date group by 1),
 marks as(select (h->>'seconds')::int seconds,count(*) filter(where (h->>'available')::boolean) priced,
 avg((h->>'gross')::numeric) gross,avg((h->>'price')::numeric) price,
 avg((h->>'spread_multiple')::numeric) spread_multiple,avg((h->>'r_multiple')::numeric) r_multiple,
 avg((h->>'a_net')::numeric) a_net,avg((h->>'b_net')::numeric) b_net
 from trades cross join lateral jsonb_array_elements(coalesce(payload->'markouts','[]'))h group by 1),
 regimes as(select d.dimension,d.regime,count(*) trades,sum((payload->>'a_net')::numeric) a_net,sum((payload->>'b_net')::numeric) b_net,
 'Descriptive cached execution results; no regime stability inference' reason from trades cross join lateral(values
 ('week',to_char((payload->>'opened_at')::timestamptz at time zone 'UTC','IYYY-IW')),
 ('session',case when extract(hour from (payload->>'opened_at')::timestamptz at time zone 'UTC')<8 then '00–08 UTC'
 when extract(hour from (payload->>'opened_at')::timestamptz at time zone 'UTC')<16 then '08–16 UTC' else '16–24 UTC' end))d(dimension,regime)
 where payload->>'reason' is null group by 1,2),
 symbols as(select payload->>'symbol' symbol,count(*) source_trades,count(*) filter(where payload->>'reason' is null) trades,
 sum((payload->>'a_net')::numeric) a_net,sum((payload->>'b_net')::numeric) b_net from trades group by 1),
 hold_bins as(select case when (payload->>'hold_s')::numeric<60 then '<60s' when (payload->>'hold_s')::numeric<300 then '1–5m'
 when (payload->>'hold_s')::numeric<3600 then '5–60m' when (payload->>'hold_s')::numeric>=3600 then '60m+' else 'unknown' end bin,count(*) n from trades group by 1),
 result as(select jsonb_build_object('available',exists(select 1 from person),'row',(select r from person),'trader',(select r from person),
 'summary',(select r from person),'details',(select r->'details' from person),
 'trades',(select coalesce(jsonb_agg(payload order by payload->>'opened_at',trade_id),'[]') from(select * from trades order by payload->>'opened_at' desc,trade_id limit 500)t),
 'trade_count',(select count(*) from trades),'trades_truncated',(select count(*)>500 from trades),
 'sensitivity',(select coalesce(jsonb_agg(row_data order by latency,slippage),'[]') from public.ab_e8_trader_perf_trader_cache where trader_id=p_trader_id),
 'curves',(select coalesce(jsonb_agg(jsonb_build_object('at',m,'a',a,'b',b,'mark_missing',missing) order by m),'[]') from sampled
 where rn=1 or rn=cnt or mod(rn-1,greatest(1,ceil(cnt::numeric/998)::int))=0),
 'daily',(select coalesce(jsonb_agg(to_jsonb(d) order by day),'[]') from daily d),
 'symbols',(select coalesce(jsonb_agg(to_jsonb(s) order by symbol),'[]') from symbols s),
 'markouts',(select coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('horizon',seconds,'price_move',price,'r',r_multiple,'n',priced) order by seconds),'[]') from marks m),
 'own_exit',(select jsonb_build_object('gross',avg((payload->>'gross')::numeric),'price',avg((payload->'own_exit'->>'price')::numeric),
 'spread_multiple',avg((payload->>'spread_multiple')::numeric),'r_multiple',avg((payload->>'r_multiple')::numeric)) from trades where payload->>'reason' is null),
 'distributions',jsonb_build_object('hold_time',(select coalesce(jsonb_agg(to_jsonb(h)),'[]') from hold_bins h),
 'a_net',(select jsonb_build_object('wins',count(*) filter(where (payload->>'a_net')::numeric>0),'losses',count(*) filter(where (payload->>'a_net')::numeric<=0),
 'avg_win',avg((payload->>'a_net')::numeric) filter(where (payload->>'a_net')::numeric>0),'avg_loss',avg((payload->>'a_net')::numeric) filter(where (payload->>'a_net')::numeric<=0)) from trades),
 'b_net',(select jsonb_build_object('wins',count(*) filter(where (payload->>'b_net')::numeric>0),'losses',count(*) filter(where (payload->>'b_net')::numeric<=0),
 'avg_win',avg((payload->>'b_net')::numeric) filter(where (payload->>'b_net')::numeric>0),'avg_loss',avg((payload->>'b_net')::numeric) filter(where (payload->>'b_net')::numeric<=0)) from trades))) j)
 select j||jsonb_build_object('equity',j->'curves','hold_histogram',(select coalesce(jsonb_agg(jsonb_build_object('label',bin,'count',n)),'[]') from hold_bins),
 'result_histogram',(select jsonb_agg(jsonb_build_object('label',label,'count',n)) from(select label,count(*) n from trades cross join lateral
 (select case when (payload->>'a_net')::numeric<0 then 'A loss' when (payload->>'a_net')::numeric>0 then 'A win' when (payload->>'a_net')::numeric=0 then 'A flat' else 'Not priced' end label)x group by label)bins),
 'decomposition',(select jsonb_build_object('gross',sum((payload->>'gross')::numeric),'spread',sum((payload->>'spread')::numeric),
 'commission',sum((payload->>'commission')::numeric),'slippage',sum((payload->>'slippage')::numeric),
 'pair_net',sum((payload->>'a_net')::numeric+(payload->>'b_net')::numeric)) from trades where payload->>'reason' is null),
 'regimes',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from regimes r),
 'statistics',(select r->'details' from person),'tails',(select coalesce(r->'details'->'tail',r->'details'->'tails') from person),
 'sample_gap',(select coalesce(r->'sample_gap',r->'details'->'power') from person),
 'copy_error',jsonb_build_object('available',false,'label','ASSUMED','reason','Insufficient actual fills to fit common/idiosyncratic copy error; no fabricated residual'),
 'variants',jsonb_build_object('risk_preserving_reverse',(select jsonb_build_object('net',sum((payload->>'risk_b_net')::numeric),
 'priced',count(*) filter(where payload->>'risk_b_net' is not null),'not_priced',count(*) filter(where payload->>'risk_b_net' is null)) from trades),
 'fixed_horizons',(select coalesce(jsonb_agg(to_jsonb(m) order by seconds),'[]') from marks m))) from result
$$;

-- Only saved per-trade paths are read here. No quote joins or live execution.
create or replace function public.ab_e8_trader_perf_portfolio(p_trader_ids uuid[],p_book text,p_latency int,p_slippage int)
returns jsonb language sql stable security definer set search_path to '' as $$
 with selected as(select * from public.ab_e8_trader_perf_trade_cache where trader_id=any(p_trader_ids)
 and latency=p_latency and slippage=p_slippage and payload->>'reason' is null),
 ev as(select s.trader_id,s.payload,p,(p->>'at')::timestamptz m,
 (p->>(p_book||'_float'))::numeric fl,(p->>(p_book||'_delta'))::numeric rd from selected s cross join lateral jsonb_array_elements(s.minute_path)p),
 agg as(select m,sum(fl) fl,sum(rd) rd,count(*) filter(where (p->>'open')::int=1) open_n,
 bool_or((p->>'mark_missing')::boolean) missing from ev group by m),
 timeline as(select *,sum(rd) over(order by m) realized,
 sum(rd) over(order by m)-sum(rd) over(partition by (m at time zone 'UTC')::date order by m) day_start from agg),
 marked as(select *,realized+fl pnl,realized+fl-day_start daily_pnl from timeline),
 drawdowns as(select *,greatest(0,max(pnl) over(order by m))-pnl drawdown from marked),
 breach as(select * from marked where pnl<=-3000 or daily_pnl<=-625 order by m limit 1),
 allocations as(select trader_id,sum(rd) realized_net,sum(rd) filter(where m<=(select m from breach)) realized_at_breach from ev group by trader_id),
 own_events as(select trader_id,m,sum(rd) rd,sum(fl) fl from ev group by trader_id,m),
 excluded as(select a.trader_id,t.m,t.realized,t.fl,t.day_start,
 coalesce(o.fl,0) own_fl,sum(coalesce(o.rd,0)) over(partition by a.trader_id order by t.m) own_realized,
 sum(coalesce(o.rd,0)) over(partition by a.trader_id,(t.m at time zone 'UTC')::date order by t.m) own_day
 from allocations a cross join timeline t left join own_events o on o.trader_id=a.trader_id and o.m=t.m),
 without_paths as(select *,realized-own_realized+fl-own_fl pnl,
 realized-own_realized+fl-own_fl-(day_start-own_realized+own_day) daily_pnl from excluded),
 without_breach as(select distinct on(trader_id) trader_id,m,pnl from without_paths where pnl<=-3000 or daily_pnl<=-625 order by trader_id,m),
 contributions as(select a.*,coalesce(b.pnl,(select sum(rd) from ev)-a.realized_net) without_net,b.m without_breach_at,
 coalesce((select pnl from breach),(select sum(rd) from ev))-coalesce(b.pnl,(select sum(rd) from ev)-a.realized_net) marginal_net
 from allocations a left join without_breach b using(trader_id)),
 sampled as(select *,row_number() over(order by m) rn,count(*) over() cnt from marked),
 crowd as(select m,payload->>'symbol' symbol,payload->>'side' side,count(distinct trader_id) traders from ev where (p->>'open')::int=1 group by 1,2,3)
 select jsonb_build_object('available',p_book in('a','b') and exists(select 1 from selected),'book',p_book,'live_broker',false,'executable',false,
 'account_size',50000,'daily_loss_limit',625,'max_drawdown_limit',3000,'breached',exists(select 1 from breach),
 'breach_at',(select m from breach),'breach_kind',(select case when pnl<=-3000 then 'max_drawdown' else 'daily_loss' end from breach),
 'pnl_at_breach',(select pnl from breach),'unconstrained_net',(select sum(rd) from ev),
 'net',(select coalesce((select pnl from breach),(select sum(rd) from ev))),
 'worst_day',(select min(daily_pnl) from marked),'max_drawdown',(select max(drawdown) from drawdowns),'max_open',(select max(open_n) from marked),
 'mark_missing',coalesce((select bool_or(missing) from marked),false),'path',(select coalesce(jsonb_agg(jsonb_build_object('at',m,'net',pnl,'daily_pnl',daily_pnl) order by m),'[]') from sampled
 where rn=1 or rn=cnt or mod(rn-1,greatest(1,ceil(cnt::numeric/998)::int))=0 or m=(select m from breach)),
 'contributions',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from contributions c),
 'crowding',jsonb_build_object('max_same_symbol_side_traders',(select max(traders) from crowd),'policy_enforced',false),
 'risk_policy',(select metadata->'risk_policy'->p_book from public.ab_e8_trader_perf_cache where id=1),
 'risk_policy_enforced',false,'marginal_method','Shared E8 stopped net minus leave-one-person-out stopped net; fixed saved lots',
 'limitations',jsonb_build_array('Minute sampled equity can miss intra-minute breaches','Swaps and broker margin policy unknown',
 'Allocator crowd caps and risk reservations are not replayed; this is not executable','After breach the account is closed; later path is unconstrained'))
$$;

create or replace function public.ab_e8_trader_perf_nightly()
returns void language sql security definer set search_path to '' as $$
 update public.ab_e8_trader_perf_config set rebuild_requested=true,requested_at=clock_timestamp() where id=1
$$;
-- Independent health check: it still runs when the heavy refresh stops succeeding.
create or replace function public.ab_e8_trader_perf_watchdog()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare last_cache timestamptz; last_failure timestamptz; unhealthy boolean;
begin
 select computed_at into last_cache from public.ab_e8_trader_perf_cache where id=1;
 select max(finished_at) into last_failure from public.ab_e8_trader_perf_runs where status='failed';
 unhealthy:=last_cache is null or last_cache<clock_timestamp()-interval '30 minutes'
 or coalesce(last_failure>last_cache,false);
 if unhealthy then
 insert into public.ab_alerts(key,severity,category,title,detail)
 values('e8_trader_perf_stale','warning','system','Individual trader performance cache is stale or failed',
 concat('Last cache: ',coalesce(last_cache::text,'never'),'; latest failure: ',coalesce(last_failure::text,'none')))
 on conflict(key) do update set last_seen=clock_timestamp(),resolved_at=null,detail=excluded.detail;
 else
 update public.ab_alerts set resolved_at=clock_timestamp(),last_seen=clock_timestamp()
 where key='e8_trader_perf_stale' and resolved_at is null;
 end if;
 return jsonb_build_object('ok',not unhealthy,'computed_at',last_cache);
end $$;
revoke all on function public.ab_e8_trader_perf_refresh_private(boolean),public.ab_e8_trader_perf_nightly(),public.ab_e8_trader_perf_watchdog() from public,anon,authenticated,service_role;
revoke all on function public.ab_e8_trader_perf_refresh(),public.ab_e8_trader_perf_read(int,int,int,int,text,text,text,int,text,boolean),
 public.ab_e8_trader_perf_detail(uuid,int,int),public.ab_e8_trader_perf_portfolio(uuid[],text,int,int) from public,anon,authenticated;
grant execute on function public.ab_e8_trader_perf_refresh(),public.ab_e8_trader_perf_read(int,int,int,int,text,text,text,int,text,boolean),
 public.ab_e8_trader_perf_detail(uuid,int,int),public.ab_e8_trader_perf_portfolio(uuid[],text,int,int) to service_role;
do $cron$ begin
 if exists(select 1 from pg_extension where extname='pg_cron') then
 perform cron.schedule('ipfx-e8-trader-perf','3,13,23,33,43,53 * * * *','select public.ab_e8_trader_perf_refresh_private()');
 perform cron.schedule('ipfx-e8-trader-perf-nightly','1 2 * * *','select public.ab_e8_trader_perf_nightly()');
 perform cron.schedule('ipfx-e8-trader-perf-watchdog','*/5 * * * *','select public.ab_e8_trader_perf_watchdog()');
 end if;
end $cron$;
commit;
