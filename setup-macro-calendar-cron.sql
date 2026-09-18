-- IPFX macro calendar refresh. Run after deploying macro-calendar-sync.
-- Store the same random value in:
--   1) Supabase Edge Function secret INTERNAL_CRON_SECRET
--   2) Supabase Vault secret named ipfx_macro_calendar_cron_secret
-- Never paste the secret into this file.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare j bigint;
begin
  for j in select jobid from cron.job where jobname = 'ipfx-macro-calendar-sync' loop
    perform cron.unschedule(j);
  end loop;
end $$;

select cron.schedule(
  'ipfx-macro-calendar-sync',
  '*/10 * * * *',
  $job$
  select net.http_post(
    url := 'https://agulweemteoeagscmppy.supabase.co/functions/v1/macro-calendar-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ipfx_macro_calendar_cron_secret' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);

select jobid,schedule,jobname,active from cron.job where jobname='ipfx-macro-calendar-sync';
