-- Funded-account sizing (owner decision 2026-10-03): copy size comes from the destination account's limits,
-- not the trader's account. Simulation of a $50K E8-style funded account (daily loss 2.5%, daily profit cap
-- 2%, payout 80% x 50%) found the profit-maximising line at about 0.25% risk per copied trade, i.e. about a
-- 2.5% daily risk budget shared across all signals. More risk earns less (the daily cap deletes profit and
-- the account passes more slowly); less risk misses the target.

alter table public.ab_risk_limits add column if not exists account_size_usd numeric check (account_size_usd > 0);
alter table public.ab_risk_limits add column if not exists daily_risk_budget_pct numeric check (daily_risk_budget_pct > 0 and daily_risk_budget_pct <= 5);
alter table public.ab_risk_limits add column if not exists per_trade_min_pct numeric check (per_trade_min_pct > 0);
alter table public.ab_risk_limits add column if not exists per_trade_max_pct numeric check (per_trade_max_pct > 0 and per_trade_max_pct <= 1);
alter table public.ab_risk_limits add column if not exists daily_profit_cap_usd numeric check (daily_profit_cap_usd > 0);
alter table public.ab_risk_limits add column if not exists room_multiple numeric not null default 2.5 check (room_multiple >= 1);

-- $50K account. The daily loss stop sits at 80% of the account's 2.5% daily limit so slippage cannot breach it.
update public.ab_risk_limits set account_size_usd = 50000, daily_risk_budget_pct = 2.5, per_trade_min_pct = 0.10,
  per_trade_max_pct = 0.50, per_trade_max_usd = 250, open_risk_max_usd = 1250, per_trader_open_max_usd = 500,
  daily_loss_stop_usd = 1000, daily_profit_cap_usd = 1000, room_multiple = 2.5
where book in ('a', 'b');

-- Reservation now also refuses new risk once the day's closed book profit has reached the account's daily
-- profit cap (extra profit would be deleted at rollover), and keeps room_multiple x risk inside the daily stop.
create or replace function public.ab_reserve_risk(p_book text, p_trade uuid, p_person uuid, p_symbol text,
  p_signed_lots numeric, p_risk_usd numeric)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare lim public.ab_risk_limits; s public.ab_settings; halted boolean;
        open_risk numeric; trader_open numeric; sym_net numeric; day_pnl numeric; day_loss numeric; room numeric; allowed numeric; rid bigint;
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
  select coalesce(sum(pnl_usd), 0) into day_pnl from public.book_daily_pnl where book = p_book and day = (now() at time zone 'utc')::date;
  day_loss := greatest(-day_pnl, 0);
  if day_loss >= lim.daily_loss_stop_usd then return jsonb_build_object('ok', false, 'reason', 'daily loss stop reached'); end if;
  if lim.daily_profit_cap_usd is not null and day_pnl >= lim.daily_profit_cap_usd then
    return jsonb_build_object('ok', false, 'reason', 'daily profit cap reached: extra profit would be removed');
  end if;
  if abs(sym_net + p_signed_lots) > lim.symbol_net_lots_max and abs(sym_net + p_signed_lots) > abs(sym_net) then
    return jsonb_build_object('ok', false, 'reason', 'symbol net exposure cap');
  end if;
  room := least(lim.per_trade_max_usd, lim.open_risk_max_usd - open_risk, lim.per_trader_open_max_usd - trader_open,
                (lim.daily_loss_stop_usd - day_loss - open_risk) / lim.room_multiple);
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

-- How far a person has progressed in Infinity (drives the confidence weight).
create or replace function public.ab_person_progress(p_person uuid)
returns text language sql stable security definer set search_path to '' as $$
  select case
    when bool_or(a.challenge_type = 'infinity' and (a.stage >= 4 or (a.stage = 3 and a.status = 'passed'))) then 'STAGE3_COMPLETE'
    when bool_or(a.challenge_type = 'infinity' and (a.stage >= 3 or (a.stage = 2 and a.status = 'passed'))) then 'STAGE2_PASSED'
    else 'EARLY' end
  from public.trading_accounts a where public.ab_person_of(a.user_id) = p_person
$$;
revoke all on function public.ab_person_progress(uuid) from public, anon, authenticated;
grant execute on function public.ab_person_progress(uuid) to service_role;

-- Policy v2: the board's 2.75% Stage 2 rule promotes straight to A-book live (owner decision 2026-10-03).
-- Size then starts at the smallest confidence weight; everything else as v1.
update public.ab_policy_versions set status = 'RETIRED' where version = 1 and status = 'ACTIVE';
insert into public.ab_policy_versions (version, status, thresholds, note) values (2, 'ACTIVE',
  '{"minDays":20,"minTrades":40,"minEdgeR":0.02,"zLower":1.645,"eValuePromote":10,"eValueLive":10,"maxBestTradeShare":0.3,
    "minMedianHoldSeconds":60,"maxShareUnder60s":0.5,"dwellDays":5,"coolOffDays":10,"liveFlipMinTrades":10,"abFailTrades":80,
    "ewmaAlpha":0.1,"abDemoteEwma":-0.05,"stage2AutoPct":2.75,"stage2AutoTarget":"AB_LIVE"}',
  'Owner decision 2026-10-03: 2.75% in Infinity Stage 2 starts A-book live copying at the smallest confidence weight.')
on conflict (version) do nothing;
