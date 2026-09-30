-- FXCM's per-symbol <Last> is the time of the last price CHANGE. feed_ts stores the newest <Last> across the
-- whole feed at the moment the row was written, so the engine can tell "quiet pair on a live feed" (tradeable)
-- from "feed stopped" (stale), instead of pausing trading whenever EURUSD is quiet for 8 seconds.
alter table public.live_quotes add column if not exists feed_ts timestamptz;
