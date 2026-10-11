-- Experimental selected-stream validation. OFF by default; paper intentions are never broker fills.
-- No account enablement, broker transport, source balance/history edits or classifier changes.
create table public.ab_validation_settings (
 singleton boolean primary key default true check(singleton),
 mode text not null default 'off' check(mode in('off','paper')),
 version bigint not null default 1,
 changed_at timestamptz not null default clock_timestamp(), changed_by uuid,reason text
);
insert into public.ab_validation_settings(singleton) values(true);
create table public.ab_validation_enrolments (
 person_id uuid primary key,enabled boolean not null default false,
 selection text not null default 'follow_state' check(selection in('follow_state','a','b')),
 selected_at timestamptz not null default clock_timestamp(),selected_by uuid,reason text not null check(length(reason)>=5)
);
create table public.ab_validation_streams (
 source_root_id uuid primary key,person_id uuid not null,source_account_id uuid not null,
 symbol text not null,source_side text,frozen_book text check(frozen_book in('a','b')),
 frozen_broker_side text check(frozen_broker_side in('buy','sell')),profile_state_at_entry text,
 initial_source_qty numeric,admission text not null check(admission in('eligible','late_or_unknown_source','integrity_hold','invalid_source')),
 captured_at timestamptz not null default clock_timestamp(),source_opened_at timestamptz,
 remaining_source_qty numeric,source_status text,last_event_id bigint
);
create table public.ab_validation_events (
 id bigint generated always as identity primary key,stream_key uuid not null,
 source_root_id uuid,source_row_id uuid,pending_order_id uuid,person_id uuid not null,source_account_id uuid not null,
 kind text not null,captured_at timestamptz not null default clock_timestamp(),source_at timestamptz,snapshot jsonb not null,
 check((source_root_id is not null and source_row_id is not null) or pending_order_id is not null)
);
create index ab_validation_events_stream on public.ab_validation_events(stream_key,id);
create table public.ab_validation_work (
 event_id bigint primary key references public.ab_validation_events(id),stream_key uuid not null,
 state text not null default 'queued' check(state in('queued','leased','sent','unknown','paper_done','skipped')),
 lease_owner uuid,lease_until timestamptz,attempts integer not null default 0,last_code text,updated_at timestamptz not null default clock_timestamp()
);
create index ab_validation_work_ready on public.ab_validation_work(state,event_id);
create index ab_validation_work_stream on public.ab_validation_work(stream_key,event_id,state);
create table public.ab_validation_paper_intentions (
 event_id bigint primary key references public.ab_validation_events(id),created_at timestamptz not null default clock_timestamp(),
 command text not null,snapshot jsonb not null,
 basis text not null default 'SOURCE_INTENT_PAPER_NOT_BROKER_DISPATCH_OR_FILL',
 can_dispatch boolean not null default false check(not can_dispatch),
 net_verified boolean not null default false check(not net_verified)
);
create function public.ab_validation_append_only() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'VALIDATION_EVIDENCE_IS_APPEND_ONLY' using errcode='55000';end $$;
create trigger ab_validation_events_immutable before update or delete on public.ab_validation_events for each row execute function public.ab_validation_append_only();
create trigger ab_validation_paper_immutable before update or delete on public.ab_validation_paper_intentions for each row execute function public.ab_validation_append_only();
create function public.ab_validation_stream_frozen() returns trigger language plpgsql set search_path='' as $$
begin
 if (old.source_root_id,old.person_id,old.source_account_id,old.symbol,old.source_side,old.frozen_book,old.frozen_broker_side,
  old.profile_state_at_entry,old.initial_source_qty,old.admission,old.captured_at,old.source_opened_at)
 is distinct from (new.source_root_id,new.person_id,new.source_account_id,new.symbol,new.source_side,new.frozen_book,new.frozen_broker_side,
  new.profile_state_at_entry,new.initial_source_qty,new.admission,new.captured_at,new.source_opened_at)
 then raise exception 'VALIDATION_ENTRY_IS_FROZEN' using errcode='55000';end if;return new;
end $$;
create trigger ab_validation_stream_frozen before update on public.ab_validation_streams for each row execute function public.ab_validation_stream_frozen();

create function public.ab_validation_capture_trade() returns trigger language plpgsql security definer set search_path='' as $$
declare t public.trades;r public.trades;a public.trading_accounts;s public.ab_validation_streams;e public.ab_validation_enrolments;
 root_id uuid;who uuid;mode text;state text;book text;admission text;kind text;eid bigint;snapshot jsonb;
