-- ============================================================
-- IPFX Capital — Trade Syncer, Phase 4 (shadow-only)
--
-- Report §12 architecture, implemented strictly within the Phase 4
-- rollout step (§12.12): "Shadow mode: no real orders; compare shadow
-- P&L to source." No provider adapter exists anywhere in this codebase
-- — there is no code path capable of sending a live order to any broker,
-- TradeLocker, or any other third party. dest_order.status is
-- constrained to 'shadow_only' by this migration's own trigger design
-- and the existing fn_block_live_dest_order() guard from
-- internal-control-core.sql, which independently blocks 'sent'/'filled'
-- unless broker_account.api_mode='live' AND automation_permitted_until
-- is current — neither of which this migration ever sets.
--
-- Per report §12.1, a Trade Syncer may copy only to an account owned or
-- controlled by iPFX. The one broker_account row this migration creates
-- is an internal placeholder for shadow measurement, not a connection
-- to any external platform.
-- ============================================================

create extension if not exists pg_net with schema extensions;

-- Shadow destination "equity" is a placeholder assumption (no real
-- destination account exists yet) — needed for the risk-normalized
-- sizing formula (report §12.7). Documented, not hidden: every
-- replication_event this produces is tagged with the equity value used.
alter table public.broker_account add column if not exists shadow_equity numeric(18,2) not null default 100000;

insert into public.broker_account (provider_id, api_mode, netting_mode, shadow_equity)
select 'ipfx-internal-shadow', 'shadow', 'netting', 100000
where not exists (select 1 from public.broker_account where provider_id = 'ipfx-internal-shadow');

-- Shared secret the trigger attaches to its call so the edge function can
-- reject requests that didn't come from this trigger, independent of
-- whatever key satisfies Supabase's own gateway. This fixed value must
-- also be set as this project's SYNCER_SHARED_SECRET edge function
-- secret (Functions -> trade-syncer-shadow -> Secrets, or `supabase
-- secrets set`) — both sides need the identical string. Rotate by
-- updating both places together; never commit the real value elsewhere.
select vault.create_secret('62612cc425dcf8f65e04a5c946d28f19c06f9ded68f50a82', 'syncer_shared_secret', 'Shared secret the order_audit_events trigger sends to trade-syncer-shadow')
where not exists (select 1 from vault.secrets where name = 'syncer_shared_secret');

-- Async, non-blocking call to the shadow syncer on every open/close.
-- Wrapped so a failure here can NEVER break real trading: exceptions are
-- caught and swallowed, exactly like logAudit() in trading-engine.
create or replace function public.fn_notify_trade_syncer_shadow() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_secret text;
  v_url text := 'https://agulweemteoeagscmppy.supabase.co/functions/v1/trade-syncer-shadow';
begin
  if NEW.event not in ('open', 'close') then
    return NEW;
  end if;
  begin
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'syncer_shared_secret';
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'X-Syncer-Secret', coalesce(v_secret, '')),
      body := jsonb_build_object('order_audit_event_id', NEW.id)
    );
  exception when others then
    null; -- shadow syncer notification must never block or fail real trading
  end;
  return NEW;
end;
$$;

drop trigger if exists trg_notify_trade_syncer_shadow on public.order_audit_events;
create trigger trg_notify_trade_syncer_shadow after insert on public.order_audit_events
  for each row execute function public.fn_notify_trade_syncer_shadow();

select 'trade-syncer-shadow schema ready' as result;
