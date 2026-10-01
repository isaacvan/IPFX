-- cTrader Open API (free, streaming) as a price source: price_feed = 'ctrader'.
alter table public.platform_config drop constraint if exists platform_config_price_feed_check;
alter table public.platform_config add constraint platform_config_price_feed_check check (price_feed in ('fxcm','shadow','tradelocker','ctrader'));
alter table public.price_feed_state add column if not exists ctrader_account_id bigint;
alter table public.price_feed_state add column if not exists ctrader_access_ct text;   -- refreshed tokens, encrypted
alter table public.price_feed_state add column if not exists ctrader_refresh_ct text;
alter table public.price_feed_state add column if not exists ctrader_env_hash text;    -- which secret-set token they derive from
alter table public.price_feed_state add column if not exists ctrader_symbols jsonb;
alter table public.price_feed_state add column if not exists ctrader_symbols_at timestamptz;
