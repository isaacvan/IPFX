-- Owner limits for ongoing A-book copying, adjustable while execution is ON. They apply to copies opened after the
-- change; open copies keep the stop they were placed with.
--   position loss cap: the broker stop on each copy is placed no further than the price where it loses this much,
--                      so the broker closes the copy automatically (tighter than the 3x backstop when it binds).
--   daily loss limit:  no new copy once today's (UTC) closed loss + open copy risk + the new copy's risk would pass it.
--                      Off = the existing 2%-of-account default.
--   per-trader lots:   a trader's copies use their own lot size; empty = the connection default.
alter table public.ongoing_copy_connections
 add column position_loss_cap_on boolean not null default false,
 add column position_loss_cap_usd numeric check(position_loss_cap_usd is null or(position_loss_cap_usd>=1 and position_loss_cap_usd<=1000 and position_loss_cap_usd::text not in('NaN','Infinity','-Infinity'))),
 add column daily_loss_on boolean not null default false,
 add column daily_loss_usd numeric check(daily_loss_usd is null or(daily_loss_usd>=1 and daily_loss_usd<=50000 and daily_loss_usd::text not in('NaN','Infinity','-Infinity'))),
 add constraint ongoing_position_cap_needs_amount check(not position_loss_cap_on or position_loss_cap_usd is not null),
 add constraint ongoing_daily_loss_needs_amount check(not daily_loss_on or daily_loss_usd is not null);
alter table public.ongoing_copy_selections
 add column lots numeric check(lots is null or(lots>0 and lots<=1 and lots::text not in('NaN','Infinity','-Infinity')));

-- Owner daily loss limit for a destination account, or null when the owner limit is off.
create function public.ongoing_copy_owner_daily_loss(p_account bigint)returns numeric language sql stable security definer set search_path='' as $$
 select c.daily_loss_usd from public.ongoing_copy_connections c where c.account_id=p_account and c.connected and c.daily_loss_on limit 1;
$$;

