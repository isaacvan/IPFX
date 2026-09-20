-- Infinity-only public launch and prospective v3 qualification contract.
-- Existing trading_accounts are deliberately not rewritten.
begin;

update public.challenge_presets set
  profit_target_pct = 8,
  max_drawdown_pct = 5,
  daily_loss_pct = 2.5,
  min_trading_days = 10,
  min_trades = 30,
  max_risk_per_trade_pct = 0.50,
  daily_profit_cap_pct = 1.50,
  min_profitable_days_pct = null
where id = 'infinity_s1';

update public.challenge_presets set
  profit_target_pct = 6,
  max_drawdown_pct = 4,
  daily_loss_pct = 2,
  min_trading_days = 15,
  min_trades = 60,
  max_risk_per_trade_pct = 0.35,
  daily_profit_cap_pct = 1.25,
  min_profitable_days_pct = 55
where id = 'infinity_s2';

update public.challenge_presets set
  profit_target_pct = 7,
  max_drawdown_pct = 4,
  daily_loss_pct = 2,
  min_trading_days = 10,
  min_trades = 40,
  max_risk_per_trade_pct = 0.35,
  daily_profit_cap_pct = 1.25,
  min_profitable_days_pct = 50
where id = 'infinity_s3';

update public.challenge_presets set
  max_drawdown_pct = 4,
  daily_loss_pct = 2,
  max_risk_per_trade_pct = 0.25
where id = 'infinity_s4';

update public.challenge_qualification_versions
set status = 'retired'
where challenge_type = 'infinity' and status = 'published';

insert into public.challenge_qualification_versions
  (id, challenge_type, stage, status, min_elapsed_days, min_trading_days,
   min_sessions, max_best_day_share, min_daily_net_fraction,
   session_flat_gap_minutes)
values
  ('infinity-v3-s1','infinity',1,'published',14,10,30,0.35,0.001,60),
  ('infinity-v3-s2','infinity',2,'published',21,15,60,0.25,0.001,60),
  ('infinity-v3-s3','infinity',3,'published',14,10,40,0.30,0.001,60)
on conflict (id) do update set
  status = excluded.status,
  min_elapsed_days = excluded.min_elapsed_days,
  min_trading_days = excluded.min_trading_days,
  min_sessions = excluded.min_sessions,
  max_best_day_share = excluded.max_best_day_share,
  min_daily_net_fraction = excluded.min_daily_net_fraction,
  session_flat_gap_minutes = excluded.session_flat_gap_minutes;

-- The application RPC already blocks everyone except the owner before
-- 1 October. This trigger is the permanent authority after launch:
-- Infinity is public; all other programmes remain paused.
create or replace function public.enforce_programme_launch_on_application()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role';
  v_owner boolean := false;
begin
  if v_uid is not null then
    select exists(
      select 1 from auth.users u
      join public.admins a on a.user_id = u.id
      where u.id = v_uid and lower(coalesce(u.email,'')) = 'paulade491@gmail.com'
    ) into v_owner;
  end if;

  if v_service or v_owner then return new; end if;
  if new.challenge_type <> 'infinity' then
    raise exception 'PROGRAMME_PAUSED_INFINITY_ONLY' using errcode = '42501';
  end if;
  if current_timestamp < timestamptz '2026-10-01 00:00:00 Europe/London' then
    raise exception 'INFINITY_LAUNCHES_OCTOBER_1' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_programme_launch_on_application() from public, anon, authenticated;

drop trigger if exists challenge_application_programme_launch on public.challenge_enrolment_requests;
create trigger challenge_application_programme_launch
before insert or update of challenge_type, preset_id, application_details
on public.challenge_enrolment_requests
for each row execute function public.enforce_programme_launch_on_application();

-- Paid launch products stay disabled at the database catalogue layer.
update public.commerce_catalog
set enabled = false
where sku like 'trad\_%' escape '\'
   or sku like 'fut\_%' escape '\'
   or sku like 'pac\_%' escape '\';

insert into public.support_config(key,value,description)
values
  ('launch_note', 'The free **Infinity Challenge** opens on **1 October 2026**. Traditional, Futures and PAC are on hold with no public application or payment date announced.', 'Public programme launch status.'),
  ('launch_short', 'The free **Infinity Challenge** opens on **1 October 2026**. Other programmes remain on hold.', 'One-line public programme launch status.'),
  ('infinity_stage3_release_pct', '5', 'Closed Stage 3 profit percentage required before held Stage 2 earnings become eligible for payout review.')
on conflict (key) do update set value=excluded.value, description=excluded.description, updated_at=now();

update public.support_kb
set answer = '- **[Infinity Challenge](/infinity.html)** — free to start and opens on **1 October 2026** after application approval.\n- **Traditional, Futures and PAC** — on hold; applications and payments are unavailable and no replacement launch date has been announced.\n\nInfinity uses transparent multi-stage consistency rules. Ask for the Stage 1 or Stage 2 rules to see the exact limits.',
    updated_at = now()
where id = 'programmes-overview';

update public.support_kb
set answer = '**Stage 2 — {{p:infinity_s2.balance}} simulated account:**\n- Profit target {{p:infinity_s2.target_pct}} ({{p:infinity_s2.target_amt}}); provisional {{p:infinity_s2.split_pct}} profit share\n- Max daily loss {{p:infinity_s2.daily_pct}}; max drawdown {{p:infinity_s2.dd_pct}} ({{p:infinity_s2.dd_mode}})\n- Minimum {{p:infinity_s2.min_days}} trading days and {{p:infinity_s2.min_trades}} independent exposure sessions\n- At least {{p:infinity_s2.prof_days_pct}} of trading days profitable\n- Max risk per trade {{p:infinity_s2.risk_pct}}; stop-loss required\n- Best day no more than 25% of positive profit\n\nStage 2 earnings are held. They become eligible for review only after the 5% Stage 3 milestone and its observation requirements are satisfied.',
    updated_at = now()
where id = 'infinity-stage2';

update public.support_kb
set answer = '**Stage 3 — {{p:infinity_s3.balance}} qualification account:**\n- Profit target {{p:infinity_s3.target_pct}} ({{p:infinity_s3.target_amt}})\n- Max daily loss {{p:infinity_s3.daily_pct}}; max drawdown {{p:infinity_s3.dd_pct}} ({{p:infinity_s3.dd_mode}})\n- Minimum {{p:infinity_s3.min_days}} trading days and {{p:infinity_s3.min_trades}} independent exposure sessions\n- Max risk per trade {{p:infinity_s3.risk_pct}}; stop-loss required\n- Best day no more than 30% of positive profit\n\nAt 5% closed profit, after all observation rules are met, held Stage 2 earnings become eligible for payout review. Completing the full target triggers the Stage 4 review.',
    updated_at = now()
where id = 'infinity-stage3';

update public.support_kb
set answer = '- **Stage 2 earnings are held**, not paid when Stage 2 finishes.\n- In **Stage 3**, reaching **5% closed profit** is necessary but not sufficient: the observation, consistency, KYC and payout checks must also pass.\n- Once approved, the Stage 2 share becomes the first Infinity payout.\n- Completing Stage 3 triggers the Stage 4 review.\n- A breach before release forfeits held earnings under the programme Terms.',
    updated_at = now()
where id = 'infinity-payouts';

commit;

