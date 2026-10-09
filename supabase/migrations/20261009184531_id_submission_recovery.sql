-- Keep private object ownership, photo-ID-only requirements and manual review.
-- Serialise a user's submission so retrying the same uploaded object is idempotent.
create or replace function public.submit_kyc(p_documents jsonb)
returns text language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_status text;d jsonb;v_types text[]:='{}';path text;
begin
 if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode='28000';end if;
 perform pg_advisory_xact_lock(hashtextextended('submit_kyc:'||v_uid::text,0));
 select status into v_status from public.trader_kyc where user_id=v_uid;
 if v_status='verified'then return 'verified';end if;
 if jsonb_typeof(p_documents)is distinct from 'array' or jsonb_array_length(p_documents)not between 1 and 6 then raise exception 'KYC_DOCUMENTS_REQUIRED' using errcode='22023';end if;
 for d in select * from jsonb_array_elements(p_documents)loop
  if jsonb_typeof(d)is distinct from 'object' or coalesce(d->>'doc_type','')not in('id_front','id_back','proof_of_address','selfie')then raise exception 'KYC_BAD_TYPE' using errcode='22023';end if;
  path:=coalesce(nullif(d->>'path',''),d->>'storage_path');
  if path is null or split_part(path,'/',1)<>v_uid::text then raise exception 'KYC_BAD_PATH' using errcode='42501';end if;
  if not exists(select 1 from storage.objects o where o.bucket_id='kyc-documents'and o.name=path)then raise exception 'KYC_FILE_MISSING' using errcode='22023';end if;
  v_types:=array_append(v_types,d->>'doc_type');
 end loop;
 if not('id_front'=any(v_types))then raise exception 'KYC_PHOTO_ID_REQUIRED' using errcode='22023';end if;
 for d in select * from jsonb_array_elements(p_documents)loop
  path:=coalesce(nullif(d->>'path',''),d->>'storage_path');
  insert into public.kyc_submissions(user_id,doc_type,storage_path)
  select v_uid,d->>'doc_type',path where not exists(select 1 from public.kyc_submissions s where s.user_id=v_uid and s.doc_type=d->>'doc_type'and s.storage_path=path);
 end loop;
 insert into public.trader_kyc(user_id,status,note,updated_at)values(v_uid,'pending',null,clock_timestamp())
 on conflict(user_id)do update set status='pending',note=null,updated_at=excluded.updated_at;
 return 'pending';
end $$;
revoke all on function public.submit_kyc(jsonb)from public,anon;
grant execute on function public.submit_kyc(jsonb)to authenticated;

-- A genuine non-expiring national ID is recorded explicitly, never with an invented future date.
-- Surgical replacement preserves all concurrent consent/reset/application gates.
do $patch$
declare d text;anchor text;
begin
 d:=pg_get_functiondef('public.submit_challenge_application(text,jsonb,text)'::regprocedure);
 anchor:=E'v_id_expiry:=(p_details->>''id_expiry_date'')::date;';
 if strpos(d,anchor)=0 then raise exception 'ID_EXPIRY_PARSE_SOURCE_DRIFT';end if;
 d:=replace(d,anchor,E'v_id_expiry:=nullif(p_details->>''id_expiry_date'','''')::date;');
 anchor:='if v_id_expiry is null or v_id_expiry<current_date then';
 if strpos(d,anchor)=0 then raise exception 'ID_EXPIRY_CHECK_SOURCE_DRIFT';end if;
 d:=replace(d,anchor,$replace$
if (p_details->'id_has_no_expiry')='true'::jsonb then
    if p_details->>'id_document_type'<>'national_id' or v_id_expiry is not null then
      raise exception 'NON_EXPIRING_ID_INVALID' using errcode='22023';
    end if;
  elsif v_id_expiry is null or v_id_expiry<current_date or not isfinite(v_id_expiry) then$replace$);
 execute d;
end $patch$;
