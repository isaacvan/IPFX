-- ============================================================
-- IPFX Capital — scheduled drawdown/stop-out sweep
--
-- The trading-engine's enforce() function already does correct
-- mark-to-market breach detection (checks live price against the
-- account's max-drawdown and daily-loss floors, force-closes open
-- positions, and locks the account). The gap: enforce() only runs
-- when a client calls the engine (trading.html polls "state" every
-- 8s while a trade tab is open). If a trader closes the tab, loses
-- connection, or the app crashes while a position is open, a
-- breach can sit unenforced until they next reconnect — and if
-- price recovers by then, the breach that SHOULD have happened
-- silently never gets recorded.
--
-- This schedules a call to the new "sweep" action every minute
-- (pg_cron's finest granularity), independent of any client being
-- connected, so open positions are checked against their drawdown
-- floors on a fixed server-side cadence regardless of who's online.
--
-- PREREQUISITES before running this:
--   1. Generate a random secret, e.g.:  openssl rand -hex 32
--   2. Set it as an edge function secret:
--        supabase secrets set CRON_SECRET=<the random value>
--   3. Paste that SAME value into <CRON_SECRET> below.
--
-- NOTE: the secret is stored in plain text in this job's definition
-- (pg_cron stores job SQL as-is). Treat this file and the deployed
-- job as sensitive; rotate the secret if this file is ever exposed.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('ipfx-drawdown-sweep')
where exists (select 1 from cron.job where jobname = 'ipfx-drawdown-sweep');

select cron.schedule(
  'ipfx-drawdown-sweep',
  '* * * * *', -- every minute
  $$
  select net.http_post(
    url := 'https://agulweemteoeagscmppy.supabase.co/functions/v1/trading-engine',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body := jsonb_build_object('action', 'sweep')
  );
  $$
);

-- Verify it's scheduled:
--   select * from cron.job where jobname = 'ipfx-drawdown-sweep';
-- Check recent runs:
--   select * from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'ipfx-drawdown-sweep')
--   order by start_time desc limit 20;
