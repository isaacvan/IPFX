-- Ongoing owner-selected A-book execution. Installation activates nobody and sends no order.
-- Monitoring retains its read-only client and monitor.execution_enabled remains false.
create table public.ongoing_copy_connections(
 id bigint generated always as identity primary key, actor_id uuid not null,
 account_id bigint not null unique references public.ladder_accounts(id),
 broker_account_id text not null,broker_server text not null,api_env text not null check(api_env='demo'),
 connected boolean not null default true,execution_on boolean not null default false,
 broker_lots numeric not null check(broker_lots>0 and broker_lots<=1 and broker_lots::text not in('NaN','Infinity','-Infinity')),
 max_trade_risk_usd numeric not null check(max_trade_risk_usd>0 and max_trade_risk_usd<=100 and max_trade_risk_usd::text not in('NaN','Infinity','-Infinity')),
 version int not null default 1, enabled_since timestamptz,reason text not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(not execution_on or connected),unique(api_env,broker_account_id)
);
create table public.ongoing_copy_selections(
 person_id uuid primary key,connection_id bigint not null references public.ongoing_copy_connections(id),
 enabled boolean not null default true,selected_since timestamptz not null default now(),reason text not null
);
create table public.ongoing_copy_intents(
 connection_id bigint not null references public.ongoing_copy_connections(id),source_trade_id uuid not null references public.trades(id),
 state text not null default 'reserved' check(state in('reserved','refused','pending_receipts','completed')),
 reason text,created_at timestamptz not null default now(),primary key(connection_id,source_trade_id)
);
alter table public.book_orders add column ongoing_copy_connection_id bigint references public.ongoing_copy_connections(id);
alter table public.book_orders add column ongoing_prior_position_ids text[];
create index ongoing_copy_selections_connection on public.ongoing_copy_selections(connection_id)where enabled;
create index ongoing_copy_intents_recent on public.ongoing_copy_intents(connection_id,created_at desc);
create index book_ongoing_copy_recent on public.book_orders(ongoing_copy_connection_id,id desc)where ongoing_copy_connection_id is not null;
alter table public.ongoing_copy_connections enable row level security;
alter table public.ongoing_copy_selections enable row level security;
alter table public.ongoing_copy_intents enable row level security;
revoke all on public.ongoing_copy_connections,public.ongoing_copy_selections,public.ongoing_copy_intents from public,anon,authenticated;
grant select,insert,update on public.ongoing_copy_connections,public.ongoing_copy_selections,public.ongoing_copy_intents to service_role;
grant usage,select on sequence public.ongoing_copy_connections_id_seq to service_role;

