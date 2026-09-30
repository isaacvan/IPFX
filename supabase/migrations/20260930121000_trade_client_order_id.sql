-- Idempotent order placement: the platform sends a random client_order_id with every new order.
-- A retried or double-submitted request with the same id cannot create a second position.
alter table public.trades add column if not exists client_order_id text;
create unique index if not exists trades_account_client_order_uidx
  on public.trades (account_id, client_order_id) where client_order_id is not null;
