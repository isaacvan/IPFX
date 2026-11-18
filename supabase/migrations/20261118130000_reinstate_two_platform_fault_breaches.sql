-- 18 Nov 2026: unlock the two Infinity accounts that were breached on daily loss because of the automatic-stop bug fixed
-- in 20261118120000 (a trade with an automatic stop could not be closed on time, so its loss ran past the stop).
--
-- 1. The freeze guard gets ONE extra, narrow exception: a daily-loss breach may be reactivated while the transaction-local
--    flag ipfx.owner_reinstatement = 'platform_fault_2026_11_18' is set. Everything else stays frozen.
-- 2. Only the two named accounts are touched, each only if it is still breached on daily loss, has no open trade and the
--    trader has no other active Infinity account. The balance is kept as it is (the trades stay closed).
-- 3. The original breach stays on record in infinity_breach_reinstatements and account_breach_events, and in admin_audit_log.
-- 4. Each trader gets one accurate email (their own template: the old reinstatement email talks about the drawdown rule).
begin;

create or replace function public.fn_keep_breached_account_frozen() returns trigger language plpgsql set search_path = '' as $$
begin
 if coalesce(current_setting('ipfx.owner_reinstatement',true),'')='closed_balance_2026_10_16' and old.challenge_type='infinity'
  and old.breach_reason='max_drawdown' and new.status='active' and new.stage is not distinct from old.stage and new.phase is not distinct from old.phase then return new;end if;
 if coalesce(current_setting('ipfx.owner_reinstatement',true),'')='platform_fault_2026_11_18' and old.challenge_type='infinity'
  and old.breach_reason='daily_loss' and new.status='active' and new.stage is not distinct from old.stage and new.phase is not distinct from old.phase then return new;end if;
 if old.status='breached' and old.phase<>'demo' and(new.status<>'breached'
  or new.breach_reason is distinct from old.breach_reason or new.breached_at is distinct from old.breached_at
  or new.breach_equity is distinct from old.breach_equity or new.breach_floor is distinct from old.breach_floor
  or (old.access_revoked_at is not null and new.access_revoked_at is null)
  or new.stage is distinct from old.stage or new.phase is distinct from old.phase) then
  raise exception 'BREACHED_ACCOUNT_IS_FROZEN';end if;
 return new;
end $$;

insert into public.email_templates (key, category, subject, preheader, body_html, body_text, is_active) values (
  'infinity_account_unlocked_fault', 'account',
  'Your Infinity account is unlocked: a fault on our side caused the breach',
  'A fault on our side stopped a trade closing on time. Your account is active again.',
  '<p>Hi {{customer_name}},</p>
<p><strong>Your Infinity Stage 1 account is active again, and we are sorry.</strong></p>
<p>A fault on our side stopped one of your trades from closing at its stop on time. That is what pushed your account below the daily loss limit, so we have undone the breach.</p>
<p>You carry on from where you were: your balance is {{balance}} and your progress is unchanged. The trades that were closed stay closed. Your daily loss limit for today is counted from your current balance.</p>
<p><a href="{{trading_url}}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Open IPFX Markets</a></p>
<p>Good luck,<br>The IPFX Capital team</p>',
  'Hi {{customer_name}},

Your Infinity Stage 1 account is active again, and we are sorry.

A fault on our side stopped one of your trades from closing at its stop on time. That is what pushed your account below the daily loss limit, so we have undone the breach.

You carry on from where you were: your balance is {{balance}} and your progress is unchanged. The trades that were closed stay closed. Your daily loss limit for today is counted from your current balance.

Open IPFX Markets: {{trading_url}}

Good luck,
The IPFX Capital team',
  true
) on conflict (key) do update set subject = excluded.subject, preheader = excluded.preheader, body_html = excluded.body_html,
  body_text = excluded.body_text, is_active = true;

