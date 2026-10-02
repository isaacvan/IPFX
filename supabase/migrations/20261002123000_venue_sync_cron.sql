-- Broker-demo challenge sync every 10s (no-op while no accounts are connected). Derived from the sweep job so
-- the cron secret is never written into this file.
select cron.unschedule(jobid) from cron.job where jobname = 'ipfx-venue-sync';
select cron.schedule('ipfx-venue-sync', '10 seconds',
  (select replace(replace(command, '''sweep''', '''venue_sync'''), '30000', '20000') from cron.job where jobname = 'ipfx-drawdown-sweep'));
