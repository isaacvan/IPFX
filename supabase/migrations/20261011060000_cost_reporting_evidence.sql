-- Read-only reporting repair; source policy, balances, stored fills and routing are unchanged.
do $guard$ begin
 if md5(pg_get_functiondef('public.cost_summary(integer)'::regprocedure)) <> '9c9476eb1343a72c033f6d3032227092'
 or md5(pg_get_functiondef('public.shadow_funded_summary(integer,numeric)'::regprocedure)) <> 'd339b0e61e60d26696118c5e08954e55'
 then raise exception 'Cost reporting definition changed since inspection; merge the live version';end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.cost_summary(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'allin', coalesce((select jsonb_agg(to_jsonb(a) order by a.symbol) from public.cost_allin(p_days * 24) a), '[]'::jsonb),
    'spreads', coalesce((select jsonb_agg(x order by x->>'symbol') from (
      select jsonb_build_object('symbol', symbol,
        'e8', round(avg(spread) filter (where role = 'monitor'), 6),
        'demo', round(avg(spread) filter (where role = 'shadow'), 6),
        'ipfx', round(avg(ipfx_spread), 6),
        'e8_vs_demo', round(avg(spread) filter (where role = 'monitor') - avg(spread) filter (where role = 'shadow'), 6),
        'ipfx_vs_e8', round(avg(ipfx_spread) filter (where role = 'monitor') / nullif(avg(spread) filter (where role = 'monitor'), 0), 3),
        'samples', count(*), 'last', max(sampled_at)) x
      from public.cost_samples where sampled_at > now() - make_interval(days => p_days)
      group by symbol) q), '[]'::jsonb),
    'commission', coalesce((select jsonb_agg(jsonb_build_object(
      'role', role, 'fills', n, 'commission_fills', commission_n, 'swap_fills', swap_n,
      'usable_quantity_fills', quantity_n, 'commission_complete', commission_n=n and quantity_n=n,
      'swap_complete', swap_n=n, 'per_lot', per_lot,
      'basis', 'PER_FILLED_LOT_REPORTED_FIELDS_NOT_ROUND_TRIP_OR_NET_PROOF')) from (
      select role, count(*) n,
        count(*) filter(where commission is not null and commission::text not in('NaN','Infinity','-Infinity')) commission_n,
        count(*) filter(where swap is not null and swap::text not in('NaN','Infinity','-Infinity')) swap_n,
        count(*) filter(where qty is not null and qty>0 and qty::text not in('NaN','Infinity','-Infinity')) quantity_n,
        case when count(*) filter(where commission is not null and commission::text not in('NaN','Infinity','-Infinity')
          and qty is not null and qty>0 and qty::text not in('NaN','Infinity','-Infinity'))=count(*)
        then round(sum(abs(commission))/nullif(sum(qty),0),4) else null end per_lot
      from public.cost_fills where created_at > now() - make_interval(days => p_days) group by role) c), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'role', role, 'api_env', api_env,
        'last_sample', (select max(sampled_at) from public.cost_samples s where s.account_id = l.id)))
      from public.ladder_accounts l where role in ('monitor', 'shadow')), '[]'::jsonb)
  );
$function$
;

