-- Reverse copy (B-book) runs on paper only (owner decision 2026-10-18). This scorecard is the test that must be
-- passed, fixed in advance, before any B-book trade may go to the E8 funded account. It reads only the replay
-- ledger (Infinity, real recorded bid/ask, latency and costs on both legs) and changes nothing.
--
-- Rule being tested: reverse a trader's next trade while their earlier closed trades total a loss (at least 5).
-- Sizing as it would run on E8: $25 risk per trade, hard stop at 2.5x the trader's stop distance (room multiple),
-- so one trade can lose at most $25. Ledger outcomes are end-of-trade, so trades that touch our stop and come back
-- are counted at their end result: the paper result is an upper bound and the pass bar is set strictly above zero.
--
-- PASS needs all of: >= 300 reversed trades from >= 30 traders; the 95% lower bound of the average result above 0
-- (standard error clustered by trader); worst day better than -$625 (1.25% of $50k); deepest fall under $3,000.
begin;

create or replace function public.ab_b_paper_scorecard(p_from date default date_trunc('month', now() at time zone 'UTC')::date,
                                                       p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path to '' as $$
declare
  risk constant numeric := 25; room constant numeric := 2.5;
  min_trades constant int := 300; min_people constant int := 30;
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
    select count(*) as k, coalesce(sum(p.trader_pnl_usd), 0) as pnl
    from public.ab_trade_ledger p
    where p.person_id = l.person_id and p.closed_at <= l.opened_at
  ) h
  where l.opened_at >= since and l.opened_at < upto and l.closed_at < upto
    and l.replay_basis = 'REPLAY_QUOTES' and l.reverse_r is not null and l.risk_usd > 0
    and h.k >= 5 and h.pnl <= 0;

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
      'day_limit_usd', day_limit, 'drawdown_limit_usd', dd_limit, 'selection', 'reverse while the trader''s earlier closed trades total a loss (5 or more)',
      'basis', 'IPFX replay at recorded bid/ask with latency and costs on both legs; end-of-trade results, so an upper bound'),
    'live_on_e8', false);
end $$;
revoke all on function public.ab_b_paper_scorecard(date, date) from public, anon, authenticated;
grant execute on function public.ab_b_paper_scorecard(date, date) to service_role;
commit;
