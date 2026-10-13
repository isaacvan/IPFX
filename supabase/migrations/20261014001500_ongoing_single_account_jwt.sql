-- JWT bearer authentication is sufficient for one owner-selected execution account.
-- No activation, token change or removal of position/margin/risk limits.
alter table public.ongoing_copy_connections add column jwt_only boolean not null default false;

create function public.ongoing_copy_single_account(p_id bigint)returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ongoing_copy_connections c where c.id=p_id
 and not exists(select 1 from public.ongoing_copy_connections x where x.execution_on and x.id<>c.id and (x.api_env,x.broker_account_id)is distinct from(c.api_env,c.broker_account_id))
 and not exists(select 1 from public.ladder_accounts x where x.execution_enabled and (x.api_env,x.account_id)is distinct from(c.api_env,c.broker_account_id)));
$$;

create function public.ongoing_copy_jwt_capacity_allowed(p_book text,p_trade uuid)returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ongoing_copy_intents i join public.ongoing_copy_connections c on c.id=i.connection_id
 where i.source_trade_id=p_trade and p_book='l'||c.account_id and c.jwt_only and c.execution_on
 and public.ongoing_copy_single_account(c.id)and public.ongoing_copy_access(p_book,p_trade,false));
$$;
revoke all on function public.ongoing_copy_single_account(bigint),public.ongoing_copy_jwt_capacity_allowed(text,uuid)from public,anon,authenticated;
grant execute on function public.ongoing_copy_single_account(bigint),public.ongoing_copy_jwt_capacity_allowed(text,uuid)to service_role;

do $ready$declare src text;anchor text:='where c.id=p_id and c.connected';begin
 src:=pg_get_functiondef('public.ongoing_copy_ready(bigint)'::regprocedure);
 if strpos(src,anchor)=0 then raise exception 'JWT_READY_SOURCE_DRIFT';end if;
 execute replace(src,anchor,anchor||' and(not c.jwt_only or public.ongoing_copy_single_account(c.id))');
end $ready$;

do $control$declare src text;anchor text:='if not p_developer or not exists(select 1 from public.book_capacity_limits';begin
 src:=pg_get_functiondef('public.ongoing_copy_control(bigint,text,int,uuid,boolean,boolean)'::regprocedure);
 if strpos(src,anchor)=0 or strpos(src,'set execution_on=true,enabled_since=')=0 then raise exception 'JWT_CONTROL_SOURCE_DRIFT';end if;
 -- Serialize default-access activations across accounts; client flags never determine developer access.
 src:=replace(src,'if p_action=''on'' then','if p_action=''on'' then'||E'\n perform pg_advisory_xact_lock(176581,1001);\n if not p_developer and not public.ongoing_copy_single_account(c.id)then raise exception ''MULTI_ACCOUNT_DEVELOPER_ACCESS_UNCONFIGURED'';end if;');
 src:=replace(src,anchor,'if not exists(select 1 from public.book_capacity_limits');
 src:=replace(src,'DOCUMENTED_CAPACITY_AND_DEVELOPER_ACCESS_REQUIRED','DOCUMENTED_CAPACITY_REQUIRED');
 src:=replace(src,'set execution_on=true,enabled_since=','set execution_on=true,jwt_only=not p_developer,enabled_since=');
 execute src;
end $control$;

-- Safe owner status includes availability, never credentials.
do $summary$declare src text;anchor text:='''ready'',public.ongoing_copy_ready(c.id),';begin
 src:=pg_get_functiondef('public.ongoing_copy_summary(uuid)'::regprocedure);
 if strpos(src,anchor)=0 then raise exception 'JWT_SUMMARY_SOURCE_DRIFT';end if;
 execute replace(src,anchor,anchor||'''jwt_available'',public.ongoing_copy_single_account(c.id),');
end $summary$;
