-- Separate owner TradeLocker logins for A and B research screens.
-- This schema does not create or arm any copier route or broker order.
create table if not exists public.team_book_destinations (
  book text primary key check (book in ('a', 'b')),
  environment text not null default 'demo' check (environment = 'demo'),
  broker text not null default 'tradelocker' check (broker = 'tradelocker'),
  server text not null,
  account_id text not null,
  acc_num text not null,
  account_name text not null,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  access_expires_at timestamptz,
  instrument_map jsonb not null default '[]'::jsonb,
  status text not null default 'connected' check (status in ('connected', 'disconnected')),
  last_health_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_book_connected_tokens check (
    status <> 'connected' or (access_token_ciphertext is not null and refresh_token_ciphertext is not null)
  )
);

create unique index if not exists team_book_separate_accounts
  on public.team_book_destinations(environment, account_id) where status = 'connected';

alter table public.team_book_destinations enable row level security;
revoke all on public.team_book_destinations from public, anon, authenticated;
grant select, insert, update, delete on public.team_book_destinations to service_role;
