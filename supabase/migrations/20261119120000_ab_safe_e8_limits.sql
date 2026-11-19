-- Safe E8 limits for copying (owner approved 2026-11-19). The E8 $50k account allows 1.25% ($625) daily loss and
-- $3,000 maximum drawdown; the old copy limits ($1,000 daily stop, $1,250 open risk) could break both within days.
--  1. Both books: $400 daily stop, $200 open risk, $25 a trade, $25 open per trader (one trade), at most 2 copies of the
--     same instrument and direction in 15 minutes, sizing 0.02%-0.05% of the account.
--  2. Books A and B share one total for open risk and today's loss.
--  3. Drawdown ladder: half size from -$1,500, a quarter from -$2,000, no new copies from -$2,500.
--  4. E8 ladder accounts use the same limits scaled to their size (before: fixed 2.5% open risk and 2% daily loss),
--     unless the owner has set that account's own daily loss.
-- Nothing is copying when this is applied (no live destination, no active reservations).
do $guard$ begin
  if md5(pg_get_functiondef('public.ab_reserve_risk(text,uuid,uuid,text,numeric,numeric)'::regprocedure)) <> 'b9e269dc4bfaf2636ced43e76ef9af1a' then
    raise exception 'ab_reserve_risk changed since review; merge the live definition before applying';
  end if;
end $guard$;

alter table public.ab_risk_limits
  add column if not exists dd_halve_usd numeric check (dd_halve_usd is null or dd_halve_usd > 0),
  add column if not exists dd_quarter_usd numeric check (dd_quarter_usd is null or dd_quarter_usd > 0),
  add column if not exists dd_stop_usd numeric check (dd_stop_usd is null or dd_stop_usd > 0);

update public.ab_risk_limits set
  daily_loss_stop_usd = 400, open_risk_max_usd = 200, per_trade_max_usd = 25, per_trader_open_max_usd = 25,
  crowd_max = 2, per_trade_max_pct = 0.05, per_trade_min_pct = 0.02,
  dd_halve_usd = 1500, dd_quarter_usd = 2000, dd_stop_usd = 2500
where book in ('a', 'b');

