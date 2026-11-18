-- 18 Nov 2026: keep the scheduler's own run log short.
-- pg_cron writes three rows (insert + two updates) for every run of every 10-second job, which was one of the busiest
-- tables on the small 1 GB database. The log is only used for debugging, so keep one day instead of three.
-- (infinity_v2_refresh_progress is deliberately NOT changed: infinity_v2_read_progress treats a cache row older than
-- 1 minute as "scoring pending", so the 1-minute refresh is part of the rules.)
begin;

select cron.alter_job(31, command := 'delete from cron.job_run_details where end_time < now() - interval ''1 day''');

commit;
