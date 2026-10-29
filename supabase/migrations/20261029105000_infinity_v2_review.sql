begin;
create function public.infinity_v2_review_evidence(p_account uuid) returns table(alert_key text,evidence_at timestamptz)
language sql stable security definer set search_path='' as $$
 select x.key||':'||md5(coalesce(x.title,'')||'|'||coalesce(x.detail,'')||'|'||coalesce(x.value::text,'')),x.first_seen
 from public.trading_accounts a join public.ab_alerts x on x.resolved_at is null
 where a.id=p_account and x.category in('rules','trader')
 and (x.key like 'ring:%' or x.key like 'ident:%' or x.title ilike '%herd%' or x.title ilike '%identical%' or x.title ilike '%linked account%')
 and (x.person_id in(a.user_id,public.ab_person_of(a.user_id)) or x.key in(
  select unnest(array['ident:phone number:'||md5(i.phone_e164),
   'ident:name and date of birth:'||md5(lower(i.legal_first_name)||'|'||lower(i.legal_last_name)||'|'||i.date_of_birth::text),
   'ident:home address:'||md5(lower(i.address_line_1)||'|'||lower(i.postal_code)||'|'||i.country_code)])
  from public.trader_identity_private i where i.user_id=a.user_id))
 union all
 select 'ring-raw:'||f.id||':'||md5(coalesce(f.shared::text,'')||'|'||coalesce(f.share::text,'')||'|'||coalesce(f.net_ratio::text,'')),f.first_seen
 from public.trading_accounts a join public.ab_hedge_flags f on public.ab_person_of(a.user_id) in(f.person_a,f.person_b)
 where a.id=p_account and f.status='open';
$$;
create or replace function public.infinity_v2_review_hold(p_account uuid) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(a.investigation_hold,false) or exists(select 1 from public.infinity_v2_review_evidence(a.id) e
 where not exists(select 1 from public.infinity_v2_review_clearances c where c.account_id=a.id and c.alert_key=e.alert_key and c.evidence_at=e.evidence_at))
 from public.trading_accounts a where a.id=p_account;
$$;
create function public.infinity_v2_record_review(p_account uuid,p_actor uuid,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts;n int;
begin
 select * into a from public.trading_accounts where id=p_account for update;
 if a.rules_version is distinct from 'infinity_v2' then raise exception 'V2_ACCOUNT_REQUIRED';end if;
 if p_actor is null or length(trim(coalesce(p_reason,'')))<10 then raise exception 'REVIEW_REASON_REQUIRED';end if;
 insert into public.infinity_v2_review_clearances(account_id,alert_key,evidence_at,reviewed_by,reason)
 select a.id,e.alert_key,e.evidence_at,p_actor,p_reason from public.infinity_v2_review_evidence(a.id) e on conflict do nothing;
 get diagnostics n=row_count;
 update public.infinity_v2_progress_cache set dirty=true where account_id=a.id;
 return jsonb_build_object('ok',true,'reviewed',n,'still_held',public.infinity_v2_review_hold(a.id));
end $$;
revoke all on function public.infinity_v2_review_evidence(uuid),public.infinity_v2_review_hold(uuid),public.infinity_v2_record_review(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.infinity_v2_review_hold(uuid),public.infinity_v2_record_review(uuid,uuid,text) to service_role;

-- Owner overrides remain unchanged for v1. v2 promises the same qualification
-- and review checks to every trader, including manually requested advancement.
do $owner$
declare src text;
begin
 select pg_get_functiondef('public.fn_owner_advance_infinity_stage(uuid,uuid)'::regprocedure) into src;
 if position(E'\nbegin\n' in src)=0 then raise exception 'OWNER_ADVANCE_SOURCE_DRIFT';end if;
 insert into public.infinity_v2_legacy_definitions values('public.fn_owner_advance_infinity_stage(uuid,uuid)',src);
 src:=replace(src,E'\nbegin\n',E'\nbegin\n if exists(select 1 from public.trading_accounts where id=p_account and rules_version=''infinity_v2'') then return public.fn_advance_infinity_stage(p_account,p_expected_user);end if;\n');
 execute src;
end $owner$;
commit;
