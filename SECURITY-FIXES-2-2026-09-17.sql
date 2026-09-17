-- ============================================================
-- IPFX Capital — security fixes batch 2 (2026-09-17)
-- Safe to run again. "Rules v2" items apply only to accounts opened on
-- or after 2026-10-01 00:00 UTC, honouring the Terms' 14-day notice
-- clause; existing accounts keep the rules they signed up under.
--
--  A. Execution costs per instrument (commission + slippage), crypto rows.
--  B. Per-account order lock, so concurrent orders can't both pass the
--     margin / risk checks.
--  C. account_progress (rules v2): partial closes and trades held under
--     60s don't count as trades; a profitable day needs >= 0.25% profit.
--  D. Payouts (rules v2): at least 4 trading days in the period and no
--     single day above 40% of the period's profit.
--  E. Referral commission withheld where referrer and referred shared an IP.
--  F. user_profiles: traders can no longer change their own jurisdiction
--     flag, referral fields, or an already-set country.
--  G. trading_accounts: mirror columns hidden from traders, so nobody can
--     tell when their trades are copied with real money.
-- ============================================================

begin;

-- ---- A. Execution costs ----
alter table public.symbol_specs drop constraint if exists symbol_specs_asset_class_check;
alter table public.symbol_specs add constraint symbol_specs_asset_class_check
  check (asset_class in ('forex','metal','index','crypto'));
alter table public.symbol_specs add column if not exists commission_per_lot_usd numeric not null default 0
  check (commission_per_lot_usd >= 0);
comment on column public.symbol_specs.commission_per_lot_usd is
  'Round-turn commission in USD per 1.00 lot, charged when a position (or part of it) closes. Rules-v2 accounts only.';
comment on column public.symbol_specs.slippage_bps is
  'Adverse slippage in basis points applied to market executions and stop fills. Rules-v2 accounts only.';

insert into public.symbol_specs (symbol, display_name, asset_class, digits, contract_size, quote_currency,
  min_volume, max_volume, volume_step, base_spread, max_spread, slippage_bps, session_hours, enabled)
values
  ('BTCUSD','Bitcoin','crypto',2,1,'USD',0.01,100,0.01,25,100,5,'24/7',true),
  ('ETHUSD','Ethereum','crypto',2,1,'USD',0.01,100,0.01,2.5,10,5,'24/7',true),
  ('LTCUSD','Litecoin','crypto',2,1,'USD',0.01,100,0.01,0.5,2,5,'24/7',true),
  ('ADAUSD','Cardano','crypto',4,1,'USD',0.01,100,0.01,0.003,0.012,5,'24/7',true),
  ('SOLUSD','Solana','crypto',2,1,'USD',0.01,100,0.01,0.15,0.6,5,'24/7',true),
  ('DOTUSD','Polkadot','crypto',3,1,'USD',0.01,100,0.01,0.02,0.08,5,'24/7',true)
on conflict (symbol) do nothing;

update public.symbol_specs set commission_per_lot_usd = 6, slippage_bps = 0.3, updated_at = now() where asset_class = 'forex';
update public.symbol_specs set commission_per_lot_usd = 6, slippage_bps = 0.5, updated_at = now() where asset_class = 'metal';
update public.symbol_specs set commission_per_lot_usd = 0, slippage_bps = 0.5, updated_at = now() where asset_class = 'index';
update public.symbol_specs set commission_per_lot_usd = 0, slippage_bps = 5,   updated_at = now() where asset_class = 'crypto';

-- ---- B. Per-account order lock ----
create table if not exists public.account_order_locks (
  account_id uuid primary key,
  locked_until timestamptz not null
);
alter table public.account_order_locks enable row level security;
revoke all on public.account_order_locks from anon, authenticated;

create or replace function public.claim_account_order_lock(p_account uuid, p_seconds int default 5)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into public.account_order_locks (account_id, locked_until)
  values (p_account, now() + make_interval(secs => greatest(1, least(coalesce(p_seconds, 5), 30))))
  on conflict (account_id) do update set locked_until = excluded.locked_until
    where public.account_order_locks.locked_until < now();
  return found;
end $$;

create or replace function public.release_account_order_lock(p_account uuid)
returns void language sql security definer set search_path = public as $$
  update public.account_order_locks set locked_until = now() where account_id = p_account;
