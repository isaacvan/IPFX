begin;
-- Excess partial quantity is an integrity error, not a missing price.
create or replace view public.e8_sim_trade_results with(security_invoker=true) as
with entry as (
 select p.*,v.id entry_event_id,x.status entry_status,x.bid entry_bid,x.ask entry_ask,x.received_at entry_quote_at,
  x.reason entry_error,x.sampling_wait_ms entry_wait_ms
 from public.e8_sim_positions p join public.e8_sim_events v on v.trade_id=p.trade_id and v.kind='open'
 left join public.e8_sim_prices x on x.event_id=v.id
), exits as (
 select e.trade_id,count(*) exits,count(*)filter(where x.status='PRICED') priced_exits,
  bool_or(e.kind='close') fully_closed,sum(e.lots) exited_lots,
  min(e.event_at) first_exit_at,max(e.event_at) last_exit_at,
  sum(e.lots*x.bid) bid_lot_sum,sum(e.lots*x.ask) ask_lot_sum,
  sum((e.source_snapshot->>'pnl')::numeric) source_pnl_usd,
  max(x.sampling_wait_ms) max_exit_wait_ms,
  jsonb_agg(jsonb_build_object('event_id',e.id,'kind',e.kind,'lots',e.lots,'event_at',e.event_at,
   'quote_at',x.received_at,'bid',x.bid,'ask',x.ask,'status',x.status,'reason',x.reason) order by e.id) exit_detail
 from public.e8_sim_events e left join public.e8_sim_prices x on x.event_id=e.id
 where e.kind in('partial','close') group by e.trade_id
), valid as (
 select p.*,coalesce(e.fully_closed,false) fully_closed,e.exited_lots,e.source_pnl_usd,e.last_exit_at,e.max_exit_wait_ms,e.exit_detail,
  p.entry_status='PRICED' and e.exits=e.priced_exits and p.entry_quote_at<e.first_exit_at and
   e.exited_lots<=p.original_lots+0.000000001 and (not e.fully_closed or abs(e.exited_lots-p.original_lots)<=0.000000001) as valid_priced,
  abs(e.exited_lots-p.original_lots)<=0.000000001 as quantity_complete,
  e.first_exit_at,e.exits,e.priced_exits,e.bid_lot_sum,e.ask_lot_sum
 from entry p left join exits e on e.trade_id=p.trade_id
), totals as (
 select v.*,
 case when valid_priced then scale_usd*case when trader_side='buy' then bid_lot_sum-entry_ask*exited_lots
  else entry_bid*exited_lots-ask_lot_sum end end same_gross_usd,
 case when valid_priced then scale_usd*case when trader_side='buy' then entry_bid*exited_lots-ask_lot_sum
  else bid_lot_sum-entry_ask*exited_lots end end reverse_gross_usd
 from valid v
)
select trade_id,source_account_id,person_id,reference_account_id,symbol,trader_side,selected_book,book_state,is_practice,
 original_lots,exited_lots,opened_at,last_exit_at,entry_bid,entry_ask,entry_quote_at,entry_wait_ms,max_exit_wait_ms,
 source_pnl_usd,scale_usd,scale_basis,same_gross_usd,reverse_gross_usd,
 case when selected_book='b' then reverse_gross_usd else same_gross_usd end selected_gross_usd,
 case when source_size_usd>0 then (case when selected_book='b' then reverse_gross_usd else same_gross_usd end)*50000/source_size_usd end selected_gross_50k_usd,
 null::numeric net_usd,'UNVERIFIED_FEES_SWAP_AND_SLIPPAGE'::text net_status,
 'E8_OBSERVED_QUOTE_ESTIMATE_NOT_BROKER_EXECUTION'::text basis,
 case when entry_status='UNAVAILABLE' then entry_error when exited_lots>original_lots+0.000000001 or (fully_closed and not quantity_complete) then 'QUANTITY_MISMATCH'
  when entry_quote_at>=first_exit_at then 'ENTRY_OBSERVATION_AFTER_EXIT'
  when priced_exits<exits and exists(select 1 from public.e8_sim_prices p join public.e8_sim_events e on e.id=p.event_id where e.trade_id=totals.trade_id and p.status='UNAVAILABLE') then 'EXIT_REFERENCE_UNAVAILABLE'
  when fully_closed and valid_priced and quantity_complete then 'CLOSED_GROSS_ESTIMATE'
  when valid_priced then 'PARTIALLY_CLOSED_GROSS_ESTIMATE' when entry_status='PRICED' and exits is null then 'OPEN_REFERENCE_ESTIMATE'
  else 'AWAITING_REFERENCE' end status,
 exit_detail
from totals;


commit;
