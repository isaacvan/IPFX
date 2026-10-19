-- Reuse deterministic Student critical values; do not compute a peer's prior
-- moments unless that peer meets the existing 30-observation / 10-day gate.
begin;
do $cache$ declare d int; i int; lo double precision; hi double precision; mid double precision; values_sql text:='';
begin
 for d in 1..30 loop
  lo:=0;hi:=1000;
  for i in 1..55 loop mid:=(lo+hi)/2;
   if public.ab_e8_trader_t_cdf(mid,d)<.975 then lo:=mid;else hi:=mid;end if;
  end loop;
  values_sql:=values_sql||case when d>1 then ',' else '' end||((lo+hi)/2)::text;
 end loop;
 execute format($f$create or replace function public.ab_e8_trader_critical(df int)
 returns double precision language plpgsql immutable strict set search_path to '' as $body$
 declare a double precision[]:=array[%s];lo double precision:=0;hi double precision:=1000;mid double precision;i int;
 begin
  if df<1 then return null;end if;
  if df<=30 then return a[df];end if;
  for i in 1..55 loop mid:=(lo+hi)/2;
   if public.ab_e8_trader_t_cdf(mid,df)<.975 then lo:=mid;else hi:=mid;end if;
  end loop;
  return (lo+hi)/2;
 end $body$;$f$,values_sql);
end $cache$;
create or replace function public.ab_e8_trader_prior_moments(p_rows jsonb,p_floor double precision)
returns jsonb language sql immutable strict set search_path to '' as $$
 select case when jsonb_array_length(p_rows)<30 then '{}'::jsonb
 when (select count(distinct v->>'day') from jsonb_array_elements(p_rows)v)<10 then '{}'::jsonb
 else public.ab_e8_trader_moments(p_rows,p_floor) end
$$;
revoke all on function public.ab_e8_trader_critical(int),public.ab_e8_trader_prior_moments(jsonb,double precision) from public,anon,authenticated;
grant execute on function public.ab_e8_trader_critical(int),public.ab_e8_trader_prior_moments(jsonb,double precision) to service_role;
do $patch$ declare source text; old text;
begin
 select pg_get_functiondef('public.ab_e8_trader_infer(jsonb,jsonb,jsonb,timestamptz)'::regprocedure) into source;
 old:=$o$lo:=0; hi:=1000;
  for i in 1..55 loop crit:=(lo+hi)/2; if public.ab_e8_trader_t_cdf(crit,d-1)<.975 then lo:=crit; else hi:=crit; end if; end loop;
  crit:=(lo+hi)/2;$o$;
 if strpos(source,old)=0 then raise exception 'Critical-value reuse patch anchor missing';end if;
 execute replace(source,old,'crit:=public.ab_e8_trader_critical(d-1);');
 select pg_get_functiondef('public.ab_e8_trader_perf_refresh_private(boolean)'::regprocedure) into source;
 old:=$o$public.ab_e8_trader_moments(coalesce(jsonb_agg(jsonb_build_object('v',c.payload->'gross'$o$;
 if strpos(source,old)=0 then raise exception 'Prior-moments reuse patch anchor missing';end if;
 source:=replace(source,old,$r$public.ab_e8_trader_prior_moments(coalesce(jsonb_agg(jsonb_build_object('v',c.payload->'gross'$r$);
 source:=replace(source,'create temp table _ep_paths on commit drop as',
 $r$tm:=tm||jsonb_build_object('pricing_and_marks',round(extract(epoch from clock_timestamp()-stage)*1000));stage:=clock_timestamp();
 create temp table _ep_paths on commit drop as$r$);
 source:=replace(source,'delete from public.ab_e8_trader_perf_trade_cache c where not exists',
 $r$tm:=tm||jsonb_build_object('path_json',round(extract(epoch from clock_timestamp()-stage)*1000));stage:=clock_timestamp();
 delete from public.ab_e8_trader_perf_trade_cache c where not exists$r$);
 execute source;
end $patch$;
commit;
