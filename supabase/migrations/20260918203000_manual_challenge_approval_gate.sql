-- Owner-approved challenge access for every IPFX programme.
-- Existing pre-approval accounts are reversibly revoked and hidden from
-- traders while their orders, trades, P&L and audit history remain intact.

begin;

create table if not exists public.trader_identity_private (
  user_id uuid primary key references auth.users(id) on delete cascade,
  legal_first_name text not null,
  legal_middle_names text,
  legal_last_name text not null,
  date_of_birth date not null,
  phone_e164 text not null,
  address_line_1 text not null,
  address_line_2 text,
  city text not null,
  region text,
  postal_code text not null,
  country_code text not null,
  nationality_code text,
  identity_version text not null default '2026-09-identity-v1',
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(legal_first_name) between 1 and 80),
  check (legal_middle_names is null or char_length(legal_middle_names) <= 120),
  check (char_length(legal_last_name) between 1 and 80),
  check (date_of_birth <= (current_date - interval '18 years')::date),
  check (date_of_birth >= date '1900-01-01'),
  check (phone_e164 ~ '^[+][1-9][0-9]{7,14}$'),
  check (char_length(address_line_1) between 3 and 160),
  check (address_line_2 is null or char_length(address_line_2) <= 160),
  check (char_length(city) between 1 and 100),
  check (region is null or char_length(region) <= 100),
  check (char_length(postal_code) between 2 and 24),
  check (country_code ~ '^[A-Z]{2}$'),
  check (nationality_code is null or nationality_code ~ '^[A-Z]{2}$')
);
alter table public.trader_identity_private enable row level security;
revoke all on public.trader_identity_private from public, anon, authenticated;
grant all on public.trader_identity_private to service_role;
create index if not exists trader_identity_private_country_idx
  on public.trader_identity_private(country_code);

create table if not exists public.challenge_enrolment_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_type text not null
    check (challenge_type in ('infinity','traditional','futures','pac')),
  preset_id text not null references public.challenge_presets(id),
  status text not null default 'pending'
    check (status in ('pending','approved','denied','withdrawn')),
  application_details jsonb not null default '{}'::jsonb,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  decision_note text,
  trading_account_id uuid references public.trading_accounts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(application_details) = 'object'),
  check (octet_length(application_details::text) <= 12000)
);
-- Upgrade the earlier PAC-only schema as well as building a fresh production
-- schema. No application is discarded during the conversion.
alter table public.challenge_enrolment_requests
  add column if not exists preset_id text references public.challenge_presets(id),
  add column if not exists decision_note text,
  add column if not exists trading_account_id uuid references public.trading_accounts(id);
update public.challenge_enrolment_requests
set status=case status when 'reviewing' then 'pending' when 'rejected' then 'denied' else status end
where status in ('reviewing','rejected');
update public.challenge_enrolment_requests
set preset_id='pac_'||case
  when lower(coalesce(application_details->>'preferred_capital','')) like '%250k%' then '250k'
  when lower(coalesce(application_details->>'preferred_capital','')) like '%100k%' then '100k'
  when lower(coalesce(application_details->>'preferred_capital','')) like '%50k%' then '50k'
  else '25k' end
where preset_id is null and challenge_type='pac';
alter table public.challenge_enrolment_requests
  drop constraint if exists challenge_enrolment_requests_challenge_type_check,
  drop constraint if exists challenge_enrolment_requests_status_check;
alter table public.challenge_enrolment_requests
  add constraint challenge_enrolment_requests_challenge_type_check
    check (challenge_type in ('infinity','traditional','futures','pac')),
  add constraint challenge_enrolment_requests_status_check
    check (status in ('pending','approved','denied','withdrawn'));
alter table public.challenge_enrolment_requests alter column preset_id set not null;
drop index if exists public.challenge_enrolment_one_open_request_idx;
create unique index if not exists challenge_enrolment_user_preset_uidx
  on public.challenge_enrolment_requests(user_id,preset_id);
alter table public.challenge_enrolment_requests enable row level security;
revoke all on public.challenge_enrolment_requests from public, anon, authenticated;
grant select on public.challenge_enrolment_requests to authenticated;
grant all on public.challenge_enrolment_requests to service_role;
drop policy if exists "own challenge enrolment requests read" on public.challenge_enrolment_requests;
create policy "own challenge enrolment requests read"
  on public.challenge_enrolment_requests for select to authenticated
  using (user_id = (select auth.uid()));
create index if not exists challenge_enrolment_review_queue_idx
  on public.challenge_enrolment_requests(status, created_at);
create index if not exists challenge_enrolment_preset_idx
  on public.challenge_enrolment_requests(preset_id);
