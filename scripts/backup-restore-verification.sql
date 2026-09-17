-- Run against a restored, non-production Supabase project only.
-- This file is deliberately read-only and returns launch-critical invariants.
select current_database() as restored_database, now() as checked_at;

select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('trading_accounts','trades','commerce_orders','commerce_outbox','admin_audit_log')
order by table_name;

select
  (select count(*) from public.trading_accounts) as trading_accounts,
  (select count(*) from public.trades) as trades,
  (select count(*) from public.commerce_orders) as commerce_orders,
  (select count(*) from public.admin_audit_log) as admin_audit_events;

select count(*) as orphaned_trades
from public.trades t
left join public.trading_accounts a on a.id = t.account_id
where a.id is null;

select count(*) as duplicate_checkout_requests
from (
  select user_id, request_key
  from public.commerce_orders
  group by user_id, request_key
  having count(*) > 1
) duplicates;

select count(*) as duplicate_provider_intents
from (
  select provider_intent_id
  from public.commerce_orders
  where provider_intent_id is not null
  group by provider_intent_id
  having count(*) > 1
) duplicates;
