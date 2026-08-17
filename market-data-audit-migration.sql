-- ============================================================
-- IPFX Markets — Market Data & Execution Audit Layer
-- Idempotent. Adds tables the checklist calls for on top of the
-- existing trading_accounts / trades / equity_snapshots / payouts /
-- admins schema. RLS: admins see everything, users see only their own.
-- ============================================================

-- ---------- 1. market_data_sources: registry of every feed we use ----------
--    tier='testing' = free/demo feed, not launch-grade. tier='production'
--    = paid single-source provider once wired up. is_official=true marks
--    the ONE provider execution prices are taken from (never a mix).
create table if not exists public.market_data_sources (
  id           text primary key,              -- e.g. 'yahoo-demo', 'oanda-prod'
  display_name text not null,
  tier         text not null check (tier in ('testing','production')),
  is_official  boolean not null default false, -- the single execution source
  enabled      boolean not null default true,
  notes        text,
  created_at   timestamptz not null default now()
);

insert into public.market_data_sources (id, display_name, tier, is_official, enabled, notes)
values ('yahoo-demo', 'Yahoo Finance (unofficial, delayed)', 'testing', true, true,
        'TESTING ONLY. Free/unofficial endpoint, ~1min granularity, no real bid/ask (synthetic spread). Replace before accepting real payouts.')
on conflict (id) do nothing;

-- ---------- 2. symbol_specs: per-instrument trading rules ----------
create table if not exists public.symbol_specs (
  symbol             text primary key,          -- e.g. 'EURUSD'
  display_name       text not null,
  asset_class        text not null check (asset_class in ('forex','metal','index')),
  digits             int  not null,
  contract_size      numeric(14,2) not null,     -- units per 1.00 lot
  quote_currency     text not null default 'USD',
  min_volume         numeric(10,2) not null default 0.01,
  max_volume         numeric(10,2) not null default 100,
  volume_step        numeric(10,2) not null default 0.01,
  base_spread        numeric(18,6) not null,      -- typical/floor spread
  max_spread         numeric(18,6) not null,      -- reject fills above this
  slippage_bps       numeric(8,2)  not null default 0, -- configurable slippage model, in basis points of price
  session_hours      text not null default '24/5', -- '24/5' | '24/7' | custom description
  enabled            boolean not null default true,
  disabled_reason    text,
  updated_at         timestamptz not null default now()
);

-- seed from the engine's current instrument table (forex + metals + indices, NO crypto)
insert into public.symbol_specs (symbol, display_name, asset_class, digits, contract_size, quote_currency, base_spread, max_spread, session_hours) values
  ('EURUSD','EUR/USD','forex',5,100000,'USD',0.0002,0.0010,'24/5'),
  ('GBPUSD','GBP/USD','forex',5,100000,'USD',0.0003,0.0012,'24/5'),
  ('USDJPY','USD/JPY','forex',3,100000,'JPY',0.03,0.12,'24/5'),
  ('AUDUSD','AUD/USD','forex',5,100000,'USD',0.0003,0.0012,'24/5'),
  ('USDCAD','USD/CAD','forex',5,100000,'CAD',0.0003,0.0012,'24/5'),
  ('USDCHF','USD/CHF','forex',5,100000,'CHF',0.0004,0.0016,'24/5'),
  ('NZDUSD','NZD/USD','forex',5,100000,'USD',0.0004,0.0016,'24/5'),
  ('GBPJPY','GBP/JPY','forex',3,100000,'JPY',0.05,0.20,'24/5'),
  ('EURJPY','EUR/JPY','forex',3,100000,'JPY',0.04,0.16,'24/5'),
  ('EURGBP','EUR/GBP','forex',5,100000,'GBP',0.0003,0.0012,'24/5'),
  ('EURCAD','EUR/CAD','forex',5,100000,'CAD',0.0005,0.0020,'24/5'),
  ('AUDCAD','AUD/CAD','forex',5,100000,'CAD',0.0006,0.0024,'24/5'),
  ('XAUUSD','Gold','metal',2,100,'USD',0.30,1.20,'23/5'),
  ('XAGUSD','Silver','metal',3,5000,'USD',0.05,0.20,'23/5'),
  ('XPTUSD','Platinum','metal',2,100,'USD',0.80,3.20,'23/5'),
  ('XPDUSD','Palladium','metal',2,100,'USD',1.20,4.80,'23/5'),
  ('SPXUSD','S&P 500','index',1,10,'USD',0.5,2.0,'23/5'),
  ('NSXUSD','NASDAQ 100','index',1,10,'USD',1.5,6.0,'23/5'),
  ('DJI','Dow Jones','index',0,10,'USD',2.0,8.0,'23/5'),
  ('UK100','FTSE 100','index',1,10,'GBP',1.0,4.0,'23/5'),
  ('GER40','DAX 40','index',1,10,'EUR',1.5,6.0,'23/5'),
  ('FRA40','CAC 40','index',1,10,'EUR',1.5,6.0,'23/5'),
  ('JPN225','Nikkei 225','index',0,10,'JPY',8.0,32.0,'23/5'),
  ('US2000','Russell 2000','index',1,10,'USD',0.8,3.2,'23/5')