create index if not exists challenge_enrolment_reviewer_idx
  on public.challenge_enrolment_requests(reviewed_by) where reviewed_by is not null;
create index if not exists challenge_enrolment_account_idx
  on public.challenge_enrolment_requests(trading_account_id) where trading_account_id is not null;

alter table public.trading_accounts
  add column if not exists access_revoked_at timestamptz,
  add column if not exists access_revoked_reason text,
  add column if not exists approval_request_id uuid
    references public.challenge_enrolment_requests(id);

create table if not exists public.challenge_access_revocations (
  account_id uuid primary key references public.trading_accounts(id),
  user_id uuid not null references auth.users(id),
  reason text not null,
  snapshot jsonb not null,
  revoked_at timestamptz not null default now()
);
alter table public.challenge_access_revocations enable row level security;
revoke all on public.challenge_access_revocations from public, anon, authenticated;
grant all on public.challenge_access_revocations to service_role;
create index if not exists challenge_access_revocations_user_idx
  on public.challenge_access_revocations(user_id);
create index if not exists trading_accounts_approval_request_idx
  on public.trading_accounts(approval_request_id) where approval_request_id is not null;

-- Reversible launch cutover: preserve every account and trade exactly as-is,
-- but remove all legacy challenge access until a fresh application is approved.
insert into public.challenge_access_revocations(account_id,user_id,reason,snapshot)
select id,user_id,'manual_approval_gate_2026_09',
       jsonb_build_object(
         'status',status,'phase',phase,'label',label,'challenge_type',challenge_type,
         'stage',stage,'starting_balance',starting_balance,'balance',balance,
         'created_at',created_at,'breach_reason',breach_reason
       )
from public.trading_accounts
where access_revoked_at is null
on conflict (account_id) do nothing;

update public.trading_accounts
set access_revoked_at=now(),
    access_revoked_reason='manual_approval_gate_2026_09',
    updated_at=now()
where access_revoked_at is null;

drop policy if exists "own accounts read" on public.trading_accounts;
drop policy if exists "own approved accounts read" on public.trading_accounts;
create policy "own approved accounts read"
  on public.trading_accounts for select to authenticated
  using (user_id=(select auth.uid()) and access_revoked_at is null);

create or replace function public.get_my_identity_profile()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v public.trader_identity_private;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode='28000'; end if;
  select * into v from public.trader_identity_private where user_id=v_uid;
  if not found then return jsonb_build_object('complete',false); end if;
  return jsonb_build_object(
    'complete',true,'legal_first_name',v.legal_first_name,
    'legal_middle_names',v.legal_middle_names,'legal_last_name',v.legal_last_name,
    'date_of_birth',v.date_of_birth,'phone_e164',v.phone_e164,
    'address_line_1',v.address_line_1,'address_line_2',v.address_line_2,
    'city',v.city,'region',v.region,'postal_code',v.postal_code,
    'country_code',v.country_code,'nationality_code',v.nationality_code,
    'updated_at',v.updated_at
  );
end $$;
revoke all on function public.get_my_identity_profile() from public,anon;
grant execute on function public.get_my_identity_profile() to authenticated;

