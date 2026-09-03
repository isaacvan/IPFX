-- ============================================================
-- IPFX Capital — Payout system v2
--
-- Rebuilds the payout path from a stub into something that can
-- actually move money without double-paying, paying the wrong
-- account, or paying out before compliance gates clear.
--
-- Fixes applied here (see the corresponding review):
--   - No funded phase existed at all: an evaluation account that hit
--     its profit target became "passed" and could never trade again,
--     so there was no account to realize payable profit on. Adds a
--     real funded phase, auto-provisioned the moment evaluation
--     passes (see trading-engine/index.ts enforce()).
--   - payout_create had no status gate, no locking (double-payment
--     race), and stamped period_end = now() instead of the real last
--     included trade, silently forfeiting any trade that closed in
--     the gap between reading the summary and writing the payout.
--     Replaced by fn_request_payout/_approve/_mark_paid/_void below,
--     each wrapped in one transaction with SELECT ... FOR UPDATE.
--   - Changing profit_split_pct retroactively changed what was owed
--     on profit already earned. fn_request_payout always settles a
--     period in full before a new one can start, so a split change
--     can only ever apply to profit not yet requested.
--   - None of the conditions your own Terms §10.2 promise (KYC,
--     minimum days between payouts, consistency check, investigation
--     hold) were enforced anywhere. All four are now hard gates
--     inside the transactional functions, not just admin judgment.
--   - Idempotency: every payout call carries a client-generated key;
--     replaying the same request returns the original row instead of
--     creating a second one.
--
-- Safe to run repeatedly (idempotent DDL). Nothing here executes a
-- real money transfer — it only makes the ledger correct so a human
-- can safely act on it.
-- ============================================================

-- ---- 1. Funded phase ----
alter table public.trading_accounts
  add column if not exists phase text not null default 'evaluation' check (phase in ('evaluation','funded')),
  add column if not exists funded_from_account_id uuid references public.trading_accounts(id),
  add column if not exists funded_at timestamptz,
  add column if not exists investigation_hold boolean not null default false,
  add column if not exists investigation_note text;

create index if not exists idx_trading_accounts_funded_from on public.trading_accounts(funded_from_account_id);

-- ---- 2. KYC (status gate only — document upload/verification workflow
--    is a separate, larger feature and is not implemented here) ----
create table if not exists public.trader_kyc (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  status      text not null default 'unverified' check (status in ('unverified','pending','verified','rejected')),
  note        text,
  verified_by uuid references auth.users(id),
  verified_at timestamptz,
  updated_at  timestamptz not null default now()
);
alter table public.trader_kyc enable row level security;
drop policy if exists "own kyc read" on public.trader_kyc;
create policy "own kyc read" on public.trader_kyc for select using (user_id = auth.uid());
-- No client write policy: only the server (service role / admin-console) writes this.

