-- Nightly rebuild refits ALL statistics and revalidates ALL quote fingerprints.
-- Unchanged immutable price inputs need no redundant replay/write. Explicit
-- p_rebuild=true remains a full price-audit diagnostic outside the cron budget.
begin;
do $patch$ declare source text; old text:='where rebuild or (select count(*) from public.ab_e8_trader_perf_trade_cache c where c.trade_id=s.trade_id and c.fingerprint=s.fingerprint)<>12;';
begin
 select pg_get_functiondef('public.ab_e8_trader_perf_refresh_private(boolean)'::regprocedure) into source;
 if strpos(source,old)=0 then raise exception 'Nightly refit patch anchor missing';end if;
 execute replace(source,old,'where p_rebuild or (select count(*) from public.ab_e8_trader_perf_trade_cache c where c.trade_id=s.trade_id and c.fingerprint=s.fingerprint)<>12;');
end $patch$;
commit;
