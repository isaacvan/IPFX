-- Owner review controls. Matching trades are evidence for review, never an
-- automatic fraud verdict. Service-role RPCs are gated again by the MFA API.
begin;
create table public.trader_entry_pauses (
 person_id uuid primary key, active boolean not null default true,
 reason text not null, actor_id uuid not null, updated_at timestamptz not null default now()
);
create table public.trader_service_notices (
 id uuid primary key default gen_random_uuid(), person_id uuid not null,
 title text not null, message text not null, kind text not null,
 created_at timestamptz not null default now(), actor_id uuid not null
);
create index on public.trader_service_notices(person_id,created_at desc);
create table public.trade_similarity_reviews (
 id uuid primary key default gen_random_uuid(), person_a uuid not null, person_b uuid not null,
 matches int not null, matched_days int not null, share numeric not null,
 evidence jsonb not null, latest_match timestamptz not null,
 reviewed_through timestamptz, review_note text, reviewed_by uuid,
 updated_at timestamptz not null default now(), unique(person_a,person_b), check(person_a<person_b)
);
create table public.brain_solution_actions (
 request_id uuid primary key, alert_id bigint not null, occurrence timestamptz not null,
 kind text not null, reason text not null, actor_id uuid not null, result jsonb not null,
 created_at timestamptz not null default now()
);
create unique index brain_one_warning_per_alert on public.brain_solution_actions(alert_id,occurrence,kind) where kind='warn';
alter table public.trader_entry_pauses enable row level security;
alter table public.trader_service_notices enable row level security;
alter table public.trade_similarity_reviews enable row level security;
alter table public.brain_solution_actions enable row level security;
revoke all on public.trader_entry_pauses,public.trader_service_notices,public.trade_similarity_reviews,public.brain_solution_actions from public,anon,authenticated;
grant select,insert,update on public.trader_entry_pauses,public.trade_similarity_reviews to service_role;
grant select,insert on public.trader_service_notices,public.brain_solution_actions to service_role;

create function public.brain_notice_push() returns trigger language plpgsql security definer set search_path='' as $$
declare who uuid;
begin
 for who in select distinct user_id from public.trading_accounts where public.ab_person_of(user_id)=new.person_id loop
  perform realtime.send(jsonb_build_object('t','trader_service_notices','op','insert'),'changed','acct:'||who::text,true);
 end loop;
 return null;
exception when others then return null; -- durable notice still arrives through normal state refresh
end;$$;
create trigger trader_notices_push after insert on public.trader_service_notices for each row execute function public.brain_notice_push();
revoke all on function public.brain_notice_push() from public,anon,authenticated;

create function public.brain_trader_controls(p_user uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('paused',coalesce((select active from public.trader_entry_pauses where person_id=public.ab_person_of(p_user)),false),
 'reason',(select reason from public.trader_entry_pauses where person_id=public.ab_person_of(p_user) and active),
 'notices',coalesce((select jsonb_agg(x order by x.created_at desc) from
  (select id,title,message,kind,created_at from public.trader_service_notices
   where person_id=public.ab_person_of(p_user) order by created_at desc limit 30) x),'[]'::jsonb));
$$;

-- A transaction lock serialises the pause with new entries, including entries
-- through a duplicate identity or a newly created practice account.
create function public.fn_guard_team_entry_pause() returns trigger
language plpgsql security definer set search_path='' as $$
declare person uuid; who uuid;
begin
 if TG_TABLE_NAME='trades' then
  if TG_OP='INSERT' and new.status<>'open' then return new; end if;
  if TG_OP='UPDATE' and not(new.status='open' and
    (new.volume>old.volume or new.open_price is distinct from old.open_price)) then return new; end if;
 else
  if TG_OP='UPDATE' or new.status<>'pending' then return new; end if;
 end if;
 select user_id into who from public.trading_accounts where id=new.account_id;
 person:=public.ab_person_of(who);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('team-entry:'||person::text,0));
 if exists(select 1 from public.trader_entry_pauses where person_id=person and active) then
  raise exception 'TRADER_PAUSED: New entries are paused for review. Existing positions can be closed.' using errcode='P0001';
 end if;
 return new;
end;
$$;
create trigger team_entry_pause_trade before insert or update on public.trades for each row execute function public.fn_guard_team_entry_pause();
create trigger team_entry_pause_pending before insert on public.pending_orders for each row execute function public.fn_guard_team_entry_pause();

