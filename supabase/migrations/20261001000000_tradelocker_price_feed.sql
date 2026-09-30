-- TradeLocker as the price source, with a safe rollout switch.
--   platform_config.price_feed: 'fxcm' (default, current behaviour)
--                               'shadow'      -> fetch TradeLocker alongside FXCM and measure; traders still see FXCM
--                               'tradelocker' -> serve TradeLocker prices (FXCM stays as automatic fallback)
alter table public.platform_config add column if not exists price_feed text not null default 'fxcm';
alter table public.platform_config drop constraint if exists platform_config_price_feed_check;
alter table public.platform_config add constraint platform_config_price_feed_check check (price_feed in ('fxcm','shadow','tradelocker'));
alter table public.platform_config add column if not exists price_feed_connection_id uuid references public.tradelocker_demo_connections(id) on delete set null;

-- Which source wrote each cached quote (fxcm-basic / tradelocker / yahoo-demo).
alter table public.live_quotes add column if not exists source text;

-- Single-row runtime state for the TradeLocker fetcher: one lease holder at a time (so overlapping pump runs never
-- double the request rate), the learned safe request rate, the instrument map and the latest measurements.
create table if not exists public.price_feed_state (
  id boolean primary key default true check (id),
  lease_until timestamptz,
  lease_owner text,
  rate numeric,
  max_rate numeric,
  instruments jsonb,
  instruments_at timestamptz,
  tl_symbols text[],
  last_429_at timestamptz,
  stats jsonb,
  updated_at timestamptz not null default now()
);
insert into public.price_feed_state (id) values (true) on conflict (id) do nothing;
alter table public.price_feed_state enable row level security;
revoke all on public.price_feed_state from anon, authenticated;
grant all on public.price_feed_state to service_role;

-- Which instruments traders are actively watching (written at most every 5s per symbol per server instance),
-- so the fetcher can refresh those first.
create table if not exists public.quote_demand (
  symbol text primary key,
  last_at timestamptz not null
);
alter table public.quote_demand enable row level security;
revoke all on public.quote_demand from anon, authenticated;
grant all on public.quote_demand to service_role;
