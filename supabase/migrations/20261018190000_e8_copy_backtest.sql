-- E8 copy backtest for the Books page (owner request 2026-10-18). Read-only.
-- Every closed Infinity trade (not practice) since E8 prices exist, run through two SEPARATE $50,000 E8 accounts:
--   A-book: copied in the trader's direction.   B-book: reverse-copied (opposite direction).
-- Execution is modelled on what the live copier actually does on E8:
--   * Size: 0.06 and 0.07 lots alternating (average 0.065). E8 only accepts 0.01 lot steps, so 0.065 is not tradable.
--   * Timing: measured from the six real E8 copies — entries reached E8 1.2-1.7s after the trader opened, exits 4-12s after
--     the trader closed. A copy fills at E8's first observed quote at/after trader time + 2s (entry) or + 5s (exit); buys at
--     the ask, sells at the bid. No E8 quote within 30s of that moment = not priced (listed, never guessed).
--   * Prices, contract sizes and currencies are E8's own (e8_reference_quotes / e8_instrument_evidence from the E8 monitor),
--     not IPFX's. Non-USD P&L converts at E8's own FX quote at exit.
--   * Commission: cost_symbol_model.e8_commission_per_lot; where E8 does not publish one, $5.50 per lot round turn is assumed.
--     Swaps are not modelled (E8 publishes no swap rates); the number of copies held through rollover is reported.
--   * E8 rules on each account: $625 daily loss (equity vs start-of-UTC-day balance) and $3,000 drawdown (equity vs $47,000),
--     checked on equity marked to E8 bid/ask every minute. A breach closes the account: the result shows the P&L at that
--     moment and which later trades could not have been taken.
begin;
create or replace function public.ab_e8_copy_backtest(p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path to '' as $$
declare
  acct bigint;
  open_delay constant interval := interval '2 seconds';
  close_delay constant interval := interval '5 seconds';
  max_wait constant interval := interval '30 seconds';
  start_bal constant numeric := 50000; day_limit constant numeric := 625; dd_limit constant numeric := 3000;
  assumed_comm constant numeric := 5.5; default_lev constant numeric := 30;
  first_quote timestamptz; since timestamptz; upto timestamptz;
  books jsonb := '{}'::jsonb; bk text; v_sum jsonb; v_e8 jsonb; v_daily jsonb; v_traders jsonb; v_symbols jsonb;
  v_n int; mean_n numeric; se numeric; breach_at timestamptz; breach_kind text; eq_at numeric; taken int;
  trades_json jsonb; cal jsonb; cov jsonb; overnight int;
begin
  select account_id into acct from public.e8_monitor_profiles where enabled order by account_id limit 1;
  if acct is null then return jsonb_build_object('available', false, 'reason', 'The E8 price monitor is not running'); end if;
  select min(received_at) into first_quote from public.e8_reference_quotes where account_id = acct;
  if first_quote is null then return jsonb_build_object('available', false, 'reason', 'No E8 prices recorded yet'); end if;
  since := greatest(coalesce(p_from::timestamp at time zone 'UTC', first_quote), first_quote);
  upto := least(coalesce((p_to + 1)::timestamp at time zone 'UTC', now()), now());

  -- 1. Source trades and their E8 entry/exit quotes.
  create temp table if not exists _bt_src (trade_id uuid, email text, symbol text, side text, opened_at timestamptz, closed_at timestamptz,
    trader_pnl numeric, lots numeric, in_at timestamptz, in_bid numeric, in_ask numeric, out_at timestamptz, out_bid numeric, out_ask numeric,
    contract numeric, qccy text, lev numeric, fx numeric, comm numeric, comm_assumed boolean, reason text) on commit drop;
  truncate _bt_src;
  insert into _bt_src (trade_id, email, symbol, side, opened_at, closed_at, trader_pnl)
  select t.id, coalesce(u.email, t.user_id::text), t.symbol, t.side, t.opened_at, t.closed_at, coalesce(t.pnl, 0)
    from public.trades t join public.trading_accounts a on a.id = t.account_id
    left join auth.users u on u.id = t.user_id
   where a.challenge_type = 'infinity' and coalesce(a.phase, '') <> 'demo' and t.status = 'closed'
     and t.opened_at >= since and t.opened_at < upto and t.closed_at is not null and t.closed_at <= now() - close_delay - max_wait;

  update _bt_src s set in_at = x.received_at, in_bid = x.bid, in_ask = x.ask
    from (select s2.trade_id, q.received_at, q.bid, q.ask from _bt_src s2 cross join lateral (
            select r.received_at, r.bid, r.ask from public.e8_reference_quotes r
             where r.account_id = acct and r.symbol = s2.symbol
               and r.received_at >= s2.opened_at + open_delay and r.received_at <= s2.opened_at + open_delay + max_wait
             order by r.received_at limit 1) q) x
   where x.trade_id = s.trade_id;
  update _bt_src s set out_at = x.received_at, out_bid = x.bid, out_ask = x.ask
    from (select s2.trade_id, q.received_at, q.bid, q.ask from _bt_src s2 cross join lateral (
            select r.received_at, r.bid, r.ask from public.e8_reference_quotes r
             where r.account_id = acct and r.symbol = s2.symbol
               and r.received_at >= greatest(s2.closed_at + close_delay, s2.in_at + interval '1 millisecond')
               and r.received_at <= greatest(s2.closed_at + close_delay, s2.in_at) + max_wait
             order by r.received_at limit 1) q where s2.in_at is not null) x
   where x.trade_id = s.trade_id;

  -- 2. E8 contract, currency, leverage and commission; currency conversion at exit.
  update _bt_src s set contract = e.lot_size, qccy = e.quote_currency, lev = nullif(e.details->>'leverage', '')::numeric
    from (select distinct on (symbol) symbol, lot_size, quote_currency, details from public.e8_instrument_evidence
           where account_id = acct and lot_size > 0 order by symbol, observed_at desc) e
   where e.symbol = s.symbol;
  update _bt_src s set contract = coalesce(s.contract, sp.contract_size), qccy = coalesce(s.qccy, sp.quote_currency)
    from public.symbol_specs sp where sp.symbol = s.symbol and (s.contract is null or s.qccy is null);
  update _bt_src s set comm = coalesce(m.c, assumed_comm), comm_assumed = m.c is null
    from (select s2.trade_id, (select nullif(cm.e8_commission_per_lot, 0) from public.cost_symbol_model cm where cm.symbol = s2.symbol) c from _bt_src s2) m
   where m.trade_id = s.trade_id;
  update _bt_src s set fx = case when s.qccy = 'USD' then 1 else (
      select case when s.qccy in ('GBP', 'EUR') then (r.bid + r.ask) / 2 else 2 / (r.bid + r.ask) end
        from public.e8_reference_quotes r
       where r.account_id = acct and r.received_at <= s.out_at
         and r.symbol = case s.qccy when 'JPY' then 'USDJPY' when 'CAD' then 'USDCAD' when 'CHF' then 'USDCHF'
                                    when 'GBP' then 'GBPUSD' when 'EUR' then 'EURUSD' end
       order by r.received_at desc limit 1) end
   where s.out_at is not null;
  update _bt_src set reason = case
      when in_at is null then 'No E8 price within 30s of the trader''s entry'
      when out_at is null then 'No E8 price within 30s of the trader''s exit'
      when contract is null then 'E8 contract size unknown'
      when fx is null then 'No E8 currency conversion price' end;
  -- Real E8 sizes only: 0.06 / 0.07 alternating in the order the copies would have opened.
  update _bt_src s set lots = case when x.k % 2 = 1 then 0.06 else 0.07 end
    from (select trade_id, row_number() over (order by in_at, trade_id) k from _bt_src where reason is null) x
   where x.trade_id = s.trade_id;

  -- 3. One position per trade per book.
  create temp table if not exists _bt_pos (book text, trade_id uuid, email text, symbol text, dir int, lots numeric, contract numeric, fx numeric,
    lev numeric, in_at timestamptz, out_at timestamptz, entry numeric, exit numeric, gross numeric, comm numeric, spread_cost numeric, net numeric,
    margin numeric) on commit drop;
  truncate _bt_pos;
  insert into _bt_pos
  select b.book, s.trade_id, s.email, s.symbol, d.dir, s.lots, s.contract, s.fx, coalesce(s.lev, default_lev), s.in_at, s.out_at,
         case when d.dir = 1 then s.in_ask else s.in_bid end, case when d.dir = 1 then s.out_bid else s.out_ask end,
         null, round(s.comm * s.lots, 4), ((s.in_ask - s.in_bid) + (s.out_ask - s.out_bid)) / 2 * s.contract * s.lots * s.fx, null, null
    from _bt_src s cross join (values ('a'), ('b')) b(book)
    cross join lateral (select case when (s.side = 'buy') = (b.book = 'a') then 1 else -1 end as dir) d
   where s.reason is null;
  update _bt_pos set gross = (exit - entry) * dir * contract * lots * fx,
                     margin = entry * contract * lots * fx / lev;
  update _bt_pos set net = gross - comm;

  -- 4. Minute-by-minute equity at E8 bid/ask (last quote carried forward), for the E8 daily-loss and drawdown rules.
  create temp table if not exists _bt_mk (symbol text, m timestamptz, bid numeric, ask numeric) on commit drop;
  truncate _bt_mk;
  insert into _bt_mk
  select distinct on (r.symbol, date_trunc('minute', r.received_at)) r.symbol, date_trunc('minute', r.received_at) + interval '1 minute', r.bid, r.ask
    from public.e8_reference_quotes r
   where r.account_id = acct and r.received_at >= since - interval '2 minutes' and r.received_at <= (select max(out_at) from _bt_pos)
     and r.symbol in (select distinct symbol from _bt_pos)
   order by r.symbol, date_trunc('minute', r.received_at), r.received_at desc;
  create index if not exists _bt_mk_i on _bt_mk (symbol, m);

  create temp table if not exists _bt_eq (book text, m timestamptz, floating numeric, open_n int, margin numeric) on commit drop;
  truncate _bt_eq;
  insert into _bt_eq
  with f as (
    select p.book, p.trade_id, p.symbol, p.dir, p.entry, p.contract, p.lots, p.fx, p.margin, g.m
      from _bt_pos p cross join lateral generate_series(date_trunc('minute', p.in_at) + interval '1 minute', date_trunc('minute', p.out_at), interval '1 minute') g(m)
  ), j as (
    select f.*, k.bid, k.ask, count(k.bid) over (partition by f.book, f.trade_id order by f.m) as grp
      from f left join _bt_mk k on k.symbol = f.symbol and k.m = f.m
  ), l as (
    select j.*, first_value(j.bid) over (partition by j.book, j.trade_id, j.grp order by j.m) as mb,
                first_value(j.ask) over (partition by j.book, j.trade_id, j.grp order by j.m) as ma
      from j
  )
  select book, m,
         sum(case when mb is null then 0 else ((case when dir = 1 then mb else ma end) - entry) * dir * contract * lots * fx end),
         count(*), sum(margin)
    from l group by book, m;

  create temp table if not exists _bt_tl (book text, m timestamptz, equity numeric, day_start numeric, open_n int, margin numeric) on commit drop;
  truncate _bt_tl;
  insert into _bt_tl
  with ev as (
    select book, date_trunc('minute', out_at) + interval '1 minute' as m, sum(net) as rd, 0::numeric as fl, 0 as cnt, 0::numeric as mg
      from _bt_pos group by 1, 2
    union all
    select book, m, 0, floating, open_n, margin from _bt_eq
  ), agg as (
    select book, m, sum(rd) rd, sum(fl) fl, sum(cnt)::int cnt, sum(mg) mg from ev group by 1, 2
  ), tl as (
    select book, m, fl, cnt, mg, sum(rd) over (partition by book order by m) as realized from agg
  ), days as (
    select distinct book, (m at time zone 'UTC')::date as d from tl
  ), ds as (
    -- E8 daily loss is measured from the balance at the start of the (UTC) day: everything closed before midnight.
    select days.book, days.d, start_bal + coalesce((select sum(p.net) from _bt_pos p
                                                    where p.book = days.book and p.out_at < days.d::timestamp at time zone 'UTC'), 0) as v
      from days
  )
  select tl.book, tl.m, start_bal + tl.realized + tl.fl, ds.v, tl.cnt, tl.mg
    from tl join ds on ds.book = tl.book and ds.d = (tl.m at time zone 'UTC')::date;

  -- 5. Per-book results.
  foreach bk in array array['a', 'b'] loop
    select count(*) into v_n from _bt_pos where book = bk;
    select avg(net) into mean_n from _bt_pos where book = bk;
    se := null;
    if v_n > 1 then
      select sqrt(sum(x * x)) / v_n into se from (select sum(p.net - mean_n) x from _bt_pos p where p.book = bk group by p.email) c;
    end if;
    select min(m), (array_agg(kind order by m))[1] into breach_at, breach_kind from (
      select m, case when equity <= start_bal - dd_limit then 'max_drawdown' else 'daily_loss' end as kind
        from _bt_tl where book = bk and (equity <= day_start - day_limit or equity <= start_bal - dd_limit)) b;
    eq_at := (select equity from _bt_tl where book = bk and m = breach_at);
    taken := (select count(*) from _bt_pos where book = bk and (breach_at is null or in_at < breach_at));

    select jsonb_build_object(
      'trades', count(*), 'traders', count(distinct email),
      'wins', count(*) filter (where net > 0), 'losses', count(*) filter (where net <= 0),
      'win_rate', round(avg((net > 0)::int), 4),
      'net_pnl', round(sum(net), 2), 'gross_pnl', round(sum(gross), 2),
      'gross_profit', round(coalesce(sum(net) filter (where net > 0), 0), 2), 'gross_loss', round(coalesce(sum(net) filter (where net <= 0), 0), 2),
      'profit_factor', case when coalesce(sum(net) filter (where net <= 0), 0) < 0
                            then round(coalesce(sum(net) filter (where net > 0), 0) / -sum(net) filter (where net <= 0), 3) end,
      'avg_win', round(avg(net) filter (where net > 0), 2), 'avg_loss', round(avg(net) filter (where net <= 0), 2),
      'expectancy', round(avg(net), 3), 'ci95_low', round(mean_n - 1.96 * se, 3), 'ci95_high', round(mean_n + 1.96 * se, 3),
      'spread_paid', round(sum(spread_cost), 2), 'commission', round(sum(comm), 2),
      'avg_hold_s', round(avg(extract(epoch from out_at - in_at))), 'lots_avg', round(avg(lots), 4))
      into v_sum from _bt_pos where book = bk;

    select jsonb_build_object(
      'breached', breach_at is not null, 'breach_at', breach_at, 'breach_kind', breach_kind,
      'pnl_at_breach', round(eq_at - start_bal, 2), 'trades_before_breach', taken,
      'trades_blocked_after_breach', v_n - taken,
      'worst_day', (select round(min(equity - day_start), 2) from _bt_tl where book = bk),
      'lowest_equity', (select round(min(equity), 2) from _bt_tl where book = bk),
      'max_drawdown', (select round(max(pk - equity), 2) from (select equity, max(equity) over (order by m) pk from _bt_tl where book = bk) d),
      'max_open', (select max(open_n) from _bt_tl where book = bk),
      'max_margin', (select round(max(margin), 2) from _bt_tl where book = bk))
      into v_e8;

    select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'trades', d.k, 'net', d.net, 'worst_intraday', w.worst) order by d.day), '[]'::jsonb)
      into v_daily
      from (select (out_at at time zone 'UTC')::date as day, count(*) k, round(sum(net), 2) net from _bt_pos where book = bk group by 1) d
      left join (select (m at time zone 'UTC')::date as day, round(min(equity - day_start), 2) worst from _bt_tl where book = bk group by 1) w using (day);

    select coalesce(jsonb_agg(x order by (x->>'net')::numeric desc), '[]'::jsonb) into v_traders from (
      select jsonb_build_object('trader', email, 'trades', count(*), 'net', round(sum(net), 2), 'win_rate', round(avg((net > 0)::int), 3),
               'profit_factor', case when coalesce(sum(net) filter (where net <= 0), 0) < 0
                                     then round(coalesce(sum(net) filter (where net > 0), 0) / -sum(net) filter (where net <= 0), 2) end) x
        from _bt_pos where book = bk group by email) t;

    select coalesce(jsonb_agg(x order by (x->>'trades')::int desc), '[]'::jsonb) into v_symbols from (
      select jsonb_build_object('symbol', symbol, 'trades', count(*), 'net', round(sum(net), 2), 'win_rate', round(avg((net > 0)::int), 3),
               'spread_paid', round(sum(spread_cost), 2)) x
        from _bt_pos where book = bk group by symbol) t;

    books := books || jsonb_build_object(bk, jsonb_build_object('summary', v_sum, 'e8', v_e8, 'daily', v_daily, 'traders', v_traders, 'symbols', v_symbols));
  end loop;

  -- 6. Every trade, priced or not.
  select coalesce(jsonb_agg(jsonb_build_object(
      'opened_at', s.opened_at, 'closed_at', s.closed_at, 'trader', s.email, 'symbol', s.symbol, 'side', s.side, 'lots', s.lots,
      'trader_pnl', round(s.trader_pnl, 2), 'reason', s.reason,
      'a_entry', a.entry, 'a_exit', a.exit, 'a_net', round(a.net, 2),
      'b_entry', b.entry, 'b_exit', b.exit, 'b_net', round(b.net, 2),
      'hold_s', round(extract(epoch from s.out_at - s.in_at)),
      'a_after_breach', ((books->'a'->'e8'->>'breach_at')::timestamptz is not null and s.in_at >= (books->'a'->'e8'->>'breach_at')::timestamptz),
      'b_after_breach', ((books->'b'->'e8'->>'breach_at')::timestamptz is not null and s.in_at >= (books->'b'->'e8'->>'breach_at')::timestamptz)
    ) order by s.opened_at desc), '[]'::jsonb) into trades_json
    from _bt_src s left join _bt_pos a on a.trade_id = s.trade_id and a.book = 'a' left join _bt_pos b on b.trade_id = s.trade_id and b.book = 'b';

  -- 7. Check against the real E8 copies: same model price vs the actual fill.
  select coalesce(jsonb_agg(jsonb_build_object('at', o.created_at, 'symbol', o.symbol, 'event', o.event, 'side', o.side,
            'actual_fill', o.fill_price, 'model_price', q.px, 'difference', round(o.fill_price - q.px, 5)) order by o.created_at), '[]'::jsonb)
    into cal
    from public.book_orders o join public.trades t on t.id = o.source_trade_id
    cross join lateral (
      select case when o.side = 'buy' then r.ask else r.bid end as px from public.e8_reference_quotes r
       where r.account_id = acct and r.symbol = o.symbol
         and r.received_at >= case when o.event = 'open' then t.opened_at + open_delay else t.closed_at + close_delay end
       order by r.received_at limit 1) q
   where o.fill_price is not null and o.event in ('open', 'close') and o.created_at >= first_quote;

  select jsonb_build_object('source_trades', count(*), 'priced', count(*) filter (where reason is null),
           'not_priced', count(*) filter (where reason is not null),
           'reasons', coalesce((select jsonb_object_agg(reason, k) from (select reason, count(*) k from _bt_src where reason is not null group by 1) r), '{}'::jsonb))
    into cov from _bt_src;
  select count(*) into overnight from _bt_pos
   where book = 'a' and date_trunc('day', (in_at at time zone 'UTC') + interval '3 hours') < date_trunc('day', (out_at at time zone 'UTC') + interval '3 hours');

  return jsonb_build_object(
    'available', true, 'from', since, 'to', upto, 'as_of', now(),
    'settings', jsonb_build_object(
      'lots', '0.06 and 0.07 alternating (average 0.065; E8 only accepts 0.01 steps)',
      'entry_delay_s', 2, 'exit_delay_s', 5, 'max_wait_s', 30,
      'account_size', start_bal, 'daily_loss_limit', day_limit, 'max_drawdown_limit', dd_limit, 'day', 'UTC',
      'prices', 'E8 TradeLocker bid/ask recorded by the E8 monitor; buys at the ask, sells at the bid',
      'commission', 'E8 commission per lot where known; $5.50 per lot round turn assumed otherwise',
      'commission_assumed_trades', (select count(*) from _bt_src where reason is null and comm_assumed),
      'swaps', 'Not included: E8 publishes no swap rates', 'overnight_copies', overnight,
      'first_e8_price', first_quote),
    'coverage', cov, 'books', books, 'trades', trades_json, 'real_fill_check', cal);
end $$;
revoke all on function public.ab_e8_copy_backtest(date, date) from public, anon, authenticated;
grant execute on function public.ab_e8_copy_backtest(date, date) to service_role;
commit;