begin
 if tg_op='DELETE' then t:=old;else t:=new;end if;
 root_id:=coalesce(t.parent_trade_id,t.id);
 select * into s from public.ab_validation_streams where source_root_id=root_id;
 if s.source_root_id is null then
  select v.mode into mode from public.ab_validation_settings v where singleton;
  if coalesce(mode,'off')<>'paper' then if tg_op='DELETE' then return old;else return new;end if;end if;
  if tg_op='DELETE' or t.parent_trade_id is not null or t.status<>'open' then return new;end if;
  select * into a from public.trading_accounts where id=t.account_id;
  if not found or a.challenge_type is distinct from 'infinity' or coalesce(a.venue,'ipfx')<>'ipfx' or a.phase='demo' or a.status='demo' or a.access_revoked_at is not null then return new;end if;
  who:=coalesce(public.ab_person_of(t.user_id),t.user_id);
  select * into e from public.ab_validation_enrolments where person_id=who and enabled;
  if not found then return new;end if;
  select book_state into state from public.ab_trader_profiles where person_id=who;
  state:=coalesce(state,'BB_DEMO');
  book:=case when e.selection<>'follow_state' then e.selection when state like 'AB_%' then 'a' else 'b' end;
  admission:=case when state='SUSPENDED' or coalesce(a.investigation_hold,false) or coalesce(a.status,'') not in('active','passed') then 'integrity_hold'
    when coalesce(a.phase,'') not in('evaluation','funded') then 'invalid_source'
    when t.opened_at is null or t.opened_at<e.selected_at then 'late_or_unknown_source'
    when t.side not in('buy','sell') or t.volume is null or t.volume<=0 or t.volume::text in('NaN','Infinity','-Infinity') then 'invalid_source' else 'eligible' end;
  insert into public.ab_validation_streams(source_root_id,person_id,source_account_id,symbol,source_side,frozen_book,frozen_broker_side,
   profile_state_at_entry,initial_source_qty,admission,source_opened_at,remaining_source_qty,source_status)
  values(root_id,who,t.account_id,t.symbol,t.side,book,
   case when t.side not in('buy','sell') then null when book='a' then t.side when t.side='buy' then 'sell' else 'buy' end,
   state,case when admission='eligible' then t.volume else null end,admission,t.opened_at,t.volume,t.status) on conflict(source_root_id)do nothing;
  select * into s from public.ab_validation_streams where source_root_id=root_id;
 end if;
 if tg_op='UPDATE' and (old.status,old.volume,old.sl,old.tp,old.trail_distance,old.pnl,old.closed_at)
  is not distinct from (new.status,new.volume,new.sl,new.tp,new.trail_distance,new.pnl,new.closed_at) then return new;end if;
 select * into r from public.trades where id=root_id;
 kind:=case when tg_op='DELETE' then 'source_deleted' when t.parent_trade_id is not null then 'partial'
  when tg_op='INSERT' then 'open' when old.status is distinct from t.status and t.status='closed' then 'close'
  when old.volume is distinct from t.volume then 'resize' else 'modify' end;
 snapshot:=jsonb_build_object('symbol',t.symbol,'side',t.side,'status',t.status,'row_qty',t.volume,
  'remaining_qty',case when r.status='closed' then 0 else r.volume end,'sl',t.sl,'tp',t.tp,'trail_distance',t.trail_distance,
  'open_price',t.open_price,'close_price',t.close_price,'source_pnl',t.pnl,'close_reason',t.close_reason,
  'frozen_book',s.frozen_book,'frozen_broker_side',s.frozen_broker_side,'admission',s.admission);
 insert into public.ab_validation_events(stream_key,source_root_id,source_row_id,person_id,source_account_id,kind,source_at,snapshot)
 values(root_id,root_id,t.id,s.person_id,s.source_account_id,kind,coalesce(t.closed_at,t.opened_at),snapshot) returning id into eid;
 insert into public.ab_validation_work(event_id,stream_key) values(eid,root_id);
 update public.ab_validation_streams set remaining_source_qty=case when r.status='closed' then 0 else r.volume end,
  source_status=case when tg_op='DELETE' and t.id=root_id then 'deleted' else r.status end,last_event_id=eid where source_root_id=root_id;
 if tg_op='DELETE' then return old;else return new;end if;
exception when others then
 begin insert into public.ab_heartbeats(worker,ok,at,detail) values('validation-capture',false,clock_timestamp(),jsonb_build_object('code',sqlstate,'coverage_unconfirmed',true))
  on conflict(worker)do update set ok=false,at=excluded.at,detail=excluded.detail;exception when others then null;end;
 if tg_op='DELETE' then return old;else return new;end if;
