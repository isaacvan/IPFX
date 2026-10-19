-- Equivalent BY suffix minima via a reverse cumulative scan: O(m log m),
-- avoiding a non-invertible moving MIN frame with quadratic rescans.
begin;
do $patch$ declare source text;
begin
 select pg_get_functiondef('public.ab_e8_trader_adjust(jsonb,jsonb)'::regprocedure) into source;
 if strpos(source,'order by p,id,direction rows between current row and unbounded following')=0 then
  raise exception 'BY performance patch anchor missing';
 end if;
 source:=replace(source,'order by p,id,direction rows between current row and unbounded following',
 'order by p desc,id desc,direction desc rows between unbounded preceding and current row');
 source:=replace(source,'order by candidate_p,id,direction rows between current row and unbounded following',
 'order by candidate_p desc,id desc,direction desc rows between unbounded preceding and current row');
 execute source;
end $patch$;
commit;
