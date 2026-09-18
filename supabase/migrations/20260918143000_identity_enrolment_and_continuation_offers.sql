-- Protected identity onboarding and immutable continuation offers.
-- Personal data is deliberately kept out of user_profiles and has no direct
-- anon/authenticated table grants. Traders can only reach their own record via
-- the narrowly-scoped SECURITY DEFINER functions below; admins use the already
-- authenticated/admin-gated server function and every view is audited there.

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
  check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
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
  challenge_type text not null check (challenge_type in ('pac')),
  status text not null default 'pending' check (status in ('pending','reviewing','approved','rejected','withdrawn')),
  application_details jsonb not null default '{}'::jsonb,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (octet_length(application_details::text) <= 12000)
);
create unique index if not exists challenge_enrolment_one_open_request_idx
  on public.challenge_enrolment_requests(user_id,challenge_type)
  where status in ('pending','reviewing','approved');
alter table public.challenge_enrolment_requests enable row level security;
revoke insert,update,delete on public.challenge_enrolment_requests from public,anon,authenticated;
drop policy if exists "own challenge enrolment requests read" on public.challenge_enrolment_requests;
create policy "own challenge enrolment requests read" on public.challenge_enrolment_requests
  for select to authenticated using (user_id=(select auth.uid()));

create or replace function public.get_my_identity_profile()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v public.trader_identity_private;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode='28000'; end if;
  select * into v from public.trader_identity_private where user_id=v_uid;
  if not found then return jsonb_build_object('complete',false); end if;
  return jsonb_build_object(
    'complete',true,
    'legal_first_name',v.legal_first_name,
    'legal_middle_names',v.legal_middle_names,
    'legal_last_name',v.legal_last_name,
    'date_of_birth',v.date_of_birth,
    'phone_e164',v.phone_e164,
    'address_line_1',v.address_line_1,
    'address_line_2',v.address_line_2,
    'city',v.city,'region',v.region,'postal_code',v.postal_code,
    'country_code',v.country_code,'nationality_code',v.nationality_code,
    'updated_at',v.updated_at
  );
end $$;
revoke all on function public.get_my_identity_profile() from public, anon;
grant execute on function public.get_my_identity_profile() to authenticated;