end $$;
create trigger ab_validation_trade_capture after insert or update or delete on public.trades for each row execute function public.ab_validation_capture_trade();

create function public.ab_validation_capture_pending() returns trigger language plpgsql security definer set search_path='' as $$
declare r public.pending_orders;a public.trading_accounts;e public.ab_validation_enrolments;who uuid;mode text;tracked boolean;kind text;eid bigint;snapshot jsonb;
begin
 if tg_op='DELETE' then r:=old;else r:=new;end if;
 select exists(select 1 from public.ab_validation_events where pending_order_id=r.id) into tracked;
 if not tracked then
  select v.mode into mode from public.ab_validation_settings v where singleton;
  if coalesce(mode,'off')<>'paper' or tg_op<>'INSERT' then if tg_op='DELETE' then return old;else return new;end if;end if;
  select * into a from public.trading_accounts where id=r.account_id;
  if not found or a.challenge_type is distinct from 'infinity' or coalesce(a.venue,'ipfx')<>'ipfx' or a.phase='demo' or a.status='demo' or a.access_revoked_at is not null then return new;end if;
  who:=coalesce(public.ab_person_of(r.user_id),r.user_id);
  select * into e from public.ab_validation_enrolments where person_id=who and enabled;
  if not found then return new;end if;
 else select person_id into who from public.ab_validation_events where pending_order_id=r.id order by id limit 1;end if;
 snapshot:=jsonb_build_object('symbol',r.symbol,'side',r.side,'order_type',r.order_type,'volume',r.volume,'trigger_price',r.trigger_price,
  'sl',r.sl,'tp',r.tp,'expires_at',r.expires_at,'status',case when tg_op='DELETE' then 'deleted' else r.status end,
  'filled_trade_id',r.filled_trade_id,'source_trade_confirmed',exists(select 1 from public.trades t where t.id=r.filled_trade_id
   and t.account_id=r.account_id and t.user_id=r.user_id and t.symbol=r.symbol and t.side=r.side and t.external_source is null));
 if tg_op='UPDATE' and (old.status,old.volume,old.trigger_price,old.sl,old.tp,old.expires_at,old.filled_trade_id)
  is not distinct from (new.status,new.volume,new.trigger_price,new.sl,new.tp,new.expires_at,new.filled_trade_id) then return new;end if;
 kind:=case when tg_op='INSERT' then 'pending_created' when tg_op='DELETE' then 'pending_deleted'
  when old.status is distinct from r.status then 'pending_'||r.status else 'pending_amended' end;
 insert into public.ab_validation_events(stream_key,pending_order_id,person_id,source_account_id,kind,source_at,snapshot)
 values(r.id,r.id,who,r.account_id,kind,coalesce(r.resolved_at,r.created_at),snapshot) returning id into eid;
 insert into public.ab_validation_work(event_id,stream_key) values(eid,r.id);
 if tg_op='DELETE' then return old;else return new;end if;
exception when others then
 begin insert into public.ab_heartbeats(worker,ok,at,detail) values('validation-capture',false,clock_timestamp(),jsonb_build_object('code',sqlstate,'coverage_unconfirmed',true))
  on conflict(worker)do update set ok=false,at=excluded.at,detail=excluded.detail;exception when others then null;end;
 if tg_op='DELETE' then return old;else return new;end if;
end $$;
create trigger ab_validation_pending_capture after insert or update or delete on public.pending_orders for each row execute function public.ab_validation_capture_pending();

create function public.fn_ab_validation_claim(p_worker uuid,p_limit integer default 25) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ids bigint[];result jsonb;
begin
 if p_worker is null or p_limit is null or p_limit<1 or p_limit>100 then raise exception 'INVALID_VALIDATION_CLAIM';end if;
 if not exists(select 1 from public.ab_validation_settings where singleton and mode='paper') then return '[]'::jsonb;end if;
 -- Only expired, never-dispatched leases become retryable. Sent/unknown stays blocked.
 update public.ab_validation_work set state='queued',lease_owner=null,lease_until=null,updated_at=clock_timestamp(),last_code='PAPER_LEASE_EXPIRED'
 where state='leased' and lease_until<clock_timestamp();
 select array_agg(id) into ids from (select w.event_id id from public.ab_validation_work w
  where w.state='queued' and not exists(select 1 from public.ab_validation_work prev where prev.stream_key=w.stream_key
   and prev.event_id<w.event_id and prev.state not in('paper_done','skipped'))
  order by w.event_id limit p_limit for update of w skip locked) q;
 if ids is null then return '[]'::jsonb;end if;
 update public.ab_validation_work set state='leased',lease_owner=p_worker,lease_until=clock_timestamp()+interval '30 seconds',attempts=attempts+1,updated_at=clock_timestamp() where event_id=any(ids);
 select jsonb_agg(to_jsonb(e) order by e.id) into result from public.ab_validation_events e where e.id=any(ids);
 return coalesce(result,'[]'::jsonb);
