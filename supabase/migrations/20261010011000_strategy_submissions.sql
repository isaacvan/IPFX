-- The "Submit Strategy" tool on IPFX Markets (trading.html, Terms clause 8.4) posts to public.strategy_submissions, but the
-- table was never created, so every submission failed. Submitters can only INSERT; only the service role can read, so the
-- code is visible to IPFX administrators only. The table limits sizes and flooding because the endpoint is public.
create table if not exists public.strategy_submissions (
  id uuid primary key default gen_random_uuid(),
  account_name text check (account_name is null or char_length(account_name) <= 120),
  login text check (login is null or char_length(login) <= 120),
  strategy_name text not null check (char_length(btrim(strategy_name)) between 1 and 120),
  language text check (language is null or char_length(language) <= 40),
  max_risk_pct numeric check (max_risk_pct is null or (max_risk_pct > 0 and max_risk_pct <= 100)),
  code text not null check (char_length(btrim(code)) between 1 and 100000),
  status text not null default 'pending_review' check (status in ('pending_review', 'approved', 'rejected')),
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists strategy_submissions_login_idx on public.strategy_submissions (login, created_at desc);
alter table public.strategy_submissions enable row level security;
revoke all on public.strategy_submissions from public, anon, authenticated;
grant insert on public.strategy_submissions to anon, authenticated;
grant select, update, delete on public.strategy_submissions to service_role;
grant insert on public.strategy_submissions to service_role;
create policy "traders can submit a strategy" on public.strategy_submissions for insert to anon, authenticated with check (true);

-- The submitter cannot choose the status or the time. At most 10 strategies per account per day and 100 per hour in total.
create or replace function public.strategy_submissions_guard() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  new.status := 'pending_review';
  new.submitted_at := now();
  new.created_at := now();
  if new.login is not null and (select count(*) from public.strategy_submissions where login = new.login and created_at > now() - interval '24 hours') >= 10 then
    raise exception 'STRATEGY_RATE_LIMITED' using errcode = 'P0001';
  end if;
  if (select count(*) from public.strategy_submissions where created_at > now() - interval '1 hour') >= 100 then
    raise exception 'STRATEGY_BUSY' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.strategy_submissions_guard() from public, anon, authenticated;
drop trigger if exists strategy_submissions_guard on public.strategy_submissions;
create trigger strategy_submissions_guard before insert on public.strategy_submissions for each row execute function public.strategy_submissions_guard();

notify pgrst, 'reload schema';
