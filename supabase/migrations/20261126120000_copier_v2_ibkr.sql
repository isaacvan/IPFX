-- Copier v2 (owner request 26 Nov 2026): event-driven copying of qualifying Infinity traders to IBKR.
--   Engine -> hub (no database round trip) -> IBKR bridge (ib_insync, one open connection, contracts looked up in advance).
--   Entries are limit orders at the trader's fill plus a small tolerance, skipped if not filled within the timeout.
--   Pending orders rest at the broker as soon as they are placed. Stop loss and take profit rest at the broker as a
--   one-cancels-the-other pair. High-impact news (+-2 minutes) is skipped.
--   Only traders whose edge survives the copy cost qualify: average trade >= 5x the copy cost and shadow-copied profit
--   >= 70% of their own, over a minimum number of shadow-copied trades.
-- Build order: 'shadow' (modelled costs, every in-scope trade) -> 'paper' (IBKR paper account, measured latency and
-- slippage). 'live' is deliberately impossible here: it needs a new migration and the owner's decision.
-- The hub reads and writes only through the secret-checked functions below (it holds no service key).
begin;

create table if not exists public.copy_settings (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'shadow' check (mode in ('off', 'shadow', 'paper')),
  entry_tolerance_pips numeric not null default 0.3 check (entry_tolerance_pips >= 0 and entry_tolerance_pips <= 5),
  fill_timeout_ms integer not null default 1500 check (fill_timeout_ms between 300 and 5000),
  news_window_s integer not null default 120 check (news_window_s between 0 and 1800),
  min_edge_multiple numeric not null default 5 check (min_edge_multiple >= 1),
  min_capture numeric not null default 0.70 check (min_capture > 0 and min_capture <= 1),
  min_trades integer not null default 30 check (min_trades >= 5),
  lookback_days integer not null default 60 check (lookback_days between 7 and 365),
  require_ab_states text[] not null default '{AB_DEMO,AB_LIVE}',
  copy_ratio numeric not null default 1 check (copy_ratio > 0 and copy_ratio <= 20),
  max_lots_per_order numeric not null default 1 check (max_lots_per_order > 0 and max_lots_per_order <= 10),
  max_open_copies integer not null default 10 check (max_open_copies between 1 and 100),
  modelled_latency_ms integer not null default 400 check (modelled_latency_ms between 0 and 5000),
  updated_at timestamptz not null default now()
);
insert into public.copy_settings (singleton) values (true) on conflict do nothing;

