-- ============================================================
-- IPFX Capital — commerce provisioning (the last mile of the
-- payment pipeline started in 20260909190000_commerce_and_mirror_safety.sql)
--
-- What existed before this file: a customer could pay (create-payment-
-- intent / payment-webhook / commerce_record_paid), which correctly
-- marks the order 'paid' and queues a 'provision_review' job in
-- commerce_outbox -- but nothing ever consumed that job. A paid order
-- sat in the outbox forever and the customer never received a trading
-- account. This closes that gap, following the exact lease/claim
-- pattern commerce_claim_receipt() already established for the
-- 'receipt' kind, and the exact trading_accounts insert shape
-- trading-engine's provisionNextStage() already uses for stage
-- progression, so a first-provisioned account looks identical in
-- shape to one produced by passing an evaluation.
--
-- Safe to run repeatedly (idempotent DDL). Additive only.
-- ============================================================

begin;

alter table public.commerce_orders
  add column if not exists provisioned_account_id uuid references public.trading_accounts(id);

-- ---- claim: same shape as commerce_claim_receipt(), for 'provision_review' ----
create function public.commerce_claim_provision()
returns public.commerce_outbox language plpgsql security definer set search_path='' as $$
declare j public.commerce_outbox;
begin
  update public.commerce_outbox set status='review',last_error='PROVISION_RECONCILIATION_REQUIRED'
    where kind='provision_review' and status in ('pending','processing','failed')
    and (first_attempt_at<now()-interval '23 hours' or attempts>=5);
  select * into j from public.commerce_outbox where kind='provision_review'
    and (status='pending' or (status='processing' and locked_at<now()-interval '10 minutes'))
    order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.commerce_outbox set status='processing',lease_token=gen_random_uuid(),
    locked_at=now(),first_attempt_at=coalesce(first_attempt_at,now()),attempts=attempts+1
    where id=j.id returning * into j;
  return j;
end $$;
revoke all on function public.commerce_claim_provision() from public,anon,authenticated;
grant execute on function public.commerce_claim_provision() to service_role;

-- ---- provision: turn one paid order into a real evaluation account ----
-- Idempotent on commerce_orders.provisioned_account_id: if an order
-- already has one, this returns it rather than creating a second
-- account, so a retried/duplicate job can never double-provision.
create function public.commerce_provision_account(p_order_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare o public.commerce_orders; p public.challenge_presets; new_id uuid; start_bal numeric;
begin
  select * into o from public.commerce_orders where id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if o.provisioned_account_id is not null then return o.provisioned_account_id; end if;
  if o.status<>'paid' then raise exception 'ORDER_NOT_PAID'; end if;

  select * into p from public.challenge_presets where id=o.sku;
  if not found then raise exception 'PRESET_NOT_FOUND'; end if;

  start_bal := p.starting_balance;
  insert into public.trading_accounts(
    user_id, label, preset_id, challenge_type, stage, phase, status,
    starting_balance, balance, day_start_equity, day_start_date,
    profit_target_pct, max_drawdown_pct, daily_loss_pct, drawdown_mode, trailing_peak,
    min_trading_days, min_trades, max_risk_per_trade_pct, daily_profit_cap_pct,
    min_profitable_days_pct, require_stop_loss, profit_split_pct, challenge_fee_usd, total_paid_out
  ) values (
    o.user_id, p.label, p.id, p.challenge_type, p.stage, 'evaluation', 'active',
    start_bal, start_bal, start_bal, (now() at time zone 'UTC')::date,
    p.profit_target_pct, p.max_drawdown_pct, p.daily_loss_pct, p.drawdown_mode, start_bal,
    p.min_trading_days, p.min_trades, p.max_risk_per_trade_pct, p.daily_profit_cap_pct,
    p.min_profitable_days_pct, p.require_stop_loss, p.profit_split_pct, o.amount_minor/100.0, 0
  ) returning id into new_id;

  update public.commerce_orders set provisioned_account_id = new_id where id = o.id;

  -- Opt the new account into qualification-v2 if a published version
  -- exists for its challenge_type/stage (Infinity only, today -- see
  -- 20260909212000_qualification_v2_activation.sql, which must be
  -- deployed before this function is ever actually called in
  -- production; a no-op if that migration has not run yet, since
  -- Postgres resolves this call at execution time, not at CREATE time).
  begin
    perform public.accept_qualification_v2(new_id);
  exception when undefined_function then
    null; -- qualification-v2 not deployed yet; provisioning still succeeds
  end;

  return new_id;
end $$;
revoke all on function public.commerce_provision_account(uuid) from public,anon,authenticated;
grant execute on function public.commerce_provision_account(uuid) to service_role;

commit;

-- Verify after deploying:
--   select status,count(*) from public.commerce_outbox where kind='provision_review' group by 1;
--   select id,sku,status,provisioned_account_id from public.commerce_orders where status='paid' order by paid_at desc limit 10;