create function public.ongoing_copy_connect(p_account bigint,p_lots numeric,p_risk numeric,p_actor uuid,p_confirm boolean,p_reason text)returns jsonb
language plpgsql security definer set search_path='' as $$
declare d public.ladder_accounts;c public.ongoing_copy_connections;
begin
 if not exists(select 1 from public.admins where user_id=p_actor) or p_confirm is distinct from true or length(trim(p_reason))<5 then raise exception 'OWNER_PERMISSION_REQUIRED';end if;
 select * into d from public.ladder_accounts where id=p_account for update;
 if not found or d.role not in('monitor','ladder') or d.api_env<>'demo' or d.status not in('funded','evaluation') or d.execution_enabled
  or d.account_id is null or d.server is null or d.access_token_ciphertext is null or d.refresh_token_ciphertext is null then raise exception 'SAVED_ACCOUNT_NOT_READY';end if;
 if exists(select 1 from public.copy_test_sessions where destination_id=d.id and state in('prepared','active','draining'))then raise exception 'EXISTING_TEST_MUST_FINISH';end if;
 select * into c from public.ongoing_copy_connections where account_id=d.id for update;
 if found then
  if c.actor_id<>p_actor or c.execution_on then raise exception 'TURN_EXECUTION_OFF_FIRST';end if;
  if exists(select 1 from public.book_orders o where o.ongoing_copy_connection_id=c.id and o.event='open'and o.status in('sent','filled','reconciliation_required')and(o.status<>'filled'or abs(coalesce((select sum(e.broker_confirmed_qty)from public.book_orders e where e.source_trade_id=o.source_trade_id and e.book=o.book and e.event<>'open'and e.status='closed'and e.dispatch_state='confirmed'and e.broker_position_id=o.broker_position_id),0)-o.qty)>0.00000001))then raise exception 'RECONCILE_PENDING_ORDERS_FIRST';end if;
  update public.ongoing_copy_connections set connected=true,broker_account_id=d.account_id,broker_server=d.server,api_env=d.api_env,
   broker_lots=p_lots,max_trade_risk_usd=p_risk,reason=left(trim(p_reason),500),version=version+1,updated_at=now()where id=c.id returning * into c;
 else
  insert into public.ongoing_copy_connections(actor_id,account_id,broker_account_id,broker_server,api_env,broker_lots,max_trade_risk_usd,reason)
   values(p_actor,d.id,d.account_id,d.server,d.api_env,p_lots,p_risk,left(trim(p_reason),500))returning * into c;
 end if;
 if d.role='ladder'then update public.ladder_accounts set copy_test_only=true where id=d.id;end if;
 insert into public.admin_audit_log(actor_id,action,detail)values(p_actor,'ongoing_copy_connect',jsonb_build_object('connection',c.id,'account',d.id,'execution_on',false,'monitor_role_unchanged',d.role='monitor'));
 return jsonb_build_object('ok',true,'id',c.id,'version',c.version,'connected',true,'execution_on',false);
end $$;

create function public.ongoing_copy_ready(p_id bigint)returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ongoing_copy_connections c join public.ladder_accounts d on d.id=c.account_id
 where c.id=p_id and c.connected and exists(select 1 from public.admins where user_id=c.actor_id)and d.role in('monitor','ladder')and not d.execution_enabled
 and d.api_env=c.api_env and d.account_id=c.broker_account_id and d.server=c.broker_server and d.status in('funded','evaluation')
 and d.access_token_ciphertext is not null and d.refresh_token_ciphertext is not null
 and not exists(select 1 from public.book_orders o where o.ongoing_copy_connection_id=c.id and o.status='reconciliation_required')
 and not exists(select 1 from public.ladder_accounts x where x.id<>d.id and x.account_id=d.account_id and x.api_env=d.api_env and x.execution_enabled)
 and (d.role='monitor'or not exists(select 1 from public.team_book_destinations x where x.status='connected' and x.account_id=d.account_id and x.environment=d.api_env)));
$$;

