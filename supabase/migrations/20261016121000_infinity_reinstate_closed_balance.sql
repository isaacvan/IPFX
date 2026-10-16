-- Owner reinstatement after the closed-balance trailing drawdown (Terms 2.2, 16 October 2026).
-- Breached accounts stay frozen; the only exception is this audited owner function, which returns a max-drawdown breach
-- to active when the run did not break the new rule. The balance stays exactly as it was (positions closed at the breach
-- stay closed); the original breach is kept permanently in infinity_breach_reinstatements and account_breach_events.
begin;
create table public.infinity_breach_reinstatements(
 account_id uuid primary key references public.trading_accounts(id),
 user_id uuid not null, actor_id uuid not null, reason text not null,
 original_breach_reason text, original_breached_at timestamptz, original_breach_equity numeric, original_breach_floor numeric,
 balance numeric not null, new_trailing_peak numeric not null, reinstated_at timestamptz not null default clock_timestamp()
);
alter table public.infinity_breach_reinstatements enable row level security;
revoke all on public.infinity_breach_reinstatements from public,anon,authenticated;
grant select,insert on public.infinity_breach_reinstatements to service_role;

-- The freeze allows exactly one change: the owner reinstatement below (transaction-local flag).
do $freeze$declare src text;a1 text:=' if old.status=''breached'' and old.phase<>''demo'' and(new.status<>''breached''';begin
 src:=pg_get_functiondef('public.fn_keep_breached_account_frozen()'::regprocedure);
 if array_length(string_to_array(src,a1),1)<>2 then raise exception 'FREEZE_SOURCE_DRIFT';end if;
 execute replace(src,a1,' if coalesce(current_setting(''ipfx.owner_reinstatement'',true),'''')=''closed_balance_2026_10_16'' and old.challenge_type=''infinity''
  and old.breach_reason=''max_drawdown'' and new.status=''active'' and new.stage is not distinct from old.stage and new.phase is not distinct from old.phase then return new;end if;
'||a1);
end $freeze$;

create function public.fn_reinstate_infinity_closed_balance(p_account uuid,p_actor uuid,p_reason text)returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts;best numeric;
begin
 if not exists(select 1 from public.admins where user_id=p_actor) or length(trim(coalesce(p_reason,'')))<10 then raise exception 'OWNER_PERMISSION_REQUIRED';end if;
 select * into a from public.trading_accounts where id=p_account for update;
 if not found or a.challenge_type<>'infinity' or a.status<>'breached' or a.breach_reason<>'max_drawdown' or a.breached_at<'2026-10-01T00:00:00Z' then raise exception 'NOT_A_REINSTATABLE_DRAWDOWN_BREACH';end if;
 if exists(select 1 from public.trades where account_id=a.id and status='open') then raise exception 'OPEN_TRADES_ON_BREACHED_ACCOUNT';end if;
 if exists(select 1 from public.trading_accounts b where b.user_id=a.user_id and b.challenge_type='infinity' and b.status='active' and b.id<>a.id) then raise exception 'TRADER_ALREADY_HAS_ACTIVE_INFINITY';end if;
 -- Best closed balance of the run (never below the start): the new trailing peak.
 select greatest(a.starting_balance,a.starting_balance+coalesce(max(cum),0)) into best from(
  select sum(pnl) over(order by closed_at,id) cum from public.trades where account_id=a.id and status='closed' and pnl is not null) z;
 if a.balance<=best-a.starting_balance*a.max_drawdown_pct/100 then raise exception 'ACCOUNT_BREACHES_THE_NEW_RULE_TOO';end if;
 insert into public.infinity_breach_reinstatements(account_id,user_id,actor_id,reason,original_breach_reason,original_breached_at,original_breach_equity,original_breach_floor,balance,new_trailing_peak)
  values(a.id,a.user_id,p_actor,left(trim(p_reason),500),a.breach_reason,a.breached_at,a.breach_equity,a.breach_floor,a.balance,best);
 perform set_config('ipfx.owner_reinstatement','closed_balance_2026_10_16',true);
 update public.trading_accounts set status='active',breach_reason=null,breached_at=null,breach_equity=null,breach_floor=null,
  access_revoked_at=null,access_revoked_reason=null,drawdown_mode='trailing_balance',trailing_peak=best,
  day_start_equity=a.balance,day_start_date=(clock_timestamp() at time zone 'UTC')::date,updated_at=clock_timestamp()
 where id=a.id;
 perform set_config('ipfx.owner_reinstatement','',true);
 insert into public.admin_audit_log(actor_id,action,target_user_id,detail)values(p_actor,'infinity_reinstate_closed_balance',a.user_id,
  jsonb_build_object('account',a.id,'balance',a.balance,'trailing_peak',best,'original_breached_at',a.breached_at,'original_floor',a.breach_floor,'reason',left(trim(p_reason),300)));
 return jsonb_build_object('ok',true,'account',a.id,'balance',a.balance,'trailing_peak',best,'dd_floor',best-a.starting_balance*a.max_drawdown_pct/100);
end $$;
revoke all on function public.fn_reinstate_infinity_closed_balance(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_reinstate_infinity_closed_balance(uuid,uuid,text) to service_role;

insert into public.email_templates(key,category,subject,preheader,body_html,body_text,is_active) values(
 'infinity_account_reinstated','account','Your Infinity account is unlocked: carry on trading',
 'Our drawdown rule changed in your favour, so your account is active again.',
 '<p>Hi {{customer_name}},</p>
<p><strong>Good news: your Infinity Stage 1 account is active again.</strong> We changed the trailing drawdown rule in your favour: it now follows your highest <em>closed</em> balance, so giving back profit on an open trade no longer ends a run. Under the new rule your account would not have been breached, so we have unlocked it.</p>
<p>You carry on from where you were: your balance is {{balance}} and your progress is unchanged. The trades that were closed when the account was breached stay closed.</p>
<p><a href="{{trading_url}}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Open IPFX Markets</a></p>
<p>Your limits now: daily loss 2.5% ($25) from the start of each UTC day, and trailing drawdown 5% ($50) below your highest closed balance. Full rules: <a href="{{terms_url}}">Terms 2.2</a>.</p>
<p>Good luck,<br>The IPFX Capital team</p>',
 'Hi {{customer_name}},

Good news: your Infinity Stage 1 account is active again. We changed the trailing drawdown rule in your favour: it now follows your highest closed balance, so giving back profit on an open trade no longer ends a run. Under the new rule your account would not have been breached, so we have unlocked it.

You carry on from where you were: your balance is {{balance}} and your progress is unchanged. The trades that were closed when the account was breached stay closed.

Open IPFX Markets: {{trading_url}}

Your limits now: daily loss 2.5% ($25) from the start of each UTC day, and trailing drawdown 5% ($50) below your highest closed balance. Full rules: {{terms_url}}

Good luck,
The IPFX Capital team',true)
on conflict(key) do update set subject=excluded.subject,preheader=excluded.preheader,body_html=excluded.body_html,body_text=excluded.body_text,is_active=true;

-- The three max-drawdown breaches that did not break the new rule (replayed 16 Oct: worst equity $979.41, $988.92 and
-- $990.49 against a $950 floor). Each is unlocked and emailed.
do $run$declare owner uuid;r record;out jsonb;
begin
 select u.id into owner from auth.users u join public.admins ad on ad.user_id=u.id where lower(u.email)='paulade491@gmail.com';
 if owner is null then raise exception 'OWNER_NOT_FOUND';end if;
 for r in select a.id,a.user_id,u.email from public.trading_accounts a join auth.users u on u.id=a.user_id
  where a.id in('6e509428-4799-4e0c-91fa-ec852eee73e1','bb46cae7-4ff8-4ac2-b023-0848bd7ac9fb','d26502b4-3bd9-40e9-889c-2ffe3bd2d78c') and a.status='breached'
 loop
  out:=public.fn_reinstate_infinity_closed_balance(r.id,owner,'Trailing drawdown changed to closed balance (Terms 2.2); this run did not break the new rule');
  insert into public.email_events(user_id,template_key,to_email,subject,status,provider,payload)values(r.user_id,'infinity_account_reinstated',r.email,
   'Your Infinity account is unlocked: carry on trading','queued','resend',jsonb_build_object('vars',jsonb_build_object('balance','$'||to_char((out->>'balance')::numeric,'FM999,990.00'),
   'trading_url','https://ipfxcapital.com/trading.html','dashboard_url','https://ipfxcapital.com/dashboard.html','terms_url','https://ipfxcapital.com/legal/2026-10-16-v2.2/terms.html')));
 end loop;
end $run$;
commit;
