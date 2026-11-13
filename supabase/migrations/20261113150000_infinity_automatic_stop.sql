-- Infinity: an automatic stop instead of stop-loss strikes (owner decision, 13 Nov 2026).
--
-- Before: a trade still without a stop 30 seconds after opening was closed, any profit removed, and it counted as a
-- strike; three strikes ended the run. That rule ended 9 of the 11 failed v2 runs, all at Stage 1 and all only slightly
-- down (-$0.93 to -$11.37), i.e. traders forgot a step rather than traded badly.
-- Now: a trade still without a stop after 30 seconds gets one automatically, at the furthest distance the per-trade
-- risk limit allows (never closer than 8 x the spread). Every trade keeps a known risk, so R, the consistency score,
-- the risk limits and copy sizing are unchanged. A trader who sets their own, tighter stop still scores a better R.
-- No strikes are recorded any more. If no valid stop fits (the trade has already lost more than the limit allows, or
-- the lot size is too large for any legal stop), the trade is closed as before, but without a strike.
begin;

-- 1. The v2 trade guard: the automatic stop may set the opening stop after the 30-second window, and while it runs,
--    other unstopped trades in the same counted trade are not charged a full risk limit each (they get their own share).
create table if not exists public.infinity_v2_legacy_definitions(signature text primary key, definition text not null);
do $guard$
declare src text;
  deadline text := 'if clock_timestamp()>new.opened_at+make_interval(secs=>(r->>''stop_deadline_seconds'')::int) then raise exception ''OPENING_STOP_TOO_LATE'';end if;';
  grp text := 'group_risk:=group_risk+coalesce(other.initial_risk_usd,lim)';
begin
  select pg_get_functiondef('public.infinity_v2_trade_guard()'::regprocedure) into src;
  if position(deadline in src) = 0 or position(grp in src) = 0 then raise exception 'V2_GUARD_SOURCE_DRIFT'; end if;
  insert into public.infinity_v2_legacy_definitions(signature, definition)
  values ('public.infinity_v2_trade_guard() before automatic stop 2026-11-13', src) on conflict (signature) do nothing;
  src := replace(src, deadline,
    'if clock_timestamp()>new.opened_at+make_interval(secs=>(r->>''stop_deadline_seconds'')::int) and coalesce(current_setting(''ipfx.auto_stop'',true),'''')<>''on'' then raise exception ''OPENING_STOP_TOO_LATE'';end if;');
  src := replace(src, grp,
    'group_risk:=group_risk+coalesce(other.initial_risk_usd,case when coalesce(current_setting(''ipfx.auto_stop'',true),'''')=''on'' and other.status=''open'' then 0 else lim end)');
  execute src;
end $guard$;

