-- Full (non-partial) unique index so imports can upsert on (account_id, external_source, external_position_id).
-- NULLs are distinct, so ordinary IPFX trades (no external id) are unaffected.
drop index if exists public.trades_external_position_uidx;
create unique index if not exists trades_external_position_full_uidx on public.trades (account_id, external_source, external_position_id);
