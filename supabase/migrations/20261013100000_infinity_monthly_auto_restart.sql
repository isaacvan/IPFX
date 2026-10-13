-- Automatic fresh Stage 1 on the 1st of the month (owner decision 2026-10-13).
-- A breach still closes every trade and freezes the run at once (unchanged). When the next-month lockout ends, a trader
-- whose last Infinity run failed gets a new $1,000 Stage 1 automatically (identity already verified), under the rules
-- published at that time, plus an email. No new application or manual review is needed. Old runs are archived, never deleted.
begin;

insert into public.email_templates (key, category, subject, preheader, body_html, body_text, is_active) values (
  'infinity_monthly_restart', 'account',
  'Your new Infinity Stage 1 is ready',
  'A new month: your fresh $1,000 Stage 1 account is waiting on IPFX Markets.',
  '<p>Hi {{customer_name}},</p>
<p><strong>It is a new month, so your fresh Infinity Stage 1 account is ready.</strong> You start again at $1,000 with no trades. You do not need to apply again.</p>
<p><a href="{{trading_url}}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Open IPFX Markets</a></p>
<p>The rules for this run:</p>
<ul>
<li>Put a stop-loss on every trade within 30 seconds. Three missed stop-losses end the run.</li>
<li>At most $14 of profit counts toward the $40 target each day. When you reach $14 in a day, open trades close and new trades pause until midnight UTC.</li>
<li>Every requirement must be met at the same time before you move to Stage 2: the target, 14 days, 10 trading days, 30 exposure sessions, 30 trades and the best-day limit.</li>
<li>Breaking the daily loss limit (2.5%) or the trailing drawdown limit (5%) ends the run, and you would wait until the 1st of next month again.</li>
</ul>
<p>Follow your progress on your dashboard: <a href="{{dashboard_url}}">{{dashboard_url}}</a>.</p>
<p>Good luck,<br>The IPFX Capital team</p>',
  'Hi {{customer_name}},

It is a new month, so your fresh Infinity Stage 1 account is ready. You start again at $1,000 with no trades. You do not need to apply again.

Open IPFX Markets: {{trading_url}}

The rules for this run:
- Put a stop-loss on every trade within 30 seconds. Three missed stop-losses end the run.
- At most $14 of profit counts toward the $40 target each day. When you reach $14 in a day, open trades close and new trades pause until midnight UTC.
- Every requirement must be met at the same time before you move to Stage 2: the target, 14 days, 10 trading days, 30 exposure sessions, 30 trades and the best-day limit.
- Breaking the daily loss limit (2.5%) or the trailing drawdown limit (5%) ends the run, and you would wait until the 1st of next month again.

Follow your progress on your dashboard: {{dashboard_url}}

Good luck,
The IPFX Capital team',
  true
) on conflict (key) do nothing;

create table if not exists public.infinity_monthly_restarts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id),
  old_account_id uuid not null,
  new_account_id uuid,
  month date not null,
  outcome text not null,
  detail text,
  created_at timestamptz not null default now(),
  unique (user_id, month)
);
alter table public.infinity_monthly_restarts enable row level security;
revoke all on public.infinity_monthly_restarts from public, anon, authenticated;
grant select, insert, update on public.infinity_monthly_restarts to service_role;

create or replace function public.fn_infinity_monthly_auto_restart() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare month_start timestamptz := date_trunc('month', clock_timestamp() at time zone 'UTC') at time zone 'UTC';
  this_month date := (clock_timestamp() at time zone 'UTC')::date - (extract(day from clock_timestamp() at time zone 'UTC')::int - 1);
  c record; old_app public.challenge_enrolment_requests; new_app uuid; new_acct uuid; p public.challenge_presets;
  terms_v text; privacy_v text; started int := 0; skipped int := 0; failed int := 0; who text;
