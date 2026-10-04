-- Crowding cap (overnight stress test 2026-10-04): the digital twin showed herds of traders following one
-- signal lose together. Each book or ladder account now takes at most crowd_max copies of the same instrument
-- and direction within 15 minutes (default 3), on top of the per-instrument net-lots cap.
alter table public.ab_risk_limits add column if not exists crowd_max int not null default 3 check (crowd_max between 1 and 50);

create or replace function public.ab_reserve_risk(p_book text, p_trade uuid, p_person uuid, p_symbol text,
  p_signed_lots numeric, p_risk_usd numeric)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare lim public.ab_risk_limits; s public.ab_settings; halted boolean; la public.ladder_accounts;
        per_trade numeric; open_max numeric; trader_max numeric; stop_usd numeric; cap_usd numeric; net_max numeric; room_mult numeric; min_frac numeric;
        open_risk numeric; trader_open numeric; sym_net numeric; day_pnl numeric; day_loss numeric; room numeric; allowed numeric; rid bigint; crowd int; crowd_max int;
begin
  if p_book ~ '^l[0-9]+$' then
    select * into la from public.ladder_accounts where id = substr(p_book, 2)::bigint for update;
    if la is null or not la.execution_enabled or la.status not in ('evaluation', 'funded') then
      return jsonb_build_object('ok', false, 'reason', 'ladder account not enabled');
    end if;
    select * into lim from public.ab_risk_limits where book = 'a';
    per_trade := la.size_usd * coalesce(lim.per_trade_max_pct, 0.5) / 100; open_max := la.size_usd * 0.025;
    trader_max := la.size_usd * 0.01; stop_usd := la.size_usd * 0.02; cap_usd := la.size_usd * 0.02;
    net_max := lim.symbol_net_lots_max * la.size_usd / coalesce(lim.account_size_usd, 50000);
    room_mult := lim.room_multiple; min_frac := lim.min_fill_fraction; crowd_max := lim.crowd_max;
  else
    select * into lim from public.ab_risk_limits where book = p_book for update;
    if lim is null then return jsonb_build_object('ok', false, 'reason', 'no limits for book'); end if;
    per_trade := lim.per_trade_max_usd; open_max := lim.open_risk_max_usd; trader_max := lim.per_trader_open_max_usd;
    stop_usd := lim.daily_loss_stop_usd; cap_usd := lim.daily_profit_cap_usd; net_max := lim.symbol_net_lots_max;
    room_mult := lim.room_multiple; min_frac := lim.min_fill_fraction; crowd_max := lim.crowd_max;
  end if;
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
  select coalesce(sum(pnl_usd), 0) into day_pnl from public.book_daily_pnl where book = p_book and day = (now() at time zone 'utc')::date;
  day_loss := greatest(-day_pnl, 0);
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
  room := least(per_trade, open_max - open_risk, trader_max - trader_open, (stop_usd - day_loss - open_risk) / room_mult);
  allowed := least(p_risk_usd, room);
  if allowed < p_risk_usd * min_frac or allowed <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'risk room exhausted', 'room', greatest(room, 0));
  end if;
  insert into public.ab_risk_reservations (book, source_trade_id, person_id, symbol, signed_lots, risk_usd)
  values (p_book, p_trade, p_person, p_symbol, p_signed_lots * (allowed / p_risk_usd), allowed) returning id into rid;
  return jsonb_build_object('ok', true, 'reservation_id', rid, 'allowed_usd', round(allowed, 2), 'fraction', allowed / p_risk_usd);
end $$;
revoke all on function public.ab_reserve_risk(text, uuid, uuid, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.ab_reserve_risk(text, uuid, uuid, text, numeric, numeric) to service_role;
