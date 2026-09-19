begin;

-- A demo account is deliberately a different phase and status. This keeps it
-- out of every challenge/funded-account query that relies on status='active',
-- while still allowing the trading engine to execute simulated orders on it.
alter table public.trading_accounts drop constraint if exists trading_accounts_phase_check;
alter table public.trading_accounts
  add constraint trading_accounts_phase_check
  check (phase in ('evaluation','funded','demo'));

alter table public.trading_accounts drop constraint if exists trading_accounts_status_check;
alter table public.trading_accounts
  add constraint trading_accounts_status_check
  check (status in ('active','passed','breached','demo'));

alter table public.trading_accounts drop constraint if exists trading_accounts_challenge_type_check;
alter table public.trading_accounts
  add constraint trading_accounts_challenge_type_check
  check (challenge_type in ('infinity','traditional','futures','pac','funded','demo'));

create unique index if not exists trading_accounts_one_demo_per_user_idx
  on public.trading_accounts(user_id)
  where phase='demo';

-- A breached account is read-only evidence the trader is entitled to see.
-- Manual launch/approval revocations remain hidden; only rule-breach rows are
-- added back to the existing owner SELECT policy.
drop policy if exists "own approved accounts read" on public.trading_accounts;
create policy "own approved accounts read"
  on public.trading_accounts for select to authenticated
  using (
    user_id=(select auth.uid())
    and (
      access_revoked_at is null
      or (status='breached' and access_revoked_reason like 'challenge_rule_breach:%')
    )
  );

create or replace function public.fn_ensure_demo_account(p_user_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_id uuid;
begin
  if p_user_id is null or not exists(select 1 from auth.users where id=p_user_id) then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- Serialise first-use creation for this user. The unique index is the final
  -- guard; this lock makes concurrent app startup + breach requests idempotent.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));

  select id into v_id from public.trading_accounts
   where user_id=p_user_id and phase='demo'
   order by created_at desc limit 1 for update;
  if found then
    -- Demo is permanent practice access. Repair only its account-level state;
    -- never touch its trade history or balance on a challenge breach.
    update public.trading_accounts
       set status='demo', access_revoked_at=null, access_revoked_reason=null,
           breach_reason=null, mirror_enabled=false, updated_at=clock_timestamp()
     where id=v_id;
    return v_id;
  end if;

  insert into public.trading_accounts(
    user_id,label,challenge_type,stage,phase,status,
    starting_balance,balance,day_start_equity,day_start_date,
    profit_target_pct,max_drawdown_pct,daily_loss_pct,drawdown_mode,trailing_peak,
    min_trading_days,min_trades,max_risk_per_trade_pct,daily_profit_cap_pct,
    min_profitable_days_pct,require_stop_loss,profit_split_pct,total_paid_out,
    mirror_enabled,access_revoked_at,access_revoked_reason
  ) values (
    p_user_id,'IPFX Demo','demo',0,'demo','demo',
    100000,100000,100000,(clock_timestamp() at time zone 'UTC')::date,
    0,100,100,'static',100000,
    0,0,null,null,null,false,0,0,false,null,null
  ) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.fn_ensure_demo_account(uuid) from public,anon,authenticated;
grant execute on function public.fn_ensure_demo_account(uuid) to service_role;

-- Replace the breach claim so freeze + reason snapshot + demo availability are
-- one transaction. A client can never race a fresh order onto the failed
-- challenge because access is revoked before this function returns.
create or replace function public.fn_claim_account_breach(
  p_account_id uuid,
  p_reason text,
  p_trigger_equity numeric,
  p_breach_floor numeric
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare a public.trading_accounts;
begin
  if p_reason not in ('max_drawdown','daily_loss')
     or p_trigger_equity is null or p_breach_floor is null then
    raise exception 'INVALID_BREACH_CLAIM';
  end if;
  select * into a from public.trading_accounts where id=p_account_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  if a.phase='demo' or a.status='demo' then raise exception 'DEMO_CANNOT_BREACH'; end if;
  if a.status='breached' then
    perform public.fn_ensure_demo_account(a.user_id);
    return false;
  end if;
  if a.status<>'active' then raise exception 'ACCOUNT_NOT_ACTIVE'; end if;

  update public.trading_accounts
     set status='breached', breach_reason=p_reason,
         breached_at=clock_timestamp(), breach_equity=p_trigger_equity,
         breach_floor=p_breach_floor, access_revoked_at=clock_timestamp(),
         access_revoked_reason='challenge_rule_breach:'||p_reason,
         mirror_enabled=false, updated_at=clock_timestamp()
   where id=p_account_id;
  insert into public.account_breach_events(
    account_id,user_id,challenge_type,stage,reason,trigger_equity,breach_floor
  ) values (
    a.id,a.user_id,a.challenge_type,a.stage,p_reason,p_trigger_equity,p_breach_floor
  ) on conflict (account_id) do nothing;
  update public.pending_orders
     set status='cancelled', resolved_at=clock_timestamp()
   where account_id=p_account_id and status='pending';
  perform public.fn_ensure_demo_account(a.user_id);
  return true;
end;
$$;
revoke all on function public.fn_claim_account_breach(uuid,text,numeric,numeric) from public,anon,authenticated;
grant execute on function public.fn_claim_account_breach(uuid,text,numeric,numeric) to service_role;

-- Challenge accounts must be active; demo orders are allowed only on the one
-- server-provisioned demo row owned by the same authenticated trader.
create or replace function public.fn_require_active_trade_account()
returns trigger language plpgsql set search_path='' as $$
begin
  if not exists (
    select 1 from public.trading_accounts a
     where a.id=new.account_id and a.user_id=new.user_id
       and a.access_revoked_at is null
       and ((a.status='active' and a.phase in ('evaluation','funded'))
         or (a.status='demo' and a.phase='demo' and a.challenge_type='demo'))
  ) then
    raise exception 'TRADING_ACCOUNT_FROZEN';
  end if;
  return new;
end;
$$;
revoke all on function public.fn_require_active_trade_account() from public,anon,authenticated;

-- Give traders who already breached before this deployment their practice
-- account too. The helper is idempotent and the partial unique index prevents
-- duplicates under concurrency.
do $$ declare r record; begin
  for r in select distinct user_id from public.trading_accounts where status='breached' loop
    perform public.fn_ensure_demo_account(r.user_id);
  end loop;
end $$;

commit;
