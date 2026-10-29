begin;
-- A voluntary restart is an archive, not a risk breach. Preserve every legacy
-- status and explicitly admit the new closed state used by this transaction.
alter table public.trading_accounts drop constraint if exists trading_accounts_status_check;
alter table public.trading_accounts add constraint trading_accounts_status_check
 check(status in('active','passed','breached','demo','closed'));
create table public.infinity_v2_restarts(user_id uuid not null,month date not null,old_account_id uuid not null,new_account_id uuid not null,
 created_at timestamptz not null default now(),primary key(user_id,month));
alter table public.infinity_v2_restarts enable row level security;
revoke all on public.infinity_v2_restarts from public,anon,authenticated;
grant select on public.infinity_v2_restarts to service_role;
create trigger infinity_v2_restarts_frozen before update or delete on public.infinity_v2_restarts for each row execute function public.infinity_v2_append_only();
create function public.infinity_v2_status() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('v2_enabled',s.infinity_v2_enabled and clock_timestamp()>=s.cutover_at,
 'v2_rules',r.rules,'v2_terms_version',s.terms_version,'cutover_at',s.cutover_at,
 'v2_terms_url',(select document_url from public.platform_legal_documents where version=s.terms_version),
 'pricing_profiles',(select jsonb_agg(to_jsonb(p) order by p.symbol) from public.infinity_v2_pricing_profiles p))
 from public.infinity_v2_settings s join public.infinity_rules_versions r on r.id='infinity_v2' where s.singleton;
$$;
create function public.fn_restart_infinity_v2(p_user uuid,p_terms text,p_accept boolean,p_confirm_age boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.infinity_v2_settings;a public.trading_accounts;n public.trading_accounts;p public.challenge_presets;
 previous public.infinity_v2_restarts;month_start timestamptz:=date_trunc('month',clock_timestamp() at time zone 'UTC') at time zone 'UTC';
 privacy text;used int;cap int;stamp timestamptz:=clock_timestamp();reset jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('infinity_v2_start:'||p_user::text,0));
 select * into s from public.infinity_v2_settings where singleton;
 if not s.infinity_v2_enabled or stamp<s.cutover_at then raise exception 'V2_NOT_LIVE';end if;
 if not coalesce(p_accept,false) or p_terms is distinct from s.terms_version then raise exception 'TERMS_NOT_ACCEPTED';end if;
 select * into previous from public.infinity_v2_restarts where user_id=p_user and month=month_start::date;
 if found then select * into n from public.trading_accounts where id=previous.new_account_id;
 return jsonb_build_object('ok',true,'account',jsonb_build_object('id',n.id,'label',n.label,'starting_balance',n.starting_balance),'attempts_left',0);end if;
 if not exists(select 1 from auth.users where id=p_user and email_confirmed_at is not null) then raise exception 'VERIFY_EMAIL_FIRST';end if;
 if not exists(select 1 from public.trader_identity_private where user_id=p_user) then raise exception 'COMPLETE_IDENTITY_FIRST';end if;
 if exists(select 1 from public.user_profiles where user_id=p_user and restricted_jurisdiction) then raise exception 'RESTRICTED_JURISDICTION';end if;
 if not exists(select 1 from public.trader_kyc where user_id=p_user and status in('pending','verified')) then raise exception 'COMPLETE_KYC_FIRST';end if;
 if not coalesce(p_confirm_age,false) and not exists(select 1 from public.user_profiles where user_id=p_user and age_confirmed) then raise exception 'CONFIRM_ADULT_AGE';end if;
 if exists(select 1 from public.trader_identity_private where user_id=p_user and date_of_birth>(stamp at time zone 'UTC')::date-interval '18 years') then raise exception 'ADULT_AGE_REQUIRED';end if;
 if coalesce((public.fn_infinity_breach_lockout(p_user)->>'locked')::boolean,true) then raise exception 'BREACH_LOCKOUT_ACTIVE';end if;
 reset:=public.infinity_reset_context(p_user);
 if coalesce((reset->>'reapplication_required')::boolean,false) then raise exception 'APPROVED_REAPPLICATION_REQUIRED';end if;
 select * into a from public.trading_accounts where user_id=p_user and challenge_type='infinity' and coalesce(phase,'')<>'demo'
 and not(id::text in(select jsonb_array_elements_text(coalesce(reset->'retired_account_ids','[]')))) order by created_at desc limit 1 for update;
 if not found then raise exception 'INFINITY_RUN_REQUIRED';end if;
 if exists(select 1 from public.trading_accounts where user_id=p_user and id<>a.id and status='active' and access_revoked_at is null and coalesce(phase,'')<>'demo') then raise exception 'ONE_ACCOUNT_RULE';end if;
 if exists(select 1 from public.trades t join public.trading_accounts v on v.id=t.account_id where v.user_id=p_user and coalesce(v.phase,'')<>'demo' and t.status='open') then raise exception 'CLOSE_OPEN_POSITIONS_FIRST';end if;
 if exists(select 1 from public.pending_orders t join public.trading_accounts v on v.id=t.account_id where v.user_id=p_user and coalesce(v.phase,'')<>'demo' and t.status='pending') then raise exception 'CANCEL_PENDING_ORDERS_FIRST';end if;
 select * into p from public.challenge_presets where id='infinity_s1';
 cap:=coalesce(p.max_attempts_per_month,1);
 select count(*) into used from public.trading_accounts where user_id=p_user and preset_id=p.id and created_at>=month_start;
 if used>=cap then raise exception 'NO_RESTARTS_LEFT: Next restart %',(month_start+interval '1 month');end if;
 select version into privacy from public.platform_legal_current where kind='privacy';
 if privacy is null or not exists(select 1 from public.platform_legal_documents where version=p_terms and kind='terms') then raise exception 'PUBLISHED_TERMS_REQUIRED';end if;
 update public.trading_accounts set status='closed',access_revoked_at=stamp,access_revoked_reason='voluntary_infinity_v2_restart',updated_at=stamp where id=a.id;
 insert into public.trading_accounts(user_id,label,preset_id,challenge_type,stage,phase,status,starting_balance,balance,day_start_equity,day_start_date,
 profit_target_pct,max_drawdown_pct,daily_loss_pct,drawdown_mode,trailing_peak,min_trading_days,min_trades,max_risk_per_trade_pct,daily_profit_cap_pct,min_profitable_days_pct,
 require_stop_loss,profit_split_pct,challenge_fee_usd,total_paid_out,approval_request_id)
 values(p_user,p.label,p.id,'infinity',1,'evaluation','active',p.starting_balance,p.starting_balance,p.starting_balance,(stamp at time zone 'UTC')::date,
 p.profit_target_pct,p.max_drawdown_pct,p.daily_loss_pct,p.drawdown_mode,p.starting_balance,0,0,p.max_risk_per_trade_pct,null,null,true,0,0,0,a.approval_request_id) returning * into n;
 insert into public.platform_legal_acceptances(user_id,terms_version,privacy_version,context) values(p_user,p_terms,privacy,
 jsonb_build_object('programme','infinity_v2','action','restart','account_id',n.id,'previous_account_id',a.id,'at',stamp));
 insert into public.infinity_v2_restarts(user_id,month,old_account_id,new_account_id) values(p_user,month_start::date,a.id,n.id);
 update public.user_profiles set age_confirmed=true where user_id=p_user and coalesce(p_confirm_age,false);
 return jsonb_build_object('ok',true,'account',jsonb_build_object('id',n.id,'label',n.label,'starting_balance',n.starting_balance),'attempts_left',greatest(0,cap-used-1));
