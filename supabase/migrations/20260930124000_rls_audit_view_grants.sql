-- S6 RLS audit (30 Sep 2026): every public TABLE has RLS enabled. Two views carried full anon/authenticated
-- grants. They are security_invoker (underlying RLS applies) and unused by the browser, but anon should hold
-- nothing on trader analytics and nobody should hold write grants on a view.
revoke all on public.trader_risk  from anon;
revoke all on public.trader_stats from anon;
revoke insert, update, delete, truncate, references, trigger on public.trader_risk  from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.trader_stats from authenticated;