create or replace function public.submit_identity_profile(p_profile jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_uid uuid:=auth.uid(); v_dob date;
  v_first text:=btrim(coalesce(p_profile->>'legal_first_name',''));
  v_middle text:=nullif(btrim(coalesce(p_profile->>'legal_middle_names','')),'');
  v_last text:=btrim(coalesce(p_profile->>'legal_last_name',''));
  v_phone text:=regexp_replace(coalesce(p_profile->>'phone_e164',''),'[^+0-9]','','g');
  v_line1 text:=btrim(coalesce(p_profile->>'address_line_1',''));
  v_line2 text:=nullif(btrim(coalesce(p_profile->>'address_line_2','')),'');
  v_city text:=btrim(coalesce(p_profile->>'city',''));
  v_region text:=nullif(btrim(coalesce(p_profile->>'region','')),'');
  v_postal text:=upper(btrim(coalesce(p_profile->>'postal_code','')));
  v_country text:=upper(btrim(coalesce(p_profile->>'country_code','')));
  v_nationality text:=nullif(upper(btrim(coalesce(p_profile->>'nationality_code',''))),'');
  v_recent integer;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode='28000'; end if;
  if jsonb_typeof(p_profile) is distinct from 'object' then
    raise exception 'IDENTITY_PROFILE_REQUIRED' using errcode='22023';
  end if;
  select count(*)::integer into v_recent from public.security_events
   where user_id=v_uid and event_type='identity_profile_submitted'
     and created_at>now()-interval '1 hour';
  if v_recent>=10 then raise exception 'IDENTITY_RATE_LIMITED' using errcode='P0001'; end if;
  begin v_dob:=(p_profile->>'date_of_birth')::date;
  exception when others then raise exception 'DATE_OF_BIRTH_INVALID' using errcode='22023'; end;
  if v_dob>(current_date-interval '18 years')::date then
    raise exception 'MUST_BE_18' using errcode='22023';
  end if;
  if v_dob<date '1900-01-01' or char_length(v_first) not between 1 and 80
     or char_length(v_last) not between 1 and 80 or v_phone!~'^[+][1-9][0-9]{7,14}$'
     or char_length(v_line1) not between 3 and 160 or char_length(v_city) not between 1 and 100
     or char_length(v_postal) not between 2 and 24 or v_country!~'^[A-Z]{2}$'
     or (v_nationality is not null and v_nationality!~'^[A-Z]{2}$') then
    raise exception 'IDENTITY_PROFILE_INVALID' using errcode='22023';
  end if;
  insert into public.trader_identity_private(
    user_id,legal_first_name,legal_middle_names,legal_last_name,date_of_birth,
    phone_e164,address_line_1,address_line_2,city,region,postal_code,country_code,
    nationality_code,submitted_at,updated_at
  ) values (
    v_uid,v_first,v_middle,v_last,v_dob,v_phone,v_line1,v_line2,v_city,v_region,
    v_postal,v_country,v_nationality,now(),now()
  ) on conflict (user_id) do update set
    legal_first_name=excluded.legal_first_name,
    legal_middle_names=excluded.legal_middle_names,
    legal_last_name=excluded.legal_last_name,date_of_birth=excluded.date_of_birth,
    phone_e164=excluded.phone_e164,address_line_1=excluded.address_line_1,
    address_line_2=excluded.address_line_2,city=excluded.city,region=excluded.region,
    postal_code=excluded.postal_code,country_code=excluded.country_code,
    nationality_code=excluded.nationality_code,updated_at=now();
  update public.user_profiles set
    full_name=v_first||' '||v_last,country_code=v_country,age_confirmed=true,updated_at=now()
  where user_id=v_uid;
  insert into public.security_events(user_id,event_type,created_at)
  values(v_uid,'identity_profile_submitted',now());
  return jsonb_build_object('complete',true,'updated_at',now());
end $$;
revoke all on function public.submit_identity_profile(jsonb) from public,anon;
grant execute on function public.submit_identity_profile(jsonb) to authenticated;

create or replace function public.submit_challenge_application(
  p_challenge_type text,p_details jsonb,p_preset_id text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_uid uuid:=auth.uid(); v public.challenge_enrolment_requests;
  v_preset public.challenge_presets; v_preset_id text:=nullif(btrim(p_preset_id),'');
  v_recent integer; v_capital text;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode='28000'; end if;
  if p_challenge_type not in ('infinity','traditional','futures','pac') then
    raise exception 'APPLICATION_TYPE_INVALID' using errcode='22023';
  end if;
  if not exists(select 1 from auth.users where id=v_uid and email_confirmed_at is not null) then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode='42501';
  end if;
  if not exists(select 1 from public.trader_identity_private where user_id=v_uid) then
    raise exception 'IDENTITY_REQUIRED' using errcode='42501';
  end if;
  if exists(select 1 from public.user_profiles where user_id=v_uid and restricted_jurisdiction) then
    raise exception 'RESTRICTED_JURISDICTION' using errcode='42501';
  end if;
  if jsonb_typeof(p_details) is distinct from 'object' or octet_length(p_details::text)>12000 then
    raise exception 'APPLICATION_DETAILS_INVALID' using errcode='22023';
  end if;
  if v_preset_id is null and p_challenge_type='infinity' then v_preset_id:='infinity_s1'; end if;
  if v_preset_id is null and p_challenge_type='pac' then
    v_capital:=lower(regexp_replace(coalesce(p_details->>'preferred_capital','25k'),'[^0-9k]','','g'));
    if v_capital not in ('25k','50k','100k','250k') then v_capital:='25k'; end if;
    v_preset_id:='pac_'||v_capital;
  end if;
  if v_preset_id is null then raise exception 'PRESET_REQUIRED' using errcode='22023'; end if;
  select * into v_preset from public.challenge_presets
   where id=v_preset_id and challenge_type=p_challenge_type and stage=1;
  if not found then raise exception 'PRESET_INVALID' using errcode='22023'; end if;
  select count(*)::integer into v_recent from public.security_events
   where user_id=v_uid and event_type='challenge_application_submitted'
     and created_at>now()-interval '1 hour';
  if v_recent>=10 then raise exception 'APPLICATION_RATE_LIMITED' using errcode='P0001'; end if;
  select * into v from public.challenge_enrolment_requests
   where user_id=v_uid and preset_id=v_preset_id;
  if found then
    if v.status='pending' then
      update public.challenge_enrolment_requests
      set application_details=p_details,updated_at=now()
      where id=v.id returning * into v;
    end if;
    return to_jsonb(v)||jsonb_build_object('label',v_preset.label);
  end if;
  insert into public.challenge_enrolment_requests(
    user_id,challenge_type,preset_id,application_details
  ) values(v_uid,p_challenge_type,v_preset_id,p_details) returning * into v;
  insert into public.security_events(user_id,event_type,created_at)
  values(v_uid,'challenge_application_submitted',now());
  return to_jsonb(v)||jsonb_build_object('label',v_preset.label);
end $$;
revoke all on function public.submit_challenge_application(text,jsonb,text) from public,anon;
grant execute on function public.submit_challenge_application(text,jsonb,text) to authenticated;

-- Keep already-open PAC pages compatible while routing them through the same
-- all-challenge approval gate. The three-argument overload is authoritative.
create or replace function public.submit_challenge_application(
  p_challenge_type text,p_details jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  return public.submit_challenge_application(p_challenge_type,p_details,null);
end $$;
revoke all on function public.submit_challenge_application(text,jsonb) from public,anon;
grant execute on function public.submit_challenge_application(text,jsonb) to authenticated;

create or replace function public.get_my_challenge_application(p_preset_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v public.challenge_enrolment_requests;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode='28000'; end if;
  select * into v from public.challenge_enrolment_requests
   where user_id=v_uid and preset_id=p_preset_id;
  if not found then return jsonb_build_object('exists',false); end if;
  return to_jsonb(v)||jsonb_build_object('exists',true);
end $$;
revoke all on function public.get_my_challenge_application(text) from public,anon;
grant execute on function public.get_my_challenge_application(text) to authenticated;

create or replace function public.commerce_begin_order(
  p_user uuid,p_request uuid,p_sku text,p_terms text
) returns public.commerce_orders language plpgsql security definer set search_path='' as $$
declare o public.commerce_orders; c public.commerce_catalog; email_value text;
begin
  -- Browser RPC calls may run as the authenticated user, while the two
  -- server-verified payment functions call with the service role after
  -- independently validating the bearer token. Reject every other caller.
  if auth.uid() is not null and p_user is distinct from auth.uid() then
    raise exception 'NOT_AUTHORISED';
  end if;
  if auth.uid() is null and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'NOT_AUTHORISED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,17));
  select * into o from public.commerce_orders where user_id=p_user and request_key=p_request;
  if found then
    if o.sku<>p_sku or o.terms_version<>p_terms then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return o;
  end if;
  if (select count(*) from public.commerce_orders where user_id=p_user and created_at>now()-interval '24 hours')>=10 then
    raise exception 'CHECKOUT_RATE_LIMIT';
  end if;
  select * into c from public.commerce_catalog where sku=p_sku and enabled;
  if not found or c.terms_version<>p_terms then raise exception 'PRODUCT_UNAVAILABLE'; end if;
  if not exists(
    select 1 from public.challenge_enrolment_requests
    where user_id=p_user and preset_id=p_sku and status='approved'
  ) then raise exception 'CHALLENGE_APPROVAL_REQUIRED'; end if;
  select email into email_value from auth.users where id=p_user and email_confirmed_at is not null;
  if email_value is null then raise exception 'VERIFIED_EMAIL_REQUIRED'; end if;
  if not exists(select 1 from public.user_profiles where user_id=p_user and age_confirmed is true
    and restricted_jurisdiction is false and country_code is not null) then
    raise exception 'ELIGIBILITY_REVIEW_REQUIRED';
  end if;
  insert into public.commerce_orders(
    user_id,request_key,sku,amount_minor,currency,billing_email,
    terms_version,terms_accepted_at,product_snapshot
  ) values(
    p_user,p_request,c.sku,c.amount_minor,c.currency,email_value,
    c.terms_version,now(),c.snapshot
  ) returning * into o;
  return o;
end $$;
revoke all on function public.commerce_begin_order(uuid,uuid,text,text) from public,anon;
revoke execute on function public.commerce_begin_order(uuid,uuid,text,text) from authenticated;
grant execute on function public.commerce_begin_order(uuid,uuid,text,text) to service_role;

commit;
