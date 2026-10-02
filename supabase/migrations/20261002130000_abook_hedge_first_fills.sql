-- Hedge-first (STP) execution for copied trades: keep the broker's exact executed price for every
-- hedge event, and a per-trade ledger proving the hedge captured every tick the trader made.
alter table public.mirror_orders add column if not exists fill_price numeric;
alter table public.mirror_orders add column if not exists fill_latency_ms integer;

-- capture_per_unit = hedge per-unit P&L minus trader per-unit P&L (price units, >= 0 when fully captured).
-- capture_usd_est scales by the hedge volume and the instrument contract size via the trader's own P&L.
create or replace view public.abook_execution_capture
with (security_invoker = true) as
select
  t.id as trade_id, t.account_id, t.symbol, t.side, t.volume as trader_volume,
  o.volume as hedge_volume,
  t.open_price as trader_open, o.fill_price as hedge_open,
  t.close_price as trader_close, c.fill_price as hedge_close,
  t.opened_at, t.closed_at, t.close_reason,
  case when o.fill_price is null then 'open_unpriced'
       when t.status = 'open' then 'open'
       when c.fill_price is null then 'close_unpriced'
       else 'matched' end as state,
  case when t.side = 'buy' then 1 else -1 end * (t.open_price - o.fill_price) as open_capture,
  case when c.fill_price is null or t.close_price is null then null
       else case when t.side = 'buy' then 1 else -1 end * (c.fill_price - t.close_price) end as close_capture,
  case when c.fill_price is null or t.close_price is null or o.fill_price is null then null
       else case when t.side = 'buy' then 1 else -1 end * ((c.fill_price - o.fill_price) - (t.close_price - t.open_price)) end as capture_per_unit
from public.trades t
join lateral (
  select m.volume, m.fill_price from public.mirror_orders m
  where m.source_trade_id = t.id and m.event = 'open' and m.idempotency_key is not null
  order by m.created_at desc limit 1
) o on true
left join lateral (
  select m.fill_price from public.mirror_orders m
  where m.source_trade_id = t.id and m.event = 'close' and m.idempotency_key is not null
  order by m.created_at desc limit 1
) c on true;

revoke all on public.abook_execution_capture from anon, authenticated;
grant select on public.abook_execution_capture to service_role;
