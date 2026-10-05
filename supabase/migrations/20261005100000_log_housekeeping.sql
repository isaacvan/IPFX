-- Housekeeping (2026-10-05). The database had grown to 607 MB, mostly scheduler history (never purged,
-- 240k rows) and dead space in pg_net's response table (high churn, ~300 KB of live rows taking 325 MB).
-- After a one-off purge + VACUUM FULL it was 179 MB. Keep it that way:
--   * scheduler history older than 3 days is deleted daily;
--   * both tables are compacted weekly (seconds: they are small once purged).
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('ipfx-cron-history-purge', 'ipfx-log-compact-http', 'ipfx-log-compact-cron');
  perform cron.schedule('ipfx-cron-history-purge', '27 3 * * *', $c$delete from cron.job_run_details where end_time < now() - interval '3 days'$c$);
  perform cron.schedule('ipfx-log-compact-http', '37 3 * * 0', 'vacuum full net._http_response');
  perform cron.schedule('ipfx-log-compact-cron', '47 3 * * 0', 'vacuum full cron.job_run_details');
end $$;
