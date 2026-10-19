-- E8 sends a single default tick band as [{tickSize, leftRangeLimit:null}].
-- Unknown or genuinely tiered schedules remain unpriced in slippage stresses.
begin;
create or replace function public.ab_e8_trader_tick_size(p_value jsonb)
returns numeric language plpgsql immutable set search_path to '' as $$
declare v jsonb:=p_value; s text;
begin
 if jsonb_typeof(v)='array' then
  if jsonb_array_length(v)<>1 or coalesce(v->0->>'leftRangeLimit','')<>'' then return null; end if;
  v:=v->0->'tickSize';
 end if;
 if jsonb_typeof(v) not in ('number','string') then return null; end if;
 s:=v#>>'{}';
 if s !~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$' then return null; end if;
 if s::numeric<=0 then return null; end if;
 return s::numeric;
end $$;
revoke all on function public.ab_e8_trader_tick_size(jsonb) from public,anon,authenticated,service_role;
do $patch$ declare source text; old text:= $old$coalesce(nullif(e.details->>'tickSize','')::numeric,nullif(e.details->>'tick_size','')::numeric,
          nullif(to_jsonb(sp)->>'tick_size','')::numeric) tick_size$old$;
 replacement text:=$new$coalesce(public.ab_e8_trader_tick_size(e.details->'tickSize'),public.ab_e8_trader_tick_size(e.details->'tick_size'),
          public.ab_e8_trader_tick_size(to_jsonb(sp)->'tick_size')) tick_size$new$;
begin
 select pg_get_functiondef('public.ab_e8_trader_perf_refresh_private(boolean)'::regprocedure) into source;
 if strpos(source,old)=0 then raise exception 'Tick metadata patch anchor missing'; end if;
 execute replace(source,old,replacement);
end $patch$;
commit;
