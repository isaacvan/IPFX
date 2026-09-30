-- S2: prevent double payouts.
--  * at most one 'requested' payout per account (function check + unique partial index as a race backstop)
--  * approval re-checks, under FOR UPDATE, that no approved/paid payout already covers the period

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
  v_min_withdrawal  constant numeric := 1000;
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

  -- One open request per account: a second request while the first is still
  -- pending would cover the same period and could be approved twice.
  if exists (select 1 from public.payouts where account_id = p_account_id and status = 'requested') then
    raise exception 'payout_pending';
  end if;

  select max(period_end) into v_last_period_end
    from public.payouts where account_id = p_account_id and status in ('approved','paid');

  v_days_since := extract(epoch from (now() - coalesce(v_last_period_end, v_acct.funded_at, v_acct.created_at))) / 86400;
  if v_days_since < v_min_days then
    raise exception 'too_soon:% days since last payout, minimum % days', round(v_days_since,1), v_min_days;
  end if;

  -- period_end is the real timestamp of the last trade actually included,
  -- not now() â€” a trade closing after this SELECT stays out of this
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
  -- to review before money moves â€” an admin can only fast-track small,
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

CREATE OR REPLACE FUNCTION public.fn_approve_payout(p_payout_id uuid, p_admin_id uuid)
 RETURNS payouts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Re-check under the row locks: never approve a period that another approved/paid payout already covers.
  if exists (select 1 from public.payouts p
              where p.account_id = v_payout.account_id and p.id <> v_payout.id
                and p.status in ('approved','paid')
                and p.period_end >= v_payout.period_end) then
    raise exception 'period_already_paid';
  end if;

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
$function$;

create unique index if not exists payouts_one_open_request_per_account
  on public.payouts (account_id) where status = 'requested';
