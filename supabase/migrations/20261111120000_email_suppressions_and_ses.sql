-- Do-not-email list, a real unsubscribe link in the come-back email, and a 5-minute outbox schedule (for Amazon SES sending).
-- Rows are written only by the email-unsubscribe and ses-events functions and read by the email-outbox function (service role).
create table if not exists public.email_suppressions (
  email      text primary key,
  reason     text not null check (reason in ('unsubscribe', 'bounce', 'complaint', 'manual')),
  source     text,
  detail     text,
  created_at timestamptz not null default now()
);
alter table public.email_suppressions enable row level security;
revoke all on public.email_suppressions from anon, authenticated;
comment on table public.email_suppressions is
  'Addresses we must not email. unsubscribe: marketing emails only. bounce / complaint / manual: everything.';

-- The come-back email footer now links to the unsubscribe page ({{unsubscribe_link}} is filled in per recipient by the outbox).
update public.email_templates set
  body_html = replace(body_html, $a$Don't want these emails? Reply to this one with the word unsubscribe and we'll stop.$a$,
    $b$Don't want these emails? <a href="{{unsubscribe_link}}" style="color:#5b6570;">Unsubscribe</a>, or reply with the word unsubscribe.$b$),
  body_text = replace(body_text, $a$Don't want these emails? Reply to this one with the word unsubscribe and we'll stop.$a$,
    $b$Don't want these emails? Unsubscribe here: {{unsubscribe_link}} (or reply with the word unsubscribe).$b$)
where key = 'infinity_comeback';

-- Every 5 minutes instead of hourly. The daily and per-run caps in the function still decide how many go out.
select cron.unschedule(jobid) from cron.job where jobname = 'ipfx-email-outbox';
select cron.schedule('ipfx-email-outbox', '*/5 * * * *', $job$
  select public.email_outbox_release_stuck();
  select net.http_post(
    url := 'https://agulweemteoeagscmppy.supabase.co/functions/v1/email-outbox',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 110000
  );
$job$);