-- Root positions only. Match both entry and final exit; one-to-one matching
-- prevents a burst of tickets or partial exits multiplying the evidence.
create index if not exists trades_similarity_closed on public.trades(symbol,side,opened_at)
 where status='closed' and parent_trade_id is null;
create function public.trade_similarity_scan() returns jsonb
language plpgsql security definer set search_path='' as $$
declare count_found int; started timestamptz:=clock_timestamp();
begin
 with roots as materialized (
  select t.id,public.ab_person_of(a.user_id) person,t.symbol,t.side,t.opened_at,t.closed_at,t.volume,t.open_price,t.sl,t.tp,
   floor(extract(epoch from t.opened_at)/5)::bigint bucket
  from public.trades t join public.trading_accounts a on a.id=t.account_id
  where t.parent_trade_id is null and t.status='closed' and t.closed_at is not null
   and t.opened_at>=now()-interval '7 days' and t.closed_at<=now()
   and a.phase<>'demo' and a.challenge_type in('infinity','traditional','futures','pac')
 ), totals as(select person,count(*) n from roots group by person), expanded as (
  select r.*,candidate_bucket from roots r cross join lateral unnest(array[r.bucket-1,r.bucket,r.bucket+1]) candidate_bucket
 ), candidates as (
  select a.person pa,b.person pb,a.id ia,b.id ib,a.opened_at,b.closed_at,
   a.symbol,a.side,a.volume va,b.volume vb,a.sl sla,b.sl slb,a.tp tpa,b.tp tpb,
   abs(extract(epoch from a.opened_at-b.opened_at)) entry_s,
   abs(extract(epoch from a.closed_at-b.closed_at)) exit_s,
   row_number() over(partition by a.person,b.person,a.id order by abs(extract(epoch from a.opened_at-b.opened_at)),b.id) ra,
   row_number() over(partition by a.person,b.person,b.id order by abs(extract(epoch from a.opened_at-b.opened_at)),a.id) rb
  from expanded a join roots b on b.bucket=a.candidate_bucket and a.person<b.person and a.symbol=b.symbol and a.side=b.side
   and b.opened_at between a.opened_at-interval '5 seconds' and a.opened_at+interval '5 seconds'
   and b.closed_at between a.closed_at-interval '10 seconds' and a.closed_at+interval '10 seconds'
 ), matched as(select * from candidates where ra=1 and rb=1), grouped as (
  select pa,pb,count(*) n,count(distinct (opened_at at time zone 'UTC')::date) days,
   count(distinct date_trunc('hour',opened_at)) sessions,max(greatest(opened_at,closed_at)) latest,
   (array_agg(jsonb_build_object('source_trade',ia,'peer_trade',ib,'symbol',symbol,'side',side,
     'opened_at',opened_at,'entry_gap_s',entry_s,'exit_gap_s',exit_s,
     'source_lots',va,'peer_lots',vb,'source_sl',sla,'peer_sl',slb,'source_tp',tpa,'peer_tp',tpb)
     order by opened_at desc))[1:12] evidence
  from matched group by pa,pb
 ) insert into public.trade_similarity_reviews(person_a,person_b,matches,matched_days,share,evidence,latest_match)
 select g.pa,g.pb,g.n,g.days,g.n::numeric/least(a.n,b.n),to_jsonb(g.evidence),g.latest
 from grouped g join totals a on a.person=g.pa join totals b on b.person=g.pb
 where g.n>=5 and g.days>=2 and g.sessions>=3 and g.n::numeric/least(a.n,b.n)>=0.6
 on conflict(person_a,person_b) do update set matches=excluded.matches,matched_days=excluded.matched_days,
  share=excluded.share,evidence=excluded.evidence,latest_match=excluded.latest_match,updated_at=now();
 get diagnostics count_found=row_count;
 insert into public.ab_heartbeats(worker,ok,at,detail)values('trade-similarity',true,now(),jsonb_build_object('pairs',count_found,'ms',extract(epoch from clock_timestamp()-started)*1000))
 on conflict(worker)do update set ok=true,at=excluded.at,detail=excluded.detail;
 return jsonb_build_object('pairs',count_found,'as_of',now());
end;
$$;

