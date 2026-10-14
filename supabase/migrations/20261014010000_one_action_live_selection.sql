-- Starting a trader is one explicit owner action. Installation activates nobody.
alter table public.ongoing_copy_selections add column live_selected boolean not null default false;
-- Preserve existing active scopes if installed independently; the release fence requires execution OFF.
update public.ongoing_copy_selections s set live_selected=true from public.ongoing_copy_connections c
where c.id=s.connection_id and s.enabled and c.execution_on;

do $route$declare src text;anchor text:='and s.enabled and p.book_state=';begin
 src:=pg_get_functiondef('public.ongoing_copy_route(uuid,uuid)'::regprocedure);
 if strpos(src,anchor)=0 then raise exception 'START_ROUTE_SOURCE_DRIFT';end if;
 execute replace(src,anchor,'and s.enabled and s.live_selected and p.book_state=');
end $route$;

do $control$declare src text;anchor text:='update public.ongoing_copy_connections set execution_on=true,jwt_only=not p_developer,enabled_since=';begin
 src:=pg_get_functiondef('public.ongoing_copy_control(bigint,text,int,uuid,boolean,boolean)'::regprocedure);
 if strpos(src,anchor)=0 then raise exception 'START_CONTROL_SOURCE_DRIFT';end if;
 execute replace(src,anchor,'update public.ongoing_copy_selections set live_selected=true where connection_id=c.id and enabled;'||E'\n '||anchor);
end $control$;

do $select$declare src text;anchor text:='return jsonb_build_object(''ok'',true,''person_id'',who,';begin
 src:=pg_get_functiondef('public.ongoing_copy_select(bigint,uuid,boolean,uuid,text,boolean,int)'::regprocedure);
 if strpos(src,anchor)=0 then raise exception 'START_SELECT_SOURCE_DRIFT';end if;
 execute replace(src,anchor,'if not p_enabled then update public.ongoing_copy_selections set live_selected=false where person_id=who;end if;'||E'\n '||anchor);
end $select$;

create function public.ongoing_copy_start_trader(p_connection bigint,p_person uuid,p_version int,p_actor uuid,p_reason text,p_developer boolean,p_confirm boolean)returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.ongoing_copy_connections;who uuid;p public.ab_trader_profiles;r jsonb;
begin
 select * into c from public.ongoing_copy_connections where id=p_connection for update;
 if not found or c.actor_id<>p_actor or not exists(select 1 from public.admins where user_id=p_actor)then raise exception 'OWNER_REQUIRED';end if;
 if p_confirm is distinct from true then raise exception 'CONFIRM_FUNDED_EXECUTION';end if;
 if p_version is distinct from c.version then raise exception 'STALE_CONNECTION_VERSION';end if;
 if length(trim(p_reason))<5 then raise exception 'REASON_REQUIRED';end if;
 perform pg_advisory_xact_lock(176581,1001);
 if not p_developer and not public.ongoing_copy_single_account(c.id)then raise exception 'MULTI_ACCOUNT_DEVELOPER_ACCESS_UNCONFIGURED';end if;
 if not public.ongoing_copy_ready(c.id)then raise exception 'REVIEW_CONNECTION_AND_PERMISSION';end if;
 if not exists(select 1 from public.book_capacity_limits where book='l'||c.account_id and position_limit>0 and margin_per_lot_usd>0 and length(provider_evidence)>=10)then raise exception 'DOCUMENTED_CAPACITY_REQUIRED';end if;
 if coalesce((select book_halt from public.ab_settings),true)or coalesce((select trading_halted from public.platform_config limit 1),true)then raise exception 'BOOK_HALTED';end if;
 who:=public.ab_person_of(p_person);
 if c.execution_on and exists(select 1 from public.ongoing_copy_selections s join public.trading_accounts a on public.ab_person_of(a.user_id)=s.person_id where s.person_id=who and s.connection_id=c.id and s.live_selected and public.ongoing_copy_route(a.user_id,a.id)='a')then return jsonb_build_object('ok',true,'id',c.id,'version',c.version,'connected',c.connected,'execution_on',true,'person_id',who,'model','AB_LIVE','live_selected',true,'unchanged',true);end if;
 -- The existing owner path rechecks active Infinity status and holds, then enrols/selects this person.
 perform public.ongoing_copy_select(c.id,who,true,p_actor,p_reason,true,c.version);
 if not c.execution_on then
  -- Starting one person must not resume other previously saved/stopped selections.
  update public.ongoing_copy_selections set live_selected=false where connection_id=c.id and person_id<>who;
 end if;
 update public.ongoing_copy_connections set execution_on=true,jwt_only=not p_developer,
  enabled_since=case when execution_on then enabled_since else clock_timestamp()end,version=version+1,updated_at=now()
  where id=c.id returning * into c;
 select * into p from public.ab_trader_profiles where person_id=who for update;
 r:=public.ab_owner_set_model(who,p.book_state,p.manual_book_state,'AB_LIVE','Owner started A-book live: '||left(p_reason,200),p_actor);
 if not coalesce((r->>'ok')::boolean,false)then raise exception 'MODEL_ASSIGNMENT_REFUSED: %',r->>'error';end if;
 update public.ongoing_copy_selections set live_selected=true where person_id=who and connection_id=c.id;
 insert into public.admin_audit_log(actor_id,action,detail)values(p_actor,'ongoing_copy_start_trader',jsonb_build_object('connection',c.id,'person',who,'model','AB_LIVE','new_entries_only',true));
 return jsonb_build_object('ok',true,'id',c.id,'version',c.version,'connected',c.connected,'execution_on',true,'person_id',who,'model','AB_LIVE','live_selected',true);
end $$;
revoke all on function public.ongoing_copy_start_trader(bigint,uuid,int,uuid,text,boolean,boolean)from public,anon,authenticated;
grant execute on function public.ongoing_copy_start_trader(bigint,uuid,int,uuid,text,boolean,boolean)to service_role;

do $summary$declare src text;anchor text:='''enabled'',s.enabled,';begin
 src:=pg_get_functiondef('public.ongoing_copy_summary(uuid)'::regprocedure);
 if strpos(src,anchor)=0 then raise exception 'START_SUMMARY_SOURCE_DRIFT';end if;
 execute replace(src,anchor,anchor||'''live_selected'',s.live_selected,''copying_on'',exists(select 1 from public.trading_accounts a where public.ab_person_of(a.user_id)=s.person_id and public.ongoing_copy_route(a.user_id,a.id)=''a'')and exists(select 1 from public.book_capacity_limits l where l.book=''l''||c.account_id),');
end $summary$;
