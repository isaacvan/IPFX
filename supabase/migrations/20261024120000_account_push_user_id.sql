-- Big Build step 3 (2026-10-24): the hub pushes "your account changed" to the trader's screen.
-- notify_account_change already tells the hub (pg_net) which ACCOUNT changed; it now also says which USER owns it, so the hub can
-- nudge only that trader's open pages (one small WebSocket message) instead of every page asking Supabase for its state on a timer.
-- The Realtime broadcast stays as the fallback for pages that cannot reach the hub. Nothing else in the function changes.
begin;

-- Build on the live definition only. If anything changed it since this migration was written, stop and re-read it first.
do $drift$ begin
  if md5(pg_get_functiondef('public.notify_account_change()'::regprocedure)) <> '6657c3aa773c08709d0affdad72223b7' then
    raise exception 'NOTIFY_ACCOUNT_CHANGE_SOURCE_DRIFT';
  end if;
end $drift$;

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
      perform net.http_post(url := hub_url, body := jsonb_build_object('account_id', acc, 'user_id', uid, 't', tg_table_name),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-hub-secret', hub_secret), timeout_milliseconds := 3000);
    end if;
  exception when others then null;
  end;
  return null;
exception when others then
  return null;
end $$;
revoke all on function public.notify_account_change() from public, anon, authenticated;
commit;