create function public.ab_owner_alert_solution(p_alert bigint,p_kind text,p_reason text,p_actor uuid,p_request uuid,p_occurrence timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.ab_alerts; previous public.brain_solution_actions; result jsonb; person uuid; peer uuid;
begin
 if not exists(select 1 from public.admins where user_id=p_actor) then raise exception 'ADMIN_REQUIRED'; end if;
 if p_request is null or p_kind not in('warn','pause','pause_pair','resume','halt_books','clear_similarity')
  or length(btrim(p_reason)) not between 5 and 500 then raise exception 'INVALID_ACTION'; end if;
 select * into previous from public.brain_solution_actions where request_id=p_request;
 if found then
  if previous.alert_id<>p_alert or previous.kind<>p_kind or previous.actor_id<>p_actor or previous.occurrence is distinct from p_occurrence or previous.reason<>btrim(p_reason) then raise exception 'REQUEST_CONFLICT'; end if;
  return previous.result;
 end if;
 select * into a from public.ab_alerts where id=p_alert for update;
 if not found or a.resolved_at is not null or a.first_seen is distinct from p_occurrence then
  return jsonb_build_object('ok',false,'error','Alert changed or resolved. Refresh before acting.'); end if;
 if p_kind='warn' then
  select * into previous from public.brain_solution_actions where alert_id=p_alert and occurrence=p_occurrence and kind=p_kind;
  if found then return previous.result; end if;
 end if;
 person:=a.person_id;
 if p_kind in('warn','pause','resume') and person is null then raise exception 'TRADER_REQUIRED'; end if;
 if p_kind='resume' and a.key not like 'rules:team-pause:%' then raise exception 'RESUME_NOT_ALLOWED'; end if;
 if p_kind='halt_books' and a.category not in('book','money','system') then raise exception 'HALT_NOT_ALLOWED'; end if;
 if p_kind='clear_similarity' and a.key not like 'rules:similarity:%' then raise exception 'REVIEW_NOT_ALLOWED'; end if;
 if p_kind='pause_pair' then
  select person_b into peer from public.trade_similarity_reviews where a.key='rules:similarity:'||id::text and person_a=person;
  if peer is null then raise exception 'PAIR_PAUSE_NOT_ALLOWED'; end if;
 end if;
 if person is not null then
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('team-entry:'||person::text,0));
 end if;
 if peer is not null then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('team-entry:'||peer::text,0)); end if;
 if p_kind='warn' then
  insert into public.trader_service_notices(person_id,title,message,kind,actor_id)
   values(person,'Strict rule warning',btrim(p_reason),'warning',p_actor);
 elsif p_kind in('pause','pause_pair') then
  insert into public.trader_entry_pauses(person_id,reason,actor_id) values(person,btrim(p_reason),p_actor)
   on conflict(person_id) do update set active=true,reason=excluded.reason,actor_id=p_actor,updated_at=now();
  update public.pending_orders p set status='cancelled',resolved_at=now() where p.status='pending'
   and exists(select 1 from public.trading_accounts t where t.id=p.account_id and public.ab_person_of(t.user_id)=person);
  insert into public.trader_service_notices(person_id,title,message,kind,actor_id)
   values(person,'New trades paused for review',btrim(p_reason)||' You can still close existing positions. Contact enquiries@ipfxcapital.com for review.','pause',p_actor);
  if peer is not null then
   insert into public.trader_entry_pauses(person_id,reason,actor_id) values(peer,btrim(p_reason),p_actor)
    on conflict(person_id) do update set active=true,reason=excluded.reason,actor_id=p_actor,updated_at=now();
   update public.pending_orders p set status='cancelled',resolved_at=now() where p.status='pending'
    and exists(select 1 from public.trading_accounts t where t.id=p.account_id and public.ab_person_of(t.user_id)=peer);
   insert into public.trader_service_notices(person_id,title,message,kind,actor_id)
    values(peer,'New trades paused for review',btrim(p_reason)||' You can still close existing positions. Contact enquiries@ipfxcapital.com for review.','pause',p_actor);
  end if;
 elsif p_kind='resume' then
  update public.trader_entry_pauses set active=false,reason=btrim(p_reason),actor_id=p_actor,updated_at=now() where person_id=person and active;
  insert into public.trader_service_notices(person_id,title,message,kind,actor_id)
   values(person,'Team entry pause removed',btrim(p_reason)||' Existing challenge breaches and other restrictions still apply.','resume',p_actor);
 elsif p_kind='halt_books' then
  update public.ab_settings set book_halt=true;
 elsif p_kind='clear_similarity' then
  update public.trade_similarity_reviews set reviewed_through=latest_match,review_note=btrim(p_reason),reviewed_by=p_actor
   where a.key='rules:similarity:'||id::text;
  if not found then raise exception 'REVIEW_NOT_FOUND'; end if;
 end if;
 result:=jsonb_build_object('ok',true,'kind',p_kind,'person_id',person,
  'message',case p_kind when 'warn' then 'Warning saved to the trader inbox. No extra automatic strike added.'
  when 'pause' then 'New entries paused; resting orders cancelled. Existing positions can still close.'
  when 'pause_pair' then 'Both traders paused for review; resting orders cancelled. No misconduct verdict applied.'
  when 'resume' then 'Team entry pause removed; other restrictions remain.'
  when 'halt_books' then 'New book risk halted; existing positions still close.' else 'Matching-trade evidence reviewed. No fraud verdict or challenge failure applied.' end);
 insert into public.brain_solution_actions(request_id,alert_id,occurrence,kind,reason,actor_id,result)
  values(p_request,p_alert,p_occurrence,p_kind,btrim(p_reason),p_actor,result);
 insert into public.admin_audit_log(actor_id,action,target_user_id,detail)
  values(p_actor,'brain_alert_solution',person,jsonb_build_object('alert',p_alert,'kind',p_kind,'reason',btrim(p_reason),'request',p_request,'peer',peer));
 -- Seen is not resolved. A warning or pause does not claim the underlying fault was fixed.
 update public.ab_alerts set acknowledged_at=now(),acknowledged_by=p_actor where id=p_alert;
 return result;
