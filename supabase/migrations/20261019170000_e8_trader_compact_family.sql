-- Keep wide per-person diagnostics out of the multiplicity sort/window work.
begin;
do $patch$ declare source text; lo int; hi int; replacement text;
begin
 select pg_get_functiondef('public.ab_e8_trader_perf_refresh_private(boolean)'::regprocedure) into source;
 lo:=strpos(source,' select public.ab_e8_trader_adjust(coalesce(jsonb_agg(row_data order by trader_id,latency,slippage)');
 hi:=strpos(source,' tm:=tm||jsonb_build_object(''inference_family''');
 if lo=0 or hi<=lo then raise exception 'Compact family patch anchor missing'; end if;
 replacement:=$r$ select public.ab_e8_trader_adjust(coalesce(jsonb_agg(jsonb_build_object(
 'trader_id',trader_id,'latency',latency,'slippage',slippage,
 'pvalue_copy',row_data->'pvalue_copy','pvalue_reverse',row_data->'pvalue_reverse',
 'evidence_class',row_data->'evidence_class','reasons',row_data->'reasons',
 'details',jsonb_build_object('anytime',row_data->'details'->'anytime',
 'candidate_gates',row_data->'details'->'candidate_gates')) order by trader_id,latency,slippage),'[]'),cfg) into tr
 from public.ab_e8_trader_perf_trader_cache;
 update public.ab_e8_trader_perf_trader_cache c set row_data=c.row_data||x.patch||
 jsonb_build_object('details',c.row_data->'details'||jsonb_build_object('fdr',x.fdr))
 from(select r,jsonb_build_object('q_copy',r->'q_copy','q_reverse',r->'q_reverse',
 'evidence_class',r->'evidence_class','reasons',r->'reasons') patch,r->'details'->'fdr' fdr
 from jsonb_array_elements(tr)t(r))x
 where c.trader_id=(x.r->>'trader_id')::uuid and c.latency=(x.r->>'latency')::int and c.slippage=(x.r->>'slippage')::int
 and (c.row_data->'q_copy' is distinct from x.r->'q_copy'
 or c.row_data->'q_reverse' is distinct from x.r->'q_reverse'
 or c.row_data->'evidence_class' is distinct from x.r->'evidence_class'
 or c.row_data->'reasons' is distinct from x.r->'reasons'
 or c.row_data->'details'->'fdr' is distinct from x.fdr);
$r$;
 source:=substr(source,1,lo-1)||replacement||substr(source,hi);
 execute source;
end $patch$;
commit;