-- 2. The automatic stop for an Infinity v2 trade. Uses exactly the guard's risk maths: the per-trade limit (tightened
--    near the daily and drawdown floors) minus what the rest of the counted trade already uses, shared equally between
--    the counted trade's unstopped open positions. The stop is rounded towards the entry (less risk) and must be at
--    least 8 spreads from the current price. The guard re-checks everything when the stop is written.
create or replace function public.infinity_v2_auto_stop(p_trade uuid, p_digits int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.trades; a public.trading_accounts; r jsonb; p jsonb; scale numeric; eq numeric; room numeric; lim numeric;
  used numeric; others int; budget numeric; dist numeric; v_sl numeric; mark numeric; f numeric; gap numeric;
begin
  select * into t from public.trades where id = p_trade for update;
  if not found or t.status <> 'open' or t.sl is not null or t.parent_trade_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'NOT_APPLICABLE');
  end if;
  select * into a from public.trading_accounts where id = t.account_id;
  if a.rules_version is distinct from 'infinity_v2' then return jsonb_build_object('ok', false, 'reason', 'NOT_V2'); end if;
  if a.status <> 'active' or a.access_revoked_at is not null then return jsonb_build_object('ok', false, 'reason', 'ACCOUNT_FROZEN'); end if;
  r := a.infinity_rules_snapshot;
  p := public.infinity_v2_price(t.symbol);
  scale := public.infinity_v2_usd_scale(t.symbol);
  if p is null or scale is null or scale <= 0 or (p->>'spread')::numeric <= 0 then return jsonb_build_object('ok', false, 'reason', 'PRICE_UNAVAILABLE'); end if;
  eq := public.fn_infinity_quote_equity(a.id);
  if eq is null then return jsonb_build_object('ok', false, 'reason', 'PRICE_UNAVAILABLE'); end if;
  room := least((eq-(greatest(coalesce(a.trailing_peak,a.starting_balance),a.balance)-a.starting_balance*a.max_drawdown_pct/100-coalesce(a.total_paid_out,0)))*0.20,
    (eq-(case when a.day_start_date is distinct from (clock_timestamp() at time zone 'UTC')::date then a.balance else a.day_start_equity end-a.starting_balance*a.daily_loss_pct/100))*0.25);
  lim := round(greatest(0, least(a.starting_balance*(r->>'risk_pct')::numeric/100, room)), 2);
  select coalesce(sum(o.initial_risk_usd), 0) + lim * count(*) filter (where o.initial_risk_usd is null and o.status <> 'open'),
         count(*) filter (where o.initial_risk_usd is null and o.status = 'open')
    into used, others
    from public.trades o
   where o.infinity_group_id = t.infinity_group_id and o.id <> t.id and o.parent_trade_id is null;
  budget := (lim - used) / (1 + others);
  if budget <= 0 then return jsonb_build_object('ok', false, 'reason', 'NO_RISK_ROOM', 'limit', lim); end if;
  dist := budget / (coalesce(t.initial_volume, t.volume) * scale);
  f := power(10::numeric, greatest(0, least(p_digits, 8)));
  v_sl := case when t.side = 'buy' then ceil((t.open_price - dist) * f) / f else floor((t.open_price + dist) * f) / f end;
  mark := case when t.side = 'buy' then (p->>'bid')::numeric else (p->>'ask')::numeric end;
  gap := case when t.side = 'buy' then mark - v_sl else v_sl - mark end;
  if v_sl <= 0 or gap < (p->>'spread')::numeric * (r->>'stop_spread_multiple')::numeric then
    return jsonb_build_object('ok', false, 'reason', 'NO_VALID_STOP', 'limit', lim, 'budget', round(budget, 2));
  end if;
  perform set_config('ipfx.auto_stop', 'on', true);
  begin
    update public.trades set sl = v_sl where id = t.id and status = 'open' and sl is null;
  exception when others then
    perform set_config('ipfx.auto_stop', '', true);
    return jsonb_build_object('ok', false, 'reason', 'GUARD_REFUSED', 'detail', left(sqlerrm, 120));
  end;
  perform set_config('ipfx.auto_stop', '', true);
  return jsonb_build_object('ok', true, 'sl', v_sl, 'risk_usd', round(abs(t.open_price - v_sl) * coalesce(t.initial_volume, t.volume) * scale, 2), 'limit', lim);
end $$;
revoke all on function public.infinity_v2_auto_stop(uuid, int) from public, anon, authenticated;
grant execute on function public.infinity_v2_auto_stop(uuid, int) to service_role;

-- 3. No more strikes: closing a trade for having no stop no longer records a warning or ends the run.
create or replace function public.fn_sl_warning_on_close() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Stop-loss strikes were retired on 13 Nov 2026 (automatic stop). Past warnings stay in public.sl_strikes.
  return new;
end $$;

-- Current warning counts are kept for the record, then cleared on running accounts so nobody sees "warning 1 of 3".
create table if not exists public.sl_strikes_cleared_2026_11 (
  account_id uuid primary key, previous_strikes int not null, cleared_at timestamptz not null default clock_timestamp());
alter table public.sl_strikes_cleared_2026_11 enable row level security;
revoke all on public.sl_strikes_cleared_2026_11 from public, anon, authenticated;
insert into public.sl_strikes_cleared_2026_11(account_id, previous_strikes)
select id, sl_strikes from public.trading_accounts
 where challenge_type = 'infinity' and status = 'active' and access_revoked_at is null and sl_strikes > 0
on conflict (account_id) do nothing;
update public.trading_accounts set sl_strikes = 0, updated_at = clock_timestamp()
 where challenge_type = 'infinity' and status = 'active' and access_revoked_at is null and sl_strikes > 0;

-- 4. Free restart for runs ended by the old rule: retired runs no longer count towards the monthly attempt or the
--    breach lockout, so each of these traders can start a fresh Stage 1 now.
insert into public.infinity_reset_batches (id, reason, requested_by)
select 'stop-rule-change-2026-11', 'Free Stage 1 restart for runs ended by the stop-loss strike rule, which was replaced by an automatic stop on 13 Nov 2026',
       u.id from auth.users u where lower(u.email) = 'paulade491@gmail.com'
