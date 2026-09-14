-- ============================================================
--  IPFX Capital — trader-detector scheduled scan (pg_cron)
--  Runs the detector every 10 minutes. Each run processes up to
--  ~50 accounts and resumes from a cursor, so a large population
--  is covered across consecutive runs. The function 401s unless
--  the x-detector-secret header matches TRADER_DETECTOR_CRON_SECRET
--  (already set as an edge-function secret at deploy time).
--
--  Deployed with --no-verify-jwt, so the secret header is the auth.
--  Safe to re-run: the job is unscheduled first if it exists.
-- ============================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any previous copy of this job so re-running is clean.
do $$
declare j int;
begin
  for j in select jobid from cron.job where jobname = 'ipfx-trader-detector' loop
    perform cron.unschedule(j);
  end loop;
end $$;

select cron.schedule(
  'ipfx-trader-detector',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://agulweemteoeagscmppy.supabase.co/functions/v1/trader-detector',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-detector-secret', 'b3967917f7a64fe19be35ba8f03a188e8a31dfe987d2c7338d729097ef1cbc13'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Verify: one row for the scheduled job.
select jobid, schedule, jobname, active from cron.job where jobname = 'ipfx-trader-detector';
