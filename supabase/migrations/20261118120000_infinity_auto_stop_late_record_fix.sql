-- 18 Nov 2026: fix for the automatic stop (migration 20261113150000).
--
-- Bug: infinity_v2_initial_risk_guard() rejected ANY insert or update of a trade whose recorded opening-stop time was
-- more than 30 seconds after the trade opened. The automatic stop records its stop at 30+ seconds, so after it fired
-- the trade could never be updated again: close requests, take profits, trailing stops and even the stop-out itself
-- all failed with OPENING_STOP_TOO_LATE. The hub then retried the failing close thousands of times, which overloaded
-- the database. Nine trades were stuck, four of them past their stop price.
--
-- Fix: the 30-second window is checked only when the opening-stop time is being recorded, not on every later update,
-- and an automatic stop (ipfx.auto_stop = on) may record it after the window, as before for the other guard.
begin;

create or replace function public.infinity_v2_initial_risk_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and old.initial_sl is not null and
   (new.initial_sl is distinct from old.initial_sl or new.initial_sl_at is distinct from old.initial_sl_at or new.initial_risk_usd is distinct from old.initial_risk_usd)
 then raise exception 'OPENING_RISK_IMMUTABLE';end if;
 if new.initial_sl_at is not null and (tg_op='INSERT' or new.initial_sl_at is distinct from old.initial_sl_at)
   and (new.initial_sl_at<new.opened_at
        or (new.initial_sl_at>new.opened_at+interval '30 seconds' and coalesce(current_setting('ipfx.auto_stop',true),'')<>'on'))
 then raise exception 'OPENING_STOP_TOO_LATE';end if;
 return new;
end $$;

commit;
