-- Tables with RLS and no policies are already deny-by-default. Add an explicit
-- restrictive browser-role policy so that intent is auditable and a future
-- permissive policy cannot accidentally expose a service-only table without
-- first removing this guard.
do $service_only$
declare r record;
begin
  for r in
    select n.nspname,c.relname
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity
      and not exists (
        select 1 from pg_policy p where p.polrelid=c.oid
      )
  loop
    execute format(
      'create policy service_only_browser_deny on %I.%I as restrictive for all to anon, authenticated using (false) with check (false)',
      r.nspname,r.relname
    );
  end loop;
end $service_only$;
