-- Admission needs paths only for still-open accepted positions. Keep compact
-- closed cash observations so subsequent entries use the identical day balance.
begin;
do $patch$ declare source text; old text; replacement text;
begin
 select pg_get_functiondef('public.ab_e8_trader_perf_admit(uuid[],text,integer,integer)'::regprocedure) into source;
 old:='side_sign:=case when (t->>''side''=''buy'')=(p_book=''a'') then 1 else -1 end;';
 if strpos(source,old)=0 then raise exception 'Allocator working-set patch anchor missing'; end if;
 replacement:=old||$r$
 select coalesce(jsonb_agg(case when (x->'payload'->>'out_at')::timestamptz<=at_time then
 jsonb_build_object('payload',jsonb_build_object('out_at',x->'payload'->'out_at',
 'a_net',x->'payload'->'a_net','b_net',x->'payload'->'b_net')) else x end),'[]') into rows
 from jsonb_array_elements(rows)x;$r$;
 source:=replace(source,old,replacement);
 source:=replace(source,$o$jsonb_build_object('payload',t,'path',r.minute_path,'risk',risk,'cost',cost,'sign',side_sign)$o$,
 $r$jsonb_build_object('payload',jsonb_build_object('out_at',t->'out_at','a_net',t->'a_net','b_net',t->'b_net',
 'trader_id',t->'trader_id','symbol',t->'symbol','lots',t->'lots','margin',t->'margin'),
 'path',r.minute_path,'risk',risk,'cost',cost,'sign',side_sign)$r$);
 execute source;
end $patch$;
commit;