-- One row per IPFX symbol: the IBKR contract, pip size and the cost model. Commission is IBKR's tiered style:
-- a fraction of notional per side with a minimum per order (the minimum dominates small copies). Defaults are
-- estimates to confirm on the paper account.
create table if not exists public.copy_symbols (
  symbol text primary key,
  broker_symbol text not null,
  broker_sec_type text not null check (broker_sec_type in ('CASH', 'CMDTY', 'CFD')),
  broker_exchange text not null,
  broker_currency text not null,
  pip numeric not null check (pip > 0),
  enabled boolean not null default true,
  tolerance_pips numeric check (tolerance_pips is null or tolerance_pips between 0 and 50),
  extra_spread_pips numeric not null default 0.3 check (extra_spread_pips >= 0),
  stop_slippage_pips numeric not null default 0.3 check (stop_slippage_pips >= 0),
  commission_rate numeric not null default 0.00002 check (commission_rate >= 0 and commission_rate < 0.01),
  commission_min_usd numeric not null default 2 check (commission_min_usd >= 0),
  news_currencies text[] not null
);
insert into public.copy_symbols (symbol, broker_symbol, broker_sec_type, broker_exchange, broker_currency, pip, tolerance_pips, extra_spread_pips, stop_slippage_pips, commission_rate, commission_min_usd, news_currencies) values
  ('EURUSD', 'EUR', 'CASH', 'IDEALPRO', 'USD', 0.0001, null, 0.3, 0.3, 0.00002, 2, '{EUR,USD}'),
  ('GBPUSD', 'GBP', 'CASH', 'IDEALPRO', 'USD', 0.0001, null, 0.3, 0.3, 0.00002, 2, '{GBP,USD}'),
  ('AUDUSD', 'AUD', 'CASH', 'IDEALPRO', 'USD', 0.0001, null, 0.3, 0.3, 0.00002, 2, '{AUD,USD}'),
  ('NZDUSD', 'NZD', 'CASH', 'IDEALPRO', 'USD', 0.0001, null, 0.4, 0.4, 0.00002, 2, '{NZD,USD}'),
  ('USDCAD', 'USD', 'CASH', 'IDEALPRO', 'CAD', 0.0001, null, 0.3, 0.3, 0.00002, 2, '{USD,CAD}'),
  ('USDCHF', 'USD', 'CASH', 'IDEALPRO', 'CHF', 0.0001, null, 0.3, 0.3, 0.00002, 2, '{USD,CHF}'),
  ('USDJPY', 'USD', 'CASH', 'IDEALPRO', 'JPY', 0.01,   null, 0.3, 0.3, 0.00002, 2, '{USD,JPY}'),
  ('EURJPY', 'EUR', 'CASH', 'IDEALPRO', 'JPY', 0.01,   null, 0.4, 0.4, 0.00002, 2, '{EUR,JPY}'),
  ('GBPJPY', 'GBP', 'CASH', 'IDEALPRO', 'JPY', 0.01,   null, 0.5, 0.5, 0.00002, 2, '{GBP,JPY}'),
  ('EURGBP', 'EUR', 'CASH', 'IDEALPRO', 'GBP', 0.0001, null, 0.3, 0.3, 0.00002, 2, '{EUR,GBP}'),
  ('EURCAD', 'EUR', 'CASH', 'IDEALPRO', 'CAD', 0.0001, null, 0.5, 0.5, 0.00002, 2, '{EUR,CAD}'),
  ('AUDCAD', 'AUD', 'CASH', 'IDEALPRO', 'CAD', 0.0001, null, 0.5, 0.5, 0.00002, 2, '{AUD,CAD}'),
  -- Spot gold: pip = $0.10. Indices (IBKR index CFDs): pip = 1 index point.
  ('XAUUSD', 'XAUUSD',   'CMDTY', 'SMART', 'USD', 0.1, 3, 2, 3, 0.000015, 2, '{USD}'),
  ('NSXUSD', 'IBUST100', 'CFD',   'SMART', 'USD', 1,   2, 1, 2, 0.00005,  1, '{USD}'),
  ('SPXUSD', 'IBUS500',  'CFD',   'SMART', 'USD', 1,   1, 0.5, 1, 0.00005, 1, '{USD}'),
  ('DJI',    'IBUS30',   'CFD',   'SMART', 'USD', 1,   3, 2, 3, 0.00005,  1, '{USD}'),
  ('GER40',  'IBDE40',   'CFD',   'SMART', 'EUR', 1,   2, 1, 2, 0.00005,  1, '{EUR}'),
  ('FRA40',  'IBFR40',   'CFD',   'SMART', 'EUR', 1,   2, 1, 2, 0.00005,  1, '{EUR}'),
  ('UK100',  'IBGB100',  'CFD',   'SMART', 'GBP', 1,   2, 1, 2, 0.00005,  1, '{GBP}')
on conflict (symbol) do nothing;

-- One row per copied (or modelled) trader trade and mode. Pips are in the symbol's pip; costs are positive numbers.
create table if not exists public.copy_trades (
  source_trade_id uuid not null,
  mode text not null check (mode in ('shadow', 'paper')),
  user_id uuid not null,
  account_id uuid not null,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  from_pending boolean not null default false,
  trader_lots numeric not null,
  copy_lots numeric,
  trader_open numeric not null,
  copy_open numeric,
  opened_at timestamptz not null,
  entry_status text not null check (entry_status in ('filled', 'missed', 'skipped', 'open_order')),
  skip_reason text,
  trader_close numeric,
  copy_close numeric,
  closed_at timestamptz,
  close_reason text,
  trader_pips numeric,
  copy_pips numeric,
  cost_pips numeric,
  entry_slip_pips numeric,
  exit_slip_pips numeric,
  commission_pips numeric,
  stale_gap_pips numeric,
  latency jsonb not null default '{}'::jsonb,
  broker jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (source_trade_id, mode)
);
create index if not exists copy_trades_user_idx on public.copy_trades (user_id, opened_at desc);
create index if not exists copy_trades_open_idx on public.copy_trades (mode) where closed_at is null and entry_status in ('filled', 'open_order');

-- Every intent and stage, for latency and audit (kept 30 days).
create table if not exists public.copy_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  source_id uuid,
  kind text not null,
  stage text not null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists copy_events_at_idx on public.copy_events (at desc);

