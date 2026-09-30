-- Low-latency quotes: the trading engine's "pump" action refreshes live_quotes every ~250ms from one
-- FXCM download and pushes changes over PRIVATE Realtime channels named quotes:<SYMBOL>.

-- Anyone may RECEIVE quote broadcasts (the same public prices the chart feed serves). There is deliberately no INSERT policy, so no client can
-- publish (spoof) prices on these channels; only the server (service role) can.
drop policy if exists "ipfx quote broadcasts readable by signed-in users" on realtime.messages;
drop policy if exists "ipfx quote broadcasts are receivable" on realtime.messages;
create policy "ipfx quote broadcasts are receivable" on realtime.messages
  for select to anon, authenticated
  using (realtime.topic() like 'quotes:%' and extension = 'broadcast');

-- Start an 11s pump run every 10s (runs overlap by ~1s so there is never a gap; long single runs were cut
-- off by the per-invocation CPU budget at ~20s). The command is derived from the existing sweep job so the
-- cron secret is never written into this file (the repo is public).
select cron.unschedule(jobid) from cron.job where jobname = 'ipfx-quote-pump';
select cron.schedule(
  'ipfx-quote-pump', '10 seconds',
  (select replace(replace(command, '''sweep''', '''pump'', ''duration_ms'', 11000'), '30000', '10000')
     from cron.job where jobname = 'ipfx-drawdown-sweep')
);
