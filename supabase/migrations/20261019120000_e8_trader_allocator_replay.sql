-- Read-only admission replay using the saved allocator policy and E8 paths.
-- Fixed lots are preserved. A refused trade is skipped, never resized after seeing its outcome.
begin;
create or replace function public.ab_e8_trader_perf_admit(p_trader_ids uuid[],p_book text,p_latency int,p_slippage int)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare policy jsonb; accepted uuid[]:='{}'; rows jsonb:='[]'; refused jsonb:='[]'; r record; t jsonb;
 at_time timestamptz; close_time timestamptz; realized numeric; day_start numeric; floating numeric; openrisk numeric;
 ownrisk numeric; netlots numeric; used_margin numeric; crowds int; ownopen int; equity numeric; current_loss numeric;
 risk numeric; cost numeric; loss_limit numeric; room numeric; side_sign int; why text; total int;
begin
 if p_book not in('a','b') or cardinality(p_trader_ids)>50 or p_latency not in(1,2,5,15) or p_slippage not in(0,1,2) then raise exception 'Invalid portfolio selection'; end if;
 select metadata->'risk_policy'->p_book into policy from public.ab_e8_trader_perf_cache where id=1;
 if policy is null or not(policy ?& array['per_trade_max_usd','open_risk_max_usd','per_trader_open_max_usd','daily_loss_stop_usd','symbol_net_lots_max','room_multiple','crowd_max']) then
 return jsonb_build_object('available',false,'accepted_ids','[]'::jsonb,'reason','Saved allocator risk and crowd policy is unavailable; no executable portfolio estimate.'); end if;
 if exists(select 1 from unnest(array['per_trade_max_usd','open_risk_max_usd','per_trader_open_max_usd','daily_loss_stop_usd','symbol_net_lots_max','room_multiple','crowd_max']) k where coalesce((policy->>k)::numeric,0)<=0) then
 return jsonb_build_object('available',false,'accepted_ids','[]'::jsonb,'reason','Allocator policy has invalid or disabled risk bounds.'); end if;
 select count(*) into total from public.ab_e8_trader_perf_trade_cache where trader_id=any(p_trader_ids) and latency=p_latency and slippage=p_slippage and payload->>'reason' is null;
 if total>3000 then return jsonb_build_object('available',false,'accepted_ids','[]'::jsonb,'reason','Select fewer traders: this interactive admission replay is bounded to 3,000 trades.'); end if;
 loss_limit:=least(625,(policy->>'daily_loss_stop_usd')::numeric);
 for r in select trade_id,payload,minute_path from public.ab_e8_trader_perf_trade_cache
 where trader_id=any(p_trader_ids) and latency=p_latency and slippage=p_slippage and payload->>'reason' is null
 order by (payload->>'in_at')::timestamptz,(payload->>'global_priced_rank')::bigint nulls last,trade_id loop
 t:=r.payload; at_time:=(t->>'in_at')::timestamptz; close_time:=(t->>'out_at')::timestamptz; why:=null;
 cost:=coalesce((t->>'spread')::numeric,0)+coalesce((t->>'commission')::numeric,0)+coalesce((t->>'slippage')::numeric,0);
 risk:=case when p_book='a' and (t->>'source_stop_valid')::boolean then (t->>'risk_usd')::numeric+cost
 when p_book='b' and (t->>'source_target_valid')::boolean then abs((t->>'source_tp')::numeric-(t->>'mid_in')::numeric)*(t->>'contract')::numeric*(t->>'lots')::numeric*(t->>'fx')::numeric+cost end;
 side_sign:=case when (t->>'side'='buy')=(p_book='a') then 1 else -1 end;
 select coalesce(sum((x->'payload'->>(p_book||'_net'))::numeric) filter(where (x->'payload'->>'out_at')::timestamptz<=at_time),0),
 coalesce(sum((x->'payload'->>(p_book||'_net'))::numeric) filter(where (x->'payload'->>'out_at')::timestamptz<date_trunc('day',at_time at time zone 'UTC') at time zone 'UTC'),0),
 coalesce(sum(coalesce((select (m->>(p_book||'_float'))::numeric from jsonb_array_elements(x->'path')m where (m->>'at')::timestamptz<=at_time order by (m->>'at')::timestamptz desc limit 1),-(x->>'cost')::numeric)) filter(where (x->'payload'->>'out_at')::timestamptz>at_time),0),
 coalesce(sum((x->>'risk')::numeric) filter(where (x->'payload'->>'out_at')::timestamptz>at_time),0),
 coalesce(sum((x->>'risk')::numeric) filter(where (x->'payload'->>'out_at')::timestamptz>at_time and x->'payload'->>'trader_id'=t->>'trader_id'),0),
 coalesce(sum((x->>'sign')::int*(x->'payload'->>'lots')::numeric) filter(where (x->'payload'->>'out_at')::timestamptz>at_time and x->'payload'->>'symbol'=t->>'symbol'),0),
 coalesce(sum((x->'payload'->>'margin')::numeric) filter(where (x->'payload'->>'out_at')::timestamptz>at_time),0),
 count(distinct x->'payload'->>'trader_id') filter(where (x->'payload'->>'out_at')::timestamptz>at_time and x->'payload'->>'symbol'=t->>'symbol' and (x->>'sign')::int=side_sign),
 count(*) filter(where (x->'payload'->>'out_at')::timestamptz>at_time and x->'payload'->>'trader_id'=t->>'trader_id')
 into realized,day_start,floating,openrisk,ownrisk,netlots,used_margin,crowds,ownopen from jsonb_array_elements(rows)x;
 equity:=50000+realized+floating; current_loss:=greatest(0,day_start-realized-floating);
 room:=least((policy->>'per_trade_max_usd')::numeric,(policy->>'open_risk_max_usd')::numeric-openrisk,
 (policy->>'per_trader_open_max_usd')::numeric-ownrisk,(loss_limit-current_loss-openrisk)/greatest((policy->>'room_multiple')::numeric,1));
 if at_time is null or close_time is null then why:='Execution timestamp unavailable';
 elsif risk is null or risk<=0 then why:='Valid opposite stop/target risk unavailable';
 elsif equity<=47000 or current_loss>=loss_limit then why:='Shared account loss gate';
 elsif coalesce((policy->>'daily_profit_cap_usd')::numeric,0)>0 and realized-day_start>=(policy->>'daily_profit_cap_usd')::numeric then why:='Allocator daily profit cap';
 elsif risk>room then why:='Fixed-lot trade exceeds allocator risk room';
 elsif crowds>=(policy->>'crowd_max')::int then why:='Same symbol and side crowd cap';
 elsif abs(netlots+side_sign*(t->>'lots')::numeric)>(policy->>'symbol_net_lots_max')::numeric then why:='Net symbol lots cap';
 elsif coalesce((policy->>'trader_max_open')::int,0)>0 and ownopen>=(policy->>'trader_max_open')::int then why:='Per-trader open-position cap';
 elsif t->>'margin' is null or used_margin+(t->>'margin')::numeric>equity then why:='Gross-margin reserve unavailable or exhausted'; end if;
 if why is null then accepted:=array_append(accepted,r.trade_id);
 rows:=rows||jsonb_build_array(jsonb_build_object('payload',t,'path',r.minute_path,'risk',risk,'cost',cost,'sign',side_sign));
 else refused:=refused||jsonb_build_array(jsonb_build_object('trade_id',r.trade_id,'reason',why)); end if;
 end loop;
 return jsonb_build_object('available',true,'accepted_ids',to_jsonb(accepted),'considered',total,'accepted',cardinality(accepted),
 'rejected',total-cardinality(accepted),'rejections',refused,'policy',policy,'policy_enforced',true,
 'basis','Saved fixed lots; current frozen allocator risk/crowd limits; full round-turn cost reserved; no outcome-based resizing',
 'limitations','Minute-sampled equity; gross unhedged margin approximation; market gaps, financing and broker liquidation remain unverified.');