end $$;
create function public.fn_ab_validation_paper_ack(p_event bigint,p_worker uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare w public.ab_validation_work;e public.ab_validation_events;command text;
begin
 select * into w from public.ab_validation_work where event_id=p_event for update;
 if not found or w.state<>'leased' or w.lease_owner is distinct from p_worker or w.lease_until<clock_timestamp() then return false;end if;
 select * into e from public.ab_validation_events where id=p_event;
 command:=case when coalesce(e.snapshot->>'admission','eligible')<>'eligible' then 'SOURCE_INELIGIBLE_OBSERVATION'
  when e.kind='open' then 'OPEN_INTENT' when e.kind in('resize','partial') then 'ABSOLUTE_REMAINING_TARGET_INTENT'
  when e.kind='close' then 'CLOSE_INTENT' when e.kind='modify' then 'AMENDMENT_OBSERVATION'
  when e.kind='source_deleted' then 'SOURCE_DELETION_REVIEW' else 'SOURCE_PENDING_INTENT_NOT_BROKER_PENDING_ORDER' end;
 insert into public.ab_validation_paper_intentions(event_id,command,snapshot) values(e.id,command,e.snapshot) on conflict(event_id)do nothing;
 update public.ab_validation_work set state='paper_done',lease_owner=null,lease_until=null,last_code=null,updated_at=clock_timestamp() where event_id=e.id;
 return true;
end $$;
create function public.fn_ab_validation_paper_tick() returns jsonb language plpgsql security definer set search_path='' as $$
declare worker_key uuid:=gen_random_uuid();event jsonb;claimed jsonb;n integer:=0;m text;started timestamptz:=clock_timestamp();
begin
 select mode into m from public.ab_validation_settings where singleton;
 while m='paper' and n<500 and clock_timestamp()-started<interval '5 seconds' loop
  claimed:=public.fn_ab_validation_claim(worker_key,100);
  if jsonb_array_length(claimed)=0 then exit;end if;
  for event in select value from jsonb_array_elements(claimed) loop
   if public.fn_ab_validation_paper_ack((event->>'id')::bigint,worker_key) then n:=n+1;end if;
  end loop;
 end loop;
 insert into public.ab_heartbeats(worker,ok,at,detail)values('validation-paper',m is not null,clock_timestamp(),jsonb_build_object('mode',m,'paper_intentions',n,'can_dispatch',false))
 on conflict(worker)do update set ok=excluded.ok,at=excluded.at,detail=excluded.detail;
 return jsonb_build_object('mode',m,'paper_intentions',n,'can_dispatch',false,'net_verified',false);
end $$;
create function public.fn_ab_validation_summary() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('settings',(select to_jsonb(s) from public.ab_validation_settings s where singleton),
 'enabled_enrolments',(select count(*) from public.ab_validation_enrolments where enabled),
 'streams',(select count(*) from public.ab_validation_streams),'events',(select count(*) from public.ab_validation_events),
 'paper_intentions',(select count(*) from public.ab_validation_paper_intentions),
 'paper_worker',(select jsonb_build_object('ok',ok,'at',at,'detail',detail) from public.ab_heartbeats where worker='validation-paper'),
 'oldest_pending_at',(select min(e.captured_at) from public.ab_validation_work w join public.ab_validation_events e on e.id=w.event_id where w.state not in('paper_done','skipped')),
 'work_states',coalesce((select jsonb_object_agg(state,n) from(select state,count(*) n from public.ab_validation_work group by state)x),'{}'::jsonb),
 'capture_failure_recorded',exists(select 1 from public.ab_heartbeats where worker='validation-capture' and not ok),
 'capture_coverage_confirmed',false,
 'can_dispatch',false,'broker_receipts',0,'net_verified',false,'basis','SELECTED_SOURCE_JOURNAL_AND_PAPER_INTENTIONS_NOT_EXECUTION');
$$;

create function public.fn_ab_validation_set_mode(p_mode text,p_expected_version bigint,p_actor uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.ab_validation_settings;
begin
 if p_actor is null or not exists(select 1 from public.admins where user_id=p_actor) then raise exception 'VALIDATION_ADMIN_REQUIRED' using errcode='42501';end if;
 if p_mode is null or p_mode not in('off','paper') or p_reason is null or length(trim(p_reason))<5 then raise exception 'INVALID_PAPER_MODE_REQUEST';end if;
 select * into s from public.ab_validation_settings where singleton for update;
 if not found or p_expected_version is distinct from s.version then return jsonb_build_object('ok',false,'reason','STALE_VALIDATION_SETTINGS');end if;
 insert into public.admin_audit_log(actor_id,action,detail) values(p_actor,'validation_mode_set',jsonb_build_object('from',s.mode,'to',p_mode,'reason',left(trim(p_reason),500),'can_dispatch',false));
 update public.ab_validation_settings set mode=p_mode,version=version+1,changed_by=p_actor,changed_at=clock_timestamp(),reason=left(trim(p_reason),500) where singleton;
 return jsonb_build_object('ok',true,'mode',p_mode,'version',s.version+1,'can_dispatch',false);
end $$;
create function public.fn_ab_validation_enrol(p_person uuid,p_enabled boolean,p_selection text,p_expected_version bigint,p_actor uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.ab_validation_settings;
begin
 if p_actor is null or not exists(select 1 from public.admins where user_id=p_actor) then raise exception 'VALIDATION_ADMIN_REQUIRED' using errcode='42501';end if;
 if p_person is null or not exists(select 1 from public.user_profiles where user_id=p_person) or p_enabled is null
  or p_selection is null or p_selection not in('follow_state','a','b') or p_reason is null or length(trim(p_reason))<5 then raise exception 'INVALID_VALIDATION_ENROLMENT';end if;
 select * into s from public.ab_validation_settings where singleton for update;
 if not found or p_expected_version is distinct from s.version then return jsonb_build_object('ok',false,'reason','STALE_VALIDATION_SETTINGS');end if;
 insert into public.admin_audit_log(actor_id,action,detail) values(p_actor,'validation_enrolment_set',jsonb_build_object('person',p_person,'enabled',p_enabled,'selection',p_selection,'reason',left(trim(p_reason),500),'prospective_only',true));
 insert into public.ab_validation_enrolments(person_id,enabled,selection,selected_at,selected_by,reason)
 values(p_person,p_enabled,p_selection,clock_timestamp(),p_actor,left(trim(p_reason),500))
 on conflict(person_id)do update set enabled=excluded.enabled,selection=excluded.selection,selected_at=excluded.selected_at,selected_by=excluded.selected_by,reason=excluded.reason;
 update public.ab_validation_settings set version=version+1,changed_at=clock_timestamp(),changed_by=p_actor where singleton;
 return jsonb_build_object('ok',true,'version',s.version+1,'can_dispatch',false,'prospective_only',true);
end $$;

alter table public.ab_validation_settings enable row level security;
alter table public.ab_validation_enrolments enable row level security;
alter table public.ab_validation_streams enable row level security;
alter table public.ab_validation_events enable row level security;
alter table public.ab_validation_work enable row level security;
alter table public.ab_validation_paper_intentions enable row level security;
revoke all on public.ab_validation_settings,public.ab_validation_enrolments,public.ab_validation_streams,public.ab_validation_events,public.ab_validation_work,public.ab_validation_paper_intentions from public,anon,authenticated;
grant select,insert,update on public.ab_validation_settings,public.ab_validation_enrolments,public.ab_validation_streams,public.ab_validation_work to service_role;
grant select,insert on public.ab_validation_events,public.ab_validation_paper_intentions to service_role;
grant usage,select on sequence public.ab_validation_events_id_seq to service_role;
revoke all on function public.ab_validation_append_only(),public.ab_validation_stream_frozen(),public.ab_validation_capture_trade(),public.ab_validation_capture_pending(),public.fn_ab_validation_claim(uuid,integer),public.fn_ab_validation_paper_ack(bigint,uuid),public.fn_ab_validation_paper_tick(),public.fn_ab_validation_summary(),public.fn_ab_validation_set_mode(text,bigint,uuid,text),public.fn_ab_validation_enrol(uuid,boolean,text,bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_ab_validation_claim(uuid,integer),public.fn_ab_validation_paper_ack(bigint,uuid),public.fn_ab_validation_paper_tick(),public.fn_ab_validation_summary(),public.fn_ab_validation_set_mode(text,bigint,uuid,text),public.fn_ab_validation_enrol(uuid,boolean,text,bigint,uuid,text) to service_role;
-- Paper-only worker, default OFF. No HTTP, credential or broker path.
do $schedule$ begin
 if not exists(select 1 from cron.job where jobname='ipfx-validation-paper') then
  perform cron.schedule('ipfx-validation-paper','10 seconds','select public.fn_ab_validation_paper_tick()');
 end if;
end $schedule$;
-- No backfill, activation, credential or transport creation.
