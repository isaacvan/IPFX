-- Infinity daily profit cap: close open positions at the cap (owner decision 2026-10-12, "new runs only").
-- Until now the cap only paused NEW entries; positions opened before the cap kept running and one trader stacked three
-- positions to finish a day at +$41.86 against a $14 cap. From Terms 2.0, for runs whose application accepted Terms
-- 2.0 or later, the engine closes every open position and cancels pending orders the moment the day's net profit
-- (closed + open) reaches the cap; new entries stay paused until 00:00 UTC (existing entry pause).
-- Runs that accepted an earlier version keep the rule they agreed to (Terms 4.3/18: never worsen an active run),
-- so this returns false for them and the engine keeps only the entry pause.
begin;
create or replace function public.fn_infinity_cap_closes_positions(p_account uuid) returns boolean
language plpgsql stable security definer set search_path to '' as $$
declare a public.trading_accounts; root public.trading_accounts; hops int := 0; accepted text;
begin
  select * into a from public.trading_accounts where id = p_account;
  if not found or a.challenge_type is distinct from 'infinity' or coalesce(a.phase, '') = 'demo'
     or a.daily_profit_cap_pct is null then return false; end if;
  root := a;
  while root.funded_from_account_id is not null and hops < 5 loop
    select * into root from public.trading_accounts where id = root.funded_from_account_id;
    if not found then return false; end if;
    hops := hops + 1;
  end loop;
  select r.application_details->>'terms_version' into accepted
    from public.challenge_enrolment_requests r where r.id = root.approval_request_id;
  -- Versions are date-prefixed ("2026-10-12-2.0"), so text order is release order.
  return coalesce(accepted, '') >= '2026-10-12-2.0';
end $$;
revoke all on function public.fn_infinity_cap_closes_positions(uuid) from public, anon, authenticated;
grant execute on function public.fn_infinity_cap_closes_positions(uuid) to service_role;
commit;
