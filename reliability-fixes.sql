-- ============================================================
-- IPFX Capital — reliability at scale (concurrency + shared quote cache)
--
-- Two real problems found while auditing "what breaks with 100s of
-- concurrent users":
--
-- 1. CONCURRENCY. trading_accounts.balance was written in a couple of
--    places as a plain read-then-write, and two spots (closeTrade's
--    conditional trade update, the pending-order fill claim) did a
--    filtered UPDATE without checking whether it actually matched a
--    row. In Postgres/supabase-js, an UPDATE ... WHERE that matches
--    zero rows is NOT an error — it silently succeeds with no data.
--    Two overlapping requests for the same account (two browser tabs,
--    a double-click, the 8-second state poll racing a manual action, or
--    the pg_cron sweep racing either) could therefore both "succeed" at
--    closing/filling the same thing, double-crediting P&L. Fixed in
--    trading-engine/index.ts by checking rows-affected everywhere a
--    conditional update matters, and by routing the one balance write
--    that sits outside enforce()'s own cycle (partial_close) through
--    the atomic increment below instead of a read-then-write.
--
-- 2. SHARED QUOTE CACHE. fetchQuote() cached quotes in a plain in-process
--    Map. Supabase Edge Functions run on ephemeral, per-invocation
--    isolates — that cache is NOT shared across concurrent requests from
--    different users. With hundreds of concurrent traders, every one of
--    them polling every 8 seconds, most quote requests would miss the
--    cache and hit the underlying (unofficial, rate-limited) Yahoo
--    Finance endpoint independently. This is a real ceiling: at scale it
--    gets the whole feed rate-limited or blocked for everyone. A
--    Postgres-backed cache is shared across every isolate, converting
--    O(concurrent users) upstream calls into O(unique symbols) per
--    cache-TTL window — the only fix code can make; the underlying feed
--    is still not launch-grade (see the comment at the top of
--    trading-engine/index.ts) and that requires a paid data vendor,
--    not more caching.
--
-- Safe to run repeatedly (idempotent DDL).
-- ============================================================

-- ---- 1. Atomic balance increment ----
-- balance = balance + delta in ONE statement is safe under concurrent
-- writers because Postgres row-level locking serializes the two
-- concurrent UPDATEs on the same row — the second one waits for the
-- first to commit and then applies on top of the already-updated value,
-- so no delta is ever lost. This is the standard fix for the
-- read-then-write race a plain SELECT + UPDATE has.
create or replace function public.fn_adjust_balance(p_account_id uuid, p_delta numeric)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare v_bal numeric;
begin
  update public.trading_accounts
    set balance = round(balance + p_delta, 2), updated_at = now()
    where id = p_account_id
    returning balance into v_bal;
  if v_bal is null then
    raise exception 'account_not_found';
  end if;
  return v_bal;
end;
$$;

-- ---- 2. Shared, cross-isolate quote cache ----
create table if not exists public.live_quotes (
  symbol       text primary key,
  mid          numeric(18,6) not null,
  bid          numeric(18,6) not null,
  ask          numeric(18,6) not null,
  spread       numeric(18,6) not null,
  provider_ts  timestamptz,
  received_at  timestamptz not null default now()
);
comment on table public.live_quotes is
  'Cross-isolate quote cache. Populated by whichever trading-engine invocation happens to fetch a symbol first within the TTL window; every other concurrent invocation reads this instead of calling the upstream feed again. Shared across ALL edge function instances, unlike the in-memory Map cache it replaces, which is per-isolate and useless under concurrent load.';

-- No RLS needed: this table is never queried directly by a client, only
-- by the service-role trading-engine function. Still enable it and add
-- zero policies as defence in depth against a future client-side query.
alter table public.live_quotes enable row level security;

-- Verify:
--   select proname from pg_proc where proname = 'fn_adjust_balance';
--   select * from public.live_quotes order by received_at desc limit 20;
