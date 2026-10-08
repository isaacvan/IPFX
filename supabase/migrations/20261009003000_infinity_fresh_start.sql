-- Owner-requested fresh Infinity application. Preserve all trades, identities,
-- documents and prior consent. Running the reset is a separate audited action.
begin;
create table public.infinity_reset_batches(id text primary key,reason text not null,requested_by uuid not null,exempt_users uuid[] not null default '{}',
 reset_at timestamptz not null default clock_timestamp(),account_count int not null default 0,application_count int not null default 0);
create table public.infinity_reset_users(user_id uuid primary key,reset_id text not null references public.infinity_reset_batches);
create table public.infinity_retired_accounts(account_id uuid primary key,reset_id text not null references public.infinity_reset_batches,
 user_id uuid not null,snapshot jsonb not null);
create table public.infinity_retired_applications(application_id uuid primary key,reset_id text not null references public.infinity_reset_batches,
 user_id uuid not null,previous_status text not null,snapshot jsonb not null);
alter table public.infinity_reset_batches enable row level security;
alter table public.infinity_reset_users enable row level security;
alter table public.infinity_retired_accounts enable row level security;
alter table public.infinity_retired_applications enable row level security;
revoke all on public.infinity_reset_batches,public.infinity_reset_users,public.infinity_retired_accounts,public.infinity_retired_applications from public,anon,authenticated;
grant select,insert,update on public.infinity_reset_batches to service_role;
grant select,insert on public.infinity_reset_users,public.infinity_retired_accounts,public.infinity_retired_applications to service_role;
create function public.infinity_reset_context(p_user uuid)returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('reset_at',b.reset_at,'reset_id',b.id,
 'reapplication_required',b.id is not null and not exists(select 1 from public.challenge_enrolment_requests r
 where r.user_id=p_user and r.challenge_type='infinity' and r.status<>'withdrawn' and r.created_at>=b.reset_at),
 'retired_account_ids',coalesce((select jsonb_agg(account_id)from public.infinity_retired_accounts where user_id=p_user),'[]'::jsonb))
 from(select 1)x left join public.infinity_reset_users u on u.user_id=p_user left join public.infinity_reset_batches b on b.id=u.reset_id;
$$;
revoke all on function public.infinity_reset_context(uuid) from public,anon,authenticated;
grant execute on function public.infinity_reset_context(uuid) to service_role;
create function public.get_my_infinity_reset()returns jsonb language plpgsql stable security definer set search_path='' as $$
begin if auth.uid() is null then raise exception 'NOT_SIGNED_IN';end if;return public.infinity_reset_context(auth.uid());end;$$;
revoke all on function public.get_my_infinity_reset() from public,anon;
grant execute on function public.get_my_infinity_reset() to authenticated;
-- Withdrawn applications are retained but no longer occupy the current request.
drop index public.challenge_enrolment_user_preset_uidx;
create unique index challenge_enrolment_user_preset_uidx on public.challenge_enrolment_requests(user_id,preset_id)where status<>'withdrawn';
create function public.infinity_retired_guard()returns trigger language plpgsql security definer set search_path='' as $$
declare reset_time timestamptz;
begin
 if tg_table_name='challenge_enrolment_requests' then
  if exists(select 1 from public.infinity_retired_applications where application_id=old.id)then
   raise exception 'INFINITY_APPLICATION_RETIRED: Submit a new application';end if;
  return new;
 end if;
 if tg_op='UPDATE' then
  if exists(select 1 from public.infinity_retired_accounts where account_id=old.id)and new.access_revoked_at is null then
   raise exception 'INFINITY_ACCOUNT_RETIRED: A new approved account is required';end if;
  return new;
 end if;
 if new.challenge_type='infinity' and new.status='active' and coalesce(new.phase,'')<>'demo' then
  select b.reset_at into reset_time from public.infinity_reset_users u join public.infinity_reset_batches b on b.id=u.reset_id where u.user_id=new.user_id;
  if reset_time is not null and not exists(select 1 from public.challenge_enrolment_requests r
   where r.user_id=new.user_id and r.challenge_type='infinity' and r.preset_id='infinity_s1'
   and r.status='approved' and r.created_at>=reset_time)then
   raise exception 'INFINITY_FRESH_APPLICATION_REQUIRED';end if;
  if exists(select 1 from public.infinity_retired_accounts where account_id=new.funded_from_account_id)then
   raise exception 'INFINITY_RETIRED_STAGE_CANNOT_ADVANCE';end if;
 end if;
 return new;
end;$$;
create trigger infinity_fresh_account before insert or update on public.trading_accounts for each row execute function public.infinity_retired_guard();
create trigger infinity_retired_application before update on public.challenge_enrolment_requests
 for each row when(old.status='withdrawn')execute function public.infinity_retired_guard();
