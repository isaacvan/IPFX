-- These research caches contain repetitive quote paths. PostgreSQL LZ4 avoids
-- spending the scheduled compute budget in pglz compression/decompression.
-- Applies only to newly written values in this feature's own new tables.
begin;
alter table public.ab_e8_trader_perf_trade_cache alter column payload set compression lz4;
alter table public.ab_e8_trader_perf_trade_cache alter column minute_path set compression lz4;
alter table public.ab_e8_trader_perf_trader_cache alter column row_data set compression lz4;
alter table public.ab_e8_trader_perf_history alter column row_data set compression lz4;
commit;
