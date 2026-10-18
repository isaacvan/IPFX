-- Reverse paper test: reverse only traders who are reliably wrong about direction by more than costs (owner decision
-- 2026-10-18). October data: 75% of traders are unprofitable, but almost all of them lose to the spread, not to wrong
-- calls, so reversing them just pays the spread again. Gross direction per trade = (same_r - reverse_r) / 2: the copy
-- result with both legs' costs taken out. A trader qualifies for their next trade when, over at least 15 earlier closed
-- trades (results capped at +-5R), the one-sided 95% upper bound of that average is below -0.2R (about one leg of costs).
-- Everything else (sizing, $25 risk, 2.5x stop, E8 limits, 95% lower bound > 0) is unchanged; min traders is 10
-- because this group is small by design. Read-only.
begin;
create or replace function public.ab_b_paper_scorecard(p_from date default date_trunc('month', now() at time zone 'UTC')::date,
                                                       p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path to '' as $$
declare
  risk constant numeric := 25; room constant numeric := 2.5;
  min_trades constant int := 300; min_people constant int := 10;
  min_history constant int := 15; gross_bar constant numeric := -0.2; cap constant numeric := 5;
  day_limit constant numeric := 625; dd_limit constant numeric := 3000;
  upto timestamptz := coalesce(p_to + 1, (now() at time zone 'UTC')::date + 1)::timestamp at time zone 'UTC';
  since timestamptz := p_from::timestamp at time zone 'UTC';
  n int; people int; mean_u numeric; se numeric; lo numeric; hi numeric; total numeric; worst_day numeric; max_dd numeric;
  days int; win numeric; verdict text; why text; series jsonb;
begin
  create temp table if not exists _bp (trade_id uuid, person_id uuid, day date, closed_at timestamptz, u numeric) on commit drop;
  truncate _bp;
  insert into _bp
  select l.trade_id, l.person_id, (l.closed_at at time zone 'UTC')::date, l.closed_at, greatest(-1, l.reverse_r / room)
  from public.ab_trade_ledger l
  cross join lateral (
    select count(*) as k, avg(g) as m, coalesce(stddev_pop(g), 0) as sd
    from (select greatest(-cap, least(cap, (p.same_r - p.reverse_r) / 2)) as g
            from public.ab_trade_ledger p
           where p.person_id = l.person_id and p.closed_at <= l.opened_at
             and p.replay_basis = 'REPLAY_QUOTES' and p.same_r is not null and p.reverse_r is not null) x
  ) h
  where l.opened_at >= since and l.opened_at < upto and l.closed_at < upto
    and l.replay_basis = 'REPLAY_QUOTES' and l.reverse_r is not null and l.risk_usd > 0
    and h.k >= min_history and h.m + 1.645 * h.sd / sqrt(h.k) < gross_bar;

  select count(*), count(distinct person_id), avg(u), sum(u) * risk, avg((u > 0)::int)
    into n, people, mean_u, total, win from _bp;
  if n > 1 then
    select sqrt(sum(s * s)) / n into se
    from (select sum(b.u - mean_u) as s from _bp b group by b.person_id) c;
    lo := mean_u - 1.96 * se; hi := mean_u + 1.96 * se;
  end if;

  with d as (select day, sum(u) * risk as pnl from _bp group by day),
       c as (select day, pnl, sum(pnl) over (order by day) as eq from d),
       p as (select day, pnl, eq, greatest(0, max(eq) over (order by day)) as peak from c)
  select min(pnl), max(peak - eq), count(*),
         coalesce(jsonb_agg(jsonb_build_object('day', day, 'pnl', round(pnl, 2), 'equity', round(eq, 2)) order by day), '[]'::jsonb)
    into worst_day, max_dd, days, series from p;

  if n < min_trades or people < min_people then
    verdict := 'NOT_ENOUGH_DATA'; why := format('%s of %s trades and %s of %s traders so far', n, min_trades, people, min_people);
  elsif coalesce(worst_day, 0) <= -day_limit or coalesce(max_dd, 0) >= dd_limit then
    verdict := 'FAIL'; why := 'At $25 a trade it would have broken an E8 limit';
  elsif lo > 0 then
    verdict := 'PASS'; why := 'Positive after costs with 95% confidence and inside the E8 limits';
  elsif hi < 0 then
    verdict := 'FAIL'; why := 'Loses money after costs with 95% confidence';
  else
    verdict := 'NO_EDGE_YET'; why := 'Not proven positive: the 95% range still includes zero';
  end if;

  return jsonb_build_object(
    'from', p_from, 'to', (upto - interval '1 day')::date, 'verdict', verdict, 'why', why,
    'trades', n, 'traders', people, 'days', days, 'win_rate', round(win, 3),
    'mean_r', round(mean_u, 4), 'low95_r', round(lo, 4), 'high95_r', round(hi, 4),
    'pnl_usd', round(total, 2), 'worst_day_usd', round(worst_day, 2), 'max_drawdown_usd', round(max_dd, 2), 'daily', series,
    'rules', jsonb_build_object('risk_per_trade_usd', risk, 'stop_multiple', room, 'min_trades', min_trades, 'min_traders', min_people,
      'day_limit_usd', day_limit, 'drawdown_limit_usd', dd_limit, 'selection', 'reverse only traders whose buy/sell calls are reliably wrong by more than costs (15+ earlier trades, 95% upper bound below -0.2R)',
      'basis', 'IPFX replay at recorded bid/ask with latency and costs on both legs; end-of-trade results, so an upper bound'),
    'live_on_e8', false);
end $$;
revoke all on function public.ab_b_paper_scorecard(date, date) from public, anon, authenticated;
grant execute on function public.ab_b_paper_scorecard(date, date) to service_role;
commit;