$$;

revoke all on function public.claim_account_order_lock(uuid, int) from public, anon, authenticated;
revoke all on function public.release_account_order_lock(uuid) from public, anon, authenticated;
grant execute on function public.claim_account_order_lock(uuid, int) to service_role;
grant execute on function public.release_account_order_lock(uuid) to service_role;

-- ---- C. account_progress (legacy accounts compute exactly as before) ----
create or replace view public.account_progress as
with closed as (
  select t.account_id,
         (t.closed_at at time zone 'UTC')::date as day,
         t.pnl,
         case when a.created_at >= timestamptz '2026-10-01 00:00:00+00'
              then (t.close_reason is distinct from 'partial'
                    and t.closed_at - t.opened_at >= interval '60 seconds')
              else true end as counts,
         case when a.created_at >= timestamptz '2026-10-01 00:00:00+00'
              then a.starting_balance * 0.0025 else 0 end as min_day_profit
    from public.trades t
    join public.trading_accounts a on a.id = t.account_id
   where t.status = 'closed' and t.closed_at is not null
), days as (
  select account_id, day,
         sum(pnl) as day_pnl,
         count(*) filter (where counts) as day_trades,
         max(min_day_profit) as min_day_profit
    from closed
   group by account_id, day
)
select a.id as account_id,
       a.user_id,
       coalesce(count(d.day) filter (where d.day_trades > 0), 0)::integer as trading_days,
       coalesce(sum(d.day_trades), 0)::integer as trades_closed,
       coalesce(count(d.day) filter (where d.day_trades > 0 and d.day_pnl > d.min_day_profit), 0)::integer as profitable_days,
       case when count(d.day) filter (where d.day_trades > 0) > 0
            then round(100.0 * count(d.day) filter (where d.day_trades > 0 and d.day_pnl > d.min_day_profit)
                       / count(d.day) filter (where d.day_trades > 0), 2)
            else null end as profitable_days_pct
  from public.trading_accounts a
  left join days d on d.account_id = a.id
 group by a.id, a.user_id;

-- ---- D. Payout rules (live definition, rules-v2 block added) ----
CREATE OR REPLACE FUNCTION public.fn_request_payout(p_account_id uuid, p_requested_by uuid, p_is_admin boolean, p_idempotency_key text, p_payout_method_id uuid DEFAULT NULL::uuid)
 RETURNS payouts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_acct            public.trading_accounts%rowtype;
  v_kyc_status      text;
  v_last_period_end timestamptz;
  v_period_end      timestamptz;
  v_net             numeric(14,2);
  v_amount          numeric(14,2);
  v_best_win        numeric(14,2);
  v_gross_win       numeric(14,2);
  v_days_since      numeric;
  v_status          text;
  v_best_day        numeric(14,2);
  v_period_days     int;
  v_row             public.payouts;
  v_min_days        constant int     := 7;
  v_min_withdrawal  constant numeric := 50;
  v_auto_cap        constant numeric := 5000;
