-- Platform features: trailing stops, OCO pending orders, server-side price alerts.

-- Trailing stop: a price distance. The engine only ever TIGHTENS sl toward the market by this distance.
alter table public.trades add column if not exists trail_distance numeric;
alter table public.trades drop constraint if exists trades_trail_distance_positive;
alter table public.trades add constraint trades_trail_distance_positive check (trail_distance is null or trail_distance > 0);

-- OCO: pending orders sharing an oco_group cancel each other once one fills.
alter table public.pending_orders add column if not exists oco_group uuid;
create index if not exists pending_orders_oco_group_idx on public.pending_orders (oco_group) where oco_group is not null;
-- Race backstop: at most one leg of a group can ever be claimed as filled.
create unique index if not exists pending_orders_one_fill_per_oco
  on public.pending_orders (oco_group) where oco_group is not null and status = 'filled';

-- Price alerts: evaluated by the engine (state polls + the 10s sweep), so they fire even with the platform closed.
create table if not exists public.price_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  condition text not null check (condition in ('above','below')),
  price numeric not null check (price > 0),
  note text check (note is null or length(note) <= 140),
  status text not null default 'active' check (status in ('active','triggered','cancelled')),
  created_at timestamptz not null default now(),
  triggered_at timestamptz,
  triggered_price numeric,
  seen_at timestamptz
);
create index if not exists price_alerts_active_idx on public.price_alerts (symbol) where status = 'active';
create index if not exists price_alerts_user_idx on public.price_alerts (user_id, created_at desc);
alter table public.price_alerts enable row level security;
drop policy if exists "own alerts read" on public.price_alerts;
create policy "own alerts read" on public.price_alerts for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.price_alerts from anon;
revoke insert, update, delete, truncate on public.price_alerts from authenticated;
grant select on public.price_alerts to authenticated;
grant all on public.price_alerts to service_role;
