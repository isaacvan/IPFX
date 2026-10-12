-- Infinity counted profit (owner decision 2026-10-12): at most the daily profit cap of each UTC day's net closed profit
-- counts toward the stage profit target ($14 a day in Stage 1). Losses count in full. Applies to runs whose application
-- accepted Terms 2.1 or later; earlier runs keep the target they agreed to (Terms 4.3/18).
-- The engine's pass gate adds DAILY_CAPPED_PROFIT to the unmet list until counted profit reaches the target.
begin;
create or replace function public.fn_infinity_counted_profit(p_account uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare a public.trading_accounts; root public.trading_accounts; hops int := 0; accepted text;
  cap numeric; target numeric; counted numeric;
begin
  select * into a from public.trading_accounts where id = p_account;
  if not found or a.challenge_type is distinct from 'infinity' or coalesce(a.phase, '') = 'demo'
     or a.daily_profit_cap_pct is null or coalesce(a.profit_target_pct, 0) <= 0 then
    return jsonb_build_object('applies', false);
  end if;
  root := a;
  while root.funded_from_account_id is not null and hops < 5 loop
    select * into root from public.trading_accounts where id = root.funded_from_account_id;
    if not found then return jsonb_build_object('applies', false); end if;
    hops := hops + 1;
  end loop;
  select r.application_details->>'terms_version' into accepted
    from public.challenge_enrolment_requests r where r.id = root.approval_request_id;
  if coalesce(accepted, '') < '2026-10-12-2.1' then return jsonb_build_object('applies', false); end if;
  cap := round(a.starting_balance * a.daily_profit_cap_pct / 100, 2);
  target := round(a.starting_balance * a.profit_target_pct / 100, 2);
  select coalesce(sum(case when d > 0 then least(d, cap) else d end), 0) into counted
  from (
    select sum(coalesce(t.pnl, 0)) as d
    from public.trades t
    where t.account_id = a.id and t.status = 'closed' and t.closed_at is not null
    group by (t.closed_at at time zone 'UTC')::date
  ) days;
  return jsonb_build_object('applies', true, 'cap_usd', cap, 'target_usd', target,
    'counted_usd', round(counted, 2), 'met', counted >= target);
end $$;
revoke all on function public.fn_infinity_counted_profit(uuid) from public, anon, authenticated;
grant execute on function public.fn_infinity_counted_profit(uuid) to service_role;
commit;