CREATE OR REPLACE FUNCTION public.shadow_funded_summary(p_days integer DEFAULT 7,p_funded numeric DEFAULT 50000)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $function$
with raw as (
 select o.source_trade_id,o.person_id,o.symbol,
  case when o.side=t.side then 'a' else 'b' end model,
  ta.starting_balance size_usd,o.price_scale_per_lot scale,
  case when o.side='buy' then 1 else -1 end dir,o.fill_price entry,c.fill_price final_exit,
  t.volume final_vol,t.pnl final_pnl,coalesce(sl.vol,0) slice_vol,coalesce(sl.move,0) slice_move,
  coalesce(sl.pnl,0) slice_pnl,coalesce(sl.n,0) partials,
  coalesce(sl.all_priced,true) and o.symbol=t.symbol and c.symbol=o.symbol and c.side<>o.side
    and o.qty is not null and o.qty>0 and o.qty::text not in('NaN','Infinity','-Infinity') and c.qty=o.qty
    and o.fill_price is not null and c.fill_price is not null
    and o.fill_price::text not in('NaN','Infinity','-Infinity') and c.fill_price::text not in('NaN','Infinity','-Infinity')
    and o.fill_price>0 and c.fill_price>0 and t.volume is not null and t.volume>0 and t.volume::text not in('NaN','Infinity','-Infinity') all_priced,
  t.pnl is not null and t.pnl::text not in('NaN','Infinity','-Infinity') and coalesce(sl.pnl_known,true) pnl_known,
  sl.max_wait_seconds
 from public.shadow_orders o
 join public.shadow_orders c on c.source_trade_id=o.source_trade_id and c.account_id=o.account_id
  and c.event='close' and c.status='closed'
 join public.trades t on t.id=o.source_trade_id and t.status='closed'
 join public.trading_accounts ta on ta.id=t.account_id
 left join lateral (
  select count(*) n,sum(tr.volume) vol,sum(tr.volume*(s.exit_price-o.fill_price)) move,sum(tr.pnl) pnl,
   bool_and(coalesce(tr.status='closed' and tr.volume>0 and tr.volume::text not in('NaN','Infinity','-Infinity')
    and tr.account_id=t.account_id and tr.user_id=t.user_id and tr.symbol=t.symbol and tr.side=t.side
    and tr.open_price=t.open_price and tr.closed_at is not null
    and s.exit_price is not null and s.exit_price>0 and s.exit_price::text not in('NaN','Infinity','-Infinity')
    and s.priced_at is not null and s.priced_at>=tr.closed_at,false)) all_priced,
   bool_and(tr.pnl is not null and tr.pnl::text not in('NaN','Infinity','-Infinity')) pnl_known,
   max(extract(epoch from s.priced_at-tr.closed_at)) max_wait_seconds
  from public.trades tr
  left join public.shadow_slices s on s.slice_trade_id=tr.id and s.source_trade_id=o.source_trade_id and s.account_id=o.account_id
  where tr.parent_trade_id=t.id and tr.close_reason='partial'
 ) sl on true
 where o.event='open' and o.status in('filled','closed') and o.side in('buy','sell') and t.side in('buy','sell')
  and o.price_scale_per_lot>0 and o.price_scale_per_lot::text not in('NaN','Infinity','-Infinity')
  and ta.starting_balance>0 and ta.starting_balance::text not in('NaN','Infinity','-Infinity')
  and t.closed_at>now()-make_interval(days=>p_days)
  and p_days between 1 and 60 and p_funded>0 and p_funded::text not in('NaN','Infinity','-Infinity')
), estimates as (
 select r.*,
  dir*scale*(final_vol*(final_exit-entry)+slice_move)*p_funded/size_usd copy_scaled,
  case when pnl_known then (final_pnl+slice_pnl)*p_funded/size_usd else null end ipfx_scaled
 from raw r where all_priced
)
select jsonb_build_object(
 'funded_size',p_funded,'input_valid',p_days between 1 and 60 and p_funded is not null and p_funded>0 and p_funded::text not in('NaN','Infinity','-Infinity'),
 'trades',(select count(*) from estimates),'incomplete',(select count(*) from raw where not all_priced),
 'ipfx_scaled',(select case when bool_and(ipfx_scaled is not null) then round(sum(ipfx_scaled),2) else null end from estimates),
 'copy_scaled',(select round(sum(copy_scaled),2) from estimates),
 'extra_cost',null,'funded_net',null,'gap',null,'net_verified',false,
 'basis','SCALED_RECORDED_DEMO_GROSS_WITH_SOURCE_CONTRACT_AND_FX_ASSUMPTIONS',
 'net_reason','Minimum-lot demo fills, quote-priced partials and role-average costs cannot verify E8 execution or net.',
 'same_direction_trades',(select count(*) from estimates where model='a'),
 'reverse_trades',(select count(*) from estimates where model='b'),
 'quote_priced_partials',(select coalesce(sum(partials),0) from estimates),
 'max_partial_sampling_wait_seconds',(select max(max_wait_seconds) from estimates),
 'coverage',jsonb_build_object(
  'copied',(select count(*) from public.shadow_orders where event='open' and status in('filled','closed') and created_at>now()-make_interval(days=>p_days)),
  'failed',(select count(*) from public.shadow_orders where event='open' and status in('error','reconciliation_required') and created_at>now()-make_interval(days=>p_days)),
  'partials',(select count(*) from public.shadow_slices where created_at>now()-make_interval(days=>p_days)),
  'traders',(select count(*) from public.shadow_assignments),
  'accounts',(select count(*) from public.ladder_accounts where role='shadow' and execution_enabled)),
 'people',coalesce((select jsonb_agg(x order by x->>'person_id',x->>'model') from (
  select jsonb_build_object('person_id',person_id,'model',model,'trades',count(*),
   'ipfx_scaled',case when bool_and(ipfx_scaled is not null) then round(sum(ipfx_scaled),2) else null end,
   'copy_scaled',round(sum(copy_scaled),2),'funded_net',null,'gap',null,'net_verified',false) x
  from estimates group by person_id,model order by person_id,model limit 20
 ) p),'[]'::jsonb)
);
$function$;