CREATE OR REPLACE FUNCTION public.ab_reserve_risk(p_book text, p_trade uuid, p_person uuid, p_symbol text, p_signed_lots numeric, p_risk_usd numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare lim public.ab_risk_limits; s public.ab_settings; halted boolean; la public.ladder_accounts;
        per_trade numeric; open_max numeric; trader_max numeric; stop_usd numeric; cap_usd numeric; net_max numeric; room_mult numeric; min_frac numeric;
        open_risk numeric; trader_open numeric; sym_net numeric; day_pnl numeric; day_loss numeric; room numeric; allowed numeric; rid bigint; crowd int; crowd_max int;
        ratio numeric := 1; books text[]; peak numeric; cur numeric; dd numeric; dd_factor numeric := 1;
begin
  if p_book ~ '^l[0-9]+$' then
    select * into la from public.ladder_accounts where id = substr(p_book, 2)::bigint for update;
    if la is null or (not la.execution_enabled and not public.ongoing_copy_access(p_book,p_trade,false)) or la.status not in ('evaluation', 'funded') then
      return jsonb_build_object('ok', false, 'reason', 'ladder account not enabled');
    end if;
    select * into lim from public.ab_risk_limits where book = 'a';
    per_trade := la.size_usd * coalesce(lim.per_trade_max_pct, 0.5) / 100; open_max := la.size_usd * 0.025;
    trader_max := la.size_usd * 0.01; stop_usd := coalesce(public.ongoing_copy_owner_daily_loss(la.id), la.size_usd * 0.02); cap_usd := la.size_usd * 0.02;
    -- Safe E8 limits (2026-11-19): unless the owner has set this account's own daily loss, the book A limits apply,
    -- scaled to the account size, and the tighter of the two wins.
    ratio := la.size_usd / coalesce(nullif(lim.account_size_usd, 0), 50000);
    if public.ongoing_copy_owner_daily_loss(la.id) is null then
      per_trade := least(per_trade, coalesce(lim.per_trade_max_usd * ratio, per_trade));
      open_max := least(open_max, coalesce(lim.open_risk_max_usd * ratio, open_max));
      trader_max := least(trader_max, coalesce(lim.per_trader_open_max_usd * ratio, trader_max));
      stop_usd := least(stop_usd, coalesce(lim.daily_loss_stop_usd * ratio, stop_usd));
    end if;
    books := array[p_book];
    net_max := lim.symbol_net_lots_max * la.size_usd / coalesce(lim.account_size_usd, 50000);
    room_mult := lim.room_multiple; min_frac := lim.min_fill_fraction; crowd_max := lim.crowd_max;
  else
    select * into lim from public.ab_risk_limits where book = p_book for update;
    if lim is null then return jsonb_build_object('ok', false, 'reason', 'no limits for book'); end if;
    per_trade := lim.per_trade_max_usd; open_max := lim.open_risk_max_usd; trader_max := lim.per_trader_open_max_usd;
    stop_usd := lim.daily_loss_stop_usd; cap_usd := lim.daily_profit_cap_usd; net_max := lim.symbol_net_lots_max;
    room_mult := lim.room_multiple; min_frac := lim.min_fill_fraction; crowd_max := lim.crowd_max;
    -- Books A and B share one total: their open risk and today's loss count together (2026-11-19).
    books := case when p_book in ('a', 'b') then array['a', 'b'] else array[p_book] end;
  end if;
  select * into s from public.ab_settings where singleton;
  select trading_halted into halted from public.platform_config limit 1;
  if s is null or s.book_halt is null or halted is null then
    return jsonb_build_object('ok', false, 'reason', 'risk halt configuration unavailable');
  end if;
  if s.book_halt or halted then return jsonb_build_object('ok', false, 'reason', 'halted'); end if;
  if p_risk_usd is null or p_risk_usd <= 0 then return jsonb_build_object('ok', false, 'reason', 'no measurable risk (stop loss required)'); end if;
  if exists (select 1 from public.ab_risk_reservations where book = p_book and source_trade_id = p_trade) then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end if;
  update public.ab_risk_reservations set status = 'expired', released_at = now()
   where book = p_book and status = 'active' and created_at < now() - interval '2 minutes'
     and not exists (select 1 from public.book_orders o where o.source_trade_id = ab_risk_reservations.source_trade_id
                     and o.book = p_book and o.event = 'open' and o.status in ('sent', 'filled', 'reconciliation_required'));
  select coalesce(sum(risk_usd), 0) into open_risk from public.ab_risk_reservations where book = any(books) and status = 'active';
  select coalesce(sum(risk_usd), 0) into trader_open from public.ab_risk_reservations where book = p_book and status = 'active' and person_id = p_person;
  select coalesce(sum(signed_lots), 0) into sym_net from public.ab_risk_reservations where book = p_book and status = 'active' and symbol = p_symbol;
  select coalesce(sum(pnl_usd), 0) into day_pnl from public.book_daily_pnl where book = any(books) and day = (now() at time zone 'utc')::date;
  day_loss := greatest(-day_pnl, 0);
  if la.id is not null then day_loss := greatest(day_loss, coalesce((select -g.today_net from public.ab_equity_guard g where g.account_id = la.id and g.read_at > now() - interval '2 minutes' and g.today_net < 0), 0)); end if;
  if day_loss >= stop_usd then return jsonb_build_object('ok', false, 'reason', 'daily loss stop reached'); end if;
  if cap_usd is not null and day_pnl >= cap_usd then return jsonb_build_object('ok', false, 'reason', 'daily profit cap reached: extra profit would be removed'); end if;
  -- Crowding: many traders taking the same instrument and direction at once (a signal service, one news
  -- release) are one bet, not many. At most crowd_max such copies per book within 15 minutes.
  select count(*) into crowd from public.ab_risk_reservations
   where book = p_book and status = 'active' and symbol = p_symbol and sign(signed_lots) = sign(p_signed_lots)
     and created_at > now() - interval '15 minutes';
  if crowd_max is not null and crowd >= crowd_max then return jsonb_build_object('ok', false, 'reason', 'crowded: same instrument and direction already copied'); end if;
  if abs(sym_net + p_signed_lots) > net_max and abs(sym_net + p_signed_lots) > abs(sym_net) then
    return jsonb_build_object('ok', false, 'reason', 'symbol net exposure cap');
  end if;
  -- Drawdown ladder (2026-11-19): from the books' best cumulative result, half size past dd_halve_usd, a quarter past
  -- dd_quarter_usd, and no new copies past dd_stop_usd (all scaled to the account size; null = off).
  if lim.dd_stop_usd is not null then
    with d as (select day, sum(pnl_usd) p from public.book_daily_pnl where book = any(books) group by day),
         c as (select day, sum(p) over (order by day) cum from d)
    select greatest(coalesce(max(cum), 0), 0), coalesce((select cum from c order by day desc limit 1), 0) into peak, cur from c;
    dd := peak - cur;
    if dd >= lim.dd_stop_usd * ratio then return jsonb_build_object('ok', false, 'reason', 'drawdown stop reached', 'drawdown', round(dd, 2)); end if;
    if lim.dd_quarter_usd is not null and dd >= lim.dd_quarter_usd * ratio then dd_factor := 0.25;
    elsif lim.dd_halve_usd is not null and dd >= lim.dd_halve_usd * ratio then dd_factor := 0.5; end if;
  end if;
  room := dd_factor * least(per_trade, open_max - open_risk, trader_max - trader_open, (stop_usd - day_loss - open_risk) / case when la.id is not null and public.ongoing_copy_owner_daily_loss(la.id) is not null then 1 else room_mult end);
  allowed := least(p_risk_usd, room);
  if allowed < p_risk_usd * min_frac or allowed <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'risk room exhausted', 'room', greatest(room, 0));
  end if;
  insert into public.ab_risk_reservations (book, source_trade_id, person_id, symbol, signed_lots, risk_usd)
  values (p_book, p_trade, p_person, p_symbol, p_signed_lots * (allowed / p_risk_usd), allowed) returning id into rid;
  return jsonb_build_object('ok', true, 'reservation_id', rid, 'allowed_usd', round(allowed, 2), 'fraction', allowed / p_risk_usd);
end $function$;