create function public.ongoing_copy_select(p_connection bigint,p_person uuid,p_enabled boolean,p_actor uuid,p_reason text,p_confirm boolean default false,p_version int default null)returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.ongoing_copy_connections;who uuid;p public.ab_trader_profiles;r jsonb;
begin
 select * into c from public.ongoing_copy_connections where id=p_connection for update;
 if not found or c.actor_id<>p_actor or not exists(select 1 from public.admins where user_id=p_actor)or length(trim(p_reason))<5 then raise exception 'OWNER_REQUIRED';end if;
 who:=public.ab_person_of(p_person);
 if c.execution_on and p_enabled and p_confirm is distinct from true then raise exception 'CONFIRM_FUNDED_EXECUTION';end if;
 if c.execution_on and p_enabled and p_version is distinct from c.version then raise exception 'STALE_CONNECTION_VERSION';end if;
 if p_enabled then
  if not c.connected or not exists(select 1 from public.trading_accounts a where public.ab_person_of(a.user_id)=who and a.challenge_type='infinity'and a.status='active'and coalesce(a.phase,'')<>'demo'and coalesce(a.venue,'ipfx')='ipfx')then raise exception 'ACTIVE_INFINITY_REQUIRED';end if;
  if exists(select 1 from public.ab_person_signals where person_id=who and (investigation_hold or critical_flag))or exists(select 1 from public.ab_trader_profiles where person_id=who and book_state='SUSPENDED')then raise exception 'TRADER_ON_HOLD';end if;
  if exists(select 1 from public.copy_test_sessions where person_id=who and state in('prepared','active','draining'))then raise exception 'EXISTING_TEST_MUST_FINISH';end if;
  perform public.ab_owner_enroll_model(p_person,p_actor);
 end if;
 if exists(select 1 from public.ongoing_copy_selections s join public.ongoing_copy_connections other on other.id=s.connection_id where s.person_id=who and s.connection_id<>c.id and(other.execution_on or exists(select 1 from public.book_orders o where o.person_id=who and o.ongoing_copy_connection_id=other.id and o.event='open'and o.status in('sent','filled','reconciliation_required'))))then raise exception 'TRADER_ALREADY_ROUTED';end if;
 insert into public.ongoing_copy_selections(person_id,connection_id,enabled,reason)values(who,c.id,p_enabled,left(trim(p_reason),300))
 on conflict(person_id)do update set connection_id=excluded.connection_id,enabled=excluded.enabled,selected_since=clock_timestamp(),reason=excluded.reason;
 if p_enabled and c.execution_on then
  select * into p from public.ab_trader_profiles where person_id=who for update;
  r:=public.ab_owner_set_model(who,p.book_state,p.manual_book_state,'AB_LIVE','Ongoing A-book connection #'||c.id||': '||left(p_reason,200),p_actor);
  if not coalesce((r->>'ok')::boolean,false)then raise exception 'MODEL_ASSIGNMENT_REFUSED: %',r->>'error';end if;
 end if;
 insert into public.admin_audit_log(actor_id,action,detail)values(p_actor,'ongoing_copy_select',jsonb_build_object('connection',c.id,'person',who,'enabled',p_enabled,'execution_on',c.execution_on));
 update public.ongoing_copy_connections set version=version+1,updated_at=now()where id=c.id;
 return jsonb_build_object('ok',true,'person_id',who,'enabled',p_enabled,'execution_on',c.execution_on);
end $$;

create function public.ongoing_copy_control(p_id bigint,p_action text,p_version int,p_actor uuid,p_developer boolean,p_confirm boolean)returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.ongoing_copy_connections;p public.ab_trader_profiles;s record;r jsonb;
begin
 select * into c from public.ongoing_copy_connections where id=p_id for update;
 if not found or c.actor_id<>p_actor or not exists(select 1 from public.admins where user_id=p_actor)then raise exception 'OWNER_REQUIRED';end if;
 if c.version<>p_version and p_action='on'then return jsonb_build_object('ok',false,'reason','STALE_CONNECTION_VERSION');end if;
 if p_action='on' then
  if p_confirm is distinct from true or not public.ongoing_copy_ready(c.id)then raise exception 'REVIEW_CONNECTION_AND_PERMISSION';end if;
  if c.execution_on then return jsonb_build_object('ok',true,'id',c.id,'version',c.version,'connected',c.connected,'execution_on',true,'unchanged',true);end if;
  if not p_developer or not exists(select 1 from public.book_capacity_limits where book='l'||c.account_id and position_limit>0 and margin_per_lot_usd>0 and length(provider_evidence)>=10)then raise exception 'DOCUMENTED_CAPACITY_AND_DEVELOPER_ACCESS_REQUIRED';end if;
  if coalesce((select book_halt from public.ab_settings),true)or coalesce((select trading_halted from public.platform_config limit 1),true)then raise exception 'BOOK_HALTED';end if;
  update public.ongoing_copy_connections set execution_on=true,enabled_since=clock_timestamp(),version=version+1,updated_at=now()where id=c.id;
  for s in select person_id,reason from public.ongoing_copy_selections where connection_id=c.id and enabled order by person_id loop
   if not exists(select 1 from public.trading_accounts a where public.ab_person_of(a.user_id)=s.person_id and a.challenge_type='infinity'and a.status='active'and coalesce(a.phase,'')<>'demo'and coalesce(a.venue,'ipfx')='ipfx')then raise exception 'ACTIVE_INFINITY_REQUIRED';end if;
   select * into p from public.ab_trader_profiles where person_id=s.person_id for update;
   r:=public.ab_owner_set_model(s.person_id,p.book_state,p.manual_book_state,'AB_LIVE','Ongoing A-book connection #'||c.id||': '||left(s.reason,200),p_actor);
   if not coalesce((r->>'ok')::boolean,false)then raise exception 'MODEL_ASSIGNMENT_REFUSED: %',r->>'error';end if;
  end loop;
 elsif p_action in('off','disconnect')then
  update public.ongoing_copy_connections set execution_on=false,connected=case when p_action='disconnect'then false else connected end,version=version+1,updated_at=now()where id=c.id;
 else raise exception 'UNKNOWN_EXECUTION_ACTION';end if;
 insert into public.admin_audit_log(actor_id,action,detail)values(p_actor,'ongoing_copy_'||p_action,jsonb_build_object('connection',c.id,'new_entries_only',true,'existing_exits_retained',true));
 select * into c from public.ongoing_copy_connections where id=c.id;
 return jsonb_build_object('ok',true,'id',c.id,'version',c.version,'connected',c.connected,'execution_on',c.execution_on);
