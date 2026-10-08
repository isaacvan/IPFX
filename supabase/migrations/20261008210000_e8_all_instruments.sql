-- E8 reference monitor: sample every instrument both platforms share, not just 5 (owner question 2026-10-08).
-- Two speeds keep the data manageable: the 5 main instruments stay every 10 seconds (what the trade replay leans on),
-- the other 19 are sampled every 30 seconds (enough for spread statistics). E8 allows 10 quote requests a second and the
-- monitor budgets 8, so this uses about 3 a second at its busiest. IPFX instruments E8 does not offer at all (DOTUSD,
-- FRA40, UK100, US2000, XPDUSD, XPTUSD) cannot be sampled. cost_samples is kept 21 days instead of 60 (the Brain panel
-- reads 7) so the extra rows cost about 0.5 GB, not 3 GB.
alter table public.e8_monitor_profiles add column if not exists slow_symbols text[] not null default '{}';
update public.e8_monitor_profiles
set slow_symbols = array['ADAUSD','AUDCAD','AUDUSD','ETHUSD','EURCAD','EURGBP','EURJPY','GBPJPY','LTCUSD','NZDUSD','SOLUSD','USDCAD','USDCHF','XAGUSD',
                         'DJI','GER40','JPN225','NSXUSD','SPXUSD']
where slow_symbols = '{}';
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'ipfx-cost-samples-purge';
  perform cron.schedule('ipfx-cost-samples-purge', '33 3 * * *', $c$delete from public.cost_samples where sampled_at < now() - interval '21 days'$c$);
end $$;
