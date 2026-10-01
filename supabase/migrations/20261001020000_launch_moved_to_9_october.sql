-- Infinity public launch moved from 1 October to 9 October 2026 (00:00 UK time).
-- Rewrites the launch gate inside the two application functions without touching anything else in them.
do $$
declare r record; def text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('enforce_programme_launch_on_application', 'submit_challenge_application') loop
    def := pg_get_functiondef(r.oid);
    if position('2026-10-01 00:00:00 Europe/London' in def) > 0 then
      execute replace(def, '2026-10-01 00:00:00 Europe/London', '2026-10-09 00:00:00 Europe/London');
    end if;
  end loop;
end $$;

-- Support assistant wording.
update public.support_kb set answer = replace(answer, 'opens on **1 October 2026**', 'opens on **9 October 2026**') where id = 'programmes-overview';
update public.support_config set value = replace(value, '**1 October 2026**', '**9 October 2026**'), updated_at = now() where key in ('launch_note', 'launch_short');

select
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('enforce_programme_launch_on_application','submit_challenge_application') and pg_get_functiondef(p.oid) like '%2026-10-09 00:00:00 Europe/London%') as gates_moved,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('enforce_programme_launch_on_application','submit_challenge_application') and pg_get_functiondef(p.oid) like '%2026-10-01 00:00:00 Europe/London%') as gates_old,
  (select count(*) from public.support_kb where answer like '%9 October 2026%') as kb_new,
  (select count(*) from public.support_config where key in ('launch_note','launch_short') and value like '%9 October 2026%') as cfg_new;
