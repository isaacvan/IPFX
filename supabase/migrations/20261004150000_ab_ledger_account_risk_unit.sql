-- Evidence for trades without a stop loss (overnight review 2026-10-04). 24 of the last 31 closed trades
-- had no stop loss, so the ledger could not express them in R and the classifier saw no evidence at all.
-- Such trades now use the account's own max-risk-per-trade limit as the R unit (risk_basis records which).
-- Copies still require a real stop loss: the book executor skips trades without one.
alter table public.ab_trade_ledger add column if not exists risk_basis text
  check (risk_basis in ('STOP_LOSS', 'ACCOUNT_RISK_LIMIT'));
update public.ab_trade_ledger set risk_basis = 'STOP_LOSS' where risk_usd is not null and risk_basis is null;

create or replace function public.ab_build_ledger(p_latency_ms int default 500)
returns int language plpgsql security definer set search_path to '' as $$
declare n int;
begin
  with closed as (
    select t.*, a.challenge_type, a.stage,
           -- R unit when the trader set no stop loss: the account's own max risk per trade (default 1%)
           coalesce(nullif(a.max_risk_per_trade_pct, 0), 1) / 100.0 * nullif(a.starting_balance, 0) as acct_risk,
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
      case when s.sl is not null and s.k is not null and abs(s.open_price - s.sl) > 0 then abs(s.open_price - s.sl) * s.k end as sl_risk
    from scaled s
  ), risked as (
    select pr.*, coalesce(pr.sl_risk, pr.acct_risk) as risk,
           case when pr.sl_risk is not null then 'STOP_LOSS' when pr.acct_risk is not null then 'ACCOUNT_RISK_LIMIT' end as risk_basis
    from priced pr
  )
  insert into public.ab_trade_ledger (trade_id, person_id, user_id, account_id, challenge_type, stage, symbol, side, volume,
    opened_at, closed_at, hold_seconds, open_price, close_price, stop_loss, trader_pnl_usd, trader_gross_usd, usd_per_price_unit,
    risk_usd, risk_basis, trader_r, latency_ms, broker_cost_usd, replay_basis, same_open_px, same_close_px, rev_open_px, rev_close_px,
    same_usd, reverse_usd, same_r, reverse_r)
  select p.id, public.ab_person_of(p.user_id), p.user_id, p.account_id, p.challenge_type, p.stage, p.symbol, p.side, p.volume,
    p.opened_at, p.closed_at, extract(epoch from (p.closed_at - p.opened_at)), p.open_price, p.close_price, p.sl,
    coalesce(p.pnl, 0), p.gross, p.k, p.risk, p.risk_basis, case when p.risk > 0 then coalesce(p.pnl, 0) / p.risk end,
    p_latency_ms, round(p.bcost, 2),
    case when p.k is null then 'NO_PRICE_SCALE' when p.so is null or p.sc is null then 'NO_QUOTES' else 'REPLAY_QUOTES' end,
    p.so, p.sc, p.ro, p.rc,
    case when p.k is not null and p.so is not null and p.sc is not null then round(((p.sc - p.so) * p.dir * p.k - p.bcost)::numeric, 2) end,
    case when p.k is not null and p.ro is not null and p.rc is not null then round(((p.ro - p.rc) * p.dir * p.k - p.bcost)::numeric, 2) end,
    case when p.risk > 0 and p.so is not null and p.sc is not null then ((p.sc - p.so) * p.dir * p.k - p.bcost) / p.risk end,
    case when p.risk > 0 and p.ro is not null and p.rc is not null then ((p.ro - p.rc) * p.dir * p.k - p.bcost) / p.risk end
  from risked p
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

-- Backfill: existing rows without a stop loss get the account-limit R unit (their replays stay as they were).
update public.ab_trade_ledger l set
  risk_usd = r.u, risk_basis = 'ACCOUNT_RISK_LIMIT', trader_r = l.trader_pnl_usd / r.u,
  same_r = case when l.same_usd is not null then l.same_usd / r.u end,
  reverse_r = case when l.reverse_usd is not null then l.reverse_usd / r.u end
from (select a.id, coalesce(nullif(a.max_risk_per_trade_pct, 0), 1) / 100.0 * nullif(a.starting_balance, 0) as u
        from public.trading_accounts a) r
where r.id = l.account_id and l.risk_usd is null and r.u > 0;
