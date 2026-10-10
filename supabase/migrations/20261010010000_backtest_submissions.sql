-- The free backtest form (backtest.html) posts to public.backtest_submissions, but that table was never created, so every
-- submission failed with "Something went wrong" (HTTP 404). Visitors can only INSERT; nobody but the service role can read.
-- Limits are enforced by the table itself so the public endpoint cannot be used to store junk or flood the database.
create table if not exists public.backtest_submissions (
  id uuid primary key default gen_random_uuid(),
  first_name text not null check (char_length(btrim(first_name)) between 1 and 80),
  last_name text check (last_name is null or char_length(last_name) <= 80),
  email text not null check (char_length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  strategy_name text not null check (char_length(btrim(strategy_name)) between 1 and 120),
  instruments text check (instruments is null or char_length(instruments) <= 200),
  timeframe text check (timeframe is null or char_length(timeframe) <= 40),
  language text check (language is null or char_length(language) <= 60),
  description text not null check (char_length(btrim(description)) between 10 and 5000),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'done', 'rejected')),
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists backtest_submissions_email_idx on public.backtest_submissions (lower(email), created_at desc);
alter table public.backtest_submissions enable row level security;
revoke all on public.backtest_submissions from public, anon, authenticated;
grant insert on public.backtest_submissions to anon, authenticated;
grant select, update, delete on public.backtest_submissions to service_role;
grant insert on public.backtest_submissions to service_role;
create policy "visitors can submit a backtest" on public.backtest_submissions for insert to anon, authenticated with check (true);

-- The visitor cannot choose the status or the time, and cannot send more than 3 requests per email per day or flood the
-- table (200 per hour in total).
create or replace function public.backtest_submissions_guard() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  new.status := 'pending';
  new.submitted_at := now();
  new.created_at := now();
  new.email := btrim(new.email);
  if (select count(*) from public.backtest_submissions where lower(email) = lower(new.email) and created_at > now() - interval '24 hours') >= 3 then
    raise exception 'BACKTEST_RATE_LIMITED' using errcode = 'P0001';
  end if;
  if (select count(*) from public.backtest_submissions where created_at > now() - interval '1 hour') >= 200 then
    raise exception 'BACKTEST_BUSY' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.backtest_submissions_guard() from public, anon, authenticated;
drop trigger if exists backtest_submissions_guard on public.backtest_submissions;
create trigger backtest_submissions_guard before insert on public.backtest_submissions for each row execute function public.backtest_submissions_guard();

notify pgrst, 'reload schema';
