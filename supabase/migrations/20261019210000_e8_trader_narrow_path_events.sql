-- Repeat only symbol/side across portfolio minute events, rather than the full
-- trade diagnostics. Temporary research paths also use fast LZ4 compression.
begin;
do $patch$ declare source text; old text:='ev as(select s.trader_id,s.payload,p,';
begin
 select pg_get_functiondef('public.ab_e8_trader_perf_portfolio(uuid[],text,integer,integer)'::regprocedure) into source;
 if strpos(source,old)=0 then raise exception 'Narrow path events patch anchor missing'; end if;
 execute replace(source,old,$r$ev as(select s.trader_id,jsonb_build_object('symbol',s.payload->'symbol','side',s.payload->'side') payload,p,$r$);
end $patch$;
-- PGlite has only pglz; production PostgreSQL advertises LZ4 explicitly.
do $$ begin
 if exists(select 1 from pg_settings where name='default_toast_compression' and 'lz4'=any(enumvals)) then
  alter function public.ab_e8_trader_perf_refresh_private(boolean) set default_toast_compression to 'lz4';
 end if;
end $$;
-- One advisory-locked cron worker; bound sort memory locally to this function.
alter function public.ab_e8_trader_perf_refresh_private(boolean) set work_mem to '32MB';
commit;
