begin;

alter table public.trading_accounts
  add column if not exists breached_at timestamptz,
  add column if not exists breach_equity numeric,
  add column if not exists breach_floor numeric,
  add column if not exists resumed_from_account_id uuid references public.trading_accounts(id);

create unique index if not exists trading_accounts_one_resume_per_breach_idx
  on public.trading_accounts (resumed_from_account_id)
  where resumed_from_account_id is not null;

create table if not exists public.account_breach_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.trading_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_type text not null,
  stage integer not null,
  reason text not null check (reason in ('max_drawdown','daily_loss')),
  trigger_equity numeric not null,
  breach_floor numeric not null,
  triggered_at timestamptz not null default clock_timestamp(),
  unique (account_id)
);
alter table public.account_breach_events enable row level security;
revoke all on table public.account_breach_events from public, anon;
grant select on table public.account_breach_events to authenticated;
grant select, insert on table public.account_breach_events to service_role;
drop policy if exists "own breach read" on public.account_breach_events;
create policy "own breach read" on public.account_breach_events
  for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.fn_claim_account_breach(
  p_account_id uuid,
  p_reason text,
  p_trigger_equity numeric,
  p_breach_floor numeric
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare a public.trading_accounts;
begin
  if p_reason not in ('max_drawdown','daily_loss')
     or p_trigger_equity is null or p_breach_floor is null then
    raise exception 'INVALID_BREACH_CLAIM';
  end if;
  select * into a from public.trading_accounts where id = p_account_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  if a.status = 'breached' then return false; end if;
  if a.status <> 'active' then raise exception 'ACCOUNT_NOT_ACTIVE'; end if;
  update public.trading_accounts
     set status = 'breached', breach_reason = p_reason,
         breached_at = clock_timestamp(), breach_equity = p_trigger_equity,
         breach_floor = p_breach_floor, updated_at = clock_timestamp()
   where id = p_account_id;
  insert into public.account_breach_events(
    account_id,user_id,challenge_type,stage,reason,trigger_equity,breach_floor
  ) values (
    a.id,a.user_id,a.challenge_type,a.stage,p_reason,p_trigger_equity,p_breach_floor
  ) on conflict (account_id) do nothing;
  update public.pending_orders
     set status = 'cancelled', resolved_at = clock_timestamp()
   where account_id = p_account_id and status = 'pending';
  return true;
end;
$$;
revoke all on function public.fn_claim_account_breach(uuid,text,numeric,numeric) from public, anon, authenticated;
grant execute on function public.fn_claim_account_breach(uuid,text,numeric,numeric) to service_role;

create or replace function public.fn_keep_breached_account_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'breached' and new.status <> 'breached' then
    raise exception 'BREACHED_ACCOUNT_IS_FROZEN';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_keep_breached_account_frozen on public.trading_accounts;
create trigger trg_keep_breached_account_frozen
before update on public.trading_accounts for each row
execute function public.fn_keep_breached_account_frozen();

create or replace function public.fn_require_active_trade_account()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from public.trading_accounts a
    where a.id = new.account_id and a.user_id = new.user_id and a.status = 'active'
  ) then
    raise exception 'TRADING_ACCOUNT_FROZEN';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_require_active_trade_account on public.trades;
create trigger trg_require_active_trade_account
before insert on public.trades for each row execute function public.fn_require_active_trade_account();
drop trigger if exists trg_require_active_pending_account on public.pending_orders;
create trigger trg_require_active_pending_account
before insert on public.pending_orders for each row execute function public.fn_require_active_trade_account();

alter table public.commerce_orders
  add column if not exists provisioned_account_id uuid references public.trading_accounts(id),
  add column if not exists source_account_id uuid references public.trading_accounts(id);

create unique index if not exists commerce_orders_one_continue_per_source_idx
  on public.commerce_orders(source_account_id)
  where source_account_id is not null;

alter table public.commerce_orders drop constraint if exists commerce_orders_currency_check;
alter table public.commerce_orders
  add constraint commerce_orders_currency_check check (currency in ('usd','gbp'));
alter table public.commerce_catalog drop constraint if exists commerce_catalog_currency_check;
alter table public.commerce_catalog
  add constraint commerce_catalog_currency_check check (currency in ('usd','gbp'));

-- commerce_catalog has a legacy FK to challenge_presets. Keep that protection
-- intact with one non-provisioning catalog key; the paid continuation always
-- provisions from commerce_orders.source_account_id's real preset instead.
insert into public.challenge_presets(
  id,challenge_type,stage,label,starting_balance,fee_usd,profit_target_pct,
  max_drawdown_pct,daily_loss_pct,drawdown_mode,min_trading_days,min_trades,
  max_risk_per_trade_pct,daily_profit_cap_pct,min_profitable_days_pct,
  max_attempts_per_month,require_stop_loss,profit_split_pct,next_preset_id
)
select
  'infinity_continue',challenge_type,stage,'Infinity continuation add-on',
  starting_balance,null,profit_target_pct,max_drawdown_pct,daily_loss_pct,
  drawdown_mode,min_trading_days,min_trades,max_risk_per_trade_pct,
  daily_profit_cap_pct,min_profitable_days_pct,null,require_stop_loss,
  profit_split_pct,null
