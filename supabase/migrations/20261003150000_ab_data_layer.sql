-- A/B-book data layer (Day 1):
--   * person-level trader profile that survives restarts and duplicate accounts
--   * bid/ask saved around every trade's open and close (the rolling tick store keeps only 6 hours)
--   * a ledger row per closed trade with a replay of copying it the same way and the opposite way at
--     real bid/ask, after broker commission and a copy latency. Reverse P&L is measured, never assumed.
-- Everything here is service-role only and changes nothing about how trades are executed.

-- ---------- person identity ----------
-- Accounts suspended as duplicates (Terms 3.4) point at the account that was kept.
create or replace function public.ab_person_of(p_user uuid)
returns uuid language sql stable security definer set search_path to '' as $$
  select coalesce(
    (select nullif(u.raw_app_meta_data -> 'suspension' ->> 'kept_user_id', '')::uuid from auth.users u where u.id = p_user),
    p_user)
$$;
revoke all on function public.ab_person_of(uuid) from public, anon, authenticated;

create table if not exists public.ab_trader_profiles (
  person_id uuid primary key,
  book_state text not null default 'BB_DEMO' check (book_state in ('BB_DEMO', 'BB_LIVE', 'AB_DEMO', 'AB_LIVE', 'SUSPENDED')),
  state_since timestamptz not null default now(),
  state_reason text not null default 'start: every trader begins on B-book demo',
  first_trade_at timestamptz,
  last_trade_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ab_trader_profiles enable row level security;
revoke all on public.ab_trader_profiles from public, anon, authenticated;
grant select, insert, update on public.ab_trader_profiles to service_role;

-- ---------- quotes around each trade ----------
create table if not exists public.trade_quote_windows (
  trade_id uuid not null references public.trades(id) on delete cascade,
  event text not null check (event in ('open', 'close')),
  ts timestamptz not null,
  bid numeric not null,
  ask numeric not null,
  source text not null default 'ipfx_feed',
  primary key (trade_id, event, ts, source)
);
create table if not exists public.trade_quote_capture (
  trade_id uuid not null references public.trades(id) on delete cascade,
  event text not null check (event in ('open', 'close')),
  captured_at timestamptz not null default now(),
  ticks int not null,
  primary key (trade_id, event)
);
alter table public.trade_quote_windows enable row level security;
alter table public.trade_quote_capture enable row level security;
revoke all on public.trade_quote_windows, public.trade_quote_capture from public, anon, authenticated;
grant select, insert, delete on public.trade_quote_windows, public.trade_quote_capture to service_role;

-- Saves ticks from 120 s before to 60 s after each open/close still inside the 6-hour tick store.
-- The extra minute before gives a valid quote even when the symbol was quiet.
create or replace function public.ab_capture_quote_windows()
returns int language plpgsql security definer set search_path to '' as $$
declare n int := 0; r record; k int;
begin
  for r in
    select t.id, t.symbol, 'open'::text as ev, t.opened_at as at from public.trades t
     where t.opened_at > now() - interval '5 hours 30 minutes' and t.opened_at < now() - interval '90 seconds'
       and not exists (select 1 from public.trade_quote_capture c where c.trade_id = t.id and c.event = 'open')
    union all
    select t.id, t.symbol, 'close', t.closed_at from public.trades t
     where t.status = 'closed' and t.closed_at > now() - interval '5 hours 30 minutes' and t.closed_at < now() - interval '90 seconds'
       and not exists (select 1 from public.trade_quote_capture c where c.trade_id = t.id and c.event = 'close')
  loop
    insert into public.trade_quote_windows (trade_id, event, ts, bid, ask)
    select r.id, r.ev, q.ts, q.bid, q.ask from public.quote_ticks q
     where q.symbol = r.symbol and q.ts between r.at - interval '120 seconds' and r.at + interval '60 seconds'
       and q.bid > 0 and q.ask >= q.bid
    on conflict do nothing;
    get diagnostics k = row_count;
    insert into public.trade_quote_capture (trade_id, event, ticks) values (r.id, r.ev, k) on conflict do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.ab_capture_quote_windows() from public, anon, authenticated;

-- ---------- ledger ----------
create table if not exists public.ab_trade_ledger (
  trade_id uuid primary key references public.trades(id) on delete cascade,
  person_id uuid not null,
  user_id uuid not null,
  account_id uuid not null,
  challenge_type text,
  stage int,
  symbol text not null,
  side text not null,
  volume numeric not null,
  opened_at timestamptz not null,
  closed_at timestamptz not null,
  hold_seconds numeric not null,
  open_price numeric not null,
  close_price numeric not null,
  stop_loss numeric,
  trader_pnl_usd numeric not null,
  trader_gross_usd numeric not null,
  usd_per_price_unit numeric,
  risk_usd numeric,
  trader_r numeric,
  latency_ms int not null,
  broker_cost_usd numeric not null,
  replay_basis text not null check (replay_basis in ('REPLAY_QUOTES', 'NO_QUOTES', 'NO_PRICE_SCALE')),
  same_open_px numeric, same_close_px numeric,
  rev_open_px numeric, rev_close_px numeric,
  same_usd numeric, reverse_usd numeric,
  same_r numeric, reverse_r numeric,
  created_at timestamptz not null default now()
);
create index if not exists ab_trade_ledger_person on public.ab_trade_ledger (person_id, closed_at);
alter table public.ab_trade_ledger enable row level security;
revoke all on public.ab_trade_ledger from public, anon, authenticated;
grant select, insert on public.ab_trade_ledger to service_role;

-- Builds ledger rows for closed trades whose quotes were captured (or that are too old to capture).
-- Copy fills: same direction buys at the ask / sells at the bid at decision time + latency; the reverse
-- does the opposite. Therefore same + reverse = -(two spreads) - 2 x commission: both sides pay costs.
create or replace function public.ab_build_ledger(p_latency_ms int default 500)
returns int language plpgsql security definer set search_path to '' as $$
declare n int;
begin
  with closed as (
    select t.*, a.challenge_type, a.stage,
           case when t.side = 'buy' then 1 else -1 end as dir,
           coalesce(t.pnl, 0) + coalesce(t.commission, 0) as gross,
           coalesce((select s.commission_per_lot_usd from public.symbol_specs s where s.symbol = t.symbol), 6) as comm_per_lot
      from public.trades t join public.trading_accounts a on a.id = t.account_id
     where t.status = 'closed' and t.closed_at is not null and t.close_price is not null and t.open_price is not null
       and not exists (select 1 from public.ab_trade_ledger l where l.trade_id = t.id)
       and ( (exists (select 1 from public.trade_quote_capture c where c.trade_id = t.id and c.event = 'open')
              and exists (select 1 from public.trade_quote_capture c where c.trade_id = t.id and c.event = 'close'))
             or t.closed_at < now() - interval '5 hours 30 minutes')
     order by t.closed_at limit 2000
  ), scaled as (
    select c.*,
      -- USD per 1.0 price move for this trade's size, recovered from its own booked P&L.
      case when abs((c.close_price - c.open_price)) > 0 and c.gross <> 0
           then abs(c.gross / ((c.close_price - c.open_price) * c.dir)) end as k,
      (select q.bid from public.trade_quote_windows q where q.trade_id = c.id and q.event = 'open'
        and q.ts <= c.opened_at + make_interval(secs => p_latency_ms / 1000.0) order by q.ts desc limit 1) as o_bid,
      (select q.ask from public.trade_quote_windows q where q.trade_id = c.id and q.event = 'open'
        and q.ts <= c.opened_at + make_interval(secs => p_latency_ms / 1000.0) order by q.ts desc limit 1) as o_ask,
      (select q.bid from public.trade_quote_windows q where q.trade_id = c.id and q.event = 'close'
        and q.ts <= c.closed_at + make_interval(secs => p_latency_ms / 1000.0) order by q.ts desc limit 1) as c_bid,
      (select q.ask from public.trade_quote_windows q where q.trade_id = c.id and q.event = 'close'
        and q.ts <= c.closed_at + make_interval(secs => p_latency_ms / 1000.0) order by q.ts desc limit 1) as c_ask
    from closed c
  ), priced as (
    select s.*,
      case when s.dir = 1 then s.o_ask else s.o_bid end as so, case when s.dir = 1 then s.c_bid else s.c_ask end as sc,
      case when s.dir = 1 then s.o_bid else s.o_ask end as ro, case when s.dir = 1 then s.c_ask else s.c_bid end as rc,
      s.comm_per_lot * s.volume as bcost,
      case when s.sl is not null and s.k is not null and abs(s.open_price - s.sl) > 0 then abs(s.open_price - s.sl) * s.k end as risk
    from scaled s
  )
  insert into public.ab_trade_ledger (trade_id, person_id, user_id, account_id, challenge_type, stage, symbol, side, volume,
    opened_at, closed_at, hold_seconds, open_price, close_price, stop_loss, trader_pnl_usd, trader_gross_usd, usd_per_price_unit,
    risk_usd, trader_r, latency_ms, broker_cost_usd, replay_basis, same_open_px, same_close_px, rev_open_px, rev_close_px,
    same_usd, reverse_usd, same_r, reverse_r)
  select p.id, public.ab_person_of(p.user_id), p.user_id, p.account_id, p.challenge_type, p.stage, p.symbol, p.side, p.volume,
    p.opened_at, p.closed_at, extract(epoch from (p.closed_at - p.opened_at)), p.open_price, p.close_price, p.sl,
    coalesce(p.pnl, 0), p.gross, p.k, p.risk, case when p.risk > 0 then coalesce(p.pnl, 0) / p.risk end,
    p_latency_ms, round(p.bcost, 2),
    case when p.k is null then 'NO_PRICE_SCALE' when p.so is null or p.sc is null then 'NO_QUOTES' else 'REPLAY_QUOTES' end,
    p.so, p.sc, p.ro, p.rc,
    case when p.k is not null and p.so is not null and p.sc is not null then round(((p.sc - p.so) * p.dir * p.k - p.bcost)::numeric, 2) end,
    case when p.k is not null and p.ro is not null and p.rc is not null then round(((p.ro - p.rc) * p.dir * p.k - p.bcost)::numeric, 2) end,
    case when p.risk > 0 and p.so is not null and p.sc is not null then ((p.sc - p.so) * p.dir * p.k - p.bcost) / p.risk end,
    case when p.risk > 0 and p.ro is not null and p.rc is not null then ((p.ro - p.rc) * p.dir * p.k - p.bcost) / p.risk end
  from priced p
  on conflict (trade_id) do nothing;
  get diagnostics n = row_count;

  -- Profiles: one per person, created on first ledger row; never reset by a restart.
  insert into public.ab_trader_profiles (person_id, first_trade_at, last_trade_at)
  select person_id, min(opened_at), max(closed_at) from public.ab_trade_ledger group by person_id
  on conflict (person_id) do update set
    first_trade_at = least(public.ab_trader_profiles.first_trade_at, excluded.first_trade_at),
    last_trade_at = greatest(public.ab_trader_profiles.last_trade_at, excluded.last_trade_at),
    updated_at = now()
  where public.ab_trader_profiles.last_trade_at is distinct from excluded.last_trade_at
     or public.ab_trader_profiles.first_trade_at is distinct from excluded.first_trade_at;
  return n;
end $$;
revoke all on function public.ab_build_ledger(int) from public, anon, authenticated;

create or replace function public.ab_ledger_tick()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare cap int; built int;
begin
  cap := public.ab_capture_quote_windows();
  built := public.ab_build_ledger(500);
  return jsonb_build_object('captured', cap, 'ledger_rows', built);
end $$;
revoke all on function public.ab_ledger_tick() from public, anon, authenticated;

-- Per-person evidence summary used by the classifier (Day 2). R-multiples need a stop loss.
create or replace view public.ab_person_stats with (security_invoker = true) as
select person_id,
  count(*) as trades,
  count(distinct (closed_at at time zone 'utc')::date) as trading_days,
  count(*) filter (where replay_basis = 'REPLAY_QUOTES') as replayed,
  count(*) filter (where same_r is not null) as r_trades,
  avg(same_r) as same_r_mean, stddev_samp(same_r) as same_r_sd,
  avg(reverse_r) as reverse_r_mean, stddev_samp(reverse_r) as reverse_r_sd,
  sum(same_usd) as same_usd_total, sum(reverse_usd) as reverse_usd_total,
  sum(trader_pnl_usd) as trader_pnl_total,
  percentile_cont(0.5) within group (order by hold_seconds) as median_hold_seconds,
  avg((hold_seconds < 60)::int) as share_under_60s,
  min(opened_at) as first_trade_at, max(closed_at) as last_trade_at
from public.ab_trade_ledger group by person_id;
revoke all on public.ab_person_stats from public, anon, authenticated;
grant select on public.ab_person_stats to service_role;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'ipfx-ab-ledger';
  perform cron.schedule('ipfx-ab-ledger', '*/5 * * * *', 'select public.ab_ledger_tick()');
end $$;