end;
$$;

-- Extend the currently installed scan without replacing other agents' alert
-- types. Stop installation if its known insertion point has changed.
do $extend$
declare definition text; anchor text:='insert into public.ab_alerts as a (key, severity, category, title, detail, person_id, value)';
 addition text:=$addition$
 insert into _alert_now
 select 'system:trade-similarity','critical','system','Matching-trade checks are not updating',
  'The last successful matching-trade scan is missing or over five minutes old. Checks are scheduled every minute; review the worker before relying on matching-trade coverage.',null,null
 where not exists(select 1 from public.ab_heartbeats where worker='trade-similarity' and ok and at>now()-interval '5 minutes') on conflict(key)do nothing;
 insert into _alert_now
 select 'rules:similarity:'||r.id::text,'warning','rules','Repeated matching trades need review',
  r.matches||' matched opens and exits across '||r.matched_days||' days; '||round(r.share*100)||'% of the smaller trade stream. Open both traders and review the evidence; this is not proof of cheating.',r.person_a,r.matches
 from public.trade_similarity_reviews r where r.latest_match>now()-interval '7 days'
  and (r.reviewed_through is null or r.latest_match>r.reviewed_through) on conflict(key) do nothing;
 insert into _alert_now
 select 'rules:team-pause:'||p.person_id::text,'warning','rules','Trader new entries are paused',p.reason,p.person_id,null
 from public.trader_entry_pauses p where p.active on conflict(key) do nothing;
 $addition$;
begin
 definition:=pg_get_functiondef('public.ab_alerts_scan()'::regprocedure);
 if strpos(definition,anchor)=0 then raise exception 'ALERT_SCAN_DRIFT: insertion point changed'; end if;
 execute replace(definition,anchor,addition||E'\n'||anchor);
end;
$extend$;
revoke all on function public.brain_trader_controls(uuid),public.trade_similarity_scan(),public.ab_owner_alert_solution(bigint,text,text,uuid,uuid,timestamptz),public.fn_guard_team_entry_pause() from public,anon,authenticated;
grant execute on function public.brain_trader_controls(uuid),public.trade_similarity_scan(),public.ab_owner_alert_solution(bigint,text,text,uuid,uuid,timestamptz) to service_role;
do $$ begin
 if exists(select 1 from pg_extension where extname='pg_cron') then
  perform cron.schedule('ipfx-trade-similarity','* * * * *','set statement_timeout = ''5s''; select public.trade_similarity_scan();');
 end if;
end $$;
commit;
