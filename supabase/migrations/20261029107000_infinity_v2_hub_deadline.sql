begin;
do $hub$
declare src text;needle text:='''id'', a.id, ''status'', a.status';
begin
 select pg_get_functiondef('public.hub_snapshot(text,uuid)'::regprocedure) into src;
 if position(needle in src)=0 then raise exception 'HUB_V2_SOURCE_DRIFT';end if;
 insert into public.infinity_v2_legacy_definitions values('public.hub_snapshot(text,uuid)',src);
 src:=replace(src,needle,needle||','||chr(10)||'        ''rules_version'',a.rules_version,''v2_stop_deadline_seconds'',case when a.rules_version=''infinity_v2'' then (a.infinity_rules_snapshot->>''stop_deadline_seconds'')::int end');
 execute src;
end $hub$;
commit;