end $$;

create function public.infinity_v2_new_run_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare p public.challenge_presets;used int;reset jsonb;
begin
 if new.rules_version is distinct from 'infinity_v2' or new.stage<>1 then return new;end if;
 perform pg_advisory_xact_lock(hashtextextended('infinity_v2_start:'||new.user_id::text,0));
 if exists(select 1 from public.trading_accounts where user_id=new.user_id and id<>new.id and status='active' and access_revoked_at is null and coalesce(phase,'')<>'demo') then raise exception 'ONE_ACCOUNT_RULE';end if;
 if exists(select 1 from public.trades t join public.trading_accounts a on a.id=t.account_id where a.user_id=new.user_id and coalesce(a.phase,'')<>'demo' and t.status='open') then raise exception 'CLOSE_OPEN_POSITIONS_FIRST';end if;
 if exists(select 1 from public.pending_orders t join public.trading_accounts a on a.id=t.account_id where a.user_id=new.user_id and coalesce(a.phase,'')<>'demo' and t.status='pending') then raise exception 'CANCEL_PENDING_ORDERS_FIRST';end if;
 if coalesce((public.fn_infinity_breach_lockout(new.user_id)->>'locked')::boolean,true) then raise exception 'BREACH_LOCKOUT_ACTIVE';end if;
 select * into p from public.challenge_presets where id='infinity_s1';reset:=public.infinity_reset_context(new.user_id);
 select count(*) into used from public.trading_accounts where user_id=new.user_id and preset_id=p.id
 and created_at>=date_trunc('month',clock_timestamp() at time zone 'UTC') at time zone 'UTC'
;
 if used>=coalesce(p.max_attempts_per_month,1) then raise exception 'MONTHLY_ATTEMPTS_EXHAUSTED';end if;
 return new;
end $$;
create trigger zz_infinity_v2_new_run_guard before insert on public.trading_accounts for each row execute function public.infinity_v2_new_run_guard();
revoke all on function public.infinity_v2_status(),public.fn_restart_infinity_v2(uuid,text,boolean,boolean),public.infinity_v2_new_run_guard() from public,anon,authenticated;
grant execute on function public.infinity_v2_status(),public.fn_restart_infinity_v2(uuid,text,boolean,boolean) to service_role;
commit;
