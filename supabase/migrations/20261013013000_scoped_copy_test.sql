-- Owner-started prospective test. No account enablement, profile change or test activation on installation.
alter table public.ladder_accounts add column copy_test_only boolean not null default false;
create table public.copy_test_sessions(
 id bigint generated always as identity primary key, actor_id uuid not null, person_id uuid not null,
 source_account_id uuid not null references public.trading_accounts(id), destination_id bigint not null references public.ladder_accounts(id),
 state text not null default 'prepared' check(state in('prepared','active','draining','completed','cancelled')),
 version int not null default 1, symbol text not null default 'XAUUSD' check(symbol='XAUUSD'),
 max_trades int not null default 5 check(max_trades=5), broker_lots numeric not null default 0.01 check(broker_lots=0.01),
 max_trade_risk_usd numeric not null check(max_trade_risk_usd>0 and max_trade_risk_usd<=100 and max_trade_risk_usd::text not in('NaN','Infinity','-Infinity')),
 slots int not null default 0 check(slots between 0 and 5), starts_at timestamptz, expires_at timestamptz,
 previous_model jsonb, reason text not null, created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create unique index copy_test_one_person on public.copy_test_sessions(person_id) where state in('prepared','active','draining');
create unique index copy_test_one_destination on public.copy_test_sessions(destination_id) where state in('prepared','active','draining');
alter table public.book_orders add column copy_test_session_id bigint references public.copy_test_sessions(id);
create table public.copy_test_slots(
 session_id bigint not null references public.copy_test_sessions(id),source_trade_id uuid not null references public.trades(id),
 ordinal int not null check(ordinal between 1 and 5),state text not null default 'reserved' check(state in('reserved','refused','pending_receipts','completed')),
 reason text,created_at timestamptz not null default now(),primary key(session_id,source_trade_id),unique(session_id,ordinal)
);
alter table public.copy_test_sessions enable row level security;alter table public.copy_test_slots enable row level security;
revoke all on public.copy_test_sessions,public.copy_test_slots from public,anon,authenticated;
grant select,insert,update on public.copy_test_sessions,public.copy_test_slots to service_role;
grant usage,select on sequence public.copy_test_sessions_id_seq to service_role;

create function public.copy_test_find_user(p_email text)returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('person_id',public.ab_person_of(u.id),'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'label',a.label))from public.trading_accounts a where a.user_id=u.id and a.status='demo' and a.challenge_type='demo' and coalesce(a.venue,'ipfx')='ipfx'),'[]'::jsonb))
 from auth.users u where lower(u.email)=lower(trim(p_email));
$$;
create function public.copy_test_summary(p_actor uuid)returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('source_email',(select u.email from public.trading_accounts a join auth.users u on u.id=a.user_id where a.id=s.source_account_id),'model_changed',false,'capacity_configured',exists(select 1 from public.book_capacity_limits where book='l'||s.destination_id),
 'receipts',coalesce((select jsonb_agg(jsonb_build_object('source_trade_id',x.source_trade_id,'slot',x.ordinal,'state',x.state,'reason',x.reason,
 'broker_events',coalesce((select jsonb_agg(jsonb_build_object('event',o.event,'status',o.status,'qty',o.qty,'side',o.side,'fill_price',o.fill_price,'gross_pnl_usd',o.pnl_usd,'broker_order_id',o.broker_order_id,'broker_position_id',o.broker_position_id,'net_verified',false))
 from public.book_orders o where o.source_trade_id=x.source_trade_id and o.book='l'||s.destination_id),'[]'::jsonb))order by x.ordinal)
 from public.copy_test_slots x where x.session_id=s.id),'[]'::jsonb))order by s.id desc),'[]'::jsonb)
 from (select id,person_id,source_account_id,destination_id,state,version,slots,max_trades,broker_lots,max_trade_risk_usd,starts_at,expires_at,updated_at
 from public.copy_test_sessions where actor_id=p_actor order by id desc limit 10)s;
$$;

