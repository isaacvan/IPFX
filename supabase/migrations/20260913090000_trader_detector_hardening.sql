-- Transactional detector persistence and independently bound decision evidence.
begin;

create table public.trader_detector_scan_control (
  singleton boolean primary key default true check(singleton),
  after_account_id uuid,
  lease_token uuid,
  lease_expires_at timestamptz
);
insert into public.trader_detector_scan_control(singleton) values(true);
alter table public.trader_detector_scan_control enable row level security;
alter table public.trader_detector_scan_control force row level security;
revoke all on public.trader_detector_scan_control from public,anon,authenticated,service_role;
create function public.trader_detector_claim_scan() returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.trader_detector_scan_control;
begin
  select * into s from public.trader_detector_scan_control where singleton for update;
  if s.lease_expires_at>clock_timestamp() then return null; end if;
  update public.trader_detector_scan_control set lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '10 minutes'
    where singleton returning * into s;
  return jsonb_build_object('lease_token',s.lease_token,'after_account_id',s.after_account_id);
end $$;
create function public.trader_detector_finish_scan(p_lease_token uuid,p_after_account_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  update public.trader_detector_scan_control set after_account_id=p_after_account_id,lease_token=null,lease_expires_at=null
    where singleton and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
  if not found then raise exception 'SCAN_LEASE_LOST'; end if;
end $$;
revoke all on function public.trader_detector_claim_scan() from public,anon,authenticated;
revoke all on function public.trader_detector_finish_scan(uuid,uuid) from public,anon,authenticated;
grant execute on function public.trader_detector_claim_scan() to service_role;
grant execute on function public.trader_detector_finish_scan(uuid,uuid) to service_role;

alter table public.trader_detector_states
  add column data_status text not null default 'OK' check(data_status in ('OK','ERROR')),
  add column last_error text,
  add column last_checked_at timestamptz not null default now();

alter table public.trades
  add column if not exists pnl_basis text check(pnl_basis in ('NET_AFTER_COSTS','GROSS_BEFORE_COSTS')),
  add column if not exists detector_stage integer check(detector_stage > 0);

-- A policy status alone is not evidence of predictive calibration.
create table public.trader_detector_calibrations (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.trader_detector_policy_versions(id),
  model_sha256 text not null check(model_sha256 ~ '^[0-9a-f]{64}$'),
  outcome_definition text not null check(length(outcome_definition) >= 20),
  horizon_days integer not null check(horizon_days > 0),
  training_cutoff_at timestamptz not null,
  validation_start_at timestamptz not null,
  validation_end_at timestamptz not null,
  sample_count integer not null check(sample_count > 0),
  metrics jsonb not null check(jsonb_typeof(metrics) = 'object'),
  evidence_sha256 text not null check(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  validation_reference text not null check(length(validation_reference) > 0),
  trader_holdout_verified boolean not null,
  prospective_verified boolean not null,
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null,
  expires_at timestamptz not null,
  check(training_cutoff_at < validation_start_at and validation_start_at < validation_end_at),
  check(validation_end_at <= approved_at and approved_at < expires_at),
  check(trader_holdout_verified and prospective_verified),
  created_at timestamptz not null default now()
);

create table public.trader_detector_forecasts (
  id uuid primary key default gen_random_uuid(),
  calibration_id uuid not null references public.trader_detector_calibrations(id),
  trading_account_id uuid not null references public.trading_accounts(id),
  policy_id uuid not null references public.trader_detector_policy_versions(id),
  input_sha256 text not null check(input_sha256 ~ '^[0-9a-f]{64}$'),
  source_cutoff_at timestamptz not null,
  predicted_at timestamptz not null,
  expires_at timestamptz not null,
  probability numeric(12,10) not null check(probability between 0 and 1),
  created_at timestamptz not null default now(),
  check(source_cutoff_at <= predicted_at and predicted_at < expires_at)
);

-- Risk evidence must reconcile open positions and transfers, not just closed PnL.
create table public.trader_detector_risk_reviews (
  id uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_accounts(id),
  policy_id uuid not null references public.trader_detector_policy_versions(id),
  input_sha256 text not null check(input_sha256 ~ '^[0-9a-f]{64}$'),
  source_cutoff_at timestamptz not null,
  as_of_at timestamptz not null,
  expires_at timestamptz not null,
  reconciled boolean not null,
  complete_history boolean not null,
  open_positions_marked boolean not null,
  cash_flows_reconciled boolean not null,
  rule_breach boolean not null,
  equity numeric(20,6) not null,
  daily_floor numeric(20,6) not null check(daily_floor>=0),
  total_floor numeric(20,6) not null check(total_floor>=0),
  stressed_open_loss numeric(20,6) not null check(stressed_open_loss>=0),
  rule_snapshot_id uuid not null references public.a_book_rule_snapshots(id),
  evidence_reference text not null check(length(evidence_reference) > 0),
  audit_sha256 text not null check(audit_sha256 ~ '^[0-9a-f]{64}$'),
  verified_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check(source_cutoff_at <= as_of_at and as_of_at < expires_at)
);

alter table public.trader_detector_assessments
  add column input_sha256 text check(input_sha256 ~ '^[0-9a-f]{64}$'),
  add column forecast_id uuid references public.trader_detector_forecasts(id),
  add column risk_review_id uuid references public.trader_detector_risk_reviews(id),
  add column copy_review_id uuid references public.trader_detector_copyability_snapshots(id),
  add column calibrated_future_probability numeric(12,10) check(calibrated_future_probability between 0 and 1);

create or replace function public.trader_detector_assessment_guard()
returns trigger language plpgsql set search_path = '' as $$
declare p public.trader_detector_policy_versions; a public.trading_accounts;
  f public.trader_detector_forecasts; c public.trader_detector_calibrations;
  r public.trader_detector_risk_reviews; cp public.trader_detector_copyability_snapshots; g text;
begin
  select * into p from public.trader_detector_policy_versions where id=new.policy_id;
  select * into a from public.trading_accounts where id=new.trading_account_id;
  if a.user_id is distinct from new.user_id or a.challenge_type is distinct from p.challenge_type then
    raise exception 'DETECTOR_ACCOUNT_POLICY_IDENTITY_MISMATCH';
  end if;
  if new.probability_status='CALIBRATED' then
    raise exception 'DESCRIPTIVE_POSTERIOR_IS_NOT_CALIBRATED_FORECAST';
  end if;
  if new.as_of_at > clock_timestamp()+interval '1 minute' then raise exception 'FUTURE_ASSESSMENT'; end if;
  if new.forecast_id is not null then
    select * into f from public.trader_detector_forecasts where id=new.forecast_id;
    select * into c from public.trader_detector_calibrations where id=f.calibration_id;
    if f.trading_account_id is distinct from new.trading_account_id or f.policy_id is distinct from new.policy_id
      or c.policy_id is distinct from new.policy_id or c.model_sha256 is distinct from lower(p.model_sha256)
      or f.input_sha256 is distinct from new.input_sha256 or f.source_cutoff_at is distinct from new.source_cutoff_at
      or f.predicted_at > new.as_of_at or f.expires_at <= new.as_of_at
      or c.approved_at > f.predicted_at or c.expires_at <= new.as_of_at
      or c.training_cutoff_at is distinct from p.training_cutoff_at then
      raise exception 'FORECAST_EVIDENCE_BINDING_INVALID';
    end if;
    new.calibrated_future_probability:=f.probability;
  elsif new.calibrated_future_probability is not null then raise exception 'FORECAST_REQUIRED';
  end if;
  if new.state in ('PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED') then
    if p.status <> 'VALIDATED' or new.forecast_id is null or new.risk_review_id is null
      or new.input_sha256 is null or f.probability < (p.thresholds->>'minConfirmedProbability')::numeric then
      raise exception 'VALIDATED_FORECAST_AND_RISK_EVIDENCE_REQUIRED';
    end if;
    select * into r from public.trader_detector_risk_reviews where id=new.risk_review_id;
    if r.trading_account_id is distinct from new.trading_account_id or r.policy_id is distinct from new.policy_id or r.input_sha256 is distinct from new.input_sha256
      or r.source_cutoff_at is distinct from new.source_cutoff_at or r.as_of_at > new.as_of_at
      or not r.reconciled or not r.complete_history or not r.open_positions_marked or not r.cash_flows_reconciled
      or r.rule_breach or r.equity-r.stressed_open_loss<=greatest(r.daily_floor,r.total_floor)
      or r.expires_at <= new.as_of_at or not exists(select 1 from public.a_book_rule_snapshots s
        where s.id=r.rule_snapshot_id and s.trading_account_id=new.trading_account_id and s.effective_at<=new.source_cutoff_at) then
      raise exception 'RISK_EVIDENCE_BINDING_INVALID';
    end if;
    if a.status='breached' then raise exception 'BREACHED_ACCOUNT_CANNOT_CONFIRM'; end if;
    foreach g in array array['accounting_basis','mark_to_market_risk','rule_snapshot','trade_stage_provenance','no_critical_risk',
      'validation_evidence','data_quality','confirmed_effective_evidence','confirmed_days','challenge_stage',
      'positive_stages','regime_coverage','concentration','stability','tail_risk','pac_validation','calibration'] loop
      if not(new.gates @> jsonb_build_array(jsonb_build_object('key',g,'status','PASS'))) then
        raise exception 'CONFIRMATION_GATE_REQUIRED:%',g;
      end if;
    end loop;
  end if;
  if new.state='LIVE_REVIEW_REQUIRED' then
    select * into cp from public.trader_detector_copyability_snapshots where id=new.copy_review_id;
    if cp.id is null or cp.trading_account_id is distinct from new.trading_account_id or
      cp.provenance->>'policy_id' is distinct from new.policy_id::text or
      cp.provenance->>'input_sha256' is distinct from new.input_sha256 or
      cp.as_of_at>new.as_of_at or cp.as_of_at<new.as_of_at-interval '5 minutes' or
      coalesce((cp.provenance->>'expires_at')::timestamptz,new.as_of_at)<=new.as_of_at or
      not coalesce((cp.provenance->>'matched_ideas_complete')::boolean,false) or
      not coalesce((cp.provenance->>'risk_normalised')::boolean,false) or
      coalesce((cp.provenance->>'net_edge_lower90_bps')::numeric,0)<=0 or
      nullif(cp.provenance->>'provider_permission_reference','') is null or
      nullif(cp.provenance->>'reserve_review_reference','') is null or
      nullif(cp.provenance->>'verified_by','') is null or
      not coalesce((cp.provenance->>'audit_sha256')~'^[a-f0-9]{64}$',false) or
      not cp.provider_authorised or not cp.reserve_capacity_available or
      cp.shadow_ideas<(p.thresholds->>'minCopyIdeas')::integer then
      raise exception 'MATCHED_COPY_EVIDENCE_REQUIRED';
    end if;
    foreach g in array array['copyability','portfolio_correlation','provider_authorisation','reserve_capacity'] loop
      if not(new.gates @> jsonb_build_array(jsonb_build_object('key',g,'status','PASS'))) then
        raise exception 'LIVE_REVIEW_GATE_REQUIRED:%',g;
      end if;
    end loop;
  end if;
  return new;
end $$;

-- One transaction owns assessment, current state, and transition alert. Lock the
-- account row because there may be no state row yet. CAS prevents stale workers.
create function public.trader_detector_commit_assessment(p_assessment jsonb,p_expected_assessment_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare n public.trader_detector_assessments; prior public.trader_detector_states;
  existing public.trader_detector_assessments; event_type text; event_severity text; event_count integer:=0;
begin
  n:=jsonb_populate_record(null::public.trader_detector_assessments,p_assessment);
  perform 1 from public.trading_accounts where id=n.trading_account_id for update;
  if not found then raise exception 'DETECTOR_ACCOUNT_NOT_FOUND'; end if;
  select * into prior from public.trader_detector_states where trading_account_id=n.trading_account_id;
  select * into existing from public.trader_detector_assessments where trading_account_id=n.trading_account_id
    and policy_id=n.policy_id and evidence_sha256=n.evidence_sha256;
  if existing.id is not null then
    if existing.id=prior.assessment_id and n.as_of_at>=prior.last_checked_at then
      update public.trader_detector_states set data_status='OK',last_error=null,last_checked_at=n.as_of_at
        where trading_account_id=n.trading_account_id;
    end if;
    return jsonb_build_object('inserted',false,'assessment_id',existing.id,'alerts_queued',0);
  end if;
  if prior.assessment_id is distinct from p_expected_assessment_id then raise exception 'STALE_DETECTOR_STATE'; end if;
  if prior.last_checked_at>n.as_of_at then raise exception 'STALE_DETECTOR_CHECK'; end if;
  if prior.assessment_id is not null and exists(select 1 from public.trader_detector_assessments old
    where old.id=prior.assessment_id and (old.as_of_at>n.as_of_at or old.source_cutoff_at>n.source_cutoff_at)) then
    raise exception 'STALE_DETECTOR_EVIDENCE';
  end if;
  if not exists(select 1 from public.trader_detector_policy_versions where id=n.policy_id
    and status in ('SHADOW_UNCALIBRATED','VALIDATED')) then raise exception 'DETECTOR_POLICY_NOT_CURRENT'; end if;
  n.id:=gen_random_uuid(); n.created_at:=now(); n.live_enabled:=false;
  insert into public.trader_detector_assessments select n.* returning * into n;
  insert into public.trader_detector_states(trading_account_id,assessment_id,state,state_since,previous_state,updated_at)
  values(n.trading_account_id,n.id,n.state,case when prior.state=n.state then prior.state_since else now() end,prior.state,now())
  on conflict(trading_account_id) do update set assessment_id=excluded.assessment_id,state=excluded.state,
    state_since=excluded.state_since,previous_state=excluded.previous_state,updated_at=excluded.updated_at;
  update public.trader_detector_states set data_status='OK',last_error=null,last_checked_at=n.as_of_at
    where trading_account_id=n.trading_account_id;
  if n.state is distinct from prior.state then
    if (prior.state='LIVE_REVIEW_REQUIRED' and n.state<>'LIVE_REVIEW_REQUIRED') or
       (prior.state='PROFITABILITY_CONFIRMED' and n.state in ('HIGH_POTENTIAL','OBSERVE','INSUFFICIENT_EVIDENCE','RISK_NO_GO')) then
      event_type:='RISK_DETERIORATION'; event_severity:='high';
    elsif n.state in ('HIGH_POTENTIAL','PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED') then
      event_type:=n.state;
      event_severity:=case n.state when 'HIGH_POTENTIAL' then 'medium' when 'PROFITABILITY_CONFIRMED' then 'high' else 'critical' end;
    elsif n.state='RISK_NO_GO' or prior.state in ('HIGH_POTENTIAL','PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED') then
      event_type:='RISK_DETERIORATION'; event_severity:=case when n.state='RISK_NO_GO' then 'critical' else 'high' end;
    end if;
  end if;
  if event_type is not null then
    insert into public.trader_detector_alerts(assessment_id,trading_account_id,alert_type,severity,title,body,payload,dedup_key)
    values(n.id,n.trading_account_id,event_type,event_severity,replace(event_type,'_',' '),
      'Review the immutable assessment and evidence before acting. Live trading remains disabled.',
      jsonb_build_object('previous_state',prior.state,'state',n.state,'probability_status',n.probability_status),
      n.id::text||':'||event_type);
    event_count:=1;
  end if;
  return jsonb_build_object('inserted',true,'assessment_id',n.id,'alerts_queued',event_count);
end $$;
revoke all on function public.trader_detector_commit_assessment(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.trader_detector_commit_assessment(jsonb,uuid) to service_role;

create function public.trader_detector_record_failure(p_account_id uuid,p_as_of_at timestamptz,p_error text)
returns void language plpgsql security definer set search_path='' as $$
declare s public.trader_detector_states;
begin
  if p_as_of_at>clock_timestamp()+interval '1 minute' or p_error is null then raise exception 'INVALID_FAILURE_EVENT'; end if;
  perform 1 from public.trading_accounts where id=p_account_id for update;
  if not found then raise exception 'DETECTOR_ACCOUNT_NOT_FOUND'; end if;
  select * into s from public.trader_detector_states where trading_account_id=p_account_id;
  if s.assessment_id is null or s.last_checked_at>p_as_of_at then return; end if;
  update public.trader_detector_states set data_status='ERROR',last_error=left(p_error,500),last_checked_at=p_as_of_at
    where trading_account_id=p_account_id;
  if s.data_status<>'ERROR' and s.state in ('HIGH_POTENTIAL','PROFITABILITY_CONFIRMED','LIVE_REVIEW_REQUIRED') then
    insert into public.trader_detector_alerts(assessment_id,trading_account_id,alert_type,severity,title,body,dedup_key)
      values(s.assessment_id,p_account_id,'RISK_DETERIORATION','critical','Trader assessment unavailable',
      'Evidence scan failed. The previous assessment is no longer current. Inspect worker health.',
      s.assessment_id::text||':scan-failure:'||p_as_of_at::text);
  end if;
end $$;
revoke all on function public.trader_detector_record_failure(uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.trader_detector_record_failure(uuid,timestamptz,text) to service_role;

create index detector_forecast_lookup on public.trader_detector_forecasts(trading_account_id,policy_id,input_sha256,predicted_at desc);
create index detector_risk_lookup on public.trader_detector_risk_reviews(trading_account_id,policy_id,input_sha256,as_of_at desc);
create index detector_state_health on public.trader_detector_states(data_status,last_checked_at,state);
create trigger detector_copy_immutable before update or delete on public.trader_detector_copyability_snapshots
for each row execute function public.trader_detector_reject_assessment_mutation();

create function public.trader_detector_recover_abandoned_runs(p_timeout_minutes integer default 15)
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  if p_timeout_minutes < 5 then raise exception 'INVALID_RUN_TIMEOUT'; end if;
  update public.trader_detector_run_log set status='FAILED',finished_at=now(),
    errors=errors||jsonb_build_array(jsonb_build_object('error','WORKER_TIMEOUT'))
    where status='RUNNING' and started_at<now()-make_interval(mins=>p_timeout_minutes);
  get diagnostics n=row_count; return n;
end $$;
revoke all on function public.trader_detector_recover_abandoned_runs(integer) from public,anon,authenticated;
grant execute on function public.trader_detector_recover_abandoned_runs(integer) to service_role;

do $$ declare t text; begin
  foreach t in array array['trader_detector_calibrations','trader_detector_forecasts','trader_detector_risk_reviews'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('alter table public.%I force row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy owner_read on public.%I for select to authenticated using ((select public.fn_is_admin()))',t);
    execute format('create trigger immutable before update or delete on public.%I for each row execute function public.trader_detector_reject_assessment_mutation()',t);
  end loop;
end $$;
grant select on public.trader_detector_policy_versions,public.trader_detector_pac_validations,
  public.trader_detector_copyability_snapshots,public.trader_detector_assessments,
  public.trader_detector_states,public.trader_detector_alerts,public.trader_detector_run_log to authenticated;
-- No service writer can bypass state/assessment agreement with a direct write.
revoke insert,update,delete on public.trader_detector_states,public.trader_detector_assessments from service_role;

-- Changed inference units require new immutable policies. A validated production
-- policy requires explicit migration review and is never silently replaced.
with retiring as (
  update public.trader_detector_policy_versions set status='RETIRED'
  where version=1 and status='SHADOW_UNCALIBRATED' returning *
)
insert into public.trader_detector_policy_versions(challenge_type,version,status,thresholds,challenge_rule_source)
select challenge_type,2,'SHADOW_UNCALIBRATED',thresholds||
  '{"inferenceUnit":"UTC_TRADING_DAY","minStageDays":5,"minRegimeDays":5}'::jsonb,
  challenge_rule_source from retiring;
commit;
