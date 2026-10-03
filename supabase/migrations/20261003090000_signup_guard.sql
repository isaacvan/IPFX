-- Sign-up abuse guard (Terms 3.4, one registered account per person).
-- The signup-guard Edge Function runs as Supabase Auth's "before user created" hook. It limits new
-- accounts per IP address and verifies a Cloudflare Turnstile token. This table is its ledger.
create table if not exists public.signup_guard_log (
  id bigint generated always as identity primary key,
  ip text,
  email_hash text,
  outcome text not null check (outcome in ('allowed', 'rejected')),
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists signup_guard_log_ip_time on public.signup_guard_log (ip, created_at desc);

alter table public.signup_guard_log enable row level security;
revoke all on public.signup_guard_log from public, anon, authenticated;
grant select, insert, delete on public.signup_guard_log to service_role;

-- Atomic per-IP check: serialises sign-ups from one IP so parallel requests cannot all slip under the limit.
-- Records the attempt and returns null when allowed, or the rejection reason.
create or replace function public.signup_guard_check(p_ip text, p_email_hash text, p_per_hour int, p_per_day int)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  n_hour int;
  n_day int;
  verdict text := null;
begin
  if p_ip is null or p_ip = '' then
    insert into signup_guard_log (ip, email_hash, outcome, reason) values (null, p_email_hash, 'allowed', 'no_ip');
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtext('signup_guard:' || p_ip));
  select count(*) filter (where created_at > now() - interval '1 hour'), count(*)
    into n_hour, n_day
    from signup_guard_log
   where ip = p_ip and outcome = 'allowed' and created_at > now() - interval '24 hours';
  if n_hour >= p_per_hour then verdict := 'ip_hourly_limit';
  elsif n_day >= p_per_day then verdict := 'ip_daily_limit';
  end if;
  insert into signup_guard_log (ip, email_hash, outcome, reason)
  values (p_ip, p_email_hash, case when verdict is null then 'allowed' else 'rejected' end, verdict);
  return verdict;
end;
$$;
revoke all on function public.signup_guard_check(text, text, int, int) from public, anon, authenticated;
grant execute on function public.signup_guard_check(text, text, int, int) to service_role;

-- Keep 30 days of sign-up ledger.
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'ipfx-signup-guard-purge';
  perform cron.schedule('ipfx-signup-guard-purge', '17 3 * * *',
    $q$delete from public.signup_guard_log where created_at < now() - interval '30 days'$q$);
end $$;
