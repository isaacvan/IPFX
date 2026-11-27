-- Self-service account deletion (owner decision 27 Nov 2026): a trader types DELETE, trading stops at once, they get an
-- email with a cancel link, and after 7 days everything personal is erased automatically - the same steps as the first
-- manual erasure (27 Nov 2026). Blocked (and the owner alerted) while a trade or order is open, a payout is in progress
-- or the account is under an integrity review. Trades and statistics are kept only against the anonymous account id.
begin;

create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  requested_at timestamptz not null default now(),
  erase_after timestamptz not null default now() + interval '7 days',
  status text not null default 'scheduled' check (status in ('scheduled','cancelled','blocked','erased')),
  cancel_token text not null unique default replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),
  revoked_accounts uuid[] not null default '{}',
  blocked_reason text,
  erased_at timestamptz,
  detail jsonb not null default '{}'::jsonb
);
create unique index if not exists account_deletion_one_open on public.account_deletion_requests(user_id) where status in ('scheduled','blocked');
alter table public.account_deletion_requests enable row level security;
revoke all on public.account_deletion_requests from public, anon, authenticated;
grant select, insert, update on public.account_deletion_requests to service_role;

-- Reasons a deletion must wait. Empty array = clear to erase.
create or replace function public.fn_account_deletion_blockers(p_user uuid) returns text[]
language plpgsql stable security definer set search_path='' as $$
declare out text[]:='{}';
begin
  if exists(select 1 from public.trades t join public.trading_accounts a on a.id=t.account_id where a.user_id=p_user and t.status='open') then out:=array_append(out,'OPEN_POSITIONS'); end if;
  if exists(select 1 from public.pending_orders o join public.trading_accounts a on a.id=o.account_id where a.user_id=p_user and o.status='pending') then out:=array_append(out,'PENDING_ORDERS'); end if;
  if exists(select 1 from public.payouts p where p.user_id=p_user and p.status in ('requested','approved')) then out:=array_append(out,'PAYOUT_IN_PROGRESS'); end if;
  if exists(select 1 from public.trading_accounts a where a.user_id=p_user and coalesce(a.investigation_hold,false)) then out:=array_append(out,'INTEGRITY_REVIEW'); end if;
  return out;
end $$;

