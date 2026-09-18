begin;

create table if not exists public.macro_calendar_events (
  provider text not null default 'trading_economics',
  provider_event_id text not null,
  event_at timestamptz not null,
  country text,
  currency text,
  category text,
  event_name text not null,
  importance smallint not null check (importance between 1 and 3),
  source_url text,
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  primary key (provider, provider_event_id)
);
create index if not exists idx_macro_calendar_event_at on public.macro_calendar_events(event_at);
create index if not exists idx_macro_calendar_currency_at on public.macro_calendar_events(currency,event_at);

create table if not exists public.trader_style_profiles (
  account_id uuid primary key references public.trading_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('scalper','news_event_trader','swing_trader','high_frequency_trader','unclassified')),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  evidence jsonb not null default '{}'::jsonb,
  classifier_version text not null default 'simple-v1',
  calculated_at timestamptz not null default now()
);
create index if not exists idx_trader_style_user on public.trader_style_profiles(user_id);
create index if not exists idx_trader_style_category on public.trader_style_profiles(category);

create table if not exists public.mirror_risk_policies (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mode text not null default 'observe' check (mode in ('observe','adaptive','blocked')),
  min_multiplier numeric(6,4) not null default 0.10 check (min_multiplier > 0 and min_multiplier <= 1),
  unusual_size_multiple numeric(6,2) not null default 3 check (unusual_size_multiple >= 1.5),
  news_multiplier numeric(6,4) not null default 0.25 check (news_multiplier >= 0 and news_multiplier <= 1),
  note text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.mirror_risk_decisions (
  id bigint generated always as identity primary key,
  source_trade_id uuid not null,
  user_id uuid not null,
  account_id uuid references public.trading_accounts(id) on delete set null,
  target_id uuid references public.mirror_targets(id) on delete set null,
  event text not null check (event in ('open','close')),
  policy_mode text not null check (policy_mode in ('observe','adaptive','blocked')),
  category text not null default 'unclassified',
  action text not null check (action in ('allow','reduce','skip')),
  requested_volume numeric(10,2),
  approved_volume numeric(10,2),
  risk_multiplier numeric(8,4) not null,
  reasons jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_mirror_risk_decision_user on public.mirror_risk_decisions(user_id,created_at desc);
create index if not exists idx_mirror_risk_decision_trade on public.mirror_risk_decisions(source_trade_id,created_at desc);

alter table public.macro_calendar_events enable row level security;
alter table public.trader_style_profiles enable row level security;
alter table public.mirror_risk_policies enable row level security;
alter table public.mirror_risk_decisions enable row level security;

-- No browser policies. All reads/writes go through service-role Edge Functions.
revoke all on public.macro_calendar_events, public.trader_style_profiles, public.mirror_risk_policies, public.mirror_risk_decisions from anon, authenticated;

commit;
