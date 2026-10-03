-- The trader detector places every trade in a stage using the rule snapshot that applied when it was
-- opened. No snapshot was ever written, so every trade was rejected and no assessment could be made.
-- Snapshots are now written by the database itself whenever a challenge account is created or changes
-- stage/phase, whichever code path did it. Existing accounts are backfilled from their stored rules.
create or replace function public.fn_snapshot_account_rules()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare cfg uuid;
begin
  if new.challenge_type not in ('infinity', 'traditional', 'futures', 'pac') or coalesce(new.stage, 0) <= 0
     or coalesce(new.starting_balance, 0) <= 0 or coalesce(new.daily_loss_pct, 0) <= 0 or coalesce(new.max_drawdown_pct, 0) <= 0 then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.stage is not distinct from old.stage and new.phase is not distinct from old.phase then
    return new;
  end if;
  select id into cfg from public.a_book_config_versions where status = 'ACTIVE' order by version desc limit 1;
  if cfg is null then return new; end if;
  insert into public.a_book_rule_snapshots
    (trading_account_id, config_version_id, effective_at, phase, anchor_mode, loss_measure,
     day_anchor_amount, max_daily_loss_fraction, max_total_loss_fraction, rules)
  values
    (new.id, cfg, case when tg_op = 'INSERT' then coalesce(new.created_at, now()) else clock_timestamp() end,
     case when new.phase = 'funded' then 'FUNDED' else 'EVALUATION' end, 'MIDNIGHT_UTC', 'EQUITY',
     new.starting_balance, new.daily_loss_pct / 100.0, new.max_drawdown_pct / 100.0,
     jsonb_build_object(
       'challenge_type', new.challenge_type, 'stage', new.stage, 'phase', new.phase,
       'drawdown_mode', coalesce(new.drawdown_mode, 'static'), 'starting_balance', new.starting_balance,
       'profit_target_pct', new.profit_target_pct, 'daily_loss_pct', new.daily_loss_pct,
       'max_drawdown_pct', new.max_drawdown_pct, 'max_risk_per_trade_pct', new.max_risk_per_trade_pct,
       'daily_profit_cap_pct', new.daily_profit_cap_pct, 'min_trading_days', new.min_trading_days,
       'min_trades', new.min_trades, 'preset_id', new.preset_id, 'source', 'auto:' || lower(tg_op)))
  on conflict (trading_account_id, effective_at) do nothing;
  return new;
end; $function$;
revoke all on function public.fn_snapshot_account_rules() from public, anon, authenticated;

drop trigger if exists trading_accounts_rule_snapshot_insert on public.trading_accounts;
create trigger trading_accounts_rule_snapshot_insert after insert on public.trading_accounts
  for each row execute function public.fn_snapshot_account_rules();
drop trigger if exists trading_accounts_rule_snapshot_update on public.trading_accounts;
create trigger trading_accounts_rule_snapshot_update after update of stage, phase on public.trading_accounts
  for each row execute function public.fn_snapshot_account_rules();

-- Backfill: one snapshot per existing challenge account, effective from its creation.
insert into public.a_book_rule_snapshots
  (trading_account_id, config_version_id, effective_at, phase, anchor_mode, loss_measure,
   day_anchor_amount, max_daily_loss_fraction, max_total_loss_fraction, rules)
select a.id, cfg.id, a.created_at, case when a.phase = 'funded' then 'FUNDED' else 'EVALUATION' end, 'MIDNIGHT_UTC', 'EQUITY',
       a.starting_balance, a.daily_loss_pct / 100.0, a.max_drawdown_pct / 100.0,
       jsonb_build_object(
         'challenge_type', a.challenge_type, 'stage', a.stage, 'phase', a.phase,
         'drawdown_mode', coalesce(a.drawdown_mode, 'static'), 'starting_balance', a.starting_balance,
         'profit_target_pct', a.profit_target_pct, 'daily_loss_pct', a.daily_loss_pct,
         'max_drawdown_pct', a.max_drawdown_pct, 'max_risk_per_trade_pct', a.max_risk_per_trade_pct,
         'daily_profit_cap_pct', a.daily_profit_cap_pct, 'min_trading_days', a.min_trading_days,
         'min_trades', a.min_trades, 'preset_id', a.preset_id, 'source', 'backfill:2026-10-03')
from public.trading_accounts a
cross join lateral (select id from public.a_book_config_versions where status = 'ACTIVE' order by version desc limit 1) cfg
where a.challenge_type in ('infinity', 'traditional', 'futures', 'pac') and coalesce(a.stage, 0) > 0
  and a.starting_balance > 0 and a.daily_loss_pct > 0 and a.max_drawdown_pct > 0
  and not exists (select 1 from public.a_book_rule_snapshots s where s.trading_account_id = a.id)
on conflict (trading_account_id, effective_at) do nothing;