end $$;

create function public.ongoing_copy_route(p_user uuid,p_source uuid)returns text language sql stable security definer set search_path='' as $$
 select case when c.connected and c.execution_on and public.ongoing_copy_ready(c.id)
  and a.status='active' and a.challenge_type='infinity'and coalesce(a.phase,'')<>'demo'and coalesce(a.venue,'ipfx')='ipfx'
  and s.enabled and p.book_state='AB_LIVE'and not coalesce((select book_halt from public.ab_settings),true)
  and not coalesce((select trading_halted from public.platform_config limit 1),true)
  and not exists(select 1 from public.ab_person_signals sig where sig.person_id=s.person_id and(sig.investigation_hold or sig.critical_flag))then 'a'else 'off'end
 from public.ongoing_copy_selections s join public.ongoing_copy_connections c on c.id=s.connection_id
 join public.trading_accounts a on a.id=p_source and public.ab_person_of(a.user_id)=s.person_id
 left join public.ab_trader_profiles p on p.person_id=s.person_id where s.person_id=public.ab_person_of(p_user)limit 1;
$$;

create function public.ongoing_copy_claim(p_trade uuid)returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.trades;c public.ongoing_copy_connections;s public.ongoing_copy_selections;
begin
 select * into t from public.trades where id=p_trade;if not found then return jsonb_build_object('handled',false);end if;
 select * into s from public.ongoing_copy_selections where person_id=public.ab_person_of(t.user_id);if not found then return jsonb_build_object('handled',false);end if;
 select * into c from public.ongoing_copy_connections where id=s.connection_id for update;
 select * into s from public.ongoing_copy_selections where person_id=public.ab_person_of(t.user_id);
 if not found or s.connection_id<>c.id then return jsonb_build_object('handled',true,'ok',false,'reason','SELECTION_CHANGED_NO_SEND');end if;
 if exists(select 1 from public.ongoing_copy_intents where connection_id=c.id and source_trade_id=t.id)then return jsonb_build_object('handled',true,'ok',false,'reason','DUPLICATE_NO_SEND');end if;
 if public.ongoing_copy_route(t.user_id,t.account_id)is distinct from 'a' then return jsonb_build_object('handled',true,'ok',false,'reason','EXECUTION_OFF_OR_TRADER_INELIGIBLE');end if;
 if t.status is distinct from 'open'or t.parent_trade_id is not null or t.external_source is not null
  or t.side is null or t.side not in('buy','sell')or t.symbol is null or t.sl is null or t.sl::text in('NaN','Infinity','-Infinity')
  or t.volume is null or t.volume<=0 or t.volume::text in('NaN','Infinity','-Infinity')
  or t.opened_at is null or t.opened_at<greatest(s.selected_since,c.enabled_since)or t.opened_at>clock_timestamp()+interval '1 second'
  then return jsonb_build_object('handled',true,'ok',false,'reason','NEW_ELIGIBLE_SOURCE_WITH_STOP_REQUIRED');end if;
 insert into public.ongoing_copy_intents(connection_id,source_trade_id)values(c.id,t.id);
 return jsonb_build_object('handled',true,'ok',true,'ongoing',true,'connection_id',c.id,'destination_id',c.account_id,'broker_lots',c.broker_lots,'max_trade_risk_usd',c.max_trade_risk_usd);
