-- Reuse the identical zero-observation inference within each execution cell.
-- Population cache invalidation uses only peers eligible for the actual prior.
begin;
do $patch$ declare source text; old text; replacement text;
begin
 select pg_get_functiondef('public.ab_e8_trader_perf_refresh_private(boolean)'::regprocedure) into source;
 source:=replace(source,'tr jsonb; pop jsonb; inferred jsonb;', 'tr jsonb; pop jsonb; inferred jsonb; empty_inferred jsonb;');
 old:='pop_fingerprint:=md5((pop->''rows'')::text);';
 if strpos(source,old)=0 then raise exception 'Empty inference patch anchor missing'; end if;
 replacement:=$r$select md5(coalesce(jsonb_agg(v order by v->>'trader_id'),'[]')::text) into pop_fingerprint
 from jsonb_array_elements(pop->'rows')v where (v->>'trades')::int>=30 and (v->>'active_days')::int>=10
 and abs((v->>'mean')::double precision)<1e100 and (v->>'variance')::double precision>=0 and (v->>'variance')::double precision<1e100;
 empty_inferred:=public.ab_e8_trader_infer('[]',pop,cfg,asof);$r$;
 source:=replace(source,old,replacement);
 source:=replace(source,'inferred:=public.ab_e8_trader_infer(tr,pop,cfg,asof)||',
 'inferred:=(case when tr=''[]''::jsonb then empty_inferred else public.ab_e8_trader_infer(tr,pop,cfg,asof) end)||');
 source:=replace(source,'-- All displayed stress cells belong to ONE family:',
 $r$tm:=tm||jsonb_build_object('inference_people',round(extract(epoch from clock_timestamp()-stage)*1000));stage:=clock_timestamp();
 -- All displayed stress cells belong to ONE family:$r$);
 source:=replace(source,'insert into public.ab_e8_trader_perf_history(trader_id,latency,slippage,captured_at,input_cutoff,config_version,config,row_data)',
 $r$tm:=tm||jsonb_build_object('inference_family',round(extract(epoch from clock_timestamp()-stage)*1000));stage:=clock_timestamp();
 insert into public.ab_e8_trader_perf_history(trader_id,latency,slippage,captured_at,input_cutoff,config_version,config,row_data)$r$);
 execute source;
end $patch$;
commit;