do $run$
declare r record; owner uuid; best numeric; n int := 0;
begin
 select u.id into owner from auth.users u join public.admins ad on ad.user_id = u.id where lower(u.email) = 'paulade491@gmail.com';
 if owner is null then raise exception 'OWNER_NOT_FOUND'; end if;
 for r in
  select a.*, u.email from public.trading_accounts a join auth.users u on u.id = a.user_id
   where a.id in ('ddb5c31a-a1aa-495a-b320-a65b5e380336', '60aa4219-e399-4983-a867-6944d6b71ec7')
     and a.challenge_type = 'infinity' and a.status = 'breached' and a.breach_reason = 'daily_loss'
     and a.breached_at >= '2026-11-17T00:00:00Z'
   for update of a
 loop
  if exists (select 1 from public.trades t where t.account_id = r.id and t.status = 'open') then raise exception 'OPEN_TRADES_ON_BREACHED_ACCOUNT %', r.id; end if;
  if exists (select 1 from public.trading_accounts b where b.user_id = r.user_id and b.challenge_type = 'infinity' and b.status = 'active' and b.id <> r.id) then
   raise exception 'TRADER_ALREADY_HAS_ACTIVE_INFINITY %', r.id; end if;
  -- the account must not also break the trailing drawdown rule from its own closed balances
  select greatest(r.starting_balance, r.starting_balance + coalesce(max(cum), 0)) into best from (
   select sum(pnl) over (order by closed_at, id) cum from public.trades where account_id = r.id and status = 'closed' and pnl is not null) z;
  best := greatest(best, coalesce(r.trailing_peak, 0));
  if r.balance <= best - r.starting_balance * r.max_drawdown_pct / 100 then raise exception 'ACCOUNT_BREACHES_DRAWDOWN_TOO %', r.id; end if;
  insert into public.infinity_breach_reinstatements (account_id, user_id, actor_id, reason, original_breach_reason, original_breached_at, original_breach_equity, original_breach_floor, balance, new_trailing_peak)
   values (r.id, r.user_id, owner, 'Platform fault: the automatic stop bug (fixed 18 Nov 2026) stopped a trade closing at its stop, which caused this daily loss breach', r.breach_reason, r.breached_at, r.breach_equity, r.breach_floor, r.balance, best);
  perform set_config('ipfx.owner_reinstatement', 'platform_fault_2026_11_18', true);
  update public.trading_accounts set status = 'active', breach_reason = null, breached_at = null, breach_equity = null, breach_floor = null,
   access_revoked_at = null, access_revoked_reason = null, day_start_equity = r.balance,
   day_start_date = (clock_timestamp() at time zone 'UTC')::date, updated_at = clock_timestamp()
   where id = r.id;
  perform set_config('ipfx.owner_reinstatement', '', true);
  insert into public.admin_audit_log (actor_id, action, target_user_id, detail) values (owner, 'infinity_reinstate_platform_fault', r.user_id,
   jsonb_build_object('account', r.id, 'balance', r.balance, 'original_breach', r.breach_reason, 'original_breached_at', r.breached_at,
    'original_floor', r.breach_floor, 'reason', 'automatic stop bug, 18 Nov 2026'));
  insert into public.email_events (user_id, template_key, to_email, subject, status, provider, payload)
   select r.user_id, 'infinity_account_unlocked_fault', r.email, 'Your Infinity account is unlocked: a fault on our side caused the breach', 'queued', 'resend',
          jsonb_build_object('account_id', r.id, 'vars', jsonb_build_object('balance', '$' || to_char(r.balance, 'FM999,990.00'),
           'trading_url', 'https://ipfxcapital.com/trading.html'))
    where r.email is not null
      and not exists (select 1 from public.email_events e where e.user_id = r.user_id and e.template_key = 'infinity_account_unlocked_fault');
  n := n + 1;
 end loop;
 raise notice 'reinstated % accounts', n;
end $run$;

commit;