end $$;

create function public.ongoing_copy_access(p_book text,p_trade uuid,p_exit boolean default false)returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ongoing_copy_intents i join public.ongoing_copy_connections c on c.id=i.connection_id
 join public.ladder_accounts d on d.id=c.account_id join public.trades t on t.id=i.source_trade_id
 where i.source_trade_id=p_trade and p_book='l'||c.account_id and d.role in('monitor','ladder')and not d.execution_enabled
 and d.account_id=c.broker_account_id and d.api_env=c.api_env and d.server=c.broker_server
 and (case when p_exit then exists(select 1 from public.book_orders o where o.book=p_book and o.source_trade_id=p_trade and o.event='open'and o.ongoing_copy_connection_id=c.id)
 else i.state='reserved'and t.status='open'and t.sl is not null and public.ongoing_copy_route(t.user_id,t.account_id)='a' end));
$$;
create function public.ongoing_copy_note(p_trade uuid,p_refused boolean,p_reason text)returns void language sql security definer set search_path='' as $$
 update public.ongoing_copy_intents set state=case when p_refused and not exists(select 1 from public.book_orders where source_trade_id=p_trade)then 'refused'else 'pending_receipts'end,reason=left(p_reason,250)where source_trade_id=p_trade and state='reserved';
$$;

create function public.ongoing_copy_summary(p_actor uuid)returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('connections',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('ready',public.ongoing_copy_ready(c.id),'capacity_configured',exists(select 1 from public.book_capacity_limits where book='l'||c.account_id),'label',d.label))from public.ongoing_copy_connections c join public.ladder_accounts d on d.id=c.account_id where c.actor_id=p_actor),'[]'::jsonb),
 'selections',coalesce((select jsonb_agg(jsonb_build_object('person_id',s.person_id,'connection_id',s.connection_id,'enabled',s.enabled,'selected_since',s.selected_since,'email',(select email from auth.users where id=s.person_id),'model',p.book_state,'manual_model',p.manual_book_state))from public.ongoing_copy_selections s join public.ongoing_copy_connections c on c.id=s.connection_id left join public.ab_trader_profiles p on p.person_id=s.person_id where c.actor_id=p_actor),'[]'::jsonb),
 'intentions',coalesce((select jsonb_agg(x)from(select i.connection_id,i.source_trade_id,i.state,i.reason,i.created_at,t.symbol,
  (select status from public.book_orders o where o.source_trade_id=i.source_trade_id and o.ongoing_copy_connection_id=c.id and o.event='open'limit 1)broker_status,
  (select count(*)from public.book_orders o where o.source_trade_id=i.source_trade_id and o.ongoing_copy_connection_id=c.id and o.status='reconciliation_required')uncertain_events
  from public.ongoing_copy_intents i join public.ongoing_copy_connections c on c.id=i.connection_id join public.trades t on t.id=i.source_trade_id where c.actor_id=p_actor order by i.created_at desc limit 100)x),'[]'::jsonb),
 'receipts',coalesce((select jsonb_agg(x)from(select o.id,o.ongoing_copy_connection_id,o.source_trade_id,o.book,o.event,o.symbol,o.side,o.qty,o.status,o.broker_order_id,o.broker_position_id,o.fill_price,o.pnl_usd,o.latency_ms,o.created_at,o.error,false net_verified from public.book_orders o join public.ongoing_copy_connections c on c.id=o.ongoing_copy_connection_id where c.actor_id=p_actor order by o.id desc limit 100)x),'[]'::jsonb));
