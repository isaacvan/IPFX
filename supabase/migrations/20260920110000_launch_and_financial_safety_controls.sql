-- Closed-preview controls and least-privilege cleanup.
-- These switches are deliberately false until legal, data, payment, reserve,
-- reconciliation and security launch gates are signed off.
begin;

alter table public.platform_config
  add column if not exists public_challenges_enabled boolean not null default false,
  add column if not exists paid_checkout_enabled boolean not null default false,
  add column if not exists payouts_enabled boolean not null default false,
  add column if not exists live_mirroring_enabled boolean not null default false;

update public.platform_config
set public_challenges_enabled=false,
    paid_checkout_enabled=false,
    payouts_enabled=false,
    live_mirroring_enabled=false,
    updated_at=now()
where id=true;

-- Revoke every currently configured live-copy target. Re-enablement requires a
-- later, explicit production migration plus the server environment switch.
do $$
begin
  if to_regclass('public.mirror_targets') is not null then
    update public.mirror_targets set enabled=false where enabled is true;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='trading_accounts' and column_name='mirror_enabled'
  ) then
    execute 'update public.trading_accounts set mirror_enabled=false where mirror_enabled is true';
  end if;
end $$;

create or replace function public.enforce_challenge_launch_gate()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_enabled boolean := false;
  v_owner boolean := false;
begin
  select coalesce(public_challenges_enabled,false) into v_enabled
  from public.platform_config where id=true;

  select exists(
    select 1 from auth.users u
    join public.admins a on a.user_id=u.id
    where u.id=new.user_id and lower(coalesce(u.email,''))='paulade491@gmail.com'
  ) into v_owner;

  if not v_enabled and not v_owner then
    raise exception 'CHALLENGE_APPLICATIONS_CLOSED' using errcode='42501';
  end if;
  return new;
end $$;

revoke all on function public.enforce_challenge_launch_gate() from public,anon,authenticated;
grant execute on function public.enforce_challenge_launch_gate() to service_role;
drop trigger if exists challenge_launch_gate on public.challenge_enrolment_requests;
create trigger challenge_launch_gate
before insert or update on public.challenge_enrolment_requests
for each row execute function public.enforce_challenge_launch_gate();

create or replace function public.enforce_payout_launch_gate()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_enabled boolean := false;
begin
  select coalesce(payouts_enabled,false) into v_enabled
  from public.platform_config where id=true;
  if not v_enabled and (tg_op='INSERT' or new.status in ('requested','approved','paid')) then
    raise exception 'PAYOUTS_DISABLED_CLOSED_PREVIEW' using errcode='42501';
  end if;
  return new;
end $$;

revoke all on function public.enforce_payout_launch_gate() from public,anon,authenticated;
grant execute on function public.enforce_payout_launch_gate() to service_role;
drop trigger if exists payout_launch_gate on public.payouts;
create trigger payout_launch_gate
before insert or update of status on public.payouts
for each row execute function public.enforce_payout_launch_gate();

-- RLS only evaluates row operations. TRUNCATE, REFERENCES and TRIGGER are not
-- row-scoped, so browser roles must never receive them. Also remove each CRUD
-- privilege where no corresponding RLS policy exists.
do $cleanup$
declare r record;
begin
  for r in
    select n.nspname,c.relname
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity
  loop
    execute format('revoke truncate, references, trigger on table %I.%I from anon, authenticated',r.nspname,r.relname);
    if not exists(select 1 from pg_policies p where p.schemaname=r.nspname and p.tablename=r.relname and p.cmd in ('ALL','SELECT')) then
      execute format('revoke select on table %I.%I from anon, authenticated',r.nspname,r.relname);
    end if;
    if not exists(select 1 from pg_policies p where p.schemaname=r.nspname and p.tablename=r.relname and p.cmd in ('ALL','INSERT')) then
      execute format('revoke insert on table %I.%I from anon, authenticated',r.nspname,r.relname);
    end if;
    if not exists(select 1 from pg_policies p where p.schemaname=r.nspname and p.tablename=r.relname and p.cmd in ('ALL','UPDATE')) then
      execute format('revoke update on table %I.%I from anon, authenticated',r.nspname,r.relname);
    end if;
    if not exists(select 1 from pg_policies p where p.schemaname=r.nspname and p.tablename=r.relname and p.cmd in ('ALL','DELETE')) then
      execute format('revoke delete on table %I.%I from anon, authenticated',r.nspname,r.relname);
    end if;
  end loop;
end $cleanup$;

-- Trigger functions are not public APIs. The promo validator remains callable
-- by the two browser roles, but not by the implicit PUBLIC role.
revoke execute on function public.guard_user_profile_fields() from public,anon,authenticated;
revoke execute on function public.validate_promo_code(text) from public;
grant execute on function public.validate_promo_code(text) to anon,authenticated;

-- New objects start closed. Migrations must opt into only the grants a feature
-- actually needs.
alter default privileges in schema public revoke all on tables from public,anon,authenticated;
alter default privileges in schema public revoke execute on functions from public,anon,authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant execute on functions to service_role;

insert into public.support_config(key,value,description,edited_by_owner)
values(
  'launch_status',
  'Closed research preview. Public challenge applications, payments, payouts, live-capital accounts and trade copying are disabled. All current IPFX Markets trading is simulated. No launch date is promised.',
  'Authoritative availability status; overrides older programme marketing.',
  false
)
on conflict (key) do update set
  value=excluded.value,
  description=excluded.description,
  updated_at=now();

update public.support_kb
set answer='IPFX is in a **closed research preview**. Public challenge applications are not open. Payments, payouts, live-capital accounts, A-book routing, automatic scaling and trade copying are disabled. All current IPFX Markets trading is simulated. A launch date will be published only after the legal, market-data, payment, reserve, reconciliation and security readiness checks are complete.',
    follow_ups=array['What is simulated trading?','Where can I read the risk disclosure?'],
    updated_at=now()
where id in ('infinity-overview','infinity-stage4','infinity-payouts','payout-how');

commit;
