-- Horizon quotes and FX do not depend on the assumed slippage stress.
-- Observe once per trade/latency/horizon; build each cell's own net costs.
begin;
do $patch$ declare source text; lo int; hi int; lookups text; materialization text;
begin
 select pg_get_functiondef('public.ab_e8_trader_perf_refresh_private(boolean)'::regprocedure) into source;
 lo:=strpos(source,' left join lateral(select (qq.bid+qq.ask)/2 mid,qq.ask-qq.bid spread,qq.received_at as horizon_at');
 hi:=strpos(source,')mk on true');
 if lo=0 or hi<=lo then raise exception 'Shared horizon patch anchor missing';end if;
 lookups:=substr(source,lo,hi-lo);
 source:=substr(source,1,lo-1)||$r$
 left join _ep_markout_quotes q on q.trade_id=c.trade_id and q.latency=c.latency and q.seconds=h.seconds and c.reason is null
 left join lateral(select case when c.qccy='USD' then 1 else q.rate end rate)hf on true$r$||substr(source,hi);
 materialization:=$r$create temp table _ep_markout_quotes on commit drop as
 select c.trade_id,c.latency,h.seconds,q.mid,q.spread,q.horizon_at,hf.rate
 from _ep_calc c cross join(values(5),(30),(60),(300),(900),(3600))h(seconds)
$r$||lookups||$r$
 where c.slippage=0;
 create index on _ep_markout_quotes(trade_id,latency,seconds);analyze _ep_markout_quotes;
 $r$;
 source:=replace(source,'drop table if exists pg_temp._ep_quote_hashes,',
 'drop table if exists pg_temp._ep_markout_quotes,pg_temp._ep_quote_hashes,');
 source:=replace(source,'delete from public.ab_e8_trader_perf_trade_cache c where not exists',
 materialization||'delete from public.ab_e8_trader_perf_trade_cache c where not exists');
 execute source;
end $patch$;
commit;
