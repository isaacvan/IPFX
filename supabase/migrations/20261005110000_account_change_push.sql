-- Push "your account changed" to the trading page instead of it asking every 4 seconds (2026-10-05).
-- The database sends a tiny private broadcast on topic acct:<user id> whenever something the platform shows
-- changes server-side: a trade opens/closes/partially closes, SL/TP/trailing stop moves, a pending order fills,
-- the account balance/status/stage changes (pass, breach, payout, investigation), or a price alert fires.
-- The page then fetches its state once. Only the owner of the account can receive it, and no client can send
-- on these topics (there is no INSERT policy). A failed send never blocks the write that caused it.

drop policy if exists "ipfx account signals receivable by the owner" on realtime.messages;
create policy "ipfx account signals receivable by the owner" on realtime.messages
  for select to authenticated
  using (realtime.topic() = 'acct:' || (select auth.uid())::text and extension = 'broadcast');

create or replace function public.notify_account_change()
returns trigger language plpgsql security definer set search_path to '' as $$
declare uid uuid;
begin
  uid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  if uid is not null then
    perform realtime.send(jsonb_build_object('t', tg_table_name, 'op', lower(tg_op)), 'changed', 'acct:' || uid::text, true);
  end if;
  return null;
exception when others then
  return null;
end $$;
revoke all on function public.notify_account_change() from public, anon, authenticated;

-- trades: new / removed rows, and only the columns the platform displays (not the frequent marking writes).
drop trigger if exists trades_push_ins_del on public.trades;
create trigger trades_push_ins_del after insert or delete on public.trades
  for each row execute function public.notify_account_change();
drop trigger if exists trades_push_upd on public.trades;
create trigger trades_push_upd after update on public.trades
  for each row when (old.status is distinct from new.status or old.volume is distinct from new.volume
    or old.sl is distinct from new.sl or old.tp is distinct from new.tp or old.trail_distance is distinct from new.trail_distance
    or old.close_price is distinct from new.close_price or old.open_price is distinct from new.open_price)
  execute function public.notify_account_change();

-- accounts: the risk sweep rewrites the row every few seconds, so only real changes signal.
drop trigger if exists accounts_push_ins on public.trading_accounts;
create trigger accounts_push_ins after insert on public.trading_accounts
  for each row execute function public.notify_account_change();
drop trigger if exists accounts_push_upd on public.trading_accounts;
create trigger accounts_push_upd after update on public.trading_accounts
  for each row when (old.status is distinct from new.status or old.balance is distinct from new.balance
    or old.stage is distinct from new.stage or old.phase is distinct from new.phase or old.breach_reason is distinct from new.breach_reason
    or old.access_revoked_at is distinct from new.access_revoked_at or old.investigation_hold is distinct from new.investigation_hold
    or old.challenge_type is distinct from new.challenge_type or old.total_paid_out is distinct from new.total_paid_out)
  execute function public.notify_account_change();

-- price alerts: created, removed, or triggered.
drop trigger if exists price_alerts_push_ins_del on public.price_alerts;
create trigger price_alerts_push_ins_del after insert or delete on public.price_alerts
  for each row execute function public.notify_account_change();
drop trigger if exists price_alerts_push_upd on public.price_alerts;
create trigger price_alerts_push_upd after update on public.price_alerts
  for each row when (old.status is distinct from new.status)
  execute function public.notify_account_change();
