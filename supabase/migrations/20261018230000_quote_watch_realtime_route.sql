-- Realtime message budget (2026-10-18): the quote pump broadcast every watched symbol on Realtime even though pages that are on
-- the IPFX hub ignore those messages (they drop the Realtime price channel while the hub is live). That cost about 1M
-- messages a day for nobody. Pages now say in their price poll whether they are on the Realtime route; the pump broadcasts a
-- symbol only while such a page is watching it. Pages that do not say (old cached pages) count as Realtime pages, so nobody
-- loses prices. A page that falls back from the hub starts reporting itself and broadcasts resume within one poll.
alter table public.quote_watch add column if not exists rt_seen timestamptz;
comment on column public.quote_watch.rt_seen is 'Last time a page on the Realtime price route (not the hub) was watching this symbol.';