create or replace function public.fn_request_account_deletion(p_user uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b text[]; r public.account_deletion_requests; ids uuid[];
begin
  select * into r from public.account_deletion_requests where user_id=p_user and status in ('scheduled','blocked');
  if found then return jsonb_build_object('ok',true,'already_requested',true,'erase_after',r.erase_after,'status',r.status); end if;
  b:=public.fn_account_deletion_blockers(p_user);
  if 'OPEN_POSITIONS'=any(b) then raise exception 'CLOSE_OPEN_POSITIONS_FIRST'; end if;
  if 'PENDING_ORDERS'=any(b) then raise exception 'CANCEL_PENDING_ORDERS_FIRST'; end if;
  if 'PAYOUT_IN_PROGRESS'=any(b) then raise exception 'PAYOUT_IN_PROGRESS'; end if;
  -- stop trading now; remember exactly which accounts were open so a cancellation restores only those
  select coalesce(array_agg(id),'{}') into ids from public.trading_accounts
   where user_id=p_user and status in ('active','demo') and access_revoked_at is null;
  update public.trading_accounts set access_revoked_at=clock_timestamp(), access_revoked_reason='account_deletion_requested', mirror_enabled=false, updated_at=clock_timestamp()
   where id=any(ids);
  insert into public.account_deletion_requests(user_id, revoked_accounts) values (p_user, ids) returning * into r;
  return jsonb_build_object('ok',true,'erase_after',r.erase_after,'cancel_token',r.cancel_token,'request_id',r.id);
end $$;

create or replace function public.fn_cancel_account_deletion(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.account_deletion_requests;
begin
  select * into r from public.account_deletion_requests where cancel_token=p_token for update;
  if not found then raise exception 'DELETION_REQUEST_NOT_FOUND'; end if;
  if r.status='erased' then raise exception 'ALREADY_ERASED'; end if;
  if r.status='cancelled' then return jsonb_build_object('ok',true,'already_cancelled',true); end if;
  update public.trading_accounts set access_revoked_at=null, access_revoked_reason=null, updated_at=clock_timestamp()
   where id=any(r.revoked_accounts) and access_revoked_reason='account_deletion_requested';
  update public.account_deletion_requests set status='cancelled', detail=detail||jsonb_build_object('cancelled_at',clock_timestamp()) where id=r.id;
  return jsonb_build_object('ok',true,'cancelled',true);
end $$;

-- Erase everything personal except the sign-in record (scrubbed last, after the confirmation email). Tolerant: a table
-- that does not exist is skipped. Append-only guards are paused only inside this transaction.
create or replace function public.fn_gdpr_erase_user(p_user uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare em text; nm text; s text; n int; log jsonb:='{}'::jsonb; g record;
  guards text[][]:=array[['ab_e8_trader_perf_history','ab_e8_trader_perf_history_frozen'],['platform_legal_acceptances','legal_acceptances_frozen']];
  steps text[][]:=array[
   ['trader_identity_private','delete from public.trader_identity_private where user_id=$1'],
   ['kyc_submissions','delete from public.kyc_submissions where user_id=$1'],
   ['trader_kyc','delete from public.trader_kyc where user_id=$1'],
   ['consent_records','delete from public.consent_records where user_id=$1'],
   ['platform_legal_acceptances','delete from public.platform_legal_acceptances where user_id=$1'],
   ['security_events','delete from public.security_events where user_id=$1'],
   ['user_chart_layouts','delete from public.user_chart_layouts where user_id=$1'],
   ['chart_indicator_events','delete from public.chart_indicator_events where user_id=$1'],
   ['trader_strategy_paper_plans','delete from public.trader_strategy_paper_plans where user_id=$1'],
   ['trader_strategy_hypotheses','delete from public.trader_strategy_hypotheses where user_id=$1'],
   ['trader_style_profiles','delete from public.trader_style_profiles where user_id=$1'],
   ['trade_journal_entries','delete from public.trade_journal_entries where user_id=$1'],
   ['price_alerts','delete from public.price_alerts where user_id=$1'],
   ['payout_methods','delete from public.payout_methods where user_id=$1'],
   ['order_audit_events','update public.order_audit_events set client_ip=null where user_id=$1 and client_ip is not null'],
   ['challenge_enrolment_requests','update public.challenge_enrolment_requests set application_details=''{}''::jsonb,decision_note=null where user_id=$1'],
   ['trading_accounts','update public.trading_accounts set status=''closed'',access_revoked_at=coalesce(access_revoked_at,clock_timestamp()),access_revoked_reason=''account_deleted_on_request'',mirror_enabled=false,updated_at=clock_timestamp() where user_id=$1 and status in (''active'',''demo'')'],
   ['email_events','delete from public.email_events where user_id=$1'],
   ['user_profiles','delete from public.user_profiles where user_id=$1']];
  i int;
begin
  select u.email, coalesce(u.raw_user_meta_data->>'full_name','') into em, nm from auth.users u where u.id=p_user;
  if em is null then raise exception 'USER_NOT_FOUND'; end if;
  for i in 1..array_length(guards,1) loop
    if to_regclass('public.'||guards[i][1]) is not null and exists(select 1 from pg_trigger where tgname=guards[i][2]) then
      execute format('alter table public.%I disable trigger %I', guards[i][1], guards[i][2]); end if;
  end loop;
  for i in 1..array_length(steps,1) loop
    if to_regclass('public.'||steps[i][1]) is null then continue; end if;
    begin execute steps[i][2] using p_user; get diagnostics n=row_count; log:=log||jsonb_build_object(steps[i][1],n);
    exception when others then log:=log||jsonb_build_object(steps[i][1],'failed: '||sqlerrm); end;
  end loop;
  if to_regclass('public.email_events') is not null then delete from public.email_events where lower(to_email)=lower(em); end if;
  -- name and email inside analytics caches and alerts
  if length(nm)>=3 or em is not null then
    if to_regclass('public.ab_alerts') is not null then
      update public.ab_alerts set title=replace(replace(title,nm,'Deleted trader'),em,'deleted trader') where person_id=p_user or (length(nm)>=3 and title ilike '%'||nm||'%') or title ilike '%'||em||'%'; end if;
    if to_regclass('public.ab_e8_trader_perf_trade_cache') is not null then
      delete from public.ab_e8_trader_perf_trade_cache where trader_id=p_user or payload::text ilike '%'||em||'%'; end if;
    if to_regclass('public.ab_e8_trader_perf_trader_cache') is not null then
      delete from public.ab_e8_trader_perf_trader_cache where row_data::text ilike '%'||em||'%' or (length(nm)>=3 and row_data::text ilike '%'||nm||'%'); end if;
    if to_regclass('public.ab_e8_trader_perf_history') is not null then
      update public.ab_e8_trader_perf_history set row_data=replace(replace(row_data::text,em,'deleted-trader@deleted.invalid'),case when length(nm)>=3 then nm else em end,'Deleted trader')::jsonb
       where row_data::text ilike '%'||em||'%' or (length(nm)>=3 and row_data::text ilike '%'||nm||'%'); end if;
    if to_regclass('public.ab_e8_trader_perf_runs') is not null then
      update public.ab_e8_trader_perf_runs set detail=replace(replace(detail::text,em,'deleted-trader@deleted.invalid'),case when length(nm)>=3 then nm else em end,'Deleted trader')::jsonb
       where detail::text ilike '%'||em||'%' or (length(nm)>=3 and detail::text ilike '%'||nm||'%'); end if;
  end if;
  delete from auth.sessions where user_id=p_user;
  for i in 1..array_length(guards,1) loop
    if to_regclass('public.'||guards[i][1]) is not null and exists(select 1 from pg_trigger where tgname=guards[i][2]) then
      execute format('alter table public.%I enable trigger %I', guards[i][1], guards[i][2]); end if;
  end loop;
  insert into public.admin_audit_log(actor_id,action,target_user_id,detail) values(p_actor,'gdpr_erasure',p_user,log);
  return jsonb_build_object('ok',true,'email',em,'name',nm,'steps',log);
end $$;

-- Last step, after the confirmation email has gone: the sign-in record keeps only an anonymous id.
create or replace function public.fn_gdpr_scrub_auth(p_user uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  delete from auth.identities where user_id=p_user;
  delete from auth.sessions where user_id=p_user;
  delete from auth.mfa_factors where user_id=p_user;
  delete from auth.one_time_tokens where user_id=p_user;
  update auth.users set email='deleted-'||left(p_user::text,8)||'@deleted.invalid', phone=null, raw_user_meta_data='{}'::jsonb,
    raw_app_meta_data=jsonb_build_object('provider','email','providers',jsonb_build_array('email'),'erased',true),
    encrypted_password='', banned_until='2999-12-31', deleted_at=now(), updated_at=now(),
    confirmation_token='', recovery_token='', email_change='', email_change_token_new='', email_change_token_current='',
    phone_change='', phone_change_token='', reauthentication_token=''
  where id=p_user;
  update public.account_deletion_requests set status='erased', erased_at=clock_timestamp() where user_id=p_user and status in ('scheduled','blocked');
  insert into public.admin_audit_log(actor_id,action,target_user_id,detail) values(p_actor,'gdpr_erasure_completed',p_user,jsonb_build_object('sign_in_scrubbed',true));
  return jsonb_build_object('ok',true);
end $$;

revoke all on function public.fn_account_deletion_blockers(uuid), public.fn_request_account_deletion(uuid), public.fn_cancel_account_deletion(text),
  public.fn_gdpr_erase_user(uuid,uuid), public.fn_gdpr_scrub_auth(uuid,uuid) from public, anon, authenticated;
grant execute on function public.fn_account_deletion_blockers(uuid), public.fn_request_account_deletion(uuid), public.fn_cancel_account_deletion(text),
  public.fn_gdpr_erase_user(uuid,uuid), public.fn_gdpr_scrub_auth(uuid,uuid) to service_role;

insert into public.email_templates (key, category, subject, preheader, body_html, body_text, is_active) values (
 'account_deletion_scheduled', 'compliance', 'Your IPFX Capital account will be deleted in 7 days',
 'Trading has stopped. Changed your mind? You can cancel within 7 days.',
 '<p>Dear {{customer_name}},</p>
<p>We have received your request to delete your IPFX Capital account. Trading on your accounts has stopped.</p>
<p>On <strong>{{erase_date}}</strong> we will permanently delete your personal information, including your identity documents. Any remaining trading statistics will be kept only in anonymised form that cannot be linked to you. We will email you when it is done.</p>
<p>Changed your mind? Cancel before then and your accounts will be restored:</p>
<p><a href="{{cancel_url}}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Keep my account</a></p>
<p>Kind regards,<br>IPFX Capital</p>',
 'Dear {{customer_name}},

We have received your request to delete your IPFX Capital account. Trading on your accounts has stopped.

On {{erase_date}} we will permanently delete your personal information, including your identity documents. Any remaining trading statistics will be kept only in anonymised form that cannot be linked to you. We will email you when it is done.

Changed your mind? Cancel before then and your accounts will be restored: {{cancel_url}}

Kind regards,
IPFX Capital', true)
on conflict (key) do update set subject=excluded.subject, preheader=excluded.preheader, body_html=excluded.body_html, body_text=excluded.body_text, is_active=true;

commit;
