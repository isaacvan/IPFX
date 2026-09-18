-- Require a complete, risk-based identity and document pack before any
-- challenge can enter the owner's manual approval queue.
begin;

create or replace function public.submit_challenge_application(
  p_challenge_type text,p_details jsonb,p_preset_id text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_uid uuid:=auth.uid(); v public.challenge_enrolment_requests;
  v_preset public.challenge_presets; v_preset_id text:=nullif(btrim(p_preset_id),'');
  v_recent integer; v_capital text; v_id_expiry date; v_address_date date;
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

  -- The private Storage bucket is not evidence by itself: submit_kyc verifies
  -- ownership and object existence before creating these rows.
  if not exists(select 1 from public.trader_kyc where user_id=v_uid and status in ('pending','verified'))
     or not exists(select 1 from public.kyc_submissions where user_id=v_uid and doc_type='id_front')
     or not exists(select 1 from public.kyc_submissions where user_id=v_uid and doc_type='proof_of_address') then
    raise exception 'KYC_DOCUMENTS_REQUIRED' using errcode='42501';
  end if;

  if coalesce((p_details->>'age_confirmed')::boolean,false) is not true
     or coalesce((p_details->>'terms_accepted')::boolean,false) is not true
     or coalesce((p_details->>'cancellation_waiver')::boolean,false) is not true
     or coalesce((p_details->>'own_behalf_confirmed')::boolean,false) is not true
     or coalesce((p_details->>'information_accurate')::boolean,false) is not true
     or coalesce((p_details->>'risk_disclosure_accepted')::boolean,false) is not true
     or coalesce((p_details->>'screening_acknowledged')::boolean,false) is not true then
    raise exception 'REQUIRED_DECLARATIONS_MISSING' using errcode='22023';
  end if;
  if coalesce(p_details->>'employment_status','') not in ('employed','self_employed','student','retired','unemployed')
     or char_length(btrim(coalesce(p_details->>'occupation',''))) not between 2 and 120
     or coalesce(p_details->>'source_of_funds','') not in ('employment_income','business_income','savings','investments','pension','family_support','other')
     or coalesce(p_details->>'expected_activity','') not in ('casual','part_time','full_time')
     or coalesce(p_details->>'purpose','') not in ('challenge_evaluation','skill_development')
     or coalesce(p_details->>'pep_status','') not in ('no','yes','unsure')
     or coalesce(p_details->>'id_document_type','') not in ('passport','driving_licence','national_id')
     or coalesce(p_details->>'id_issuing_country','') !~ '^[A-Z]{2}$' then
    raise exception 'SUITABILITY_DETAILS_INVALID' using errcode='22023';
  end if;
  begin
    v_id_expiry:=(p_details->>'id_expiry_date')::date;
    v_address_date:=(p_details->>'proof_of_address_date')::date;
  exception when others then
    raise exception 'DOCUMENT_DATES_INVALID' using errcode='22023';
  end;
  if v_id_expiry<current_date or v_address_date>current_date
     or v_address_date<current_date-interval '3 months' then
    raise exception 'DOCUMENT_DATES_INVALID' using errcode='22023';
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
      update public.challenge_enrolment_requests set application_details=p_details,updated_at=now()
      where id=v.id returning * into v;
    end if;
    return to_jsonb(v)||jsonb_build_object('label',v_preset.label);
  end if;
  insert into public.challenge_enrolment_requests(user_id,challenge_type,preset_id,application_details)
  values(v_uid,p_challenge_type,v_preset_id,p_details) returning * into v;
  insert into public.security_events(user_id,event_type,created_at)
  values(v_uid,'challenge_application_submitted',now());
  return to_jsonb(v)||jsonb_build_object('label',v_preset.label);
end $$;
revoke all on function public.submit_challenge_application(text,jsonb,text) from public,anon;
grant execute on function public.submit_challenge_application(text,jsonb,text) to authenticated;

create or replace function public.submit_challenge_application(p_challenge_type text,p_details jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin return public.submit_challenge_application(p_challenge_type,p_details,null); end $$;
revoke all on function public.submit_challenge_application(text,jsonb) from public,anon;
grant execute on function public.submit_challenge_application(text,jsonb) to authenticated;

commit;
