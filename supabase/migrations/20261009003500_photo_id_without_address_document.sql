-- Owner policy: keep residential address details and photo ID; remove the
-- routine proof-of-address upload/date requirement. Keep existing documents.
begin;
do $patch$
declare d text;anchor text;
begin
 d:=pg_get_functiondef('public.submit_kyc(jsonb)'::regprocedure);
 anchor:='if not (''id_front'' = any(v_types) and ''proof_of_address'' = any(v_types)) then';
 if strpos(d,anchor)=0 then raise exception 'PHOTO_ID_KYC_SOURCE_DRIFT';end if;
 d:=replace(d,anchor,'if not (''id_front'' = any(v_types)) then');
 anchor:='for d in select * from jsonb_array_elements(p_documents) loop';
 if strpos(d,anchor)=0 then raise exception 'KYC_PATH_SOURCE_DRIFT';end if;
 execute replace(d,anchor,E'p_documents:=(select jsonb_agg(e||jsonb_build_object(''path'',coalesce(e->>''path'',e->>''storage_path'')))from jsonb_array_elements(p_documents)e);\n  '||anchor);
 d:=pg_get_functiondef('public.submit_challenge_application(text,jsonb,text)'::regprocedure);
 anchor:='or not exists(select 1 from public.kyc_submissions where user_id=v_uid and doc_type=''proof_of_address'')';
 if strpos(d,anchor)=0 then raise exception 'PHOTO_ID_APPLICATION_SOURCE_DRIFT';end if;
 d:=replace(d,anchor,'');
 anchor:='v_address_date:=(p_details->>''proof_of_address_date'')::date;';
 if strpos(d,anchor)=0 then raise exception 'ADDRESS_DATE_SOURCE_DRIFT';end if;
 d:=replace(d,anchor,'');
 anchor:=E'if v_id_expiry<current_date or v_address_date>current_date\n     or v_address_date<current_date-interval ''3 months'' then';
 if strpos(d,anchor)=0 then raise exception 'ID_EXPIRY_SOURCE_DRIFT';end if;
 execute replace(d,anchor,'if v_id_expiry is null or v_id_expiry<current_date then');
end;$patch$;
commit;
