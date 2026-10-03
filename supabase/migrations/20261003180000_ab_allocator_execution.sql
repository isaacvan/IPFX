-- A/B-book Day 3: risk allocation and execution.
--   * ab_settings: switches (book halt, scales, 30-second stop-loss deadline). Off by default.
--   * ab_risk_limits: hard caps per book. Only a migration can change them: the service role (and so every
--     model, worker and Edge Function) can read but never raise them.
--   * ab_risk_reservations: risk is reserved atomically BEFORE an order; parallel orders cannot breach a cap.
--   * book_orders: every A/B-book broker order with exact broker ids, one row per open / partial / close.
-- Destinations stay demo-only: team_book_destinations.environment is constrained to 'demo'.

create table if not exists public.ab_settings (
  singleton boolean primary key default true check (singleton),
  book_halt boolean not null default false,
  a_scale numeric not null default 1 check (a_scale > 0 and a_scale <= 10),
  b_scale numeric not null default 1 check (b_scale > 0 and b_scale <= 10),
  sl_deadline_seconds int check (sl_deadline_seconds is null or sl_deadline_seconds between 10 and 600),
  updated_at timestamptz not null default now()
);
insert into public.ab_settings (singleton) values (true) on conflict do nothing;

create table if not exists public.ab_risk_limits (
  book text primary key check (book in ('a', 'b')),
  per_trade_max_usd numeric not null check (per_trade_max_usd > 0),
  open_risk_max_usd numeric not null check (open_risk_max_usd > 0),
  per_trader_open_max_usd numeric not null check (per_trader_open_max_usd > 0),
  symbol_net_lots_max numeric not null check (symbol_net_lots_max > 0),
  daily_loss_stop_usd numeric not null check (daily_loss_stop_usd > 0),
  min_fill_fraction numeric not null default 0.2 check (min_fill_fraction > 0 and min_fill_fraction <= 1),
  max_multiplier numeric not null default 6 check (max_multiplier >= 1 and max_multiplier <= 10)
);
-- Sized for a $50K account: 0.5% per trade, 2% open, 1% per trader, 2.5% daily stop (= E8-style daily limit).
insert into public.ab_risk_limits values
  ('a', 250, 1000, 500, 2.0, 1250, 0.2, 6),
  ('b', 250, 1000, 500, 2.0, 1250, 0.2, 3)
on conflict (book) do nothing;

create table if not exists public.ab_risk_reservations (
  id bigint generated always as identity primary key,
  book text not null check (book in ('a', 'b')),
  source_trade_id uuid not null references public.trades(id) on delete cascade,
  person_id uuid not null,
  symbol text not null,
  signed_lots numeric not null,
  risk_usd numeric not null check (risk_usd > 0),
  status text not null default 'active' check (status in ('active', 'released', 'expired')),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  unique (book, source_trade_id)
);
create index if not exists ab_risk_reservations_active on public.ab_risk_reservations (book, status) where status = 'active';

