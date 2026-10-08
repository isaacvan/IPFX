-- Capture the exact published document versions for new application consent.
-- Existing accounts/rule snapshots are not rewritten and no payments activate.
begin;
create table public.platform_legal_documents(version text primary key,kind text not null check(kind in('terms','privacy')),
 source_sha256 text not null check(source_sha256 ~ '^[0-9a-f]{64}$'),document_url text not null,published_at timestamptz not null default now());
create table public.platform_legal_current(kind text primary key,version text not null references public.platform_legal_documents(version));
create table public.platform_legal_acceptances(id bigint generated always as identity primary key,user_id uuid not null,
 terms_version text not null references public.platform_legal_documents(version),privacy_version text not null references public.platform_legal_documents(version),
 context jsonb not null,accepted_at timestamptz not null default now(),unique(user_id,terms_version,privacy_version,context));
alter table public.platform_legal_documents enable row level security;
alter table public.platform_legal_current enable row level security;
alter table public.platform_legal_acceptances enable row level security;
revoke all on public.platform_legal_documents,public.platform_legal_current,public.platform_legal_acceptances from public,anon,authenticated;
grant select on public.platform_legal_documents,public.platform_legal_current,public.platform_legal_acceptances to service_role;
insert into public.platform_legal_documents(version,kind,source_sha256,document_url) values
 ('2026-10-08-1.3','terms','5335553f8de6109b3b1022c01c4589d377840dd699423b57e42e914e0dd3ce22','/legal/2026-10-08/terms.html'),
 ('2026-10-08-1.1','privacy','e37a197689dd5bddd9efbf58b0e74b362e248e44bd54f029499d16eb011e5fa9','/legal/2026-10-08/privacy.html');
insert into public.platform_legal_current(kind,version)values('terms','2026-10-08-1.3'),('privacy','2026-10-08-1.1');
create function public.legal_document_immutable()returns trigger language plpgsql set search_path='' as $$begin raise exception 'LEGAL_RECORD_IMMUTABLE';end;$$;
create trigger legal_documents_frozen before update or delete on public.platform_legal_documents for each row execute function public.legal_document_immutable();
create trigger legal_acceptances_frozen before update or delete on public.platform_legal_acceptances for each row execute function public.legal_document_immutable();
create function public.legal_acceptance_record(p_details jsonb,p_context jsonb)returns void language plpgsql security definer set search_path='' as $$
declare who uuid:=auth.uid();terms_id text;privacy_id text;
begin
 if who is null then raise exception 'NOT_SIGNED_IN';end if;
 select version into terms_id from public.platform_legal_current where kind='terms';
 select version into privacy_id from public.platform_legal_current where kind='privacy';
 if terms_id is null or privacy_id is null or p_details->>'terms_version' is distinct from terms_id
  or p_details->>'privacy_notice_version' is distinct from privacy_id or p_details->'terms_accepted' is distinct from 'true'::jsonb then
  raise exception 'LEGAL_VERSION_UPDATED';end if;
 insert into public.platform_legal_acceptances(user_id,terms_version,privacy_version,context)
 values(who,terms_id,privacy_id,p_context)on conflict(user_id,terms_version,privacy_version,context)do nothing;
end;$$;
revoke all on function public.legal_acceptance_record(jsonb,jsonb),public.legal_document_immutable() from public,anon,authenticated;
-- Extend the installed submission function in place, preserving its current
-- KYC, launch, rate, preset and approval safeguards. Abort on source drift.
do $patch$
declare definition text;anchor text:='  if v_uid is null then raise exception ''NOT_SIGNED_IN'' using errcode=''28000''; end if;';
begin
 definition:=pg_get_functiondef('public.submit_challenge_application(text,jsonb,text)'::regprocedure);
 if strpos(definition,anchor)=0 then raise exception 'APPLICATION_CONSENT_SOURCE_DRIFT';end if;
 execute replace(definition,anchor,anchor||E'\n  perform public.legal_acceptance_record(p_details,jsonb_build_object(''challenge_type'',p_challenge_type,''preset_id'',p_preset_id));');
end;$patch$;
commit;