create function public.copy_test_prepare(p_person uuid,p_source uuid,p_destination bigint,p_risk numeric,p_actor uuid,p_reason text)returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts;d public.ladder_accounts;who uuid;s bigint;sig record;
begin
 if not exists(select 1 from public.admins where user_id=p_actor) or length(trim(p_reason))<5 then raise exception 'OWNER_OR_REASON_REQUIRED';end if;
 who:=public.ab_person_of(p_person);select * into a from public.trading_accounts where id=p_source;
 if not found or public.ab_person_of(a.user_id)<>who or a.challenge_type<>'demo' or a.status<>'demo' or coalesce(a.venue,'ipfx')<>'ipfx' then raise exception 'SELECT_OWN_IPFX_PRACTICE_ACCOUNT';end if;
 select * into d from public.ladder_accounts where id=p_destination for update;
 if not found or d.role<>'ladder' or d.execution_enabled or d.api_env<>'demo' or d.status<>'funded' then raise exception 'FUNDED_CONNECTION_MUST_BE_SAVED_OFF';end if;
 if exists(select 1 from public.ladder_accounts m where m.role='monitor' and m.account_id=d.account_id and m.api_env=d.api_env) then raise exception 'MONITOR_AND_ALIASES_ARE_READ_ONLY';end if;
 if p_risk is null or p_risk<=0 or p_risk>100 or p_risk::text in('NaN','Infinity','-Infinity') then raise exception 'ENTER_BOUNDED_MAXIMUM_TRADE_RISK';end if;
 select * into sig from public.ab_person_signals where person_id=who;
 if coalesce(sig.investigation_hold,false) or coalesce(sig.critical_flag,false) or exists(select 1 from public.ab_trader_profiles where person_id=who and book_state='SUSPENDED')then raise exception 'TRADER_ON_HOLD';end if;
 insert into public.copy_test_sessions(actor_id,person_id,source_account_id,destination_id,max_trade_risk_usd,reason,previous_model)
 values(p_actor,who,p_source,p_destination,p_risk,left(trim(p_reason),500),(select jsonb_build_object('book_state',p.book_state,'manual_book_state',p.manual_book_state)from public.ab_trader_profiles p where person_id=who))returning id into s;
 update public.ladder_accounts set copy_test_only=true where id=d.id;
 insert into public.admin_audit_log(actor_id,action,detail)values(p_actor,'copy_test_prepare',jsonb_build_object('session',s,'person',who,'source',p_source,'destination',d.id,'execution_enabled',false));
 return jsonb_build_object('ok',true,'id',s,'state','prepared','version',1,'execution_enabled',false);
end $$;