create or replace function public.submit_identity_profile(p_profile jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_dob date;
  v_first text := btrim(coalesce(p_profile->>'legal_first_name',''));
  v_middle text := nullif(btrim(coalesce(p_profile->>'legal_middle_names','')), '');
  v_last text := btrim(coalesce(p_profile->>'legal_last_name',''));
  v_phone text := regexp_replace(coalesce(p_profile->>'phone_e164',''), '[^+0-9]', '', 'g');
  v_line1 text := btrim(coalesce(p_profile->>'address_line_1',''));
  v_line2 text := nullif(btrim(coalesce(p_profile->>'address_line_2','')), '');
  v_city text := btrim(coalesce(p_profile->>'city',''));
  v_region text := nullif(btrim(coalesce(p_profile->>'region','')), '');
  v_postal text := upper(btrim(coalesce(p_profile->>'postal_code','')));
  v_country text := upper(btrim(coalesce(p_profile->>'country_code','')));
  v_nationality text := nullif(upper(btrim(coalesce(p_profile->>'nationality_code',''))), '');
  v_recent integer;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode='28000'; end if;
  select count(*)::integer into v_recent from public.security_events
   where user_id=v_uid and event_type='identity_profile_submitted'
     and created_at > now() - interval '1 hour';
  if v_recent >= 10 then raise exception 'IDENTITY_RATE_LIMITED' using errcode='P0001'; end if;
  if jsonb_typeof(p_profile) is distinct from 'object' then
    raise exception 'IDENTITY_PROFILE_REQUIRED' using errcode='22023';
  end if;
  begin v_dob := (p_profile->>'date_of_birth')::date;
  exception when others then raise exception 'DATE_OF_BIRTH_INVALID' using errcode='22023'; end;
  if v_dob > (current_date - interval '18 years')::date then
    raise exception 'MUST_BE_18' using errcode='22023';
  end if;
  if v_dob < date '1900-01-01' or char_length(v_first) not between 1 and 80
     or char_length(v_last) not between 1 and 80 or v_phone !~ '^\+[1-9][0-9]{7,14}$'
     or char_length(v_line1) not between 3 and 160 or char_length(v_city) not between 1 and 100
     or char_length(v_postal) not between 2 and 24 or v_country !~ '^[A-Z]{2}$'
     or (v_nationality is not null and v_nationality !~ '^[A-Z]{2}$') then
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
    legal_last_name=excluded.legal_last_name,
    date_of_birth=excluded.date_of_birth,
    phone_e164=excluded.phone_e164,
    address_line_1=excluded.address_line_1,
    address_line_2=excluded.address_line_2,
    city=excluded.city,region=excluded.region,postal_code=excluded.postal_code,
    country_code=excluded.country_code,nationality_code=excluded.nationality_code,
    updated_at=now();

  update public.user_profiles set
    full_name=v_first || ' ' || v_last,
    country_code=v_country,
    age_confirmed=true,
    updated_at=now()
  where user_id=v_uid;

  insert into public.security_events(user_id,event_type,created_at)
  values(v_uid,'identity_profile_submitted',now());
  return jsonb_build_object('complete',true,'updated_at',now());
end $$;
revoke all on function public.submit_identity_profile(jsonb) from public, anon;
grant execute on function public.submit_identity_profile(jsonb) to authenticated;

create or replace function public.submit_challenge_application(p_challenge_type text,p_details jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v public.challenge_enrolment_requests;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode='28000'; end if;
  if p_challenge_type <> 'pac' then raise exception 'APPLICATION_TYPE_INVALID' using errcode='22023'; end if;
  if not exists(select 1 from public.trader_identity_private where user_id=v_uid) then
    raise exception 'IDENTITY_REQUIRED' using errcode='42501';
  end if;
  if jsonb_typeof(p_details) is distinct from 'object' or octet_length(p_details::text)>12000 then
    raise exception 'APPLICATION_DETAILS_INVALID' using errcode='22023';
  end if;
  if char_length(btrim(coalesce(p_details->>'strategy',''))) < 20
     or char_length(btrim(coalesce(p_details->>'experience',''))) < 5 then
    raise exception 'APPLICATION_DETAILS_REQUIRED' using errcode='22023';
  end if;
  select * into v from public.challenge_enrolment_requests
   where user_id=v_uid and challenge_type='pac' and status in ('pending','reviewing','approved')
   order by created_at desc limit 1;
  if found then return to_jsonb(v); end if;
  insert into public.challenge_enrolment_requests(user_id,challenge_type,application_details)
  values(v_uid,'pac',jsonb_build_object(
    'strategy',left(btrim(p_details->>'strategy'),4000),
    'experience',left(btrim(p_details->>'experience'),1000),
    'preferred_capital',left(btrim(coalesce(p_details->>'preferred_capital','')),100)
  )) returning * into v;
  insert into public.security_events(user_id,event_type,created_at) values(v_uid,'pac_application_submitted',now());
  return to_jsonb(v);
end $$;
revoke all on function public.submit_challenge_application(text,jsonb) from public,anon;
grant execute on function public.submit_challenge_application(text,jsonb) to authenticated;

create table if not exists public.challenge_continuation_offers (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null unique references public.trading_accounts(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_type text not null,
  stage integer not null,
  failure_number integer not null check (failure_number >= 1),
  progress_ratio numeric(7,6) not null check (progress_ratio between 0 and 1),
  amount_minor integer not null check (amount_minor between 100 and 100000),
  currency text not null default 'gbp' check (currency='gbp'),
  pricing_version text not null default 'infinity-continuation-v1',
  pricing_snapshot jsonb not null,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now()
);
alter table public.challenge_continuation_offers enable row level security;
revoke all on public.challenge_continuation_offers from public, anon, authenticated;
grant all on public.challenge_continuation_offers to service_role;
create index if not exists challenge_continuation_offers_user_time_idx
  on public.challenge_continuation_offers(user_id,created_at desc);

-- Keep every paid evaluation family on the same catalogue/payment/provisioning
-- pipeline. Prices are copied from the versioned phase-one presets and are
-- revalidated by commerce_begin_order(), never trusted from page markup.
insert into public.commerce_catalog(
  sku,label,amount_minor,currency,terms_version,enabled,snapshot,updated_at
)
select p.id,p.label,round(p.fee_usd * 100)::integer,'usd','2026-09-review',true,
       jsonb_build_object('kind','challenge','challenge_type',p.challenge_type,'stage',p.stage),now()
from public.challenge_presets p
where p.stage=1 and p.challenge_type in ('traditional','futures') and p.fee_usd > 0
on conflict (sku) do update set
  label=excluded.label,amount_minor=excluded.amount_minor,currency=excluded.currency,
  terms_version=excluded.terms_version,enabled=excluded.enabled,
  snapshot=excluded.snapshot,updated_at=now();

commit;
