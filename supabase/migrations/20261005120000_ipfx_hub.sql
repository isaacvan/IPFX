-- IPFX hub (free Oracle Cloud server, hub.ipfxcapital.com): streams prices to IPFX Markets and watches every
-- open position on each price tick. It never decides a rule itself: when a stop, take-profit, pending order or
-- loss limit is crossed it asks trading-engine's existing enforce() to act on that account. Supabase stays the
-- system of record; if the hub stops, pages fall back to the Supabase path and the 10s sweep keeps running.
--
-- The hub holds NO service key. It authenticates with a dedicated secret (Vault: ipfx_hub_secret, set outside
-- migrations; the repo is public) and can only call the narrow functions below.

create or replace function public.hub_check(p_secret text)
returns boolean language plpgsql stable security definer set search_path to '' as $$
declare s text;
begin
  select decrypted_secret into s from vault.decrypted_secrets where name = 'ipfx_hub_secret' limit 1;
  return s is not null and length(s) >= 32 and p_secret is not null and md5(p_secret) = md5(s) and p_secret = s;
end $$;
revoke all on function public.hub_check(text) from public, anon, authenticated;

-- Everything the hub needs to watch positions: accounts with open trades or resting orders, those trades and
-- orders, and the stop-loss deadline. p_account = one account only (after a change signal).
create or replace function public.hub_snapshot(p_secret text, p_account uuid default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare ids uuid[];
begin
  if not public.hub_check(p_secret) then raise exception 'not authorised' using errcode = '42501'; end if;
  if p_account is not null then ids := array[p_account];
  else
    select array_agg(distinct x) into ids from (
      select account_id x from public.trades where status = 'open'
      union select account_id from public.pending_orders where status = 'pending') q;
  end if;
  return jsonb_build_object(
    'at', now(),
    'sl_deadline_seconds', (select sl_deadline_seconds from public.ab_settings limit 1),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'status', a.status, 'balance', a.balance, 'starting_balance', a.starting_balance,
        'max_drawdown_pct', a.max_drawdown_pct, 'daily_loss_pct', a.daily_loss_pct, 'day_start_equity', a.day_start_equity,
        'day_start_date', a.day_start_date, 'drawdown_mode', a.drawdown_mode, 'trailing_peak', a.trailing_peak,
        'total_paid_out', a.total_paid_out, 'venue', a.venue, 'challenge_type', a.challenge_type,
        'revoked', a.access_revoked_at is not null))
      from public.trading_accounts a where a.id = any(coalesce(ids, '{}'))), '[]'::jsonb),
    'trades', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'account_id', t.account_id, 'symbol', t.symbol, 'side', t.side, 'volume', t.volume,
        'open_price', t.open_price, 'sl', t.sl, 'tp', t.tp, 'trail_distance', t.trail_distance, 'opened_at', t.opened_at))
      from public.trades t where t.status = 'open' and t.account_id = any(coalesce(ids, '{}'))), '[]'::jsonb),
    'pending', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'account_id', o.account_id, 'symbol', o.symbol, 'side', o.side, 'order_type', o.order_type,
        'trigger_price', o.trigger_price, 'expires_at', o.expires_at))
      from public.pending_orders o where o.status = 'pending' and o.account_id = any(coalesce(ids, '{}'))), '[]'::jsonb)
  );
end $$;
revoke all on function public.hub_snapshot(text, uuid) from public, authenticated;
grant execute on function public.hub_snapshot(text, uuid) to anon;

-- Symbols the hub's viewers and positions need, so the price pump keeps fetching and pushing them.
create or replace function public.hub_watch(p_secret text, p_symbols text[])
returns int language plpgsql security definer set search_path to '' as $$
declare n int;
begin
  if not public.hub_check(p_secret) then raise exception 'not authorised' using errcode = '42501'; end if;
  insert into public.quote_watch (symbol, last_seen)
  select distinct s, now() from unnest(p_symbols[1:300]) s where s ~ '^[A-Z0-9:._-]{2,20}$'
  on conflict (symbol) do update set last_seen = excluded.last_seen;
  get diagnostics n = row_count;
  insert into public.quote_demand (symbol, last_at)
  select distinct s, now() from unnest(p_symbols[1:300]) s where s ~ '^[A-Z0-9:._-]{2,20}$'
  on conflict (symbol) do update set last_at = excluded.last_at;
  return n;
end $$;
revoke all on function public.hub_watch(text, text[]) from public, authenticated;
grant execute on function public.hub_watch(text, text[]) to anon;

create or replace function public.hub_heartbeat(p_secret text, p_detail jsonb)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if not public.hub_check(p_secret) then raise exception 'not authorised' using errcode = '42501'; end if;
  insert into public.ab_heartbeats (worker, ok, at, detail) values ('hub', coalesce((p_detail->>'ok')::boolean, true), now(), p_detail)
  on conflict (worker) do update set ok = excluded.ok, at = now(), detail = excluded.detail;
end $$;
revoke all on function public.hub_heartbeat(text, jsonb) from public, authenticated;
grant execute on function public.hub_heartbeat(text, jsonb) to anon;

-- Account changes also tell the hub (one small HTTP call via pg_net), so a new trade, a moved stop or a filled
-- order is watched straight away. Only when the hub URL and secret are configured; never blocks the write.
create or replace function public.notify_account_change()
returns trigger language plpgsql security definer set search_path to '' as $$
declare uid uuid; acc uuid; hub_url text; hub_secret text;
begin
  uid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  if uid is not null and tg_table_name <> 'pending_orders' then
    perform realtime.send(jsonb_build_object('t', tg_table_name, 'op', lower(tg_op)), 'changed', 'acct:' || uid::text, true);
  end if;
  begin
    acc := case when tg_table_name = 'trading_accounts' then (case when tg_op = 'DELETE' then old.id else new.id end)
                else (case when tg_op = 'DELETE' then old.account_id else new.account_id end) end;
    select decrypted_secret into hub_url from vault.decrypted_secrets where name = 'ipfx_hub_event_url' limit 1;
    if acc is not null and hub_url is not null then
      select decrypted_secret into hub_secret from vault.decrypted_secrets where name = 'ipfx_hub_secret' limit 1;
      perform net.http_post(url := hub_url, body := jsonb_build_object('account_id', acc, 't', tg_table_name),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-hub-secret', hub_secret), timeout_milliseconds := 3000);
    end if;
  exception when others then null;
  end;
  return null;
exception when others then
  return null;
end $$;
revoke all on function public.notify_account_change() from public, anon, authenticated;

drop trigger if exists pending_orders_push on public.pending_orders;
create trigger pending_orders_push after insert or update of status, trigger_price or delete on public.pending_orders
  for each row execute function public.notify_account_change();
