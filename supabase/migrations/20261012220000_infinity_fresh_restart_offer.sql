-- One-time free Stage 1 restart (owner decision 2026-10-12).
-- Traders on an earlier-rules run (accepted Terms before 2.1) who had a day above the daily profit cap ($14 in Stage 1)
-- now need far more total profit to satisfy the best-day rule. IPFX Markets shows each of them their own numbers and
-- offers ONE free restart onto the new rules (Terms 2.1). The old run is archived (never deleted); the new run starts at
-- $1,000. If the new run later fails, the normal next-month lockout applies, so this is a one-time choice.
begin;

create table if not exists public.infinity_restart_offers (
  user_id uuid primary key references auth.users(id),
  old_account_id uuid not null,
  new_account_id uuid not null,
  used_at timestamptz not null default now(),
  snapshot jsonb not null
);
alter table public.infinity_restart_offers enable row level security;
revoke all on public.infinity_restart_offers from public, anon, authenticated;
grant select, insert on public.infinity_restart_offers to service_role;

insert into public.infinity_reset_batches (id, reason, requested_by)
select 'fresh-restart-offer-2026-10', 'One-time free Stage 1 restart offered to earlier-rules runs with a day above the daily profit cap',
       (select u.id from auth.users u where lower(u.email) = 'paulade491@gmail.com')
where exists (select 1 from auth.users u where lower(u.email) = 'paulade491@gmail.com')
on conflict (id) do nothing;

