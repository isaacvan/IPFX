-- Hash each quote minute once. Boundary minutes can cause conservative extra
-- invalidation, but every relevant tick remains covered; no pricing changes.
begin;
do $patch$ declare source text; old text; replacement text;
begin
 select pg_get_functiondef('public.ab_e8_trader_perf_refresh_private(boolean)'::regprocedure) into source;
 source:=replace(source,'drop table if exists pg_temp._ep_control,',
 'drop table if exists pg_temp._ep_quote_hashes,pg_temp._ep_control,');
 source:=replace(source,'-- Fingerprints include only relevant source, quote, model and configuration data.',
 $r$create temp table _ep_quote_hashes on commit drop as
 select symbol,date_trunc('minute',received_at) bucket,
 md5(string_agg(concat_ws(':',id,received_at,bid,ask),'|' order by received_at,id)) fingerprint
 from _ep_quotes group by 1,2;
 create index on _ep_quote_hashes(symbol,bucket);analyze _ep_quote_hashes;
 -- Fingerprints include all relevant source, quote, model and configuration data.$r$);
 old:=$o$(select md5(coalesce(string_agg(concat_ws(':',q.id,q.received_at,q.bid,q.ask),'|' order by q.received_at,q.id),''))
 from _ep_quotes q where q.symbol=s.symbol and q.received_at between s.opened_at-interval '2 minutes'
 and greatest(s.closed_at+interval '80 seconds',s.opened_at+interval '3700 seconds'))$o$;
 replacement:=$r$(select md5(coalesce(string_agg(q.fingerprint,'|' order by q.bucket),''))
 from _ep_quote_hashes q where q.symbol=s.symbol and q.bucket between date_trunc('minute',s.opened_at-interval '2 minutes')
 and date_trunc('minute',greatest(s.closed_at+interval '80 seconds',s.opened_at+interval '3700 seconds')))$r$;
 if strpos(source,old)=0 then raise exception 'Fingerprint block patch anchor missing'; end if;
 source:=replace(source,old,replacement);
 source:=replace(source,'jsonb_agg(c.payload order by c.payload->>''opened_at'',c.trade_id)',
 $r$jsonb_agg(c.payload-array['markouts','swaps','volatility_basis','own_exit'] order by c.payload->>'opened_at',c.trade_id)$r$);
 source:=replace(source,'empty_inferred:=public.ab_e8_trader_infer(''[]'',pop,cfg,asof);',
 $r$select jsonb_set(pop,'{rows}',coalesce(jsonb_agg(v order by v->>'trader_id'),'[]')) into pop
 from jsonb_array_elements(pop->'rows')v where (v->>'trades')::int>=30 and (v->>'active_days')::int>=10
 and abs((v->>'mean')::double precision)<1e100 and (v->>'variance')::double precision>=0 and (v->>'variance')::double precision<1e100;
 empty_inferred:=public.ab_e8_trader_infer('[]',pop,cfg,asof);$r$);
 execute source;
end $patch$;
commit;