-- IPFX price vs broker price, per symbol per 5 minutes (needs the bridge's price stream).
create table if not exists public.copy_feed_parity (
  symbol text not null,
  bucket timestamptz not null,
  samples integer not null,
  mean_gap_pips numeric not null,
  max_gap_pips numeric not null,
  ipfx_behind_ms numeric,
  primary key (symbol, bucket)
);

alter table public.copy_settings enable row level security;
alter table public.copy_symbols enable row level security;
alter table public.copy_trades enable row level security;
alter table public.copy_events enable row level security;
alter table public.copy_feed_parity enable row level security;
revoke all on public.copy_settings, public.copy_symbols, public.copy_trades, public.copy_events, public.copy_feed_parity from anon, authenticated;

-- Who qualifies, from shadow-copied trades in the lookback window:
--   average trader trade >= min_edge_multiple x average copy cost, shadow-copied profit >= min_capture x own profit,
--   at least min_trades shadow-copied trades, a classifier state in require_ab_states, and an edge that is not made of
--   stale IPFX prices (when broker prices are known: stale gap under 30% of the average trade).
create or replace view public.copy_trader_quality with (security_invoker = true) as
with s as (select * from public.copy_settings where singleton),
t as (
  select c.user_id, count(*) as trades,
    avg(c.trader_pips) as avg_trader_pips,
    avg(c.cost_pips) as avg_cost_pips,
    sum(c.trader_pips * c.trader_lots) as trader_pip_lots,
    sum(c.copy_pips * c.trader_lots) as copy_pip_lots,
    count(*) filter (where c.entry_status = 'missed') as missed,
    avg(c.stale_gap_pips) as avg_stale_gap_pips
  from public.copy_trades c, s
  where c.mode = 'shadow' and c.entry_status in ('filled', 'missed') and c.closed_at is not null
    and c.opened_at > now() - make_interval(days => s.lookback_days)
  group by c.user_id
)
select t.user_id, p.book_state, t.trades, t.missed,
  round(t.avg_trader_pips, 2) as avg_trader_pips,
  round(t.avg_cost_pips, 2) as avg_cost_pips,
  round(t.avg_trader_pips / nullif(t.avg_cost_pips, 0), 2) as edge_multiple,
  round(t.copy_pip_lots / nullif(t.trader_pip_lots, 0), 3) as capture,
  round(t.avg_stale_gap_pips, 2) as avg_stale_gap_pips,
  (t.trades >= s.min_trades
    and t.trader_pip_lots > 0
    and t.avg_trader_pips >= s.min_edge_multiple * t.avg_cost_pips
    and t.copy_pip_lots >= s.min_capture * t.trader_pip_lots
    and coalesce(p.book_state, '') = any (s.require_ab_states)
    and (t.avg_stale_gap_pips is null or t.avg_stale_gap_pips < 0.3 * t.avg_trader_pips)) as qualifies
from t cross join s
left join public.ab_trader_profiles p on p.person_id = public.ab_person_of(t.user_id);
revoke all on public.copy_trader_quality from anon, authenticated;

-- Hub: everything it needs in memory (settings, symbols, who qualifies, copies still open after a restart).
create or replace function public.copy_hub_config(p_secret text)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.hub_check(p_secret) then raise exception 'not authorised' using errcode = '42501'; end if;
  return jsonb_build_object(
    'settings', (select to_jsonb(s) from public.copy_settings s where singleton),
    'symbols', coalesce((select jsonb_agg(to_jsonb(y)) from public.copy_symbols y), '[]'::jsonb),
    'qualified', coalesce((select jsonb_agg(q.user_id) from public.copy_trader_quality q where q.qualifies), '[]'::jsonb),
    'open', coalesce((select jsonb_agg(to_jsonb(c)) from public.copy_trades c
      where c.closed_at is null and c.entry_status in ('filled', 'open_order') and c.opened_at > now() - interval '30 days'), '[]'::jsonb));
end $$;
revoke all on function public.copy_hub_config(text) from public, authenticated;
grant execute on function public.copy_hub_config(text) to anon;

-- Hub: batched results (never in the order path). Trades are upserted whole; events and parity are appended.
create or replace function public.copy_hub_save(p_secret text, p_trades jsonb, p_events jsonb, p_parity jsonb)
returns integer language plpgsql security definer set search_path to '' as $$
declare n integer := 0;
begin
  if not public.hub_check(p_secret) then raise exception 'not authorised' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_trades, '[]')) <> 'array' or jsonb_array_length(coalesce(p_trades, '[]')) > 500
     or jsonb_typeof(coalesce(p_events, '[]')) <> 'array' or jsonb_array_length(coalesce(p_events, '[]')) > 2000
     or jsonb_typeof(coalesce(p_parity, '[]')) <> 'array' or jsonb_array_length(coalesce(p_parity, '[]')) > 500 then
    raise exception 'batch too large' using errcode = '22023';
  end if;
  insert into public.copy_trades as c (source_trade_id, mode, user_id, account_id, symbol, side, from_pending, trader_lots, copy_lots,
    trader_open, copy_open, opened_at, entry_status, skip_reason, trader_close, copy_close, closed_at, close_reason, trader_pips, copy_pips,
    cost_pips, entry_slip_pips, exit_slip_pips, commission_pips, stale_gap_pips, latency, broker, updated_at)
  select x.source_trade_id, x.mode, x.user_id, x.account_id, x.symbol, x.side, coalesce(x.from_pending, false), x.trader_lots, x.copy_lots,
    x.trader_open, x.copy_open, x.opened_at, x.entry_status, x.skip_reason, x.trader_close, x.copy_close, x.closed_at, x.close_reason, x.trader_pips, x.copy_pips,
    x.cost_pips, x.entry_slip_pips, x.exit_slip_pips, x.commission_pips, x.stale_gap_pips, coalesce(x.latency, '{}'), coalesce(x.broker, '{}'), now()
  from jsonb_to_recordset(coalesce(p_trades, '[]')) as x(source_trade_id uuid, mode text, user_id uuid, account_id uuid, symbol text, side text,
    from_pending boolean, trader_lots numeric, copy_lots numeric, trader_open numeric, copy_open numeric, opened_at timestamptz, entry_status text,
    skip_reason text, trader_close numeric, copy_close numeric, closed_at timestamptz, close_reason text, trader_pips numeric, copy_pips numeric,
    cost_pips numeric, entry_slip_pips numeric, exit_slip_pips numeric, commission_pips numeric, stale_gap_pips numeric, latency jsonb, broker jsonb)
  -- The copy must belong to the trade it claims: same account, owner and symbol.
  where exists (select 1 from public.trades t where t.id = x.source_trade_id and t.account_id = x.account_id and t.user_id = x.user_id and t.symbol = x.symbol)
  on conflict (source_trade_id, mode) do update set
    copy_lots = excluded.copy_lots, copy_open = excluded.copy_open, entry_status = excluded.entry_status, skip_reason = excluded.skip_reason,
    trader_close = excluded.trader_close, copy_close = excluded.copy_close, closed_at = excluded.closed_at, close_reason = excluded.close_reason,
    trader_pips = excluded.trader_pips, copy_pips = excluded.copy_pips, cost_pips = excluded.cost_pips, entry_slip_pips = excluded.entry_slip_pips,
    exit_slip_pips = excluded.exit_slip_pips, commission_pips = excluded.commission_pips, stale_gap_pips = excluded.stale_gap_pips,
    latency = c.latency || excluded.latency, broker = c.broker || excluded.broker, trader_lots = excluded.trader_lots, updated_at = now();
  get diagnostics n = row_count;
  insert into public.copy_events (at, source_id, kind, stage, detail)
  select coalesce(x.at, now()), x.source_id, left(x.kind, 40), left(x.stage, 40), coalesce(x.detail, '{}')
  from jsonb_to_recordset(coalesce(p_events, '[]')) as x(at timestamptz, source_id uuid, kind text, stage text, detail jsonb)
  where x.kind is not null and x.stage is not null;
  insert into public.copy_feed_parity (symbol, bucket, samples, mean_gap_pips, max_gap_pips, ipfx_behind_ms)
  select x.symbol, x.bucket, x.samples, x.mean_gap_pips, x.max_gap_pips, x.ipfx_behind_ms
  from jsonb_to_recordset(coalesce(p_parity, '[]')) as x(symbol text, bucket timestamptz, samples integer, mean_gap_pips numeric, max_gap_pips numeric, ipfx_behind_ms numeric)
  where x.symbol is not null and x.bucket is not null and x.samples > 0
  on conflict (symbol, bucket) do update set samples = excluded.samples, mean_gap_pips = excluded.mean_gap_pips, max_gap_pips = excluded.max_gap_pips, ipfx_behind_ms = excluded.ipfx_behind_ms;
  return n;
end $$;
revoke all on function public.copy_hub_save(text, jsonb, jsonb, jsonb) from public, authenticated;
grant execute on function public.copy_hub_save(text, jsonb, jsonb, jsonb) to anon;

-- Housekeeping: events kept 30 days, parity 90 days.
select cron.schedule('ipfx-copy-events-purge', '41 3 * * *',
  $$delete from public.copy_events where at < now() - interval '30 days'; delete from public.copy_feed_parity where bucket < now() - interval '90 days';$$);

commit;
