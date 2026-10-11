-- Hourly email outbox run (applied once the owner confirmed the test emails arrived and looked right).
select cron.unschedule(jobid) from cron.job where jobname = 'ipfx-email-outbox';
select cron.schedule('ipfx-email-outbox', '7 * * * *', $job$
  select public.email_outbox_release_stuck();
  select net.http_post(
    url := 'https://agulweemteoeagscmppy.supabase.co/functions/v1/email-outbox',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$job$);
