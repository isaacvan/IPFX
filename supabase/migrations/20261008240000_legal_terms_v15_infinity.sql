-- Terms 1.5: automatic promotion, qualifying trade and meaningful trading day, held-earnings warning, negotiated Stage 4,
-- automatic hedge-ring and duplicate-identity detection, identity-document handling, conflict-of-interest sentence,
-- UTC definition, crypto removed. Earlier versions stay immutable; this publishes a new one.
--
-- Infinity applications must also tick "held Stage 2 earnings are lost if I fail Stage 2 or 3 before completing Stage 3".
-- The tick is required by the page and enforced here, so it cannot be skipped by calling the function directly.
begin;
insert into public.platform_legal_documents(version,kind,source_sha256,document_url)
 values('2026-10-08-1.5','terms','c71a729ea14292b1d21b9ee487843fcda87d9274d7a66b4b6abbd5ee83d10490','/legal/2026-10-08-v1.5/terms.html');
update public.platform_legal_current set version='2026-10-08-1.5' where kind='terms';

do $patch$
declare definition text;
 anchor text:='  perform public.legal_acceptance_record(p_details,jsonb_build_object(''challenge_type'',p_challenge_type,''preset_id'',p_preset_id));';
begin
 definition:=pg_get_functiondef('public.submit_challenge_application(text,jsonb,text)'::regprocedure);
 if strpos(definition,anchor)=0 then raise exception 'HELD_EARNINGS_SOURCE_DRIFT';end if;
 if strpos(definition,'HELD_EARNINGS_ACK_REQUIRED')>0 then return;end if;
 execute replace(definition,anchor,anchor||E'\n  if p_challenge_type=''infinity'' and coalesce((p_details->>''held_earnings_acknowledged'')::boolean,false) is not true then raise exception ''HELD_EARNINGS_ACK_REQUIRED'' using errcode=''22023''; end if;');
end;$patch$;
commit;