do $patch$
declare d text;anchor text;
begin
 d:=pg_get_functiondef('public.submit_challenge_application(text,jsonb,text)'::regprocedure);
 anchor:='  if v_uid is null then raise exception ''NOT_SIGNED_IN'' using errcode=''28000''; end if;';
 if strpos(d,anchor)=0 then raise exception 'FRESH_APPLICATION_SUBMIT_SOURCE_DRIFT';end if;
 d:=replace(d,anchor,anchor||E'\n  if p_challenge_type=''infinity'' and exists(select 1 from public.infinity_reset_users u join public.infinity_reset_batches b on b.id=u.reset_id where u.user_id=v_uid and not exists(select 1 from public.trader_identity_private i where i.user_id=v_uid and i.updated_at>=b.reset_at)) then raise exception ''INFINITY_DETAILS_RESUBMISSION_REQUIRED'';end if;');
 anchor:='where user_id=v_uid and preset_id=v_preset_id;';
 if strpos(d,anchor)=0 then raise exception 'FRESH_APPLICATION_LOOKUP_SOURCE_DRIFT';end if;
 execute replace(d,anchor,'where user_id=v_uid and preset_id=v_preset_id and status<>''withdrawn'';');
 d:=pg_get_functiondef('public.get_my_challenge_application(text)'::regprocedure);
 anchor:='where user_id=v_uid and preset_id=p_preset_id;';
 if strpos(d,anchor)=0 then raise exception 'FRESH_APPLICATION_READ_SOURCE_DRIFT';end if;
 execute replace(d,anchor,'where user_id=v_uid and preset_id=p_preset_id and status<>''withdrawn'';');
 d:=pg_get_functiondef('public.enforce_infinity_stage1_monthly_start()'::regprocedure);
 anchor:='and a.preset_id = ''infinity_s1''';
 if strpos(d,anchor)=0 then raise exception 'FRESH_ATTEMPT_SOURCE_DRIFT';end if;
 execute replace(d,anchor,anchor||' and not exists(select 1 from public.infinity_retired_accounts r where r.account_id=a.id)');
 d:=pg_get_functiondef('public.fn_infinity_breach_lockout(uuid)'::regprocedure);
 anchor:='where a.challenge_type=''infinity'' and a.status=''breached''';
 if strpos(d,anchor)=0 then raise exception 'FRESH_LOCKOUT_SOURCE_DRIFT';end if;
 execute replace(d,anchor,anchor||' and not exists(select 1 from public.infinity_retired_accounts r where r.account_id=a.id)');
end;$patch$;
create function public.infinity_run_fresh_start(p_id text,p_actor uuid,p_reason text,p_expected_accounts int,p_exempt_users uuid[] default '{}')returns jsonb
language plpgsql security definer set search_path='' as $$
declare n int;apps int;at_time timestamptz;
begin
 if not exists(select 1 from public.admins where user_id=p_actor)or length(btrim(p_reason))<10 then raise exception 'OWNER_RESET_REASON_REQUIRED';end if;
 if p_exempt_users is null or cardinality(p_exempt_users)>20 or exists(select 1 from unnest(p_exempt_users)x where x is null or not exists(select 1 from auth.users u where u.id=x))then raise exception 'RESET_EXEMPTION_INVALID';end if;
 perform pg_advisory_xact_lock(hashtext('infinity-fresh-start'));
 if exists(select 1 from public.infinity_reset_batches where id=p_id)then return jsonb_build_object('already_applied',true);end if;
 lock table public.trading_accounts,public.trades,public.pending_orders,public.challenge_enrolment_requests in share row exclusive mode;
 select count(*) into n from public.trading_accounts where challenge_type='infinity' and status<>'demo' and coalesce(phase,'')<>'demo';
 if n<>p_expected_accounts then raise exception 'RESET_SCOPE_CHANGED:%',n;end if;
 if exists(select 1 from public.trades t join public.trading_accounts a on a.id=t.account_id where a.challenge_type='infinity' and a.status<>'demo' and coalesce(a.phase,'')<>'demo' and t.status='open')
  or exists(select 1 from public.pending_orders o join public.trading_accounts a on a.id=o.account_id where a.challenge_type='infinity' and a.status<>'demo' and coalesce(a.phase,'')<>'demo' and o.status='pending')then
  raise exception 'RESET_OPEN_EXPOSURE_REQUIRES_REVIEW';end if;
 -- No payout/identity/trade mutation. Audit snapshots support recovery.
 insert into public.infinity_reset_batches(id,reason,requested_by,account_count,exempt_users)values(p_id,p_reason,p_actor,n,p_exempt_users)returning reset_at into at_time;
 insert into public.infinity_reset_users(user_id,reset_id)select id,p_id from auth.users where not(id=any(p_exempt_users));
 insert into public.infinity_retired_accounts(account_id,reset_id,user_id,snapshot)
 select id,p_id,user_id,to_jsonb(a)from public.trading_accounts a where challenge_type='infinity' and status<>'demo' and coalesce(phase,'')<>'demo';
 update public.trading_accounts set access_revoked_at=coalesce(access_revoked_at,at_time),access_revoked_reason='infinity_launch_fresh_application',updated_at=at_time
 where id in(select account_id from public.infinity_retired_accounts where reset_id=p_id);
 -- Withdraw first, then freeze old requests against later accidental approval.
 create temp table reset_previous_applications on commit drop as
 select id,user_id,status,to_jsonb(r)snapshot from public.challenge_enrolment_requests r where challenge_type='infinity' and status<>'withdrawn' and not(user_id=any(p_exempt_users));
 update public.challenge_enrolment_requests set status='withdrawn',decision_note='Infinity launch reset: submit your details again for a fresh Stage 1 application.',updated_at=at_time
 where challenge_type='infinity' and status<>'withdrawn' and not(user_id=any(p_exempt_users));get diagnostics apps=row_count;
 insert into public.infinity_retired_applications(application_id,reset_id,user_id,previous_status,snapshot)
 select id,p_id,user_id,status,snapshot from reset_previous_applications;
 update public.infinity_reset_batches set application_count=apps where id=p_id;
 return jsonb_build_object('reset_at',at_time,'retired_accounts',n,'withdrawn_applications',apps,'new_account_trades',0,'history_preserved',true);
end;$$;
revoke all on function public.infinity_run_fresh_start(text,uuid,text,int,uuid[]),public.infinity_retired_guard()from public,anon,authenticated;
grant execute on function public.infinity_run_fresh_start(text,uuid,text,int,uuid[])to service_role;
commit;
