-- Usage (8 Nov 2026): the ipfx-venue-sync job called the trading engine every 10 s (8,640 Edge Function invocations a
-- day) although no broker venue connection exists. The job now calls only when a connection is connected or in error,
-- so behaviour is identical the moment one is added. The existing command (with its secret) is kept; only a WHERE is added.
select cron.alter_job(j.jobid,
  command := regexp_replace(j.command, '\)\s*;?\s*$', ') where exists (select 1 from public.venue_connections where status in (''connected'',''error''));'))
from cron.job j
where j.jobname = 'ipfx-venue-sync' and j.command not like '%venue_connections%';
