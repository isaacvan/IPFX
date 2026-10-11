-- Read-only aggregates avoid the API row limit truncating 2,000-person counts or open risk.
begin;
create or replace function public.treasury_book_totals() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'book_states',coalesce((select jsonb_object_agg(book_state,n) from
    (select book_state,count(*) n from public.ab_trader_profiles group by book_state) c),'{}'::jsonb),
  'open_risk',coalesce((select jsonb_object_agg(book,n) from
    (select book,sum(risk_usd) n from public.ab_risk_reservations where status='active' group by book) r),'{}'::jsonb),
  'day_pnl',coalesce((select jsonb_agg(jsonb_build_object('book',book,'pnl_usd',n)) from
    (select book,sum(pnl_usd) n from public.book_daily_pnl where day=(now() at time zone 'UTC')::date group by book) p),'[]'::jsonb),
  'as_of',now());
$$;
revoke all on function public.treasury_book_totals() from public,anon,authenticated;
grant execute on function public.treasury_book_totals() to service_role;
commit;
