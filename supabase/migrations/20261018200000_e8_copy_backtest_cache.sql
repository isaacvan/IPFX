-- The Books page E8 copy backtest takes ~25s, but the app's API session cuts every query off at 8s (and rejects an UPDATE
-- without WHERE). So the calculation runs out-of-band as the postgres user (scheduled job, no 8s limit) and the page reads
-- the saved result instantly. Read-only with respect to all trading data: the only table written is this cache.
begin;
create table if not exists public.ab_e8_copy_backtest_cache (
  id int primary key check (id = 1),
  computed_at timestamptz not null,
  took_ms int not null,
  result jsonb not null
);
alter table public.ab_e8_copy_backtest_cache enable row level security;
revoke all on public.ab_e8_copy_backtest_cache from public, anon, authenticated;
grant select, insert, update on public.ab_e8_copy_backtest_cache to service_role;

create or replace function public.ab_e8_copy_backtest_refresh()
returns jsonb language plpgsql volatile security definer set search_path to '' as $$
declare t0 timestamptz := clock_timestamp(); r jsonb; ms int;
begin
  r := public.ab_e8_copy_backtest();
  ms := (extract(epoch from clock_timestamp() - t0) * 1000)::int;
  insert into public.ab_e8_copy_backtest_cache (id, computed_at, took_ms, result) values (1, now(), ms, r)
  on conflict (id) do update set computed_at = excluded.computed_at, took_ms = excluded.took_ms, result = excluded.result;
  return jsonb_build_object('ok', coalesce((r->>'available')::boolean, false), 'took_ms', ms);
end $$;
revoke all on function public.ab_e8_copy_backtest_refresh() from public, anon, authenticated;
grant execute on function public.ab_e8_copy_backtest_refresh() to service_role;

do $cron$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('ipfx-e8-copy-backtest', '*/10 * * * *', 'select public.ab_e8_copy_backtest_refresh()');
  end if;
end $cron$;
commit;