on conflict (id) do nothing;
insert into public.infinity_retired_accounts (account_id, reset_id, user_id, snapshot)
select a.id, 'stop-rule-change-2026-11', a.user_id, to_jsonb(a)
  from public.trading_accounts a
 where a.challenge_type = 'infinity' and a.status = 'breached' and a.access_revoked_reason = 'challenge_rule_breach:stop_loss_rule'
   and exists (select 1 from public.infinity_reset_batches b where b.id = 'stop-rule-change-2026-11')
on conflict (account_id) do nothing;
update public.infinity_reset_batches b set account_count = (select count(*) from public.infinity_retired_accounts r where r.reset_id = b.id)
 where b.id = 'stop-rule-change-2026-11';

-- 5. Email to those traders (sent by email-outbox).
insert into public.email_templates (key, category, subject, preheader, body_html, body_text, is_active) values (
  'infinity_stop_rule_restart', 'account',
  'We changed the stop-loss rule. Your free restart is ready',
  'No more stop-loss warnings. Start a fresh Infinity Stage 1 now, free.',
  '<p>Hi {{customer_name}},</p>
<p>Your Infinity run ended because of the stop-loss warning rule. <strong>We have replaced that rule.</strong></p>
<ul>
<li>There are no more stop-loss warnings, and a missing stop can no longer end your run.</li>
<li>Add your own stop within 30 seconds of opening a trade. If you don''t, IPFX adds one for you automatically at your maximum risk per trade.</li>
<li>Setting your own, tighter stop is still better: you risk less, and the same profit counts for more in your consistency score.</li>
</ul>
<p><strong>Your fresh Stage 1 is free and does not use your monthly attempt.</strong></p>
<p><a href="{{trading_url}}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Restart on IPFX Markets</a></p>
<p>Good luck,<br>The IPFX Capital team</p>',
  'Hi {{customer_name}},

Your Infinity run ended because of the stop-loss warning rule. We have replaced that rule.

- There are no more stop-loss warnings, and a missing stop can no longer end your run.
- Add your own stop within 30 seconds of opening a trade. If you don''t, IPFX adds one for you automatically at your maximum risk per trade.
- Setting your own, tighter stop is still better: you risk less, and the same profit counts for more in your consistency score.

Your fresh Stage 1 is free and does not use your monthly attempt.

Restart on IPFX Markets: {{trading_url}}

Good luck,
The IPFX Capital team',
  true
) on conflict (key) do update set subject = excluded.subject, preheader = excluded.preheader, body_html = excluded.body_html,
  body_text = excluded.body_text, is_active = true;

insert into public.email_events (user_id, template_key, to_email, subject, status, provider, payload)
select r.user_id, 'infinity_stop_rule_restart', u.email, 'We changed the stop-loss rule. Your free restart is ready', 'queued', 'resend',
       jsonb_build_object('vars', jsonb_build_object('trading_url', 'https://ipfxcapital.com/trading.html'), 'account_id', r.account_id)
  from public.infinity_retired_accounts r join auth.users u on u.id = r.user_id
 where r.reset_id = 'stop-rule-change-2026-11' and u.email is not null
   and not exists (select 1 from public.email_events e where e.user_id = r.user_id and e.template_key = 'infinity_stop_rule_restart');

-- 6. Emails that described strikes now describe the automatic stop.
update public.email_templates set
  body_html = replace(body_html, 'A trade without one is closed and counts as a strike. Three strikes end the run.', 'If you don''t, IPFX adds one automatically at your maximum risk per trade.'),
  body_text = replace(body_text, 'A trade without one is closed and counts as a strike. Three strikes end the run.', 'If you don''t, IPFX adds one automatically at your maximum risk per trade.')
 where key = 'infinity_ready';
update public.email_templates set
  body_html = replace(body_html, 'A trade without one is closed and counts as a strike, and three strikes end your run.', 'If you don''t, IPFX adds one automatically at your maximum risk per trade.'),
  body_text = replace(body_text, 'A trade without one is closed and counts as a strike, and three strikes end your run.', 'If you don''t, IPFX adds one automatically at your maximum risk per trade.')
 where key = 'infinity_approved';

commit;
