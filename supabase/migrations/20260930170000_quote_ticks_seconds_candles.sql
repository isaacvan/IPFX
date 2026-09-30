-- Second-level chart timeframes (1s / 15s / 30s). The quote pump records every price CHANGE it sees; the
-- chart-candles function aggregates them into candles. Kept for 6 hours (seconds charts only need recent data).
create table if not exists public.quote_ticks (
  symbol text not null,
  ts timestamptz not null,
  mid numeric not null,
  bid numeric,
  ask numeric
);
create index if not exists quote_ticks_symbol_ts_idx on public.quote_ticks (symbol, ts desc);
alter table public.quote_ticks enable row level security;
revoke all on public.quote_ticks from anon, authenticated;
grant all on public.quote_ticks to service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'ipfx-quote-ticks-purge';
select cron.schedule('ipfx-quote-ticks-purge', '*/5 * * * *', $$delete from public.quote_ticks where ts < now() - interval '6 hours'$$);