-- What this trader needs, in their own numbers, and whether the restart is open to them.
create or replace function public.fn_infinity_restart_offer(p_account uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare a public.trading_accounts; accepted text; cap numeric; best numeric; pos numeric; share numeric := 0.35;
  need numeric; remaining numeric; used boolean; q jsonb; target numeric; days_left int; open_n int;
begin
  select * into a from public.trading_accounts where id = p_account;
  if not found or a.challenge_type is distinct from 'infinity' or coalesce(a.phase, '') = 'demo' or a.stage <> 1
     or a.status <> 'active' or a.access_revoked_at is not null or a.daily_profit_cap_pct is null then
    return jsonb_build_object('eligible', false);
  end if;
  select r.application_details->>'terms_version' into accepted from public.challenge_enrolment_requests r where r.id = a.approval_request_id;
  if coalesce(accepted, '') >= '2026-10-12-2.1' then return jsonb_build_object('eligible', false, 'reason', 'already_on_new_rules'); end if;
  cap := round(a.starting_balance * a.daily_profit_cap_pct / 100, 2);
  select max(d), coalesce(sum(d) filter (where d > 0), 0) into best, pos
  from (select sum(coalesce(t.pnl, 0)) d from public.trades t
        where t.account_id = a.id and t.status = 'closed' and t.closed_at is not null
        group by (t.closed_at at time zone 'UTC')::date) days;
  if best is null or best <= cap then return jsonb_build_object('eligible', false, 'reason', 'no_day_above_cap'); end if;
  begin
    q := public.qualification_progress_v2(a.id);
    share := coalesce(nullif((q->'rules'->>'max_best_day_share'), '')::numeric, 0.35);
  exception when others then share := 0.35;
  end;
  need := round(best / share, 2);
  remaining := greatest(0, round(need - pos, 2));
  target := round(a.starting_balance * (1 + a.profit_target_pct / 100), 2);
  used := exists (select 1 from public.infinity_restart_offers o where o.user_id = a.user_id);
  days_left := ((date_trunc('month', now() at time zone 'UTC') + interval '1 month')::date - (now() at time zone 'UTC')::date);
  select count(*) into open_n from public.trades t where t.account_id = a.id and t.status = 'open';
  return jsonb_build_object(
    'eligible', not used, 'used', used,
    'best_day_usd', round(best, 2), 'cap_usd', cap, 'best_day_max_share', share,
    'need_positive_total_usd', need, 'have_positive_total_usd', round(pos, 2), 'remaining_usd', remaining,
    'min_more_profitable_days', case when cap > 0 then ceil(remaining / cap)::int else null end,
    'target_balance_usd', target, 'balance_usd', round(a.balance, 2),
    'days_left_in_month', days_left, 'open_positions', open_n);
end $$;
revoke all on function public.fn_infinity_restart_offer(uuid) from public, anon, authenticated;
grant execute on function public.fn_infinity_restart_offer(uuid) to service_role;

-- Takes the restart. Only the account owner, only once, only when flat. Archives the old run and issues a new Stage 1
-- account under Terms 2.1, recording the trader's acceptance of the current Terms and Privacy versions.
create or replace function public.fn_infinity_take_fresh_restart(p_account uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare a public.trading_accounts; offer jsonb; old_app public.challenge_enrolment_requests; new_app uuid; new_acct uuid;
  p public.challenge_presets; terms_v text; privacy_v text;
begin
  select * into a from public.trading_accounts where id = p_account for update;
  if not found or a.user_id is distinct from p_user then raise exception 'RESTART_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('infinity-fresh-restart:' || p_user::text, 0));
  offer := public.fn_infinity_restart_offer(p_account);
  if coalesce((offer->>'eligible')::boolean, false) is not true then raise exception 'RESTART_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  if exists (select 1 from public.trades t where t.account_id = a.id and t.status = 'open') then
    raise exception 'CLOSE_POSITIONS_FIRST' using errcode = 'P0001';
  end if;
  update public.pending_orders set status = 'cancelled', resolved_at = now()
   where account_id = a.id and status = 'pending';

  insert into public.infinity_retired_accounts (account_id, reset_id, user_id, snapshot)
  values (a.id, 'fresh-restart-offer-2026-10', a.user_id, to_jsonb(a) || jsonb_build_object('restart_offer', offer));
  update public.trading_accounts set access_revoked_at = now(), access_revoked_reason = 'infinity_fresh_restart_offer', updated_at = now()
   where id = a.id;

  select * into old_app from public.challenge_enrolment_requests where id = a.approval_request_id;
  if found then
    update public.challenge_enrolment_requests set status = 'withdrawn', decision_note = 'Replaced by the one-time free Stage 1 restart', updated_at = now()
     where id = old_app.id;
  end if;

  select version into terms_v from public.platform_legal_current where kind = 'terms';
  select version into privacy_v from public.platform_legal_current where kind = 'privacy';
  insert into public.challenge_enrolment_requests (user_id, challenge_type, preset_id, status, application_details, reviewed_by, reviewed_at, decision_note)
  values (a.user_id, 'infinity', 'infinity_s1', 'approved',
          coalesce(old_app.application_details, '{}'::jsonb) || jsonb_build_object('source', 'fresh_restart_offer', 'terms_version', terms_v,
            'privacy_notice_version', privacy_v, 'restarted_from_account', a.id),
          a.user_id, now(), 'One-time free Stage 1 restart (identity already verified)')
  returning id into new_app;

  select * into p from public.challenge_presets where id = 'infinity_s1';
  insert into public.trading_accounts (user_id, label, preset_id, challenge_type, stage, phase, status, starting_balance, balance, day_start_equity,
    day_start_date, profit_target_pct, max_drawdown_pct, daily_loss_pct, drawdown_mode, trailing_peak, min_trading_days, min_trades,
    max_risk_per_trade_pct, daily_profit_cap_pct, min_profitable_days_pct, require_stop_loss, profit_split_pct, challenge_fee_usd, total_paid_out,
    approval_request_id)
  values (a.user_id, p.label, p.id, p.challenge_type, p.stage, 'evaluation', 'active', p.starting_balance, p.starting_balance, p.starting_balance,
    (now() at time zone 'UTC')::date, p.profit_target_pct, p.max_drawdown_pct, p.daily_loss_pct, p.drawdown_mode, p.starting_balance,
    coalesce(p.min_trading_days, 0), coalesce(p.min_trades, 0), p.max_risk_per_trade_pct, p.daily_profit_cap_pct, p.min_profitable_days_pct,
    coalesce(p.require_stop_loss, false), coalesce(p.profit_split_pct, 0), 0, 0, new_app)
  returning id into new_acct;
  update public.challenge_enrolment_requests set trading_account_id = new_acct, updated_at = now() where id = new_app;
  perform public.accept_qualification_v2(new_acct);

  insert into public.platform_legal_acceptances (user_id, terms_version, privacy_version, context)
  values (a.user_id, terms_v, privacy_v, jsonb_build_object('challenge_type', 'infinity', 'preset_id', 'infinity_s1', 'source', 'fresh_restart_offer'))
  on conflict do nothing;
  insert into public.infinity_restart_offers (user_id, old_account_id, new_account_id, snapshot)
  values (a.user_id, a.id, new_acct, offer);
  return jsonb_build_object('ok', true, 'new_account_id', new_acct, 'terms_version', terms_v);
end $$;
revoke all on function public.fn_infinity_take_fresh_restart(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_infinity_take_fresh_restart(uuid, uuid) to service_role;
commit;
