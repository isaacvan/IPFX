-- Read-only accuracy/cost breakdown. Never changes a fill, balance or classifier.
begin;
-- Correct older placeholders: unknown metal/index/crypto commission was stored
-- as zero. Keep explicitly configured rates; unknown all-in totals remain null.
alter table public.cost_symbol_model alter column e8_commission_per_lot drop not null;
update public.cost_symbol_model set e8_commission_per_lot=null
 where e8_commission_per_lot=0 and note ilike '%unknown%';
create table public.e8_public_fee_estimates (
 symbol text primary key, round_turn_usd_per_lot numeric not null check(round_turn_usd_per_lot>=0),
 source_url text not null, pricing_mode text not null default 'PUBLIC_RAW_SPREAD_SCHEDULE_NOT_ACCOUNT_CONFIRMED',
 charge_timing text not null default 'ONE_TIME_ON_OPEN',observed_at timestamptz not null default clock_timestamp()
);
alter table public.e8_public_fee_estimates enable row level security;
revoke all on public.e8_public_fee_estimates from public,anon,authenticated;
grant select on public.e8_public_fee_estimates to service_role;
create trigger e8_fee_estimates_frozen before update or delete on public.e8_public_fee_estimates
 for each row execute function public.e8_sim_append_only();
insert into public.e8_public_fee_estimates(symbol,round_turn_usd_per_lot,source_url)
 select symbol,rate,'https://e8x.e8markets.com/trading-symbols' from(values
 ('EURUSD',5),('GBPUSD',5),('USDJPY',5),('AUDUSD',5),('USDCAD',5),('USDCHF',5),('NZDUSD',5),
 ('GBPJPY',5),('EURJPY',5),('EURGBP',5),('EURCAD',5),('AUDCAD',5),('XAUUSD',6),('XAGUSD',6),
 ('SPXUSD',6),('NSXUSD',6),('DJI',12),('GER40',6),('JPN225',6),
 ('BTCUSD',30),('ETHUSD',30),('LTCUSD',30),('ADAUSD',30),('SOLUSD',30))p(symbol,rate);
-- Replace only the original undocumented defaults, never a custom owner rate.
update public.cost_symbol_model m set e8_commission_per_lot=p.round_turn_usd_per_lot,
 note='E8 public raw-spread schedule 2026-10-08; account applicability unconfirmed; '||p.source_url
 from public.e8_public_fee_estimates p where p.symbol=m.symbol
 and ((m.note='forex' and m.e8_commission_per_lot=5.5) or (m.note ilike '%unknown%' and m.e8_commission_per_lot is null));
-- The two venues need their OWN lot sizes. Do not multiply both spreads by the
-- old IPFX contract assumption, or merge several reference accounts silently.
create or replace function public.cost_allin(p_hours int default 24)
returns table(symbol text,e8_spread numeric,ipfx_spread numeric,e8_usd numeric,ipfx_usd numeric,
 e8_commission numeric,ipfx_commission numeric,ratio numeric,samples bigint)
language sql stable security definer set search_path='' as $$
 with s as(select c.symbol,(percentile_cont(.5)within group(order by spread))::numeric e8,
 (percentile_cont(.5)within group(order by ipfx_spread))::numeric ip,count(*) n,
 case when count(distinct account_id)=1 then min(account_id) end account_id
 from public.cost_samples c where role='monitor' and ipfx_spread is not null and spread>0
 and sampled_at>now()-make_interval(hours=>p_hours) group by c.symbol),
 px as(select symbol,(bid+ask)/2 mid from public.live_quotes where received_at>now()-interval '15 seconds' and bid>0 and ask>=bid),
 inputs as(select s.*,m.e8_commission_per_lot e8c,coalesce(sp.commission_per_lot_usd,m.ipfx_commission_per_lot) ipc,
 ev.lot_size e8_contract,ev.quote_currency e8_ccy,coalesce(sp.contract_size,m.contract) ip_contract,
 coalesce(sp.quote_currency,m.quote_ccy) ip_ccy
 from s join public.cost_symbol_model m on m.symbol=s.symbol left join public.symbol_specs sp on sp.symbol=s.symbol
 left join lateral(select lot_size,quote_currency from public.e8_instrument_evidence ev where ev.symbol=s.symbol
 and ev.account_id=s.account_id and observed_at<=now() and observed_at>now()-interval '6 hours' order by observed_at desc limit 1)ev on true),
 usd as(select i.*,
 e8*e8_contract*case e8_ccy when 'USD' then 1::numeric when 'JPY' then 1/nullif((select mid from px where symbol='USDJPY'),0)
 when 'CAD' then 1/nullif((select mid from px where symbol='USDCAD'),0) when 'CHF' then 1/nullif((select mid from px where symbol='USDCHF'),0)
 when 'GBP' then(select mid from px where symbol='GBPUSD') when 'EUR' then(select mid from px where symbol='EURUSD')end e8_spread_usd,
 ip*ip_contract*case ip_ccy when 'USD' then 1::numeric when 'JPY' then 1/nullif((select mid from px where symbol='USDJPY'),0)
 when 'CAD' then 1/nullif((select mid from px where symbol='USDCAD'),0) when 'CHF' then 1/nullif((select mid from px where symbol='USDCHF'),0)
 when 'GBP' then(select mid from px where symbol='GBPUSD') when 'EUR' then(select mid from px where symbol='EURUSD')end ip_spread_usd from inputs i)
 select symbol,round(e8,8),round(ip,8),round(e8_spread_usd+e8c,2),round(ip_spread_usd+ipc,2),e8c,ipc,
 round((ip_spread_usd+ipc)/nullif(e8_spread_usd+e8c,0),3),n from usd;
