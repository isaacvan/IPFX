-- Read-only supplement. Archived prices, trades, net flags and classifier remain unchanged.
create function public.e8_currency_model(p_trade uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $model$
declare p public.e8_sim_positions;spec public.e8_instrument_evidence;entry_q public.e8_reference_quotes;
 exit_q public.e8_reference_quotes;fx public.e8_reference_quotes;e record;fx_symbol text;
 copy_side text;exited numeric:=0;gross numeric:=0;quote_profit numeric;converted numeric;
 first_exit timestamptz;fully_closed boolean:=false;n int:=0;size_ok boolean;events jsonb:='[]';
begin
 select * into p from public.e8_sim_positions where trade_id=p_trade;
 if not found or p.reference_account_id is null or p.opened_at>now() or p.original_lots::text in('NaN','Infinity','-Infinity') then return jsonb_build_object('available',false,'reason','REFERENCE_OR_SOURCE_UNAVAILABLE','net_verified',false);end if;
 select * into spec from public.e8_instrument_evidence where account_id=p.reference_account_id and symbol=p.symbol
  and observed_at<=p.opened_at and observed_at>=p.opened_at-interval '6 hours' order by observed_at desc,id desc limit 1;
 if not found or spec.lot_size is null or spec.lot_size<=0 or spec.lot_size::text in('NaN','Infinity','-Infinity') then return jsonb_build_object('available',false,'reason','ENTRY_CONTRACT_UNAVAILABLE','net_verified',false);end if;
 if spec.quote_currency='USD' then return jsonb_build_object('available',false,'reason','USD_MODEL_ALREADY_AVAILABLE','net_verified',false);end if;
 fx_symbol:=case spec.quote_currency when 'JPY' then 'USDJPY' when 'CAD' then 'USDCAD' when 'CHF' then 'USDCHF' when 'GBP' then 'GBPUSD' when 'EUR' then 'EURUSD' end;
 if fx_symbol is null then return jsonb_build_object('available',false,'reason','FX_PAIR_UNSUPPORTED','net_verified',false);end if;
 size_ok:=case when jsonb_typeof(spec.details->'minLot')='number' and jsonb_typeof(spec.details->'maxLot')='number'
  and jsonb_typeof(spec.details->'lotStep')='number' and (spec.details->>'lotStep')::numeric>0 then
  p.original_lots between (spec.details->>'minLot')::numeric and (spec.details->>'maxLot')::numeric
  and mod(p.original_lots,(spec.details->>'lotStep')::numeric)=0 end;
 if size_ok is distinct from true then return jsonb_build_object('available',false,'reason','BROKER_SIZE_UNCONFIRMED','net_verified',false);end if;
 select * into entry_q from public.e8_reference_quotes where account_id=p.reference_account_id and symbol=p.symbol
  and requested_at>=p.opened_at+make_interval(secs=>p.min_delay_ms/1000.0)
  and received_at<=p.opened_at+make_interval(secs=>(p.min_delay_ms+p.max_wait_ms)/1000.0) and received_at<=now()
  and bid>0 and ask>=bid and bid::text not in('NaN','Infinity','-Infinity') and ask::text not in('NaN','Infinity','-Infinity')
  order by received_at,id limit 1;
 if not found then return jsonb_build_object('available',false,'reason','ENTRY_REFERENCE_MISSING','net_verified',false);end if;
 select min(event_at) into first_exit from public.e8_sim_events where trade_id=p_trade and kind in('partial','close');
 if first_exit is null or entry_q.received_at>=first_exit then return jsonb_build_object('available',false,'reason','ENTRY_REFERENCE_TOO_LATE_OR_NO_EXIT','net_verified',false);end if;
 copy_side:=case when p.selected_book='a' then p.trader_side when p.trader_side='buy' then 'sell' else 'buy' end;
 for e in select * from public.e8_sim_events where trade_id=p_trade and kind in('partial','close') order by event_at,id loop
  n:=n+1;if n>50 or e.event_at>now() or e.lots<=0 or e.lots::text in('NaN','Infinity','-Infinity') then return jsonb_build_object('available',false,'reason','EXIT_SEQUENCE_INVALID','net_verified',false);end if;
  if e.lots<(spec.details->>'minLot')::numeric or mod(e.lots,(spec.details->>'lotStep')::numeric)<>0 then return jsonb_build_object('available',false,'reason','EXIT_LOT_LIMIT_UNVERIFIED','net_verified',false);end if;
  exited:=exited+e.lots;fully_closed:=fully_closed or e.kind='close';
  if exited>p.original_lots+0.000000001 then return jsonb_build_object('available',false,'reason','EXIT_QUANTITY_MISMATCH','net_verified',false);end if;
  select * into exit_q from public.e8_reference_quotes where account_id=p.reference_account_id and symbol=p.symbol
   and requested_at>=e.event_at+make_interval(secs=>p.min_delay_ms/1000.0)
   and received_at<=e.event_at+make_interval(secs=>(p.min_delay_ms+p.max_wait_ms)/1000.0) and received_at<=now()
   and bid>0 and ask>=bid and bid::text not in('NaN','Infinity','-Infinity') and ask::text not in('NaN','Infinity','-Infinity')
   order by received_at,id limit 1;
  if not found then return jsonb_build_object('available',false,'reason','EXIT_REFERENCE_MISSING','net_verified',false);end if;
  select * into fx from public.e8_reference_quotes where account_id=p.reference_account_id and symbol=fx_symbol
   and received_at<=exit_q.received_at and received_at>=exit_q.received_at-interval '15 seconds'
   and requested_at<=received_at and bid>0 and ask>=bid
   and bid::text not in('NaN','Infinity','-Infinity') and ask::text not in('NaN','Infinity','-Infinity') order by received_at desc,id desc limit 1;
  if not found then return jsonb_build_object('available',false,'reason','FRESH_ASOF_FX_MISSING','net_verified',false);end if;
  quote_profit:=e.lots*spec.lot_size*case when copy_side='buy' then exit_q.bid-entry_q.ask else entry_q.bid-exit_q.ask end;
  converted:=case when spec.quote_currency in('JPY','CAD','CHF') then quote_profit/(case when quote_profit>=0 then fx.ask else fx.bid end)
   else quote_profit*(case when quote_profit>=0 then fx.bid else fx.ask end) end;
  gross:=gross+converted;
  events:=events||jsonb_build_array(jsonb_build_object('event_id',e.id,'lots',e.lots,'event_at',e.event_at,'quote_at',exit_q.received_at,
   'quote_profit',quote_profit,'fx_symbol',fx_symbol,'fx_bid',fx.bid,'fx_ask',fx.ask,'fx_at',fx.received_at,'gross_usd',converted,
   'sampling_wait_ms',extract(epoch from exit_q.received_at-e.event_at)*1000));
 end loop;
 if fully_closed and abs(exited-p.original_lots)>0.000000001 then return jsonb_build_object('available',false,'reason','CLOSE_QUANTITY_INCOMPLETE','net_verified',false);end if;
 return jsonb_build_object('available',true,'basis','RECONSTRUCTED_OBSERVED_FX_MARK_ESTIMATE','currency_assumption','USD_ACCOUNT_MODEL',
  'gross_usd',gross,'quote_currency',spec.quote_currency,'contract_size',spec.lot_size,'entry_quote_at',entry_q.received_at,
  'entry_sampling_wait_ms',extract(epoch from entry_q.received_at-p.opened_at)*1000,'exited_lots',exited,'fully_closed',fully_closed,
  'events',events,'net_verified',false,'unverified',jsonb_build_array('Actual broker FX conversion','Account-specific costs','Execution slippage'));
end $model$;
revoke all on function public.e8_currency_model(uuid) from public,anon,authenticated;
grant execute on function public.e8_currency_model(uuid) to service_role;
-- LIVE_ACCURACY_WRAPPER_FOLLOWS
do $fence$ begin if md5(pg_get_functiondef('public.e8_sim_accuracy(uuid)'::regprocedure))<>'5efd45209f20893d00eed2295667750d' then raise exception 'CURRENCY_ACCURACY_SOURCE_DRIFT';end if;end $fence$;
CREATE OR REPLACE FUNCTION public.e8_sim_accuracy(p_trade uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; d record; spec record; model record; factor numeric; adjusted numeric;
 commission_rate numeric; commission_cost numeric; ipfx_commission numeric; tick numeric;
 spec_basis text:='E8_SPEC_UNAVAILABLE'; size_ok boolean; quote_age numeric; events jsonb; timing_ok boolean; currency_model jsonb;
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
 if adjusted is null and spec.quote_currency is not null and spec.quote_currency<>'USD' then
  currency_model:=public.e8_currency_model(p_trade);
  if currency_model->>'available'='true' then adjusted:=(currency_model->>'gross_usd')::numeric;spec_basis:='OBSERVED_FX_MARK_ESTIMATE';size_ok:=true;end if;
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
 return jsonb_build_object('currency_model',currency_model,'e8_gross_usd',adjusted,'original_gross_usd',r.selected_gross_usd,
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
  'e8_entry_wait_ms',case when currency_model->>'available'='true' then (currency_model->>'entry_sampling_wait_ms')::numeric else r.entry_wait_ms end,
  'e8_exit_wait_ms',case when currency_model->>'available'='true' then (select max((x->>'sampling_wait_ms')::numeric) from jsonb_array_elements(currency_model->'events') x) else r.max_exit_wait_ms end,
  'ipfx_quote_max_age_ms',quote_age,'decision_timing_valid',timing_ok,'net_usd',null,'net_verified',false,
  'unverified',jsonb_build_array('E8 commission schedule','E8 swaps and rollover','Actual execution slippage'),
  'events',events);
end;$function$
;
