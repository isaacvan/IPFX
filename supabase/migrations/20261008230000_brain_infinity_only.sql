-- The Brain studies Infinity challenge trades only (owner request 2026-10-08: "i only care about trades placed on the
-- infinity challenge"). Demo practice accounts and the Traditional / Futures programmes no longer feed the ledger, the
-- classifier, the metrics, the hedge-ring scan or the A/B routing.
--
-- Nothing is lost: rows that leave the Brain are first copied to ab_scope_archive (owner only, service role). The ledger
-- rebuilds itself from the trades table, so widening the scope later is one function change.
create table if not exists public.ab_scope_archive (
  id bigint generated always as identity primary key,
  kind text not null,
  payload jsonb not null,
  archived_at timestamptz not null default now()
);
alter table public.ab_scope_archive enable row level security;
revoke all on public.ab_scope_archive from public, anon, authenticated;
grant select, insert on public.ab_scope_archive to service_role;

-- 1. The ledger builder: Infinity accounts that are not demo accounts.
CREATE OR REPLACE FUNCTION public.ab_build_ledger(p_latency_ms integer DEFAULT 500)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     where a.challenge_type = 'infinity' and a.status <> 'demo' and coalesce(a.phase, '') <> 'demo'
       and t.status = 'closed' and t.closed_at is not null and t.close_price is not null and t.open_price is not null
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
end $function$;

-- 2. Hedge-ring scan: Infinity accounts only.
create or replace function public.ab_hedge_pairs(p_days int default 30, p_window_s int default 60, p_min_shared int default 4)
returns table (account_a uuid, account_b uuid, person_a uuid, person_b uuid, shared bigint, share numeric, net_ratio numeric)
language sql stable security definer set search_path to '' as $$
  with t as (
    select tr.id, tr.account_id, tr.symbol, tr.side, tr.opened_at, tr.volume, tr.pnl, tr.status
    from public.trades tr join public.trading_accounts ta on ta.id = tr.account_id
    where tr.opened_at > now() - make_interval(days => p_days) and ta.challenge_type = 'infinity' and ta.status <> 'demo' and coalesce(ta.phase, '') <> 'demo'
  ), n as (select account_id, count(*) as n from t group by account_id),
  m as (
    select a.account_id as aa, b.account_id as ab, a.id as ida, a.pnl as pa, b.pnl as pb, a.status as sa, b.status as sb
    from t a join t b
      on b.symbol = a.symbol and b.side <> a.side and a.account_id < b.account_id
     and b.opened_at between a.opened_at - make_interval(secs => p_window_s) and a.opened_at + make_interval(secs => p_window_s)
     and least(a.volume, b.volume) >= 0.7 * greatest(a.volume, b.volume)
  ), agg as (
    select aa, ab, count(distinct ida) as shared,
           sum(abs(coalesce(pa, 0)) + abs(coalesce(pb, 0))) filter (where sa = 'closed' and sb = 'closed') as gross,
           sum(coalesce(pa, 0) + coalesce(pb, 0)) filter (where sa = 'closed' and sb = 'closed') as net
    from m group by aa, ab
  )
  select g.aa, g.ab, public.ab_person_of(xa.user_id), public.ab_person_of(xb.user_id), g.shared,
         round(g.shared::numeric / least(na.n, nb.n), 3),
         case when g.gross > 0 then round(abs(g.net) / g.gross, 3) end
  from agg g
  join n na on na.account_id = g.aa join n nb on nb.account_id = g.ab
  join public.trading_accounts xa on xa.id = g.aa join public.trading_accounts xb on xb.id = g.ab
  where g.shared >= p_min_shared and g.shared >= 0.3 * least(na.n, nb.n)
    and (g.gross is null or g.gross = 0 or abs(g.net) / g.gross <= 0.35);
$$;
revoke all on function public.ab_hedge_pairs(int, int, int) from public, anon, authenticated;
grant execute on function public.ab_hedge_pairs(int, int, int) to service_role;

-- 3. Move everything outside the new scope out of the Brain (copy first, then delete).
insert into public.ab_scope_archive (kind, payload)
select 'ledger', to_jsonb(l) from public.ab_trade_ledger l where l.challenge_type is distinct from 'infinity'
   or exists (select 1 from public.trading_accounts a where a.id = l.account_id and (a.status = 'demo' or coalesce(a.phase, '') = 'demo'));
delete from public.ab_trade_ledger l where l.challenge_type is distinct from 'infinity'
   or exists (select 1 from public.trading_accounts a where a.id = l.account_id and (a.status = 'demo' or coalesce(a.phase, '') = 'demo'));

-- People with no Infinity trade left (and no owner-set state) leave the profile and metrics tables; the classifier
-- recreates a profile the day they place an Infinity trade.
insert into public.ab_scope_archive (kind, payload)
select 'profile', to_jsonb(p) from public.ab_trader_profiles p
 where p.manual_book_state is null and not exists (select 1 from public.ab_trade_ledger l where l.person_id = p.person_id);
insert into public.ab_scope_archive (kind, payload)
select 'metrics', to_jsonb(m) from public.ab_trader_metrics m
 where not exists (select 1 from public.ab_trade_ledger l where l.person_id = m.person_id)
   and not exists (select 1 from public.ab_trader_profiles p where p.person_id = m.person_id and p.manual_book_state is not null);
delete from public.ab_trader_metrics m
 where not exists (select 1 from public.ab_trade_ledger l where l.person_id = m.person_id)
   and not exists (select 1 from public.ab_trader_profiles p where p.person_id = m.person_id and p.manual_book_state is not null);
delete from public.ab_trader_profiles p
 where p.manual_book_state is null and not exists (select 1 from public.ab_trade_ledger l where l.person_id = p.person_id);
