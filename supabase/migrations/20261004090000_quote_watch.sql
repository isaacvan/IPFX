-- Which symbols someone currently has open in IPFX Markets (written by their price polls at most every
-- 20 s per symbol per engine instance). The quote pump pushes realtime prices only for these symbols, at
-- most twice a second each: Supabase bills realtime per message and recipient.
create table if not exists public.quote_watch (
  symbol text primary key,
  last_seen timestamptz not null default now()
);
alter table public.quote_watch enable row level security;
revoke all on public.quote_watch from public, anon, authenticated;
grant select, insert, update on public.quote_watch to service_role;
