-- On-site feedback form (feedback.html) posts here. One place for bugs, complaints and suggestions so the
-- team catches problems privately before they become support emails or public reviews. Mirrors the
-- backtest_submissions pattern: visitors may only INSERT, the table enforces its own size and flood limits,
-- and only the service role (via the admin-console function) can read or triage. No review-gating: this is an
-- internal support channel and is independent of any public review invitation.
create table if not exists public.feedback_submissions (
  id uuid primary key default gen_random_uuid(),
  name text check (name is null or char_length(name) <= 120),
  email text not null check (char_length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  category text not null check (category in ('bug', 'complaint', 'suggestion', 'question', 'praise', 'other')),
  message text not null check (char_length(btrim(message)) between 5 and 5000),
  page text check (page is null or char_length(page) <= 300),            -- where the user was / what they were doing
  user_agent text check (user_agent is null or char_length(user_agent) <= 400),
  status text not null default 'new' check (status in ('new', 'in_progress', 'resolved', 'dismissed')),
  admin_note text check (admin_note is null or char_length(admin_note) <= 5000),
  handled_by uuid,
  handled_at timestamptz,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists feedback_submissions_status_idx on public.feedback_submissions (status, created_at desc);
create index if not exists feedback_submissions_email_idx on public.feedback_submissions (lower(email), created_at desc);

alter table public.feedback_submissions enable row level security;
revoke all on public.feedback_submissions from public, anon, authenticated;
grant insert on public.feedback_submissions to anon, authenticated;
grant select, insert, update, delete on public.feedback_submissions to service_role;
create policy "visitors can submit feedback" on public.feedback_submissions for insert to anon, authenticated with check (true);

-- The submitter cannot set the status, triage fields or timestamps, and cannot flood the table:
-- at most 8 submissions per email per day and 400 per hour in total.
create or replace function public.feedback_submissions_guard() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  new.status := 'new';
  new.admin_note := null;
  new.handled_by := null;
  new.handled_at := null;
  new.submitted_at := now();
  new.created_at := now();
  new.email := btrim(new.email);
  if (select count(*) from public.feedback_submissions where lower(email) = lower(new.email) and created_at > now() - interval '24 hours') >= 8 then
    raise exception 'FEEDBACK_RATE_LIMITED' using errcode = 'P0001';
  end if;
  if (select count(*) from public.feedback_submissions where created_at > now() - interval '1 hour') >= 400 then
    raise exception 'FEEDBACK_BUSY' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.feedback_submissions_guard() from public, anon, authenticated;
drop trigger if exists feedback_submissions_guard on public.feedback_submissions;
create trigger feedback_submissions_guard before insert on public.feedback_submissions for each row execute function public.feedback_submissions_guard();

notify pgrst, 'reload schema';
