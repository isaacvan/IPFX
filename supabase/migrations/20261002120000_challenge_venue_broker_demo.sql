-- Option 3: a challenge can be traded on the trader's own broker TradeLocker DEMO account instead of IPFX Markets.
-- IPFX reads the account every ~10s, imports the trades and applies the challenge rules. OFF until switched on.
alter table public.platform_config add column if not exists challenge_venue text not null default 'ipfx';
alter table public.platform_config drop constraint if exists platform_config_challenge_venue_check;
alter table public.platform_config add constraint platform_config_challenge_venue_check check (challenge_venue in ('ipfx','tradelocker_demo'));
alter table public.platform_config add column if not exists venue_broker_server text;           -- e.g. 'HeroFX'

alter table public.trading_accounts add column if not exists venue text not null default 'ipfx';
alter table public.trading_accounts drop constraint if exists trading_accounts_venue_check;
alter table public.trading_accounts add constraint trading_accounts_venue_check check (venue in ('ipfx','tradelocker_demo'));
alter table public.trading_accounts add column if not exists venue_equity numeric;
alter table public.trading_accounts add column if not exists venue_synced_at timestamptz;

alter table public.trades add column if not exists external_source text;
alter table public.trades add column if not exists external_position_id text;
create unique index if not exists trades_external_position_uidx
  on public.trades (account_id, external_source, external_position_id) where external_position_id is not null;

create table if not exists public.venue_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  trading_account_id uuid not null unique references public.trading_accounts(id) on delete cascade,
  provider text not null default 'tradelocker' check (provider = 'tradelocker'),
  environment text not null default 'demo' check (environment = 'demo'),
  server text not null,
  tradelocker_account_id bigint not null,
  acc_num bigint not null,
  account_name text,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  access_expires_at timestamptz,
  baseline_balance numeric not null,          -- broker balance when connected (challenge P&L is measured from here)
  connected_at timestamptz not null default now(),
  status text not null default 'connected' check (status in ('connected','error','disconnected')),
  last_sync_at timestamptz,
  last_error text,
  broker_balance numeric,
  broker_equity numeric,
  instrument_names jsonb,
  updated_at timestamptz not null default now()
);
alter table public.venue_connections enable row level security;
revoke all on public.venue_connections from anon, authenticated;   -- tokens: server only; status is served by the function
grant all on public.venue_connections to service_role;

create table if not exists public.venue_sync_lease (id boolean primary key default true check (id), lease_until timestamptz, owner text);
insert into public.venue_sync_lease (id) values (true) on conflict do nothing;
alter table public.venue_sync_lease enable row level security;
revoke all on public.venue_sync_lease from anon, authenticated;
grant all on public.venue_sync_lease to service_role;
