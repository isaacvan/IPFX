-- Remove duplicate SELECT evaluation from legacy FOR ALL admin policies and
-- cache auth lookups once per statement on the three remaining hot policies.
do $$
declare
  r record;
begin
  for r in
    select c.relname as table_name
    from pg_policy p
    join pg_class c on c.oid=p.polrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and p.polname='admin_write' and p.polcmd='*'
  loop
    execute format('drop policy admin_write on public.%I', r.table_name);
    execute format('create policy admin_insert on public.%I for insert to authenticated with check ((select public.fn_is_admin()))', r.table_name);
    execute format('create policy admin_update on public.%I for update to authenticated using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()))', r.table_name);
    execute format('create policy admin_delete on public.%I for delete to authenticated using ((select public.fn_is_admin()))', r.table_name);
  end loop;

  for r in
    select c.relname as table_name
    from pg_policy p
    join pg_class c on c.oid=p.polrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and p.polname='own_row_select'
  loop
    execute format('alter policy own_row_select on public.%I to authenticated', r.table_name);
  end loop;
end $$;

alter policy own_row_select on public.person
  using (auth_user_id = (select auth.uid()) or (select public.fn_is_admin()));

alter policy own_all on public.trade_journal_entries
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter policy "own kyc submissions read" on public.kyc_submissions
  to authenticated
  using (user_id = (select auth.uid()));