on conflict (symbol) do nothing;

-- ---------- 3. market_data_ticks: raw quote log (sampled, not every poll) ----------
create table if not exists public.market_data_ticks (
  id             bigint generated always as identity primary key,
  symbol         text not null,
  source_id      text not null references public.market_data_sources(id),
  bid            numeric(18,6) not null,
  ask            numeric(18,6) not null,
  spread         numeric(18,6) not null,
  provider_ts    timestamptz,              -- timestamp the provider reports (if any)
  received_ts    timestamptz not null default now(), -- when our server received it
  latency_ms     integer,                  -- received_ts - provider_ts, if known
  created_at     timestamptz not null default now()
);
create index if not exists idx_ticks_symbol_time on public.market_data_ticks(symbol, received_ts desc);

-- ---------- 4. market_data_candles: resampled OHLC per symbol/timeframe ----------
create table if not exists public.market_data_candles (
  symbol      text not null,
  timeframe   text not null check (timeframe in ('1m','3m','5m','15m','30m','1h','4h','1d')),
  bucket_ts   timestamptz not null,   -- candle open time
  open        numeric(18,6) not null,
  high        numeric(18,6) not null,
  low         numeric(18,6) not null,
  close       numeric(18,6) not null,
  tick_count  integer not null default 0,
  source_id   text not null references public.market_data_sources(id),
  primary key (symbol, timeframe, bucket_ts)
);
create index if not exists idx_candles_symbol_tf on public.market_data_candles(symbol, timeframe, bucket_ts desc);

-- ---------- 5. order_audit_events: full fill audit trail ----------
create table if not exists public.order_audit_events (
  id               bigint generated always as identity primary key,
  trade_id         uuid,                    -- public.trades.id (open or close event)
  user_id          uuid not null,
  account_id       uuid not null,
  event            text not null check (event in ('open','close','reject')),
  reject_reason    text,
  symbol           text not null,
  side             text,
  requested_volume numeric(10,2),
  requested_price  numeric(18,6),           -- price the client/engine intended
  fill_price       numeric(18,6),
  bid              numeric(18,6),
  ask              numeric(18,6),
  spread           numeric(18,6),
  quote_ts         timestamptz,             -- timestamp of the quote used
  server_ts        timestamptz not null default now(),
  latency_ms       integer,
  source_id        text references public.market_data_sources(id),
  created_at       timestamptz not null default now()
);
create index if not exists idx_audit_user on public.order_audit_events(user_id, created_at desc);
create index if not exists idx_audit_account on public.order_audit_events(account_id, created_at desc);
create index if not exists idx_audit_trade on public.order_audit_events(trade_id);

-- ---------- 6. feed_health_events: outages, staleness, reconnects ----------
create table if not exists public.feed_health_events (
  id         bigint generated always as identity primary key,
  source_id  text references public.market_data_sources(id),
  event      text not null check (event in ('stale','outage','reconnect','spike','bad_quote')),
  symbol     text,
  detail     text,
  created_at timestamptz not null default now()
);
create index if not exists idx_feed_health_time on public.feed_health_events(created_at desc);

-- ---------- 7. user_chart_layouts: per-account indicator/layout persistence ----------
create table if not exists public.user_chart_layouts (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  studies     jsonb not null default '[]'::jsonb,
  timeframe   text not null default '60',
  chart_style int  not null default 1,
  updated_at  timestamptz not null default now()
);

-- ---------- RLS ----------
alter table public.market_data_sources  enable row level security;
alter table public.symbol_specs         enable row level security;
alter table public.market_data_ticks    enable row level security;
alter table public.market_data_candles  enable row level security;
alter table public.order_audit_events   enable row level security;
alter table public.feed_health_events   enable row level security;
alter table public.user_chart_layouts   enable row level security;

-- public read-only reference data (safe to expose: no PII)
drop policy if exists "sources public read" on public.market_data_sources;
create policy "sources public read" on public.market_data_sources for select using (true);
drop policy if exists "specs public read" on public.symbol_specs;
create policy "specs public read" on public.symbol_specs for select using (true);
drop policy if exists "candles public read" on public.market_data_candles;
create policy "candles public read" on public.market_data_candles for select using (true);
drop policy if exists "ticks public read" on public.market_data_ticks;
create policy "ticks public read" on public.market_data_ticks for select using (true);

-- audit/health/layouts: own rows only (server/service-role writes everything)
drop policy if exists "own audit read" on public.order_audit_events;
create policy "own audit read" on public.order_audit_events for select using (user_id = auth.uid());
drop policy if exists "own layout read" on public.user_chart_layouts;
create policy "own layout read" on public.user_chart_layouts for select using (user_id = auth.uid());

-- admins bypass via admin-console (service role) — no separate policy needed;
-- the function already authenticates against public.admins before reading.