-- ---- 3. Payout methods ----
-- A trader-entered DESTINATION REFERENCE, not raw payment credentials —
-- the actual transfer happens through your payment processor / bank
-- portal outside this app. Never store a full card/account number here.
create table if not exists public.payout_methods (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  method_type text not null check (method_type in ('bank_transfer','paypal','wire')),
  label       text not null,       -- trader-facing nickname, e.g. "Chase checking"
  reference   text not null,       -- masked/last-4 style reference or a PayPal email — never a full PAN/IBAN/CVV
  is_default  boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table public.payout_methods enable row level security;
drop policy if exists "own payout methods select" on public.payout_methods;
create policy "own payout methods select" on public.payout_methods for select using (user_id = auth.uid());
drop policy if exists "own payout methods insert" on public.payout_methods;
create policy "own payout methods insert" on public.payout_methods for insert with check (user_id = auth.uid());
drop policy if exists "own payout methods delete" on public.payout_methods;
create policy "own payout methods delete" on public.payout_methods for delete using (user_id = auth.uid());

-- ---- 4. Payouts: extend lifecycle + audit trail ----
alter table public.payouts
  add column if not exists currency         text not null default 'USD',
  add column if not exists idempotency_key  text,
  add column if not exists created_by       uuid references auth.users(id),
  add column if not exists approved_by      uuid references auth.users(id),
  add column if not exists approved_at      timestamptz,
  add column if not exists paid_by          uuid references auth.users(id),
  add column if not exists void_reason      text,
  add column if not exists voided_by        uuid references auth.users(id),
  add column if not exists voided_at        timestamptz,
  add column if not exists payout_method_id uuid references public.payout_methods(id);

create unique index if not exists idx_payouts_idempotency on public.payouts(idempotency_key) where idempotency_key is not null;

-- lifecycle: requested -> approved -> paid, or -> void at any point before paid
update public.payouts set status = 'requested' where status = 'pending';
alter table public.payouts drop constraint if exists payouts_status_check;
alter table public.payouts add constraint payouts_status_check
  check (status in ('requested','approved','paid','void'));

-- ---- 5. Referral commission tracking ----
-- Fee actually paid at signup wasn't stored anywhere before now, which
-- made both this and any future refund/commission logic impossible.
alter table public.trading_accounts
  add column if not exists challenge_fee_usd numeric(10,2);

create table if not exists public.referral_rewards (
  id                 uuid primary key default gen_random_uuid(),
  referrer_user_id   uuid not null references auth.users(id) on delete cascade,
  referred_user_id   uuid not null references auth.users(id) on delete cascade,
  triggering_payout_id uuid references public.payouts(id),
  amount_usd         numeric(10,2) not null,
  status             text not null default 'pending' check (status in ('pending','paid','void')),
  created_at         timestamptz not null default now(),
  paid_at            timestamptz,
  unique (referred_user_id) -- one commission per referred trader's first payout
);
alter table public.referral_rewards enable row level security;
drop policy if exists "own referral rewards" on public.referral_rewards;
create policy "own referral rewards" on public.referral_rewards for select using (referrer_user_id = auth.uid());

-- ---- 6. trader_payout_summary: DISPLAY ONLY from here on ----
-- Used by the admin overview to show an at-a-glance "owed" figure.
-- The authoritative, transactional calculation lives inside
-- fn_request_payout below — this view is never used to move money.
-- Restricted to funded accounts only, since evaluation-phase profit
-- is never payable.
create or replace view public.trader_payout_summary as
with last_payout as (
  select account_id, max(period_end) as last_end
  from public.payouts
  where status in ('approved','paid')
  group by account_id
),
realized as (
  select
    t.account_id,
    a.user_id,
    a.profit_split_pct,
    a.status as account_status,
    coalesce(sum(t.pnl), 0) as realized_since
  from public.trades t
  join public.trading_accounts a on a.id = t.account_id
  left join last_payout lp on lp.account_id = t.account_id
  where t.status = 'closed'
    and a.phase = 'funded'
    and (lp.last_end is null or t.closed_at > lp.last_end)
  group by t.account_id, a.user_id, a.profit_split_pct, a.status
)
select
  account_id, user_id, account_status, profit_split_pct,
  round(realized_since, 2) as realized_profit_unpaid,
  round(greatest(realized_since, 0) * profit_split_pct / 100, 2) as trader_share_owed
from realized;

comment on view public.trader_payout_summary is
  'Display-only estimate of owed profit on funded accounts. fn_request_payout recomputes this transactionally at request time — this view is never itself used to move money.';

-- ---- 7. Atomic, gated payout functions ----
-- All four are SECURITY DEFINER: callers reach them only through the
-- edge functions (service role), never directly from the browser.

create or replace function public.fn_request_payout(
  p_account_id      uuid,
  p_requested_by    uuid,
  p_is_admin        boolean,
  p_idempotency_key text,
  p_payout_method_id uuid default null
) returns public.payouts
language plpgsql
security definer
set search_path = public
as $$
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
$$;

create or replace function public.fn_approve_payout(p_payout_id uuid, p_admin_id uuid)
returns public.payouts
language plpgsql security definer set search_path = public
as $$
declare
  v_payout public.payouts%rowtype;
  v_acct   public.trading_accounts%rowtype;
  v_kyc    text;
begin
  select * into v_payout from public.payouts where id = p_payout_id for update;
  if not found then raise exception 'payout_not_found'; end if;
  if v_payout.status <> 'requested' then raise exception 'not_requested:%', v_payout.status; end if;

  select * into v_acct from public.trading_accounts where id = v_payout.account_id for update;
  if v_acct.status <> 'active' then raise exception 'account_not_in_good_standing:%', v_acct.status; end if;
  if v_acct.investigation_hold then raise exception 'investigation_hold'; end if;
  select status into v_kyc from public.trader_kyc where user_id = v_acct.user_id;
  if v_kyc is distinct from 'verified' then raise exception 'kyc_not_verified'; end if;
  if v_payout.trader_share > v_acct.balance then raise exception 'insufficient_balance'; end if;

  update public.payouts set status = 'approved', approved_by = p_admin_id, approved_at = now()
    where id = p_payout_id returning * into v_payout;

  update public.trading_accounts set
    balance = round(balance - v_payout.trader_share, 2),
    total_paid_out = round(total_paid_out + v_payout.trader_share, 2),
    day_start_equity = round(day_start_equity - v_payout.trader_share, 2),
    updated_at = now()
  where id = v_acct.id;

  return v_payout;
end;
$$;

create or replace function public.fn_mark_paid(p_payout_id uuid, p_admin_id uuid)
returns public.payouts
language plpgsql security definer set search_path = public
as $$
declare v_payout public.payouts%rowtype;
begin
  select * into v_payout from public.payouts where id = p_payout_id for update;
  if not found then raise exception 'payout_not_found'; end if;
  if v_payout.status <> 'approved' then raise exception 'not_approved:%', v_payout.status; end if;
  update public.payouts set status = 'paid', paid_at = now(), paid_by = p_admin_id
    where id = p_payout_id returning * into v_payout;
  return v_payout;
end;
$$;

create or replace function public.fn_void_payout(p_payout_id uuid, p_admin_id uuid, p_reason text)
returns public.payouts
language plpgsql security definer set search_path = public
as $$
declare v_payout public.payouts%rowtype;
begin
  select * into v_payout from public.payouts where id = p_payout_id for update;
  if not found then raise exception 'payout_not_found'; end if;
  if v_payout.status = 'paid' then raise exception 'cannot_void_paid'; end if;
  if v_payout.status = 'void' then raise exception 'already_void'; end if;

  -- Reverse the balance effect if money was already committed (approved
  -- but not yet actually sent) — e.g. a bank transfer bounced.
  if v_payout.status = 'approved' then
    update public.trading_accounts set
      balance = round(balance + v_payout.trader_share, 2),
      total_paid_out = round(total_paid_out - v_payout.trader_share, 2),
      day_start_equity = round(day_start_equity + v_payout.trader_share, 2),
      updated_at = now()
    where id = v_payout.account_id;
  end if;

  update public.payouts set status = 'void', void_reason = p_reason, voided_by = p_admin_id, voided_at = now()
    where id = p_payout_id returning * into v_payout;
  return v_payout;
end;
$$;

-- ---- 8. Referral commission on a trader's first payout ----
-- Called from fn_mark_paid's caller (admin-console) after a payout is
-- actually paid, not on request/approval — the promised copy is
-- "10% ... within 30 days of their first payout," i.e. a real, sent
-- payment, not merely an approved one.
create or replace function public.fn_maybe_award_referral(p_payout_id uuid)
returns public.referral_rewards
language plpgsql security definer set search_path = public
as $$
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

  select challenge_fee_usd into v_fee from public.trading_accounts where id = v_payout.account_id;
  if v_fee is null then return null; end if; -- fee wasn't recorded (pre-fix account) — nothing to compute from

  insert into public.referral_rewards (referrer_user_id, referred_user_id, triggering_payout_id, amount_usd, status)
  values (v_referrer, v_payout.user_id, p_payout_id, round(v_fee * 0.10, 2), 'pending')
  on conflict (referred_user_id) do nothing
  returning * into v_reward;

  return v_reward;
end;
$$;

-- Verify after running:
--   select proname from pg_proc where proname like 'fn_%payout%' or proname like 'fn_maybe%';
--   select * from public.trader_kyc limit 5;
--   select column_name from information_schema.columns where table_name='trading_accounts' and column_name in ('phase','investigation_hold','challenge_fee_usd');