begin
  select * into p from public.challenge_presets where id = 'infinity_s1';
  select version into terms_v from public.platform_legal_current where kind = 'terms';
  select version into privacy_v from public.platform_legal_current where kind = 'privacy';
  for c in
    select distinct on (a.user_id) a.user_id, a.id as account_id, a.status, a.breached_at
    from public.trading_accounts a
    where a.challenge_type = 'infinity' and coalesce(a.phase, '') <> 'demo'
    order by a.user_id, a.created_at desc
  loop
    -- Only runs that ended in a breach before this month; nothing newer exists for the trader.
    if c.status is distinct from 'breached' or c.breached_at is null or c.breached_at >= month_start then continue; end if;
    -- Each trader once per month; a failed attempt is retried by the later runs that day.
    if exists (select 1 from public.infinity_monthly_restarts r where r.user_id = c.user_id and r.month = this_month and r.outcome in ('started', 'skipped')) then continue; end if;
    begin
      if coalesce((public.fn_infinity_breach_lockout(c.user_id)->>'locked')::boolean, false) then
        insert into public.infinity_monthly_restarts (user_id, old_account_id, month, outcome, detail) values (c.user_id, c.account_id, this_month, 'skipped', 'lockout still active') on conflict (user_id, month) do update set outcome = excluded.outcome, detail = excluded.detail, new_account_id = excluded.new_account_id, created_at = now();
        skipped := skipped + 1; continue;
      end if;
      if not exists (select 1 from public.trader_kyc k where k.user_id = c.user_id and k.status = 'verified')
         or exists (select 1 from public.user_profiles u where u.user_id = c.user_id and u.restricted_jurisdiction)
         or exists (select 1 from public.ab_trader_profiles t where t.person_id = public.ab_person_of(c.user_id) and t.book_state = 'SUSPENDED') then
        insert into public.infinity_monthly_restarts (user_id, old_account_id, month, outcome, detail) values (c.user_id, c.account_id, this_month, 'skipped', 'identity not verified, restricted or suspended') on conflict (user_id, month) do update set outcome = excluded.outcome, detail = excluded.detail, new_account_id = excluded.new_account_id, created_at = now();
        skipped := skipped + 1; continue;
      end if;

      select * into old_app from public.challenge_enrolment_requests
       where user_id = c.user_id and preset_id = 'infinity_s1' and status <> 'withdrawn' order by created_at desc limit 1;
      if found then
        if old_app.status = 'denied' then
          insert into public.infinity_monthly_restarts (user_id, old_account_id, month, outcome, detail) values (c.user_id, c.account_id, this_month, 'skipped', 'application denied') on conflict (user_id, month) do update set outcome = excluded.outcome, detail = excluded.detail, new_account_id = excluded.new_account_id, created_at = now();
          skipped := skipped + 1; continue;
        end if;
        update public.challenge_enrolment_requests set status = 'withdrawn', decision_note = 'Replaced by the automatic monthly Stage 1 restart', updated_at = now()
         where id = old_app.id;
      end if;
      insert into public.challenge_enrolment_requests (user_id, challenge_type, preset_id, status, application_details, reviewed_by, reviewed_at, decision_note)
      values (c.user_id, 'infinity', 'infinity_s1', 'approved',
              coalesce(old_app.application_details, '{}'::jsonb) || jsonb_build_object('source', 'monthly_auto_restart', 'terms_version', terms_v,
                'privacy_notice_version', privacy_v, 'restarted_from_account', c.account_id),
              c.user_id, now(), 'Automatic monthly Stage 1 restart (identity already verified)')
      returning id into new_app;
      insert into public.trading_accounts (user_id, label, preset_id, challenge_type, stage, phase, status, starting_balance, balance, day_start_equity,
        day_start_date, profit_target_pct, max_drawdown_pct, daily_loss_pct, drawdown_mode, trailing_peak, min_trading_days, min_trades,
        max_risk_per_trade_pct, daily_profit_cap_pct, min_profitable_days_pct, require_stop_loss, profit_split_pct, challenge_fee_usd, total_paid_out,
        approval_request_id)
      values (c.user_id, p.label, p.id, p.challenge_type, p.stage, 'evaluation', 'active', p.starting_balance, p.starting_balance, p.starting_balance,
        (now() at time zone 'UTC')::date, p.profit_target_pct, p.max_drawdown_pct, p.daily_loss_pct, p.drawdown_mode, p.starting_balance,
        coalesce(p.min_trading_days, 0), coalesce(p.min_trades, 0), p.max_risk_per_trade_pct, p.daily_profit_cap_pct, p.min_profitable_days_pct,
        coalesce(p.require_stop_loss, false), coalesce(p.profit_split_pct, 0), 0, 0, new_app)
      returning id into new_acct;
      update public.challenge_enrolment_requests set trading_account_id = new_acct, updated_at = now() where id = new_app;
      perform public.accept_qualification_v2(new_acct);
      select u.email into who from auth.users u where u.id = c.user_id;
      if who is not null then
        insert into public.email_events (user_id, template_key, to_email, subject, status, provider, payload)
        values (c.user_id, 'infinity_monthly_restart', who, 'Your new Infinity Stage 1 is ready', 'queued', 'resend',
                jsonb_build_object('vars', jsonb_build_object('trading_url', 'https://ipfxcapital.com/trading.html', 'dashboard_url', 'https://ipfxcapital.com/dashboard.html')));
      end if;
      insert into public.infinity_monthly_restarts (user_id, old_account_id, new_account_id, month, outcome) values (c.user_id, c.account_id, new_acct, this_month, 'started') on conflict (user_id, month) do update set outcome = excluded.outcome, detail = excluded.detail, new_account_id = excluded.new_account_id, created_at = now();
      started := started + 1;
    exception when others then
      failed := failed + 1;
      begin
        insert into public.infinity_monthly_restarts (user_id, old_account_id, month, outcome, detail) values (c.user_id, c.account_id, this_month, 'failed', left(sqlerrm, 300))
        on conflict (user_id, month) do update set outcome = excluded.outcome, detail = excluded.detail, new_account_id = excluded.new_account_id, created_at = now();
      exception when others then null; end;
    end;
  end loop;
  return jsonb_build_object('started', started, 'skipped', skipped, 'failed', failed, 'month', this_month);
end $$;
revoke all on function public.fn_infinity_monthly_auto_restart() from public, anon, authenticated;
grant execute on function public.fn_infinity_monthly_auto_restart() to service_role;

-- 00:05 UTC on the 1st, and again at 06:05 and 12:05 in case the first run met a temporary error
-- (each trader is handled at most once per month).
select cron.unschedule(jobid) from cron.job where jobname = 'ipfx-infinity-monthly-restart';
select cron.schedule('ipfx-infinity-monthly-restart', '5 0,6,12 1 * *', $job$ select public.fn_infinity_monthly_auto_restart(); $job$);
commit;