end $$;
revoke all on function public.ab_e8_trader_perf_admit(uuid[],text,int,int) from public,anon,authenticated,service_role;

-- Extend only this feature's new function; fail if its known source changes.
do $patch$ declare definition text; anchor text; replacement text;
begin
 definition:=pg_get_functiondef('public.ab_e8_trader_perf_portfolio(uuid[],text,int,int)'::regprocedure);
 anchor:=$a$with selected as(select * from public.ab_e8_trader_perf_trade_cache where trader_id=any(p_trader_ids)
 and latency=p_latency and slippage=p_slippage and payload->>'reason' is null),$a$;
 replacement:=$r$with admission as materialized(select public.ab_e8_trader_perf_admit(p_trader_ids,p_book,p_latency,p_slippage) r),
 selected as(select * from public.ab_e8_trader_perf_trade_cache where trader_id=any(p_trader_ids)
 and latency=p_latency and slippage=p_slippage and payload->>'reason' is null
 and trade_id in(select value::text::uuid from admission,jsonb_array_elements_text(r->'accepted_ids'))),$r$;
 if strpos(definition,anchor)=0 then raise exception 'Trader portfolio source drift'; end if;
 definition:=replace(definition,anchor,replacement);
 definition:=replace(definition,$a$'risk_policy_enforced',false$a$,$r$'admission',(select r from admission),'risk_policy_enforced',true$r$);
 definition:=replace(definition,$a$'policy_enforced',false$a$,$r$'policy_enforced',true$r$);
 definition:=replace(definition,$a$'marginal_method','Shared E8 stopped net minus leave-one-person-out stopped net; fixed saved lots'$a$,
 $r$'reason',(select r->>'reason' from admission),'marginal_method','Stopped net minus leave-one-person-out stopped net, holding accepted trade set fixed; allocator readmission is not recomputed'$r$);
 definition:=replace(definition,'Allocator crowd caps and risk reservations are not replayed; this is not executable',
 'Current allocator risk/crowd caps are replayed with fixed lots; gross margin is approximate and broker execution remains unverified');
 execute definition;
end $patch$;
commit;