create function public.copy_test_control(p_id bigint,p_action text,p_version int,p_actor uuid,p_developer boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.copy_test_sessions;d public.ladder_accounts;sig record;g jsonb;
begin
 select * into s from public.copy_test_sessions where id=p_id for update;
 if not found or s.actor_id<>p_actor or not exists(select 1 from public.admins where user_id=p_actor)then raise exception 'OWNER_REQUIRED';end if;
 if s.version<>p_version then return jsonb_build_object('ok',false,'reason','STALE_TEST_VERSION');end if;
 select * into d from public.ladder_accounts where id=s.destination_id for update;
 if p_action='start' then
  if s.state<>'prepared' or d.role<>'ladder' or d.execution_enabled or not d.copy_test_only or d.status<>'funded' or d.api_env<>'demo' then raise exception 'TEST_OR_CONNECTION_NOT_READY';end if;
  if exists(select 1 from public.ladder_accounts m where m.role='monitor' and m.account_id=d.account_id and m.api_env=d.api_env)then raise exception 'MONITOR_AND_ALIASES_ARE_READ_ONLY';end if;
  if exists(select 1 from public.ladder_accounts x where x.id<>d.id and x.execution_enabled and x.account_id=d.account_id and x.api_env=d.api_env)
   or exists(select 1 from public.team_book_destinations x where x.status='connected' and x.account_id=d.account_id and x.environment=d.api_env) then raise exception 'ACCOUNT_USED_BY_OTHER_COPIER';end if;
  if not p_developer or not exists(select 1 from public.book_capacity_limits where book='l'||d.id and position_limit>0 and margin_per_lot_usd>0 and length(provider_evidence)>=10)then raise exception 'DOCUMENTED_CAPACITY_AND_DEVELOPER_ACCESS_REQUIRED';end if;
  if(select count(*)from jsonb_array_elements(d.instrument_map)x where regexp_replace(upper(x->>'symbol'),'[^A-Z0-9]','','g')like 'XAUUSD%')<>1 then raise exception 'GOLD_METADATA_NOT_VERIFIED';end if;
  select x into g from jsonb_array_elements(d.instrument_map)x where regexp_replace(upper(x->>'symbol'),'[^A-Z0-9]','','g')like 'XAUUSD%';
  if g is null or jsonb_typeof(g->'lot_size')<>'number' or (g->>'lot_size')::numeric<=0 or g->>'quote_currency'<>'USD'
   or g->>'spec_observed_at' is null or (g->>'spec_observed_at')::timestamptz>now() or (g->>'spec_observed_at')::timestamptz<now()-interval '6 hours' then raise exception 'GOLD_METADATA_NOT_VERIFIED';end if;
  if coalesce((select book_halt from public.ab_settings),true)then raise exception 'BOOK_HALTED';end if;
  select * into sig from public.ab_person_signals where person_id=s.person_id;
  if coalesce(sig.investigation_hold,false) or coalesce(sig.critical_flag,false) or exists(select 1 from public.ab_trader_profiles where person_id=s.person_id and book_state='SUSPENDED')then raise exception 'TRADER_ON_HOLD';end if;
  update public.copy_test_sessions set state='active',starts_at=clock_timestamp(),expires_at=clock_timestamp()+interval '24 hours',version=version+1,updated_at=now()where id=s.id;
  update public.ladder_accounts set execution_enabled=true where id=d.id;
 elsif p_action='stop' then
  if s.state not in('prepared','active','draining')then raise exception 'TEST_ALREADY_FINISHED';end if;
  update public.copy_test_sessions set state=case when slots=0 then 'cancelled' else 'draining' end,version=version+1,updated_at=now()where id=s.id;
  update public.ladder_accounts set execution_enabled=false where id=d.id;
 else raise exception 'UNKNOWN_TEST_ACTION';end if;
 insert into public.admin_audit_log(actor_id,action,detail)values(p_actor,'copy_test_'||p_action,jsonb_build_object('session',s.id,'person',s.person_id,'source',s.source_account_id,'destination',d.id));
 return jsonb_build_object('ok',true,'owner_activation',p_action='start');
end $$;
-- Use the scoped effective model only for NEW simulator roots; archived rows are immutable.
do $capture$ declare src text;anchor text:='state:=coalesce(state,''BB_DEMO'');';begin
 src:=pg_get_functiondef('public.e8_sim_capture()'::regprocedure);
 if strpos(src,anchor)=0 then raise exception 'E8_CAPTURE_SOURCE_DRIFT';end if;
 execute replace(src,anchor,anchor||E'\n  if public.copy_test_route(new.user_id,a.id,new.symbol)=''a'' then state:=''AB_LIVE'';end if;');
end $capture$;

create function public.copy_test_route(p_user uuid,p_source uuid,p_symbol text default 'XAUUSD') returns text language sql stable security definer set search_path='' as $$
 select 'a'::text from public.copy_test_sessions s join public.trading_accounts a on a.id=s.source_account_id join public.ladder_accounts d on d.id=s.destination_id
 where s.person_id=public.ab_person_of(p_user) and s.source_account_id=p_source and p_symbol=s.symbol and a.status='demo' and a.challenge_type='demo'
 and s.state='active' and s.slots<5 and now()<s.expires_at
 and d.role='ladder' and d.copy_test_only and d.execution_enabled and d.status='funded' and d.api_env='demo'
 and not coalesce((select book_halt from public.ab_settings),true)limit 1;
$$;

create function public.copy_test_claim(p_trade uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.trades;s public.copy_test_sessions;d public.ladder_accounts;who uuid;sig record;
begin
 select * into t from public.trades where id=p_trade;if not found then return jsonb_build_object('handled',false);end if;
 who:=public.ab_person_of(t.user_id);
 select * into s from public.copy_test_sessions where person_id=who and source_account_id=t.account_id and state in('active','draining') order by id desc limit 1 for update;
 if not found then return jsonb_build_object('handled',false);end if;
 if exists(select 1 from public.copy_test_slots where session_id=s.id and source_trade_id=t.id)then return jsonb_build_object('handled',true,'ok',false,'reason','DUPLICATE_TEST_NO_SEND');end if;
 if s.state<>'active' or s.slots>=5 or clock_timestamp()>=s.expires_at then return jsonb_build_object('handled',true,'ok',false,'reason','TEST_STOPPED_OR_FIVE_CAP');end if;
 if t.symbol<>s.symbol or t.parent_trade_id is not null or t.external_source is not null or t.status<>'open' or t.opened_at<s.starts_at
  or t.volume<0.01 or t.volume::text in('NaN','Infinity','-Infinity') or t.sl is null then return jsonb_build_object('handled',true,'ok',false,'reason','INELIGIBLE_TEST_SOURCE');end if;
 if not exists(select 1 from public.trading_accounts a where a.id=t.account_id and a.status='demo' and a.challenge_type='demo' and coalesce(a.venue,'ipfx')='ipfx')then return jsonb_build_object('handled',true,'ok',false,'reason','SOURCE_NOT_PRACTICE_DEMO');end if;
 select * into sig from public.ab_person_signals where person_id=who;
 if coalesce((select book_halt from public.ab_settings),true) or coalesce(sig.investigation_hold,false) or coalesce(sig.critical_flag,false)
  or exists(select 1 from public.ab_trader_profiles where person_id=who and book_state='SUSPENDED')then return jsonb_build_object('handled',true,'ok',false,'reason','HALT_OR_INTEGRITY_HOLD');end if;
 select * into d from public.ladder_accounts where id=s.destination_id;
 if not found or not d.execution_enabled or not d.copy_test_only or d.role<>'ladder' or d.api_env<>'demo' or d.status<>'funded'
  or exists(select 1 from public.ladder_accounts m where m.role='monitor' and m.account_id=d.account_id and m.api_env=d.api_env)
 then return jsonb_build_object('handled',true,'ok',false,'reason','TEST_DESTINATION_UNAVAILABLE');end if;
 insert into public.copy_test_slots(session_id,source_trade_id,ordinal)values(s.id,t.id,s.slots+1);
 update public.copy_test_sessions set slots=slots+1,state=case when slots+1=5 then 'draining' else 'active' end,updated_at=now()where id=s.id;
 -- Slots are never refunded, including rejected or uncertain requests.
 return jsonb_build_object('handled',true,'ok',true,'session_id',s.id,'destination_id',s.destination_id,'broker_lots',s.broker_lots,'max_trade_risk_usd',s.max_trade_risk_usd);
end $$;

create function public.copy_test_note(p_trade uuid,p_refused boolean,p_reason text) returns void language plpgsql security definer set search_path='' as $$
begin
 update public.copy_test_slots set state=case when p_refused and not exists(select 1 from public.book_orders where source_trade_id=p_trade)then 'refused' else 'pending_receipts' end,reason=left(p_reason,200)
 where source_trade_id=p_trade and state='reserved';
end $$;
create function public.copy_test_settle()returns int language plpgsql security definer set search_path='' as $$
declare s public.copy_test_sessions;n int:=0;
begin
 for s in select * from public.copy_test_sessions where state in('active','draining')order by id for update skip locked loop
  if s.state='active' and clock_timestamp()>=s.expires_at then update public.copy_test_sessions set state='draining',updated_at=now()where id=s.id;s.state:='draining';end if;
  update public.copy_test_slots x set state='completed'where x.session_id=s.id and x.state='pending_receipts'
   and exists(select 1 from public.trades t where t.id=x.source_trade_id and t.status='closed')
   and exists(select 1 from public.book_orders o where o.source_trade_id=x.source_trade_id and o.event='open' and o.book='l'||s.destination_id and o.status='filled' and o.qty>0 and o.broker_position_id is not null
    and abs(coalesce((select sum(e.broker_confirmed_qty)from public.book_orders e where e.source_trade_id=o.source_trade_id and e.book=o.book and e.event<>'open' and e.status='closed' and e.dispatch_state='confirmed' and e.broker_confirmed_qty=e.qty and e.broker_position_id=o.broker_position_id and e.broker_order_id is not null and e.fill_price>0),0)-o.qty)<0.000000001
    and not exists(select 1 from public.book_orders e where e.source_trade_id=o.source_trade_id and e.book=o.book and e.event<>'open' and (e.dispatch_state is distinct from 'confirmed' or e.status<>'closed')));
  if s.state='draining' then
   update public.ladder_accounts set execution_enabled=false where id=s.destination_id;
   if not exists(select 1 from public.copy_test_slots where session_id=s.id and state not in('refused','completed'))then
    update public.copy_test_sessions set state='completed',version=version+1,updated_at=now()where id=s.id;n:=n+1;
    -- No global profile was overwritten: normal source routing resumes automatically.
    insert into public.admin_audit_log(actor_id,action,detail)values(s.actor_id,'copy_test_complete',jsonb_build_object('session',s.id,'slots',s.slots,'model_changed',false));
   end if;
  end if;
 end loop;return n;
end $$;
-- A test-only destination must never make unrelated traders appear funded-ready.
do $cap$ declare src text;anchor text:='where l.role=''ladder'' and l.status=''funded'' and l.execution_enabled';begin
 src:=pg_get_functiondef('public.ab_model_capabilities(uuid)'::regprocedure);
 if strpos(src,anchor)=0 then raise exception 'MODEL_CAPABILITIES_SOURCE_DRIFT';end if;
 execute replace(src,anchor,anchor||' and not l.copy_test_only');
end $cap$;
do $$declare f text;begin foreach f in array array['copy_test_summary(uuid)','copy_test_find_user(text)','copy_test_prepare(uuid,uuid,bigint,numeric,uuid,text)','copy_test_control(bigint,text,integer,uuid,boolean)','copy_test_route(uuid,uuid,text)','copy_test_claim(uuid)','copy_test_note(uuid,boolean,text)','copy_test_settle()']loop
 execute 'revoke all on function public.'||f||' from public,anon,authenticated';execute 'grant execute on function public.'||f||' to service_role';end loop;end $$;
