-- Index the saved control once; share price marks across slippage cells.
begin;
do $patch$ declare source text; lo int; hi int; replacement text;
begin
 select pg_get_functiondef('public.ab_e8_trader_perf_refresh_private(boolean)'::regprocedure) into source;
 source:=replace(source,'drop table if exists pg_temp._ep_source,',
 'drop table if exists pg_temp._ep_control,pg_temp._ep_path_marks,pg_temp._ep_source,');
 source:=replace(source,'create temp table _ep_source on commit drop as',
 $r$create temp table _ep_control on commit drop as
 select x,x->>'trader' trader,(x->>'opened_at')::timestamptz opened_at,(x->>'closed_at')::timestamptz closed_at,
 x->>'symbol' symbol,x->>'side' side from jsonb_array_elements(coalesce(src->'trades','[]'))x;
 create index on _ep_control(trader,opened_at,closed_at,symbol,side);analyze _ep_control;
 create temp table _ep_source on commit drop as$r$);
 source:=replace(source,'select x from jsonb_array_elements(coalesce(src->''trades'',''[]'')) x','select * from _ep_control');
 source:=replace(source,$o$where x->>'trader'=coalesce(u.email,t.user_id::text) and (x->>'opened_at')::timestamptz=t.opened_at
   and (x->>'closed_at')::timestamptz=t.closed_at and x->>'symbol'=t.symbol and x->>'side'=t.side$o$,
 $r$where control.trader=coalesce(u.email,t.user_id::text) and control.opened_at=t.opened_at
   and control.closed_at=t.closed_at and control.symbol=t.symbol and control.side=t.side$r$);
 lo:=strpos(source,' create temp table _ep_paths on commit drop as');
 hi:=strpos(source,' delete from public.ab_e8_trader_perf_trade_cache');
 if lo=0 or hi<=lo then raise exception 'Path reuse patch anchor missing'; end if;
 replacement:=$r$ create temp table _ep_path_marks on commit drop as
 select c.trade_id,c.latency,p.* from _ep_calc c cross join lateral(
 select g.m,
 case when q.bid is not null then ((case when c.dir=1 then q.bid else q.ask end)-(case when c.dir=1 then c.in_ask else c.in_bid end))*c.dir*c.contract*c.lots*c.fx end af,
 case when q.bid is not null then ((case when c.dir=-1 then q.bid else q.ask end)-(case when c.dir=-1 then c.in_ask else c.in_bid end))*-c.dir*c.contract*c.lots*c.fx end bf,
 0::numeric ad,0::numeric bd,1 op,q.bid is null missing
 from generate_series(date_trunc('minute',c.in_at)+interval '1 minute',date_trunc('minute',c.out_at),interval '1 minute')g(m)
 left join lateral(select qq.bid,qq.ask from _ep_quotes qq where qq.symbol=c.symbol and qq.received_at<g.m
 order by qq.received_at desc,qq.id desc limit 1)q on true
 union all select date_trunc('minute',c.out_at)+interval '1 minute',0,0,c.a_net,c.b_net,0,false
 )p where c.reason is null and c.slippage=0;
 create index on _ep_path_marks(trade_id,latency);analyze _ep_path_marks;
 create temp table _ep_paths on commit drop as
 select c.trade_id,c.latency,c.slippage,
 jsonb_agg(jsonb_build_object('at',p.m,
 'a_float',p.af-case when p.op=1 then c.slip_cost/2 else 0 end,
 'b_float',p.bf-case when p.op=1 then c.slip_cost/2 else 0 end,
 'a_delta',p.ad-case when p.op=0 then c.slip_cost else 0 end,
 'b_delta',p.bd-case when p.op=0 then c.slip_cost else 0 end,
 'open',p.op,'mark_missing',p.missing) order by p.m) path
 from _ep_calc c join _ep_path_marks p using(trade_id,latency)
 where c.reason is null group by c.trade_id,c.latency,c.slippage;
$r$;
 source:=substr(source,1,lo-1)||replacement||substr(source,hi);
 execute source;
end $patch$;
commit;
