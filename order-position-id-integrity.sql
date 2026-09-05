-- ============================================================
-- IPFX Capital — order/position audit integrity fix
--
-- THE BUG THIS FIXES
-- order_audit_events.event had a check constraint of
-- ('open','close','reject') only. trading-engine's logAudit() has been
-- calling it with event:'modify' since the modify (SL/TP change) action
-- was added — every one of those inserts has been silently REJECTED by
-- the check constraint and swallowed by logAudit's own try/catch
-- ("audit logging must never block trading"), so every SL/TP modify on
-- a live position has left zero audit trail. Same gap for the two
-- pending-order actions (place_pending/cancel_pending), which never
-- called logAudit at all.
--
-- order_audit_events.id (a stable, auto-incrementing identity, one row
-- per order-type action against the engine) is the natural Order ID for
-- this platform's architecture: every order-type action (open, modify,
-- partial_close, close, reject, place_pending, cancel_pending) is a
-- single synchronous request with no separate broker ack/fill lifecycle
-- to track, so a parallel "orders" ledger duplicating trades/
-- pending_orders would just be two sources of truth. trades.id remains
-- the Position ID (one row per position, per the table's own comment);
-- order_audit_events.id is the Order ID for the action that touched it.
--
-- Safe to run repeatedly (idempotent DDL).
-- ============================================================

alter table public.order_audit_events drop constraint if exists order_audit_events_event_check;
alter table public.order_audit_events add constraint order_audit_events_event_check
  check (event in ('open','close','reject','modify','partial_close','place_pending','cancel_pending'));

-- order_id: the pending order this event resolved, when applicable
-- (place_pending / cancel_pending events, and a fill event carried
-- through from a triggered pending order) — distinct from trade_id,
-- which is the resulting Position.
alter table public.order_audit_events
  add column if not exists pending_order_id uuid references public.pending_orders(id);
create index if not exists idx_audit_pending_order on public.order_audit_events(pending_order_id);

comment on column public.order_audit_events.id is
  'The Order ID for this platform: one row per order-type action (open/modify/partial_close/close/reject/place_pending/cancel_pending). Distinct from trade_id, which is the Position ID.';
comment on column public.order_audit_events.trade_id is
  'Position ID (public.trades.id) this order action opened, modified, or closed. Null for reject / place_pending / cancel_pending events with no resulting position.';

-- Verify:
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'order_audit_events_event_check';
--   select event, count(*) from public.order_audit_events group by event order by 2 desc;
