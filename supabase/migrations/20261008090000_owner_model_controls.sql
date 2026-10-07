-- Owner choices change future per-person classification/routing, not existing legs.
-- Monitor connections never become execution accounts. No live account is enabled.
begin;
alter table public.ab_trader_profiles
 add column manual_book_state text check(manual_book_state in('AB_DEMO','AB_LIVE','BB_DEMO','BB_LIVE')),
 add column manual_by uuid, add column manual_since timestamptz, add column manual_reason text;

create function public.ab_model_signal_group(p_person uuid,p_groups int) returns int
language plpgsql immutable set search_path='' as $$
declare h bigint:=2166136261; c text;
begin
 if p_groups<1 then return 0; end if;
 for c in select regexp_split_to_table(p_person::text,'') loop
  h:=((h # ascii(c)::bigint)*16777619) & 4294967295;
 end loop;
 return (h % p_groups)::int;
end $$;

create function public.ab_model_capabilities(p_person uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare halted boolean; groups int; grp int; ready int; sig record; safe boolean;
begin
 select book_halt into halted from public.ab_settings;
 select signal_groups into groups from public.ladder_settings;
 grp:=public.ab_model_signal_group(p_person,coalesce(groups,1));
 select * into sig from public.ab_person_signals where person_id=p_person;
 safe:=not coalesce(sig.investigation_hold,false) and not coalesce(sig.critical_flag,false)
  and not exists(select 1 from public.ab_trader_profiles where person_id=p_person and book_state='SUSPENDED');
 select count(*) into ready from public.ladder_accounts l
 where l.role='ladder' and l.status='funded' and l.execution_enabled
  and l.access_token_ciphertext is not null and l.refresh_token_ciphertext is not null
  and l.signal_group % coalesce(groups,1)=grp;
 return jsonb_build_object(
  'signal_group',grp,'halted',coalesce(halted,true),'integrity_clear',safe,
  'AB_DEMO',jsonb_build_object('available',safe,'mode','INTERNAL_SAME_DIRECTION','reason','Same-direction internal simulation; no funded broker order'),
  'BB_DEMO',jsonb_build_object('available',safe,'mode','INTERNAL_REVERSE','reason','Reverse internal simulation; no funded broker order'),
  'AB_LIVE',jsonb_build_object('available',safe and not coalesce(halted,true) and ready>0,
    'mode','FUNDED_EXECUTION','destinations',ready,'reason',case when not safe then 'Investigation or suspension must be resolved'
     when coalesce(halted,true) then 'Book execution is halted'
     when ready=0 then 'No enabled funded execution account for this signal group; the E8 monitor is read-only'
     else 'Funded destination configured; every order still passes risk, symbol and capacity checks' end),
  'BB_LIVE',jsonb_build_object('available',false,'mode','NOT_CONNECTED',
    'reason','Live reverse execution adapter is not connected; current B review accounts are demo-only'));
end $$;

create or replace function public.ab_apply_transition(p_person uuid,p_from text,p_to text,p_reason text,
 p_evidence jsonb,p_policy_version int,p_actor text default 'ab-classifier') returns boolean
language plpgsql security definer set search_path='' as $$
declare n int;
begin
 if p_from='SUSPENDED' and p_actor='ab-classifier' then return false; end if;
 update public.ab_trader_profiles set book_state=p_to,state_since=now(),state_reason=left(p_reason,300),policy_version=p_policy_version,
  last_ab_exit_at=case when p_from in('AB_DEMO','AB_LIVE') and p_to in('BB_DEMO','BB_LIVE') then now() else last_ab_exit_at end,
  manual_book_state=case when p_to='SUSPENDED' then null else manual_book_state end,
  manual_by=case when p_to='SUSPENDED' then null else manual_by end,
  manual_since=case when p_to='SUSPENDED' then null else manual_since end,
  manual_reason=case when p_to='SUSPENDED' then null else manual_reason end,updated_at=now()
 where person_id=p_person and book_state=p_from
  and (p_actor<>'ab-classifier' or manual_book_state is null or p_to='SUSPENDED');
 get diagnostics n=row_count;
 if n=0 then return false; end if;
 insert into public.ab_lifecycle_events(person_id,from_state,to_state,reason,evidence,policy_version,actor)
 values(p_person,p_from,p_to,left(p_reason,300),coalesce(p_evidence,'{}'),p_policy_version,p_actor);
 return true;
end $$;

create function public.ab_owner_set_model(p_person uuid,p_expected_state text,p_expected_manual text,
 p_target text,p_reason text,p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.ab_trader_profiles; caps jsonb; policy int; ok boolean; target text;
begin
 if not exists(select 1 from public.admins where user_id=p_actor) then raise exception 'Admin actor required'; end if;
 if p_target is null or p_target not in('AUTOMATIC','AB_DEMO','AB_LIVE','BB_DEMO','BB_LIVE') then
  return jsonb_build_object('ok',false,'error','Choose one of the four models or Automatic'); end if;
 if p_reason is null or length(btrim(p_reason))<5 or length(p_reason)>300 then
  return jsonb_build_object('ok',false,'error','Give a reason between 5 and 300 characters'); end if;
 select * into p from public.ab_trader_profiles where person_id=p_person for update;
 if not found then return jsonb_build_object('ok',false,'error','Trader profile not found'); end if;
 if p.book_state is distinct from p_expected_state or p.manual_book_state is distinct from p_expected_manual then
  return jsonb_build_object('ok',false,'error','Trader control changed; refresh before applying'); end if;
 select version into policy from public.ab_policy_versions where status='ACTIVE';
 if policy is null then return jsonb_build_object('ok',false,'error','No active policy'); end if;
 caps:=public.ab_model_capabilities(p_person);
 if p_target='AUTOMATIC' then
  if p.manual_book_state is null then return jsonb_build_object('ok',true,'unchanged',true,'state',p.book_state,'control','AUTOMATIC'); end if;
  update public.ab_trader_profiles set manual_book_state=null,manual_by=null,manual_since=null,manual_reason=null,updated_at=now() where person_id=p_person;
  insert into public.ab_lifecycle_events(person_id,from_state,to_state,reason,evidence,policy_version,actor)
   values(p_person,p.book_state,p.book_state,'Automatic control restored: '||p_reason,
    jsonb_build_object('previous_manual',p.manual_book_state),policy,'human:'||p_actor::text);
 else
  if not coalesce((caps->p_target->>'available')::boolean,false) then
   return jsonb_build_object('ok',false,'error',case when not (caps->>'integrity_clear')::boolean then
    'Suspension or investigation must be resolved before changing model' else caps->p_target->>'reason' end,'routing',caps); end if;
  if p.manual_book_state=p_target and p.book_state=p_target then return jsonb_build_object('ok',true,'unchanged',true,'state',p.book_state,'control','MANUAL'); end if;
  ok:=public.ab_apply_transition(p_person,p.book_state,p_target,'Owner choice: '||p_reason,
    jsonb_build_object('control','MANUAL','requested',p_target,'previous_manual',p.manual_book_state,'existing_positions','UNCHANGED'),policy,'human:'||p_actor::text);
  if not ok then raise exception 'Model change conflict'; end if;
  update public.ab_trader_profiles set manual_book_state=p_target,manual_by=p_actor,manual_since=now(),manual_reason=p_reason where person_id=p_person;
 end if;
 insert into public.admin_audit_log(actor_id,action,detail) values(p_actor,'brain_model_change',
  jsonb_build_object('person_id',p_person,'from',p.book_state,'requested',p_target,'reason',p_reason,'previous_manual',p.manual_book_state));
 return jsonb_build_object('ok',true,'state',case when p_target='AUTOMATIC' then p.book_state else p_target end,
  'control',case when p_target='AUTOMATIC' then 'AUTOMATIC' else 'MANUAL' end,'effective','NEW_ORDERS_ONLY','routing',caps);
end $$;

-- Preserve the existing automatic route, but shadow/monitor accounts cannot qualify as A execution.
create or replace function public.ab_route_for_user(p_user uuid) returns text
language sql stable security definer set search_path='' as $$
 select case when s.book_halt then null
  when p.book_state='AB_LIVE' and (exists(select 1 from public.team_book_destinations d where d.book='a' and d.status='connected')
   or exists(select 1 from public.ladder_accounts l where l.role='ladder' and l.execution_enabled and l.status in('evaluation','funded'))) then 'a'
  when p.book_state='BB_LIVE' and exists(select 1 from public.team_book_destinations d where d.book='b' and d.status='connected') then 'b' end
 from public.ab_trader_profiles p cross join public.ab_settings s where p.person_id=public.ab_person_of(p_user)
$$;
create function public.ab_brain_live_activity(p_person uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('as_of',clock_timestamp(),
 'source_trades',coalesce((select jsonb_agg(x) from(select t.id,t.parent_trade_id,t.account_id,t.symbol,t.side,t.volume,
  t.status,t.open_price,t.close_price,t.sl,t.tp,t.pnl,t.commission,t.financing,t.opened_at,t.closed_at,t.close_reason
  from public.trades t join public.trading_accounts a on a.id=t.account_id
  where public.ab_person_of(a.user_id)=p_person and coalesce(a.venue,'ipfx')='ipfx' and t.external_source is null
  order by (t.status='open') desc,coalesce(t.closed_at,t.opened_at) desc limit 100)x),'[]'::jsonb),
 'simulations',coalesce((select jsonb_agg(x) from(select r.trade_id,r.symbol,r.trader_side,r.selected_book,r.status,
  r.original_lots,r.exited_lots,r.selected_gross_usd,r.net_usd,r.net_status,r.opened_at,r.last_exit_at,
  d.status decision_status,d.selected_gross_usd decision_gross_usd
  from public.e8_sim_trade_results r left join public.ipfx_sim_decision_results d using(trade_id)
  where r.person_id=p_person order by r.opened_at desc limit 50)x),'[]'::jsonb),
 'pending',coalesce((select jsonb_agg(x) from(select * from public.ipfx_sim_pending_state where person_id=p_person
  order by captured_at desc limit 50)x),'[]'::jsonb));
$$;
create index e8_sim_person_opened on public.e8_sim_positions(person_id,opened_at desc);
create function public.ab_owner_enroll_model(p_user uuid,p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare who uuid; n int;
begin
 if not exists(select 1 from public.admins where user_id=p_actor) then raise exception 'Admin actor required'; end if;
 if not exists(select 1 from public.user_profiles where user_id=p_user) then
  return jsonb_build_object('ok',false,'error','Registered trader not found'); end if;
 who:=public.ab_person_of(p_user);
 insert into public.ab_trader_profiles(person_id,book_state,state_reason,policy_version)
 values(who,'BB_DEMO','Owner added to Brain: automatic B-book demo',(select version from public.ab_policy_versions where status='ACTIVE'))
 on conflict(person_id) do nothing;
 get diagnostics n=row_count;
 if n>0 then insert into public.admin_audit_log(actor_id,action,detail) values(p_actor,'brain_trader_enroll',
  jsonb_build_object('user_id',p_user,'person_id',who,'state','BB_DEMO')); end if;
 return jsonb_build_object('ok',true,'person_id',who,'created',n>0);
end $$;
revoke all on function public.ab_model_signal_group(uuid,int),public.ab_model_capabilities(uuid),
 public.ab_owner_set_model(uuid,text,text,text,text,uuid),public.ab_brain_live_activity(uuid),
 public.ab_apply_transition(uuid,text,text,text,jsonb,int,text),public.ab_route_for_user(uuid),public.ab_owner_enroll_model(uuid,uuid) from public,anon,authenticated;
grant execute on function public.ab_model_signal_group(uuid,int),public.ab_model_capabilities(uuid),
 public.ab_owner_set_model(uuid,text,text,text,text,uuid),public.ab_brain_live_activity(uuid),
 public.ab_apply_transition(uuid,text,text,text,jsonb,int,text),public.ab_route_for_user(uuid),public.ab_owner_enroll_model(uuid,uuid) to service_role;
commit;