-- Adjust default lots and both loss limits (versioned, audited). Allowed while execution is ON.
create function public.ongoing_copy_limits(p_connection bigint,p_version int,p_actor uuid,p_lots numeric,p_position_on boolean,p_position_usd numeric,p_daily_on boolean,p_daily_usd numeric,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ongoing_copy_connections;
begin
 if not exists(select 1 from public.admins where user_id=p_actor) or length(trim(coalesce(p_reason,'')))<5 then raise exception 'OWNER_PERMISSION_REQUIRED';end if;
 select * into c from public.ongoing_copy_connections where id=p_connection for update;
 if not found or not c.connected or c.actor_id<>p_actor then raise exception 'SAVED_ACCOUNT_NOT_READY';end if;
 if p_version is distinct from c.version then raise exception 'STALE_CONNECTION_VERSION';end if;
 if p_lots is null or p_lots<=0 or p_lots>1 or p_position_on is null or p_daily_on is null
  or (p_position_on and (p_position_usd is null or p_position_usd<1 or p_position_usd>1000))
  or (p_daily_on and (p_daily_usd is null or p_daily_usd<1 or p_daily_usd>50000)) then raise exception 'LIMITS_OUT_OF_RANGE';end if;
 update public.ongoing_copy_connections set broker_lots=p_lots,position_loss_cap_on=p_position_on,position_loss_cap_usd=coalesce(p_position_usd,position_loss_cap_usd),
  daily_loss_on=p_daily_on,daily_loss_usd=coalesce(p_daily_usd,daily_loss_usd),version=version+1,updated_at=now()where id=c.id returning * into c;
 insert into public.admin_audit_log(actor_id,action,detail)values(p_actor,'ongoing_copy_limits',jsonb_build_object('connection',c.id,'lots',c.broker_lots,
  'position_loss_cap',case when c.position_loss_cap_on then c.position_loss_cap_usd end,'daily_loss',case when c.daily_loss_on then c.daily_loss_usd end,'execution_on',c.execution_on,'reason',left(trim(p_reason),300)));
 return jsonb_build_object('ok',true,'id',c.id,'version',c.version,'broker_lots',c.broker_lots,'position_loss_cap_on',c.position_loss_cap_on,'position_loss_cap_usd',c.position_loss_cap_usd,'daily_loss_on',c.daily_loss_on,'daily_loss_usd',c.daily_loss_usd);
end $$;

-- One trader's copy lot size (null = connection default). Audited; applies to their next copies.
create function public.ongoing_copy_trader_lots(p_connection bigint,p_person uuid,p_lots numeric,p_actor uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.ongoing_copy_selections;
begin
 if not exists(select 1 from public.admins where user_id=p_actor) or length(trim(coalesce(p_reason,'')))<5 then raise exception 'OWNER_PERMISSION_REQUIRED';end if;
 if p_lots is not null and (p_lots<=0 or p_lots>1) then raise exception 'LIMITS_OUT_OF_RANGE';end if;
 update public.ongoing_copy_selections set lots=p_lots where person_id=p_person and connection_id=p_connection returning * into s;
 if not found then raise exception 'TRADER_NOT_SELECTED';end if;
 insert into public.admin_audit_log(actor_id,action,detail)values(p_actor,'ongoing_copy_trader_lots',jsonb_build_object('connection',p_connection,'person',p_person,'lots',p_lots,'reason',left(trim(p_reason),300)));
 return jsonb_build_object('ok',true,'person_id',s.person_id,'lots',s.lots);
end $$;

-- Admission returns the trader's own lots (or the default) and the position loss cap when it is on.
do $claim$declare src text;anchor text:='''broker_lots'',c.broker_lots,''max_trade_risk_usd'',c.max_trade_risk_usd);';begin
 src:=pg_get_functiondef('public.ongoing_copy_claim(uuid)'::regprocedure);
 if strpos(src,anchor)=0 or array_length(string_to_array(src,anchor),1)<>2 then raise exception 'LIMITS_CLAIM_SOURCE_DRIFT';end if;
 execute replace(src,anchor,'''broker_lots'',coalesce(s.lots,c.broker_lots),''max_trade_risk_usd'',c.max_trade_risk_usd,''position_loss_cap_usd'',case when c.position_loss_cap_on then c.position_loss_cap_usd end);');
end $claim$;

-- Risk reservation: the owner's daily loss limit replaces the 2% default for that destination and is applied exactly
-- (today's loss + open risk + new risk), without the 2.5x safety divisor used for the default.
do $risk$declare src text;a1 text:='stop_usd := la.size_usd * 0.02;';a2 text:='(stop_usd - day_loss - open_risk) / room_mult)';begin
 src:=pg_get_functiondef('public.ab_reserve_risk(text,uuid,uuid,text,numeric,numeric)'::regprocedure);
 if array_length(string_to_array(src,a1),1)<>2 or array_length(string_to_array(src,a2),1)<>2 then raise exception 'LIMITS_RISK_SOURCE_DRIFT';end if;
 src:=replace(src,a1,'stop_usd := coalesce(public.ongoing_copy_owner_daily_loss(la.id), la.size_usd * 0.02);');
 src:=replace(src,a2,'(stop_usd - day_loss - open_risk) / case when la.id is not null and public.ongoing_copy_owner_daily_loss(la.id) is not null then 1 else room_mult end)');
 execute src;
end $risk$;

-- Owner status shows each trader's lot size.
do $summary$declare src text;anchor text:='''enabled'',s.enabled,';begin
 src:=pg_get_functiondef('public.ongoing_copy_summary(uuid)'::regprocedure);
 if array_length(string_to_array(src,anchor),1)<>2 then raise exception 'LIMITS_SUMMARY_SOURCE_DRIFT';end if;
 execute replace(src,anchor,anchor||'''lots'',s.lots,');
end $summary$;

do $$declare f text;begin foreach f in array array['ongoing_copy_owner_daily_loss(bigint)','ongoing_copy_limits(bigint,int,uuid,numeric,boolean,numeric,boolean,numeric,text)','ongoing_copy_trader_lots(bigint,uuid,numeric,uuid,text)'] loop
 execute 'revoke all on function public.'||f||' from public,anon,authenticated';execute 'grant execute on function public.'||f||' to service_role';end loop;end $$;
