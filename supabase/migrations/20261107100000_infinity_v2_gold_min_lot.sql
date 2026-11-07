-- Gold on Infinity v2 (7 Nov 2026): every gold order under 0.01 lots was rejected as INVALID_LOT_STEP (686 orders from 42 traders,
-- 2-6 Nov, the most common rejection on the platform). The v2 pricing profile allowed 0.001 lots, but trades.volume and
-- pending_orders.volume are numeric(10,2): a 0.004-lot order is stored as 0.00 before the v2 trigger runs, so the trigger saw
-- zero lots. A size like 0.015 would have been stored as 0.02, above the risk the engine had checked.
-- The minimum gold lot goes back to 0.01, which the tables can hold. The ticket reads min_lot from the account state, so it sizes
-- in 0.01 steps from the next state poll. No v2 gold position was open when this ran. Allowing 0.001 again needs both volume
-- columns widened first (they are read by several views), which is left for a separate, planned change.
begin;
update public.infinity_v2_pricing_profiles set min_lot = 0.01 where symbol = 'XAUUSD' and min_lot < 0.01;
commit;