begin
  if p_idempotency_key is not null then
    select * into v_row from public.payouts where idempotency_key = p_idempotency_key;
    if found then return v_row; end if;
  end if;

  select * into v_acct from public.trading_accounts where id = p_account_id for update;
  if not found then raise exception 'account_not_found'; end if;
  if v_acct.phase <> 'funded' then raise exception 'not_funded'; end if;
  if v_acct.status <> 'active' then raise exception 'account_not_in_good_standing:%', v_acct.status; end if;
  if v_acct.investigation_hold then raise exception 'investigation_hold'; end if;

  select status into v_kyc_status from public.trader_kyc where user_id = v_acct.user_id;
  if v_kyc_status is distinct from 'verified' then raise exception 'kyc_not_verified'; end if;

  select max(period_end) into v_last_period_end
    from public.payouts where account_id = p_account_id and status in ('approved','paid');

  v_days_since := extract(epoch from (now() - coalesce(v_last_period_end, v_acct.funded_at, v_acct.created_at))) / 86400;
  if v_days_since < v_min_days then
    raise exception 'too_soon:% days since last payout, minimum % days', round(v_days_since,1), v_min_days;
  end if;

  -- period_end is the real timestamp of the last trade actually included,
  -- not now() — a trade closing after this SELECT stays out of this
  -- period and is correctly picked up by the next request instead of
  -- silently vanishing.
  select coalesce(sum(t.pnl),0), max(t.closed_at)
    into v_net, v_period_end
    from public.trades t
    where t.account_id = p_account_id and t.status = 'closed'
      and (v_last_period_end is null or t.closed_at > v_last_period_end);

  v_amount := round(greatest(v_net,0) * v_acct.profit_split_pct/100, 2);
  if v_amount <= 0 or v_period_end is null then raise exception 'nothing_owed'; end if;
  if v_amount < v_min_withdrawal then raise exception 'below_minimum:minimum $%', v_min_withdrawal; end if;

  select coalesce(max(t.pnl),0), coalesce(sum(t.pnl) filter (where t.pnl > 0),0)
    into v_best_win, v_gross_win
    from public.trades t
    where t.account_id = p_account_id and t.status = 'closed' and t.pnl > 0
      and (v_last_period_end is null or t.closed_at > v_last_period_end);
  if v_gross_win > 0 and (v_best_win / v_gross_win) * 100 > 25 then
    raise exception 'consistency_check_failed:single trade is more than 25%% of this period''s profit';
  end if;

  -- Terms 10.2 / 7.5, accounts opened from 1 Oct 2026: splitting one lucky
  -- day into many small trades no longer passes the single-trade check.
  if v_acct.created_at >= timestamptz '2026-10-01 00:00:00+00' then
    select coalesce(max(x.day_pnl), 0), count(*)
      into v_best_day, v_period_days
      from (select sum(t.pnl) as day_pnl
              from public.trades t
             where t.account_id = p_account_id and t.status = 'closed'
               and (v_last_period_end is null or t.closed_at > v_last_period_end)
             group by (t.closed_at at time zone 'UTC')::date) x;
    if v_period_days < 4 then
      raise exception 'min_trading_days:% trading days since last payout, minimum 4', v_period_days;
    end if;
    if v_net > 0 and (v_best_day / v_net) * 100 > 40 then
      raise exception 'consistency_check_failed:best day is more than 40%% of this period''s profit';
    end if;
  end if;

  -- Trader-initiated requests, and any amount above the auto-approve cap
  -- even when admin-initiated, always land in "requested" for a human
  -- to review before money moves — an admin can only fast-track small,
  -- already-earned amounts, not skip review on large ones.
  if p_is_admin and v_amount <= v_auto_cap then
    v_status := 'approved';
  else
    v_status := 'requested';
  end if;

  insert into public.payouts (
    user_id, account_id, period_start, period_end, gross_profit, split_pct, trader_share,
    status, currency, idempotency_key, created_by, payout_method_id, approved_by, approved_at
  ) values (
    v_acct.user_id, p_account_id, v_last_period_end, v_period_end,
    round(greatest(v_net,0), 2), v_acct.profit_split_pct, v_amount,
    v_status, 'USD', p_idempotency_key, p_requested_by, p_payout_method_id,
    case when v_status = 'approved' then p_requested_by end,
    case when v_status = 'approved' then now() end
  ) returning * into v_row;

  if v_status = 'approved' then
    update public.trading_accounts set
      balance = round(balance - v_amount, 2),
      total_paid_out = round(total_paid_out + v_amount, 2),
      day_start_equity = round(day_start_equity - v_amount, 2),
      updated_at = now()
    where id = p_account_id;
  end if;

  return v_row;
end;
$function$;

-- ---- E. Referral commission (live definition, shared-IP exclusion added) ----
CREATE OR REPLACE FUNCTION public.fn_maybe_award_referral(p_payout_id uuid)
 RETURNS referral_rewards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_payout   public.payouts%rowtype;
  v_referrer uuid;
  v_referrer_code varchar(10);
  v_fee      numeric(10,2);
  v_reward   public.referral_rewards%rowtype;
  v_prior_paid_count int;
