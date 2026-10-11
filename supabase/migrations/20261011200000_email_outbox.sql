-- Email outbox: lets the email-outbox worker claim a row ("sending") so two runs never send the same email twice,
-- and schedules it hourly. The worker only delivers emails the platform already queued, inside a daily cap
-- (80 a day by default, leaving room inside Resend's free 100/day for sign-up and password-reset emails).
alter table public.email_events drop constraint if exists email_events_status_check;
alter table public.email_events add constraint email_events_status_check
  check (status = any (array['queued', 'sending', 'sent', 'failed', 'skipped']));

-- If a run crashes mid-send, a row stuck in "sending" goes back to the queue on the next run. Resend's idempotency
-- key (one per email_events row) stops a duplicate if the first attempt did reach the provider.
create or replace function public.email_outbox_release_stuck() returns int
language sql security definer set search_path to '' as $$
  with r as (
    update public.email_events set status = 'queued'
     where status = 'sending' and sent_at is null and created_at < now() - interval '30 minutes'
    returning 1
  ) select count(*)::int from r;
$$;
revoke all on function public.email_outbox_release_stuck() from public, anon, authenticated;

-- The hourly schedule is added separately, after the owner has checked the test emails
-- (migration 20261011201000_email_outbox_schedule.sql).
