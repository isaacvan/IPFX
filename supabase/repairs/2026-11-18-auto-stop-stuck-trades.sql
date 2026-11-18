-- One-off repair, 18 Nov 2026 (run together with migration 20261118120000, already applied to production).
-- Closes every open Infinity v2 trade that got an automatic stop and has since passed that stop price, at the STOP
-- price (not the current market price), because the bug fixed by 20261118120000 is what stopped them closing on time.
-- Loss = recorded opening risk + the standard v2 commission, exactly as the engine's closeTrade computes it.
-- Idempotent: it only touches open trades whose stop has been crossed and whose stop was recorded after 30 seconds.
begin;

do $$
declare r record; comm numeric; res jsonb; fixed int := 0; ids uuid[] := '{}';
begin
 for r in
  select t.id, t.account_id, t.user_id, t.symbol, t.volume, t.open_price, t.sl, t.initial_risk_usd
    from public.trades t
    join public.trading_accounts a on a.id = t.account_id
    left join public.live_quotes q on q.symbol = t.symbol
   where t.status = 'open' and a.rules_version = 'infinity_v2'
     and t.initial_sl_at > t.opened_at + interval '30 seconds' and t.sl is not null
     and ((t.side = 'buy' and q.bid <= t.sl) or (t.side = 'sell' and q.ask >= t.sl))
   order by t.opened_at
   for update of t
 loop
  comm := round(coalesce((public.infinity_v2_price(r.symbol)->>'commission')::numeric, 0) * r.volume, 2);
  res := public.fn_request_ipfx_full_close(r.id, r.account_id, r.user_id, r.volume,
    jsonb_build_object('reason', 'sl', 'exit', r.sl, 'repair', 'late-stop record bug, 18 Nov 2026', 'at', now()));
  if not coalesce((res->>'ok')::boolean, false) then raise exception 'REPAIR_REQUEST_REFUSED % %', r.id, res; end if;
  res := public.fn_commit_ipfx_close(r.id, r.account_id, r.user_id, r.volume, r.open_price, r.sl,
    round(-r.initial_risk_usd - comm, 2), 'sl', true, comm, 0, null);
  if not coalesce((res->>'ok')::boolean, false) then raise exception 'REPAIR_COMMIT_REFUSED % %', r.id, res; end if;
  ids := ids || r.id; fixed := fixed + 1;
 end loop;
 -- the 10-minute pause after a stop-out should not punish a close that was only late because of the bug
 delete from public.infinity_v2_pauses p
  using public.trades t
  where t.id = any(ids) and p.account_id = t.account_id and p.symbol = t.symbol and p.until_at > now();
 raise notice 'closed % trades at their stop price', fixed;
end $$;

commit;