begin
  select * into v_payout from public.payouts where id = p_payout_id;
  if not found or v_payout.status <> 'paid' then raise exception 'payout_not_paid'; end if;

  -- only the referred trader's FIRST paid payout triggers a reward
  select count(*) into v_prior_paid_count
    from public.payouts
    where user_id = v_payout.user_id and status = 'paid' and id <> p_payout_id;
  if v_prior_paid_count > 0 then return null; end if;

  select referred_by_code into v_referrer_code from public.user_profiles where user_id = v_payout.user_id;
  if v_referrer_code is null then return null; end if;

  select user_id into v_referrer from public.user_profiles where referral_code = v_referrer_code;
  if v_referrer is null then return null; end if;

  -- Terms 21: no commission where referrer and referred traded from the
  -- same IP address (self-referral through a second identity).
  if exists (select 1 from public.order_audit_events a
               join public.order_audit_events b on b.client_ip = a.client_ip
              where a.user_id = v_referrer and b.user_id = v_payout.user_id
                and a.client_ip is not null) then
    return null;
  end if;

  select challenge_fee_usd into v_fee from public.trading_accounts where id = v_payout.account_id;
  if v_fee is null then return null; end if; -- fee wasn't recorded (pre-fix account) — nothing to compute from

  insert into public.referral_rewards (referrer_user_id, referred_user_id, triggering_payout_id, amount_usd, status)
  values (v_referrer, v_payout.user_id, p_payout_id, round(v_fee * 0.10, 2), 'pending')
  on conflict (referred_user_id) do nothing
  returning * into v_reward;

  return v_reward;
end;
$function$;

-- ---- F. user_profiles: protect server-owned fields from self-edits ----
create or replace function public.guard_user_profile_fields()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    nullif(current_setting('request.jwt.claim.role', true), ''), '');
begin
  -- Only requests made with a trader's own session are restricted. The
  -- signup trigger, admin tools and the service role are trusted.
  if v_role not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
    new.referral_code := old.referral_code;
    new.referred_by_code := old.referred_by_code;
    new.referral_count := old.referral_count;
    new.age_confirmed := old.age_confirmed or coalesce(new.age_confirmed, false); -- may confirm, never un-confirm
    if old.country_code is not null then
      new.country_code := old.country_code;
      new.restricted_jurisdiction := old.restricted_jurisdiction;
    end if;
  else
    new.referral_count := 0;
  end if;

  if new.country_code is not null and (tg_op = 'INSERT' or old.country_code is null) then
    new.country_code := upper(new.country_code);
    new.restricted_jurisdiction := exists (
      select 1 from public.restricted_countries rc where rc.country_code = new.country_code);
  elsif tg_op = 'INSERT' then
    new.restricted_jurisdiction := false;
  elsif old.country_code is null then
    new.restricted_jurisdiction := old.restricted_jurisdiction;
  end if;
  return new;
end $$;

drop trigger if exists guard_user_profile_fields on public.user_profiles;
create trigger guard_user_profile_fields
  before insert or update on public.user_profiles
  for each row execute function public.guard_user_profile_fields();

-- ---- G. Hide mirror columns from traders ----
-- Column-level SELECT: a column added to trading_accounts later must be
-- granted to authenticated explicitly if the website needs to read it.
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'trading_accounts'
     and column_name not ilike '%mirror%';
  execute 'revoke select on public.trading_accounts from anon, authenticated';
  execute format('grant select (%s) on public.trading_accounts to authenticated', cols);
end $$;

commit;

-- ---- Verification (single row) ----
select
  (select count(*) from public.symbol_specs where asset_class = 'crypto')                      as crypto_specs,
  (select count(*) from public.symbol_specs where commission_per_lot_usd > 0)                  as specs_with_commission,
  (select count(*) from pg_proc where proname in ('claim_account_order_lock','release_account_order_lock')) as order_lock_fns,
  (select pg_get_viewdef('public.account_progress'::regclass) ilike '%60 seconds%')              as progress_v2,
  (select pg_get_functiondef('public.fn_request_payout(uuid,uuid,boolean,text,uuid)'::regprocedure) ilike '%min_trading_days%') as payout_v2,
  (select pg_get_functiondef('public.fn_maybe_award_referral(uuid)'::regprocedure) ilike '%client_ip%') as referral_ip_check,
  (select count(*) from pg_trigger where tgname = 'guard_user_profile_fields')                  as profile_guard,
  has_column_privilege('authenticated', 'public.trading_accounts', 'mirror_enabled', 'SELECT')   as trader_can_read_mirror,
  has_column_privilege('authenticated', 'public.trading_accounts', 'balance', 'SELECT')          as trader_can_read_balance;