create table if not exists public.book_orders (
  id bigint generated always as identity primary key,
  book text not null check (book in ('a', 'b')),
  source_trade_id uuid not null references public.trades(id) on delete cascade,
  person_id uuid not null,
  event text not null check (event in ('open', 'partial_close', 'close')),
  idempotency_key text not null unique,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  qty numeric not null check (qty > 0),
  multiplier numeric,
  risk_usd numeric,
  status text not null default 'sent' check (status in ('sent', 'filled', 'closed', 'skipped', 'error', 'reconciliation_required')),
  broker_order_id text,
  broker_position_id text,
  fill_price numeric,
  price_scale_per_lot numeric,             -- USD per 1.0 price move per lot (contract x conversion)
  latency_ms int,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists book_orders_trade on public.book_orders (source_trade_id, event);
create index if not exists book_orders_open on public.book_orders (book, status) where event = 'open';

alter table public.ab_settings enable row level security;
alter table public.ab_risk_limits enable row level security;
alter table public.ab_risk_reservations enable row level security;
alter table public.book_orders enable row level security;
revoke all on public.ab_settings, public.ab_risk_limits, public.ab_risk_reservations, public.book_orders from public, anon, authenticated;
grant select, update on public.ab_settings to service_role;
grant select on public.ab_risk_limits to service_role;                -- read only: caps change by migration
grant select, insert, update on public.ab_risk_reservations, public.book_orders to service_role;

-- Atomic reservation. Locks the book's limits row so concurrent orders serialise, then measures room from
-- active reservations and today's closed book P&L. Returns the risk allowed (shrunk to fit) or a refusal.
create or replace function public.ab_reserve_risk(p_book text, p_trade uuid, p_person uuid, p_symbol text,
  p_signed_lots numeric, p_risk_usd numeric)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare lim public.ab_risk_limits; s public.ab_settings; halted boolean;
        open_risk numeric; trader_open numeric; sym_net numeric; day_loss numeric; room numeric; allowed numeric; rid bigint;
begin
  select * into lim from public.ab_risk_limits where book = p_book for update;
  if lim is null then return jsonb_build_object('ok', false, 'reason', 'no limits for book'); end if;
  select * into s from public.ab_settings where singleton;
  select coalesce((select trading_halted from public.platform_config limit 1), false) into halted;
  if s.book_halt or halted then return jsonb_build_object('ok', false, 'reason', 'halted'); end if;
  if p_risk_usd is null or p_risk_usd <= 0 then return jsonb_build_object('ok', false, 'reason', 'no measurable risk (stop loss required)'); end if;
  if exists (select 1 from public.ab_risk_reservations where book = p_book and source_trade_id = p_trade) then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end if;
  update public.ab_risk_reservations set status = 'expired', released_at = now()
   where book = p_book and status = 'active' and created_at < now() - interval '2 minutes'
     and not exists (select 1 from public.book_orders o where o.source_trade_id = ab_risk_reservations.source_trade_id
                     and o.book = p_book and o.event = 'open' and o.status in ('sent', 'filled', 'reconciliation_required'));
  select coalesce(sum(risk_usd), 0) into open_risk from public.ab_risk_reservations where book = p_book and status = 'active';
  select coalesce(sum(risk_usd), 0) into trader_open from public.ab_risk_reservations where book = p_book and status = 'active' and person_id = p_person;
  select coalesce(sum(signed_lots), 0) into sym_net from public.ab_risk_reservations where book = p_book and status = 'active' and symbol = p_symbol;
  select coalesce(-sum(pnl_usd), 0) into day_loss from public.book_daily_pnl where book = p_book and day = (now() at time zone 'utc')::date;
  if day_loss >= lim.daily_loss_stop_usd then return jsonb_build_object('ok', false, 'reason', 'daily loss stop reached'); end if;
  if abs(sym_net + p_signed_lots) > lim.symbol_net_lots_max and abs(sym_net + p_signed_lots) > abs(sym_net) then
    return jsonb_build_object('ok', false, 'reason', 'symbol net exposure cap');
  end if;
  room := least(lim.per_trade_max_usd, lim.open_risk_max_usd - open_risk, lim.per_trader_open_max_usd - trader_open,
                lim.daily_loss_stop_usd - day_loss - open_risk);
  allowed := least(p_risk_usd, room);
  if allowed < p_risk_usd * lim.min_fill_fraction or allowed <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'risk room exhausted', 'room', greatest(room, 0));
  end if;
  insert into public.ab_risk_reservations (book, source_trade_id, person_id, symbol, signed_lots, risk_usd)
  values (p_book, p_trade, p_person, p_symbol, p_signed_lots * (allowed / p_risk_usd), allowed) returning id into rid;
  return jsonb_build_object('ok', true, 'reservation_id', rid, 'allowed_usd', round(allowed, 2), 'fraction', allowed / p_risk_usd);
