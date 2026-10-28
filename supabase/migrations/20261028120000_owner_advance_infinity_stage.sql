-- Owner decision 2026-10-28: the owner alone can move a trader up an Infinity stage from the team Traders page, whether or not every
-- progression box is ticked. Mirrors fn_advance_infinity_stage (20261009070000) but skips the progression checks (target, days, trades,
-- qualification, short-hold profit). Kept: the account must be an active Infinity evaluation at Stage 1-3, flat (no open trades), not frozen
-- by the live risk check, and must have no child stage yet. Service role only; the team function checks the owner and writes the audit row first.
create or replace function public.fn_owner_advance_infinity_stage(p_account uuid, p_expected_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.trading_accounts; n public.challenge_presets; child public.trading_accounts; risk jsonb; children integer;
begin
 select * into a from public.trading_accounts where id = p_account for update;
 if not found or a.user_id is distinct from p_expected_user then raise exception 'ACCOUNT_NOT_FOUND_OR_OWNER_MISMATCH'; end if;
 select count(*) into children from public.trading_accounts where funded_from_account_id = a.id;
 if children > 1 then raise exception 'AMBIGUOUS_DESCENDANTS'; end if;
 if children = 1 then
  select * into child from public.trading_accounts where funded_from_account_id = a.id;
  return jsonb_build_object('ok', true, 'already_created', true, 'next_account', child.id, 'next_stage', child.stage);
 end if;
 if a.challenge_type <> 'infinity' or a.stage not between 1 and 3 or a.phase <> 'evaluation' or a.status <> 'active' or a.access_revoked_at is not null then
  return jsonb_build_object('ok', false, 'reason', 'PARENT_NOT_ELIGIBLE');
 end if;
 risk := public.fn_enforce_infinity_from_quotes(a.id);
 select * into a from public.trading_accounts where id = p_account;
 if a.status <> 'active' or a.access_revoked_at is not null then return jsonb_build_object('ok', false, 'reason', 'ACCOUNT_FROZEN'); end if;
 if exists (select 1 from public.trades where account_id = a.id and status = 'open') then return jsonb_build_object('ok', false, 'reason', 'OPEN_POSITIONS'); end if;
 select next.* into n from public.challenge_presets cur join public.challenge_presets next on next.id = cur.next_preset_id where cur.id = a.preset_id;
 if not found or n.challenge_type <> 'infinity' or n.stage <> a.stage + 1 then raise exception 'NEXT_PRESET_UNAVAILABLE'; end if;
 update public.trading_accounts set status = 'passed', updated_at = now() where id = a.id and status = 'active';
 if not found then raise exception 'PARENT_STATUS_CHANGED'; end if;
 update public.pending_orders set status = 'cancelled' where account_id = a.id and status = 'pending';
 insert into public.trading_accounts(user_id, label, preset_id, challenge_type, stage, phase, status, starting_balance, balance,
  day_start_equity, day_start_date, profit_target_pct, max_drawdown_pct, daily_loss_pct, drawdown_mode, trailing_peak,
  min_trading_days, min_trades, max_risk_per_trade_pct, daily_profit_cap_pct, min_profitable_days_pct, require_stop_loss,
  profit_split_pct, challenge_fee_usd, funded_from_account_id, total_paid_out)
 values (a.user_id, n.label, n.id, n.challenge_type, n.stage, 'evaluation', 'active', n.starting_balance, n.starting_balance,
  n.starting_balance, (now() at time zone 'UTC')::date, n.profit_target_pct, n.max_drawdown_pct, n.daily_loss_pct, n.drawdown_mode, n.starting_balance,
  coalesce(n.min_trading_days, 0), coalesce(n.min_trades, 0), n.max_risk_per_trade_pct, n.daily_profit_cap_pct, n.min_profitable_days_pct, n.require_stop_loss,
  coalesce(n.profit_split_pct, 85), a.challenge_fee_usd, a.id, 0) returning * into child;
 return jsonb_build_object('ok', true, 'already_created', false, 'next_account', child.id, 'next_stage', child.stage, 'owner_override', true);
end $$;
revoke all on function public.fn_owner_advance_infinity_stage(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_owner_advance_infinity_stage(uuid, uuid) to service_role;
