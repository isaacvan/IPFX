begin;
-- Called only by the authenticated engine after acquiring its account order lock.
-- Lock order is always account row, then account's open/pending rows.
create function public.fn_switch_infinity_v2(p_account uuid,p_user uuid,p_request text,p_terms text,p_accept boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts;s public.infinity_v2_settings; existing public.infinity_v2_switches;
 privacy text; stamp timestamptz; snapshot jsonb;
begin
 if p_request is null or length(p_request)<8 or length(p_request)>128 then raise exception 'INVALID_REQUEST_ID';end if;
 perform pg_advisory_xact_lock(hashtextextended('infinity_v2_switch:'||p_user::text,0));
 select * into a from public.trading_accounts where id=p_account for update;
 if not found or a.user_id is distinct from p_user or a.challenge_type is distinct from 'infinity' then raise exception 'ACCOUNT_NOT_FOUND';end if;
 select * into existing from public.infinity_v2_switches where account_id=p_account;
 if found then
   if existing.request_id<>p_request then raise exception 'ALREADY_SWITCHED';end if;
   return jsonb_build_object('ok',true,'account_id',a.id,'rules_version',a.rules_version,'effective_at',existing.switched_at);
 end if;
 select * into s from public.infinity_v2_settings where singleton;
 if not s.infinity_v2_enabled or clock_timestamp()<s.cutover_at then raise exception 'V2_NOT_LIVE';end if;
 if not coalesce(p_accept,false) or p_terms is distinct from s.terms_version then raise exception 'TERMS_NOT_ACCEPTED';end if;
 if a.rules_version is distinct from 'infinity_v1' or a.status<>'active' or coalesce(a.phase,'')='demo' then raise exception 'ACTIVE_V1_RUN_REQUIRED';end if;
 if exists(select 1 from public.trades where account_id=a.id and status='open') then raise exception 'CLOSE_OPEN_POSITIONS_FIRST';end if;
 if exists(select 1 from public.pending_orders where account_id=a.id and status='pending') then raise exception 'CANCEL_PENDING_ORDERS_FIRST';end if;
 if exists(select 1 from public.infinity_v2_switches where user_id=p_user and switched_at>clock_timestamp()-interval '1 minute') then raise exception 'SWITCH_RATE_LIMIT';end if;
 select version into privacy from public.platform_legal_current where kind='privacy';
 if privacy is null or not exists(select 1 from public.platform_legal_documents where version=p_terms and kind='terms') then raise exception 'PUBLISHED_TERMS_REQUIRED';end if;
 stamp:=clock_timestamp();
 select rules || (rules->'stages'->a.stage::text) into snapshot from public.infinity_rules_versions where id='infinity_v2';
 insert into public.platform_legal_acceptances(user_id,terms_version,privacy_version,context)
 values(p_user,p_terms,privacy,jsonb_build_object('programme','infinity_v2','switched_from','infinity_v1','account_id',a.id,'at',stamp));
 insert into public.infinity_v2_switches(account_id,user_id,switched_at,request_id,terms_version) values(a.id,p_user,stamp,p_request,p_terms);
 -- No financial, loss-state or strike columns are updated.
 update public.trading_accounts set rules_version='infinity_v2',rules_effective_at=stamp,infinity_rules_snapshot=snapshot where id=a.id;
 return jsonb_build_object('ok',true,'account_id',a.id,'rules_version','infinity_v2','effective_at',stamp);
end $$;
revoke all on function public.fn_switch_infinity_v2(uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.fn_switch_infinity_v2(uuid,uuid,text,text,boolean) to service_role;
commit;
