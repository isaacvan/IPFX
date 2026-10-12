-- A daily profit cap pauses new exposure; it never rewrites P&L or fails a run.
-- Remember the first observed hit until the next UTC day, even if an existing
-- position subsequently loses profit. Existing closes and protective exits work.
begin;
create table public.infinity_daily_entry_pauses (
  account_id uuid not null references public.trading_accounts(id),
  utc_day date not null,
  hit_at timestamptz not null default now(),
  observed_gain numeric not null,
  cap_usd numeric not null,
  primary key(account_id, utc_day)
);
alter table public.infinity_daily_entry_pauses enable row level security;
revoke all on public.infinity_daily_entry_pauses from public, anon, authenticated;
grant select, insert on public.infinity_daily_entry_pauses to service_role;

create function public.fn_infinity_daily_entry_limit(p_account uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts; eq numeric; gain numeric; cap numeric;
  today date := (clock_timestamp() at time zone 'UTC')::date;
  blocked boolean;
begin
  select * into a from public.trading_accounts where id=p_account for update;
  if not found then return jsonb_build_object('checked',false); end if;
  if a.challenge_type is distinct from 'infinity' or a.phase='demo'
    or coalesce(a.venue,'ipfx')<>'ipfx' or a.daily_profit_cap_pct is null then
    return jsonb_build_object('checked',true,'blocked',false); end if;
  cap := round(a.starting_balance*a.daily_profit_cap_pct/100,2);
  select exists(select 1 from public.infinity_daily_entry_pauses
    where account_id=a.id and utc_day=today) into blocked;
  eq := public.fn_infinity_quote_equity(a.id);
  -- Day-start rollover belongs to the existing risk guard. Never compare a
  -- new day's equity against yesterday's baseline or invent a missing mark.
  if eq is null or a.day_start_date is distinct from today then
    return jsonb_build_object('checked',blocked,'blocked',blocked,'cap_usd',cap); end if;
  gain := round(eq-a.day_start_equity,2);
  if a.status='active' and a.access_revoked_at is null and gain>=cap then
    insert into public.infinity_daily_entry_pauses(account_id,utc_day,observed_gain,cap_usd)
    values(a.id,today,gain,cap) on conflict do nothing;
    blocked := true;
  end if;
  return jsonb_build_object('checked',true,'blocked',blocked,'cap_usd',cap,'gain_usd',gain);
end $$;
revoke all on function public.fn_infinity_daily_entry_limit(uuid) from public,anon,authenticated;
grant execute on function public.fn_infinity_daily_entry_limit(uuid) to service_role;

-- Final database guard covers concurrent and direct source insert paths.
-- Closed partial slices are accounting records, never new exposure.
create function public.fn_guard_infinity_daily_entry_limit() returns trigger
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if (tg_table_name='trades' and new.status='open')
    or (tg_table_name='pending_orders' and new.status='pending') then
    result := public.fn_infinity_daily_entry_limit(new.account_id);
    if result->>'blocked'='true' then raise exception 'DAILY_PROFIT_CAP_REACHED' using errcode='P0001'; end if;
    if result->>'checked'='false' then raise exception 'DAILY_PROFIT_CAP_UNAVAILABLE' using errcode='P0001'; end if;
  end if;
  return new;
end $$;
revoke all on function public.fn_guard_infinity_daily_entry_limit() from public,anon,authenticated;
create trigger infinity_daily_entry_trade before insert on public.trades
  for each row execute function public.fn_guard_infinity_daily_entry_limit();
create trigger infinity_daily_entry_pending before insert on public.pending_orders
  for each row execute function public.fn_guard_infinity_daily_entry_limit();
commit;