from public.challenge_presets where id='infinity_s1'
on conflict (id) do nothing;

insert into public.commerce_catalog(sku,label,amount_minor,currency,terms_version,enabled,snapshot,updated_at)
values (
  'infinity_continue','Continue Infinity from your current stage',1000,'gbp','2026-09-review',true,
  '{"kind":"infinity_continue","same_stage":true,"positions_reopen":false}'::jsonb,now()
)
on conflict (sku) do update set
  label=excluded.label,amount_minor=excluded.amount_minor,currency=excluded.currency,
  terms_version=excluded.terms_version,enabled=excluded.enabled,snapshot=excluded.snapshot,updated_at=now();

create or replace function public.commerce_provision_account(p_order_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  o public.commerce_orders;
  p public.challenge_presets;
  source_account public.trading_accounts;
  new_id uuid;
  start_bal numeric;
begin
  select * into o from public.commerce_orders where id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if o.provisioned_account_id is not null then return o.provisioned_account_id; end if;
  if o.status<>'paid' then raise exception 'ORDER_NOT_PAID'; end if;

  if o.sku = 'infinity_continue' then
    if o.source_account_id is null then raise exception 'SOURCE_ACCOUNT_REQUIRED'; end if;
    select * into source_account from public.trading_accounts
      where id=o.source_account_id and user_id=o.user_id for update;
    if not found or source_account.challenge_type<>'infinity' or source_account.status<>'breached' then
      raise exception 'INFINITY_BREACH_REQUIRED';
    end if;
    if exists(select 1 from public.trading_accounts where user_id=o.user_id and status='active') then
      raise exception 'ACTIVE_ACCOUNT_EXISTS';
    end if;
    select * into p from public.challenge_presets where id=source_account.preset_id;
  else
    select * into p from public.challenge_presets where id=o.sku;
  end if;
  if not found then raise exception 'PRESET_NOT_FOUND'; end if;

  start_bal := p.starting_balance;
  insert into public.trading_accounts(
    user_id,label,preset_id,challenge_type,stage,phase,status,
    starting_balance,balance,day_start_equity,day_start_date,
    profit_target_pct,max_drawdown_pct,daily_loss_pct,drawdown_mode,trailing_peak,
    min_trading_days,min_trades,max_risk_per_trade_pct,daily_profit_cap_pct,
    min_profitable_days_pct,require_stop_loss,profit_split_pct,challenge_fee_usd,total_paid_out,
    resumed_from_account_id
  ) values (
    o.user_id,p.label,p.id,p.challenge_type,p.stage,'evaluation','active',
    start_bal,start_bal,start_bal,(now() at time zone 'UTC')::date,
    p.profit_target_pct,p.max_drawdown_pct,p.daily_loss_pct,p.drawdown_mode,start_bal,
    p.min_trading_days,p.min_trades,p.max_risk_per_trade_pct,p.daily_profit_cap_pct,
    p.min_profitable_days_pct,p.require_stop_loss,p.profit_split_pct,
    case when o.sku='infinity_continue' then 0 else o.amount_minor/100.0 end,0,
    case when o.sku='infinity_continue' then o.source_account_id else null end
  ) returning id into new_id;

  update public.commerce_orders set provisioned_account_id=new_id where id=o.id;
  begin perform public.accept_qualification_v2(new_id);
  exception when undefined_function then null;
  end;
  return new_id;
end;
$$;
revoke all on function public.commerce_provision_account(uuid) from public,anon,authenticated;
grant execute on function public.commerce_provision_account(uuid) to service_role;

create or replace function public.fn_provision_paid_infinity_continue()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.sku='infinity_continue' and new.status='paid'
     and old.status is distinct from new.status then
    begin
      perform public.commerce_provision_account(new.id);
    exception when others then
      update public.commerce_orders set status='review' where id=new.id;
      insert into public.commerce_outbox(order_id,kind)
        values(new.id,'provision_review') on conflict do nothing;
    end;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_provision_paid_infinity_continue() from public,anon,authenticated;
grant execute on function public.fn_provision_paid_infinity_continue() to service_role;
drop trigger if exists trg_provision_paid_infinity_continue on public.commerce_orders;
create trigger trg_provision_paid_infinity_continue
after update of status on public.commerce_orders for each row
execute function public.fn_provision_paid_infinity_continue();

commit;