$$;

-- Partial/full exit journals retain the exact original execution connection after OFF/disconnect.
create function public.ongoing_copy_link_exit()returns trigger language plpgsql set search_path='' as $$
begin
 if new.event<>'open'and new.ongoing_copy_connection_id is null then
  select o.ongoing_copy_connection_id into new.ongoing_copy_connection_id from public.book_orders o where o.source_trade_id=new.source_trade_id and o.book=new.book and o.event='open'limit 1;
 end if;return new;
end $$;
create trigger book_ongoing_copy_exit_link before insert on public.book_orders for each row execute function public.ongoing_copy_link_exit();
revoke all on function public.ongoing_copy_link_exit()from public,anon,authenticated;

-- Preserve numerical risk policy; allow this physical monitor account ONLY for an admitted ongoing intent.
do $risk$declare src text;anchor text:='if la is null or not la.execution_enabled or la.status not in (''evaluation'', ''funded'') then';begin
 src:=pg_get_functiondef('public.ab_reserve_risk(text,uuid,uuid,text,numeric,numeric)'::regprocedure);
 if strpos(src,anchor)=0 then raise exception 'ONGOING_RISK_SOURCE_DRIFT';end if;
 execute replace(src,anchor,'if la is null or (not la.execution_enabled and not public.ongoing_copy_access(p_book,p_trade,false)) or la.status not in (''evaluation'', ''funded'') then');
end $risk$;
-- Actual destination readiness is bound to this person's explicitly selected, enabled connection.
do $caps$declare src text;anchor text:='return jsonb_build_object(';begin
 src:=pg_get_functiondef('public.ab_model_capabilities(uuid)'::regprocedure);
 if strpos(src,anchor)=0 or array_length(string_to_array(src,anchor),1)<>2 then raise exception 'ONGOING_CAPABILITIES_SOURCE_DRIFT';end if;
 execute replace(src,anchor,'ready:=ready+(select count(*)from public.ongoing_copy_selections os join public.ongoing_copy_connections oc on oc.id=os.connection_id where os.person_id=p_person and os.enabled and oc.execution_on and public.ongoing_copy_ready(oc.id));'||E'\n '||anchor);
end $caps$;
do $capture$declare src text;anchor text:='state:=coalesce(state,''BB_DEMO'');';begin
 src:=pg_get_functiondef('public.e8_sim_capture()'::regprocedure);
 if strpos(src,anchor)=0 then raise exception 'ONGOING_CAPTURE_SOURCE_DRIFT';end if;
 execute replace(src,anchor,anchor||E'\n if public.ongoing_copy_route(new.user_id,a.id)=''a''then state:=''AB_LIVE'';end if;');
end $capture$;
do $$declare f text;begin foreach f in array array['ongoing_copy_connect(bigint,numeric,numeric,uuid,boolean,text)','ongoing_copy_ready(bigint)','ongoing_copy_select(bigint,uuid,boolean,uuid,text,boolean,int)','ongoing_copy_control(bigint,text,int,uuid,boolean,boolean)','ongoing_copy_route(uuid,uuid)','ongoing_copy_claim(uuid)','ongoing_copy_access(text,uuid,boolean)','ongoing_copy_note(uuid,boolean,text)','ongoing_copy_summary(uuid)']loop
 execute 'revoke all on function public.'||f||' from public,anon,authenticated';execute 'grant execute on function public.'||f||' to service_role';end loop;end $$;