$$;
create function public.e8_sim_accuracy(p_trade uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r record; d record; spec record; model record; factor numeric; adjusted numeric;
 commission_rate numeric; commission_cost numeric; ipfx_commission numeric; tick numeric;
 spec_basis text:='E8_SPEC_UNAVAILABLE'; size_ok boolean; quote_age numeric; events jsonb; timing_ok boolean;
begin
 select * into r from public.e8_sim_trade_results where trade_id=p_trade;
 if not found then return null;end if;
 select * into d from public.ipfx_sim_decision_results where trade_id=p_trade;
 -- Prefer the specification observed at entry. Older trades may only have later
 -- observations: expose that backcast instead of fabricating historical proof.
 select * into spec from public.e8_instrument_evidence
 where account_id=r.reference_account_id and symbol=r.symbol
 order by (observed_at<=r.opened_at) desc,
  case when observed_at<=r.opened_at then observed_at end desc,
  case when observed_at>r.opened_at then observed_at end asc limit 1;
 if spec.id is not null and spec.lot_size>0 and spec.quote_currency='USD' and r.scale_usd>0 then
  factor:=spec.lot_size/r.scale_usd;
  spec_basis:=case when spec.observed_at>r.opened_at then 'LATER_SPEC_BACKCAST_ESTIMATE'
   when spec.observed_at<r.opened_at-interval '6 hours' then 'STALE_ENTRY_SPEC_ESTIMATE' else 'BROKER_SPEC_OBSERVED_AT_ENTRY' end;
  size_ok:=case when jsonb_typeof(spec.details->'minLot')='number' and jsonb_typeof(spec.details->'maxLot')='number'
   and jsonb_typeof(spec.details->'lotStep')='number' and (spec.details->>'lotStep')::numeric>0 then
   r.original_lots between (spec.details->>'minLot')::numeric and (spec.details->>'maxLot')::numeric
   and mod(r.original_lots,(spec.details->>'lotStep')::numeric)=0 end;
  if size_ok is distinct from false then adjusted:=r.selected_gross_usd*factor;end if;
  if jsonb_typeof(spec.details->'tickSize')='array' and jsonb_array_length(spec.details->'tickSize')=1
   and jsonb_typeof(spec.details->'tickSize'->0->'tickSize')='number' then
   tick:=(spec.details->'tickSize'->0->>'tickSize')::numeric;
   if tick<=0 then tick:=null;end if;
  end if;
 end if;
 select * into model from public.cost_symbol_model where symbol=r.symbol;
 -- Existing forex assumption is retained as an ESTIMATE. An unknown zero from
 -- the older cost table must not become evidence of commission-free trading.
 if model.e8_commission_per_lot>0 and coalesce(model.note,'') not ilike '%unknown%' then
  commission_rate:=model.e8_commission_per_lot;
  commission_cost:=commission_rate*r.exited_lots;
 end if;
 select case when count(*)>0 and bool_and(source_snapshot->>'commission' is not null)
  then sum(abs((source_snapshot->>'commission')::numeric)) end into ipfx_commission
 from public.e8_sim_events where trade_id=p_trade and kind in('partial','close');
 select max(extract(epoch from(server_ts-quote_ts))*1000),
  count(*)>0 and bool_and(quote_ts is not null and server_ts is not null and quote_ts<=server_ts
   and extract(epoch from(server_ts-quote_ts))*1000<=coalesce((select max_quote_age_ms from public.e8_monitor_profiles where account_id=r.reference_account_id),15000)) into quote_age,timing_ok
 from public.ipfx_sim_decision_quotes where trade_id=p_trade;
 select coalesce(jsonb_agg(jsonb_build_object('kind',e.kind,'lots',e.lots,'event_at',e.event_at,
  'bid',x.bid,'ask',x.ask,'quote_at',x.received_at,'sampling_wait_ms',x.sampling_wait_ms,
  'decision_bid',q.bid,'decision_ask',q.ask,'decision_quote_at',q.quote_ts,'decision_at',q.server_ts)
  order by e.id),'[]') into events
 from public.e8_sim_events e left join public.e8_sim_prices x on x.event_id=e.id
 left join lateral(select * from public.ipfx_sim_decision_quotes q where q.trade_id=e.trade_id
  and q.source_row_id=e.source_row_id and q.kind=e.kind order by audit_id limit 1)q on true
 where e.trade_id=p_trade and e.kind in('open','partial','close');
 return jsonb_build_object('e8_gross_usd',adjusted,'original_gross_usd',r.selected_gross_usd,
  'scale_basis',spec_basis,'broker_lot_size',spec.lot_size,'broker_quote_currency',spec.quote_currency,
  'spec_observed_at',spec.observed_at,'broker_size_valid',size_ok,'original_lots',r.original_lots,'exited_lots',r.exited_lots,
  'e8_commission_rate',commission_rate,'e8_commission_usd',commission_cost,
  'commission_basis',case when commission_rate is null then 'UNKNOWN_NOT_ZERO'
   when model.note like 'E8 public raw-spread schedule%' then 'PUBLIC_RAW_SCHEDULE_ESTIMATE_NOT_ACCOUNT_CONFIRMED'
   else 'CONFIGURED_UNCONFIRMED_ROUND_TURN_ESTIMATE' end,
  'commission_source_url',case when model.note like 'E8 public raw-spread schedule%' then 'https://e8x.e8markets.com/trading-symbols' end,
  'e8_after_commission_usd',adjusted-commission_cost,
  'ipfx_commission_usd',ipfx_commission,'ipfx_after_commission_usd',case when timing_ok then d.selected_gross_usd-ipfx_commission end,
  'one_tick_slippage_usd',case when adjusted is not null then 2*tick*spec.lot_size*r.exited_lots end,
  'one_tick_after_commission_usd',adjusted-commission_cost-2*tick*spec.lot_size*r.exited_lots,
  'five_tick_after_commission_usd',adjusted-commission_cost-10*tick*spec.lot_size*r.exited_lots,
  'remaining_cost_budget_usd',coalesce(adjusted,r.selected_gross_usd)-coalesce(commission_cost,0),
  'e8_entry_wait_ms',r.entry_wait_ms,'e8_exit_wait_ms',r.max_exit_wait_ms,
  'ipfx_quote_max_age_ms',quote_age,'decision_timing_valid',timing_ok,'net_usd',null,'net_verified',false,
  'unverified',jsonb_build_array('E8 commission schedule','E8 swaps and rollover','Actual execution slippage'),
  'events',events);
end;$$;
revoke all on function public.e8_sim_accuracy(uuid) from public,anon,authenticated;
grant execute on function public.e8_sim_accuracy(uuid) to service_role;
-- Extend only the installed read-only activity select; preserve account scope,
-- low-P&L processing and other agents' changes. Abort if the anchor has drifted.
do $patch$
declare definition text;anchor text:='d.status decision_status,d.selected_gross_usd decision_gross_usd';
begin
 definition:=pg_get_functiondef('public.ab_brain_live_activity(uuid)'::regprocedure);
 if strpos(definition,anchor)=0 then raise exception 'SIM_ACCURACY_ACTIVITY_SOURCE_DRIFT';end if;
 execute replace(definition,anchor,anchor||',public.e8_sim_accuracy(r.trade_id) accuracy');
end;$patch$;
commit;
