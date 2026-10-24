-- Big Build step 3b (2026-10-24): hub_watch rewrote every watched symbol's quote_watch and quote_demand row on every call (every 20s),
-- about 2.4 row writes a second even with no traders trading. Both tables are read with a 60-second window, so a row only needs refreshing
-- once it is 30 seconds old: it stays well inside the window and the writes roughly halve. Nothing else changes.
begin;
do $drift$ begin
  if md5(pg_get_functiondef('public.hub_watch(text,text[])'::regprocedure)) <> '3fd48c6be1410ed7f9e38af6be0ffbb4' then
    raise exception 'HUB_WATCH_SOURCE_DRIFT';
  end if;
end $drift$;

create or replace function public.hub_watch(p_secret text, p_symbols text[])
returns int language plpgsql security definer set search_path to '' as $$
declare n int;
begin
  if not public.hub_check(p_secret) then raise exception 'not authorised' using errcode = '42501'; end if;
  insert into public.quote_watch (symbol, last_seen)
  select distinct s, now() from unnest(p_symbols[1:300]) s where s ~ '^[A-Z0-9:._-]{2,20}$'
  on conflict (symbol) do update set last_seen = excluded.last_seen
    where public.quote_watch.last_seen < now() - interval '30 seconds';
  get diagnostics n = row_count;
  insert into public.quote_demand (symbol, last_at)
  select distinct s, now() from unnest(p_symbols[1:300]) s where s ~ '^[A-Z0-9:._-]{2,20}$'
  on conflict (symbol) do update set last_at = excluded.last_at
    where public.quote_demand.last_at < now() - interval '30 seconds';
  return n;
end $$;
revoke all on function public.hub_watch(text, text[]) from public, authenticated;
grant execute on function public.hub_watch(text, text[]) to anon;
commit;
