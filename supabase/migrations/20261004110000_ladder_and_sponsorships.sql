-- A/B-book Day 5: evaluation ladder (prop-firm accounts IPFX buys and trades on pooled A-book signals) and
-- graduate sponsorships (a funded account bought in a Stage 3 graduate's own name).
-- The controller only RECOMMENDS purchases (buy / hold / stop) on the owner's Treasury screen. It never buys,
-- never pays and never enables an account: execution_enabled is set by the owner per account.

create table if not exists public.ladder_settings (
  singleton boolean primary key default true check (singleton),
  seed_budget_usd numeric not null default 1500 check (seed_budget_usd >= 0),
  reinvest_fraction numeric not null default 0.5 check (reinvest_fraction between 0 and 1),
  default_fee_usd numeric not null default 300 check (default_fee_usd > 0),
  max_active_accounts int not null default 30 check (max_active_accounts between 0 and 500),
  signal_groups int not null default 3 check (signal_groups between 1 and 20),
  gate_min_trades int not null default 200 check (gate_min_trades > 0),
  gate_break_even_r numeric not null default 0.03,
  gate_window_days int not null default 30 check (gate_window_days between 5 and 180)
);
insert into public.ladder_settings (singleton) values (true) on conflict do nothing;

create table if not exists public.ladder_accounts (
  id bigint generated always as identity primary key,
  label text not null,
  size_usd numeric not null check (size_usd > 0),
  fee_usd numeric not null default 0 check (fee_usd >= 0),
  status text not null default 'evaluation' check (status in ('evaluation', 'funded', 'breached', 'closed')),
  signal_group int not null default 0 check (signal_group >= 0),
  platform text not null default 'tradelocker' check (platform in ('tradelocker')),
  environment text not null default 'prop' check (environment in ('demo', 'prop')),
  server text, account_id text, acc_num text,
  access_token_ciphertext text, refresh_token_ciphertext text, access_expires_at timestamptz,
  instrument_map jsonb not null default '[]'::jsonb,
  execution_enabled boolean not null default false,
  purchased_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.ladder_payouts (
  id bigint generated always as identity primary key,
  ladder_account_id bigint references public.ladder_accounts(id) on delete set null,
  amount_usd numeric not null check (amount_usd > 0),
  received_at timestamptz not null default now(),
  note text
);
create table if not exists public.ladder_recommendations (
  id bigint generated always as identity primary key,
  as_of timestamptz not null default now(),
  action text not null check (action in ('buy', 'hold', 'stop')),
  accounts int not null default 0,
  budget_usd numeric not null,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb
);
create table if not exists public.graduate_sponsorships (
  id bigint generated always as identity primary key,
  account_id uuid not null unique references public.trading_accounts(id) on delete cascade,
  user_id uuid not null,
  person_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'purchased', 'declined')),
  fee_usd numeric,
  note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

alter table public.ladder_settings enable row level security;
alter table public.ladder_accounts enable row level security;
alter table public.ladder_payouts enable row level security;
alter table public.ladder_recommendations enable row level security;
alter table public.graduate_sponsorships enable row level security;
revoke all on public.ladder_settings, public.ladder_accounts, public.ladder_payouts, public.ladder_recommendations, public.graduate_sponsorships
  from public, anon, authenticated;
grant select, update on public.ladder_settings to service_role;
grant select, insert, update on public.ladder_accounts, public.ladder_payouts, public.ladder_recommendations, public.graduate_sponsorships to service_role;

-- A graduate is an Infinity account that passed Stage 3 (or a Stage 4 account appearing). Queue a sponsorship.
create or replace function public.fn_queue_graduate_sponsorship() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.challenge_type = 'infinity' and ((new.stage = 3 and new.status = 'passed') or new.stage >= 4) then
    insert into public.graduate_sponsorships (account_id, user_id, person_id)
    values (new.id, new.user_id, public.ab_person_of(new.user_id)) on conflict (account_id) do nothing;
  end if;
  return new;
end $$;
revoke all on function public.fn_queue_graduate_sponsorship() from public, anon, authenticated;
drop trigger if exists trading_accounts_graduate_sponsorship on public.trading_accounts;
create trigger trading_accounts_graduate_sponsorship after insert or update of status, stage on public.trading_accounts
  for each row execute function public.fn_queue_graduate_sponsorship();

-- Book identifiers: 'a' (A-book review destination), 'b' (B-book), 'l<id>' (ladder account <id>).
alter table public.ab_risk_reservations drop constraint if exists ab_risk_reservations_book_check;
alter table public.ab_risk_reservations add constraint ab_risk_reservations_book_check check (book ~ '^(a|b|l[0-9]{1,12})$');
alter table public.book_orders drop constraint if exists book_orders_book_check;
alter table public.book_orders add constraint book_orders_book_check check (book ~ '^(a|b|l[0-9]{1,12})$');

-- Reservation with per-ladder-account limits: the same percentages as the A-book row, applied to each
-- account's own size (0.5% per trade, 2.5% open, 1% per trader, daily stop 2%, daily cap 2%).
create or replace function public.ab_reserve_risk(p_book text, p_trade uuid, p_person uuid, p_symbol text,
  p_signed_lots numeric, p_risk_usd numeric)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare lim public.ab_risk_limits; s public.ab_settings; halted boolean; la public.ladder_accounts;
        per_trade numeric; open_max numeric; trader_max numeric; stop_usd numeric; cap_usd numeric; net_max numeric; room_mult numeric; min_frac numeric;
        open_risk numeric; trader_open numeric; sym_net numeric; day_pnl numeric; day_loss numeric; room numeric; allowed numeric; rid bigint;
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
    room_mult := lim.room_multiple; min_frac := lim.min_fill_fraction;
  else
    select * into lim from public.ab_risk_limits where book = p_book for update;
    if lim is null then return jsonb_build_object('ok', false, 'reason', 'no limits for book'); end if;
    per_trade := lim.per_trade_max_usd; open_max := lim.open_risk_max_usd; trader_max := lim.per_trader_open_max_usd;
    stop_usd := lim.daily_loss_stop_usd; cap_usd := lim.daily_profit_cap_usd; net_max := lim.symbol_net_lots_max;
    room_mult := lim.room_multiple; min_frac := lim.min_fill_fraction;
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

-- A-book routing also applies when at least one ladder account is enabled (even with no review destination).
create or replace function public.ab_route_for_user(p_user uuid)
returns text language sql stable security definer set search_path to '' as $$
  select case when s.book_halt then null
              when p.book_state = 'AB_LIVE' and (exists (select 1 from public.team_book_destinations d where d.book = 'a' and d.status = 'connected')
                   or exists (select 1 from public.ladder_accounts l where l.execution_enabled and l.status in ('evaluation', 'funded'))) then 'a'
              when p.book_state = 'BB_LIVE' and exists (select 1 from public.team_book_destinations d where d.book = 'b' and d.status = 'connected') then 'b'
         end
  from public.ab_trader_profiles p cross join public.ab_settings s
  where p.person_id = public.ab_person_of(p_user)
$$;
revoke all on function public.ab_route_for_user(uuid) from public, anon, authenticated;
grant execute on function public.ab_route_for_user(uuid) to service_role;

-- Pooled evidence for the ladder gate: same-direction replay R of traders currently copied (AB_LIVE) over
-- the window. One row; the controller compares it with the break-even edge.
create or replace function public.ladder_gate_evidence(p_days int)
returns jsonb language sql stable security definer set search_path to '' as $$
  with x as (
    select l.same_r, (l.closed_at at time zone 'utc')::date as d
    from public.ab_trade_ledger l join public.ab_trader_profiles p on p.person_id = l.person_id
    where p.book_state = 'AB_LIVE' and l.replay_basis = 'REPLAY_QUOTES' and l.same_r is not null
      and l.closed_at > now() - make_interval(days => p_days)
  ), days as (select d, sum(same_r) s from x group by d)
  select jsonb_build_object('trades', (select count(*) from x), 'mean_r', (select avg(same_r) from x),
    'days', (select count(*) from days), 'day_mean', (select avg(s) from days), 'day_sd', (select stddev_samp(s) from days))
$$;
revoke all on function public.ladder_gate_evidence(int) from public, anon, authenticated;
grant execute on function public.ladder_gate_evidence(int) to service_role;