end $$;
revoke all on function public.ab_reserve_risk(text, uuid, uuid, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.ab_reserve_risk(text, uuid, uuid, text, numeric, numeric) to service_role;

create or replace function public.ab_release_risk(p_book text, p_trade uuid, p_fraction numeric default 1)
returns void language sql security definer set search_path to '' as $$
  update public.ab_risk_reservations
     set risk_usd = case when p_fraction >= 1 then risk_usd else risk_usd * (1 - p_fraction) end,
         signed_lots = case when p_fraction >= 1 then signed_lots else signed_lots * (1 - p_fraction) end,
         status = case when p_fraction >= 1 then 'released' else status end,
         released_at = case when p_fraction >= 1 then now() else released_at end
   where book = p_book and source_trade_id = p_trade and status = 'active';
$$;
revoke all on function public.ab_release_risk(text, uuid, numeric) from public, anon, authenticated;
grant execute on function public.ab_release_risk(text, uuid, numeric) to service_role;

-- Daily book P&L from closed broker legs (open fill vs close fill x qty x price scale), for the daily stop.
alter table public.book_orders add column if not exists pnl_usd numeric;
create or replace view public.book_daily_pnl with (security_invoker = true) as
select book, (updated_at at time zone 'utc')::date as day, sum(coalesce(pnl_usd, 0)) as pnl_usd
from public.book_orders where event in ('close', 'partial_close') and status = 'closed' group by 1, 2;
revoke all on public.book_daily_pnl from public, anon, authenticated;
grant select on public.book_daily_pnl to service_role;

-- Which book (if any) a user's new trades are routed to: the person's state, a connected destination and no halt.
create or replace function public.ab_route_for_user(p_user uuid)
returns text language sql stable security definer set search_path to '' as $$
  select case when s.book_halt then null
              when p.book_state = 'AB_LIVE' and exists (select 1 from public.team_book_destinations d where d.book = 'a' and d.status = 'connected') then 'a'
              when p.book_state = 'BB_LIVE' and exists (select 1 from public.team_book_destinations d where d.book = 'b' and d.status = 'connected') then 'b'
         end
  from public.ab_trader_profiles p cross join public.ab_settings s
  where p.person_id = public.ab_person_of(p_user)
$$;
revoke all on function public.ab_route_for_user(uuid) from public, anon, authenticated;
grant execute on function public.ab_route_for_user(uuid) to service_role;

-- Reconciler + orphan sweep for book orders: pg_cron calls book-executor every minute with a dedicated secret.
create or replace function public.kick_book_reconcile() returns void language plpgsql security definer set search_path to '' as $$
declare secret text;
begin
  if not exists (select 1 from public.book_orders where status in ('sent', 'reconciliation_required') and created_at < now() - interval '45 seconds')
     and not exists (select 1 from public.book_orders o join public.trades t on t.id = o.source_trade_id
                     where o.event = 'open' and o.status = 'filled' and t.status = 'closed'
                       and not exists (select 1 from public.book_orders c where c.source_trade_id = o.source_trade_id and c.book = o.book and c.event = 'close')) then
    return;
  end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'ipfx_book_executor_secret' limit 1;
  if secret is null then raise warning 'book reconcile not scheduled: Vault secret missing'; return; end if;
  perform net.http_post(url := 'https://agulweemteoeagscmppy.supabase.co/functions/v1/book-executor',
    headers := jsonb_build_object('x-book-secret', secret, 'Content-Type', 'application/json'),
    body := '{"action":"reconcile"}'::jsonb, timeout_milliseconds := 30000);
end $$;
revoke all on function public.kick_book_reconcile() from public, anon, authenticated;
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'ipfx-book-reconcile';
  perform cron.schedule('ipfx-book-reconcile', '* * * * *', 'select public.kick_book_reconcile()');
end $$;
