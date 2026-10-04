-- Herd detector (overnight stress tests 2026-10-04). Traders following one signal service open the same
-- instrument and direction within seconds, so they win and lose together: one lucky week can push dozens
-- of them past the 2.75% rule at once. Random traders almost never share 5+ trades within 60 seconds
-- (about 1 pair in 10,000 at 10,000 users), so a pair that does, on 30%+ of the smaller trader's trades,
-- is following the same source. Linked pairs form clusters in the classifier.
create index if not exists trades_symbol_side_opened_idx on public.trades (symbol, side, opened_at);

create or replace function public.ab_herd_pairs(p_days int default 30, p_window_s int default 60, p_min_shared int default 5, p_min_share numeric default 0.3)
returns table (person_a uuid, person_b uuid, shared bigint, share numeric)
language sql stable security definer set search_path to '' as $$
  with t as (
    select tr.id, public.ab_person_of(tr.user_id) as person, tr.symbol, tr.side, tr.opened_at
    from public.trades tr
    where tr.opened_at > now() - make_interval(days => p_days) and tr.opened_at is not null
  ), n as (select person, count(*) as n from t group by person),
  pairs as (
    select a.person as pa, b.person as pb, count(distinct a.id) as shared
    from t a join t b
      on b.symbol = a.symbol and b.side = a.side and a.person < b.person
     and b.opened_at between a.opened_at - make_interval(secs => p_window_s) and a.opened_at + make_interval(secs => p_window_s)
    group by a.person, b.person
  )
  select p.pa, p.pb, p.shared, round(p.shared::numeric / least(na.n, nb.n), 3)
  from pairs p join n na on na.person = p.pa join n nb on nb.person = p.pb
  where p.shared >= p_min_shared and p.shared >= p_min_share * least(na.n, nb.n);
$$;
revoke all on function public.ab_herd_pairs(int, int, int, numeric) from public, anon, authenticated;
grant execute on function public.ab_herd_pairs(int, int, int, numeric) to service_role;
