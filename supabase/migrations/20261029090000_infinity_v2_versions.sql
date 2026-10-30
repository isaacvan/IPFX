-- Build-only foundation. Do not apply or enable until the integration checklist is complete.
begin;
create table public.infinity_rules_versions (
  id text primary key check (id in ('infinity_v1','infinity_v2')),
  rules jsonb not null,
  created_at timestamptz not null default now()
);
insert into public.infinity_rules_versions(id,rules) values
('infinity_v1','{}'),
('infinity_v2','{"group_gap_minutes":15,"min_hold_seconds":300,"score_r_cap":5,"sd_floor":0.5,"sl_strikes_max":3,"stop_deadline_seconds":30,"stop_spread_multiple":8,"stop_pause_seconds":600,"total_risk_multiple":3,"stages":{"1":{"starting_balance":1000,"daily_loss_pct":2.5,"max_drawdown_pct":5,"target_pct":4,"min_counted_trades":20,"stage_score":1.0,"combined_score":null,"best_day_share":0.35,"risk_pct":0.5},"2":{"starting_balance":5000,"daily_loss_pct":2,"max_drawdown_pct":4,"target_pct":7,"min_counted_trades":40,"stage_score":1.65,"combined_score":2.0,"best_day_share":0.35,"risk_pct":0.35},"3":{"starting_balance":10000,"daily_loss_pct":2,"max_drawdown_pct":4,"target_pct":8,"min_counted_trades":50,"stage_score":null,"combined_score":2,"best_day_share":0.3,"risk_pct":0.35},"4":{"starting_balance":25000,"daily_loss_pct":2,"max_drawdown_pct":4,"target_pct":0,"min_counted_trades":0,"stage_score":null,"combined_score":null,"best_day_share":null,"risk_pct":0.25,"performance_window":40,"performance_loss_pct":2}},"reference_max_age_ms":3000,"default_spread_markup":1.15,"max_open_positions":20,"max_pending_orders":20,"order_burst_limit":5,"order_burst_window_seconds":10}');
create table public.infinity_v2_settings (
  singleton boolean primary key default true check(singleton),
  infinity_v2_enabled boolean not null default false,
  cutover_at timestamptz not null default '2026-11-01T00:00:00Z',
  terms_version text,
  -- This build is incomplete. An explicit integration gate prevents accidental activation.
  integration_ready boolean not null default false,
  check (not infinity_v2_enabled or (integration_ready and terms_version is not null))
);
insert into public.infinity_v2_settings(singleton) values(true);
create table public.infinity_v2_pricing_profiles (
  symbol text primary key,
  spread_markup numeric not null default 1.15 check(spread_markup>=1),
  commission_round_turn_per_lot numeric check(commission_round_turn_per_lot>=0),
  min_lot numeric not null default 0.01 check(min_lot>0)
);
insert into public.infinity_v2_pricing_profiles(symbol,min_lot) values('XAUUSD',0.001);

alter table public.trading_accounts
  add column rules_version text references public.infinity_rules_versions(id),
  add column rules_effective_at timestamptz,
  add column infinity_rules_snapshot jsonb;
update public.trading_accounts set rules_version='infinity_v1'
where challenge_type='infinity' and rules_version is null;

create table public.infinity_v2_switches (
  account_id uuid primary key references public.trading_accounts(id),
  user_id uuid not null,
  switched_at timestamptz not null,
  request_id text not null,
  terms_version text not null,
  unique(user_id,request_id)
);

create function public.infinity_v2_assign_version() returns trigger
language plpgsql security definer set search_path='' as $$
declare parent public.trading_accounts; settings public.infinity_v2_settings; stage_rules jsonb;
begin
 if tg_op='UPDATE' then
   if new.rules_version is distinct from old.rules_version then
     if old.rules_version is distinct from 'infinity_v1' or new.rules_version is distinct from 'infinity_v2'
        or not exists(select 1 from public.infinity_v2_switches s where s.account_id=old.id and s.user_id=old.user_id
          and s.switched_at=new.rules_effective_at) then raise exception 'RULES_VERSION_IMMUTABLE';end if;
   elsif new.rules_effective_at is distinct from old.rules_effective_at or new.infinity_rules_snapshot is distinct from old.infinity_rules_snapshot then
     raise exception 'RULES_SNAPSHOT_IMMUTABLE';
   end if;
   return new;
 end if;
 if new.challenge_type is distinct from 'infinity' then return new;end if;
 select * into settings from public.infinity_v2_settings where singleton;
 -- A Stage 1 restart is a new run even when a caller supplies the old parent.
 if new.stage>1 then
   select * into parent from public.trading_accounts where id=new.funded_from_account_id;
   if not found then
     -- Legacy v1 issuance accepted missing lineage. Do not change that behavior
     -- until v2 starts are enabled. v2 never accepts unknown lineage.
     if settings.infinity_v2_enabled then raise exception 'INFINITY_PARENT_REQUIRED';end if;
     new.rules_version:='infinity_v1';
   else
     if (settings.infinity_v2_enabled or parent.rules_version='infinity_v2') and (parent.challenge_type<>'infinity' or parent.user_id is distinct from new.user_id
       or new.stage<>parent.stage+1) then raise exception 'INFINITY_PARENT_REQUIRED';end if;
     new.rules_version:=parent.rules_version;
   end if;
 else
   new.rules_version:=case when settings.infinity_v2_enabled and clock_timestamp()>=settings.cutover_at then 'infinity_v2' else 'infinity_v1' end;
 end if;
 if new.rules_version='infinity_v2' then
   select rules || (rules->'stages'->new.stage::text) into stage_rules from public.infinity_rules_versions where id='infinity_v2';
   if stage_rules is null then raise exception 'V2_RULES_MISSING';end if;
   new.infinity_rules_snapshot:=stage_rules;
   new.rules_effective_at:=clock_timestamp();
 end if;
 return new;
end $$;
create trigger infinity_v2_assign_version before insert or update on public.trading_accounts
for each row execute function public.infinity_v2_assign_version();

create function public.infinity_v2_append_only() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'APPEND_ONLY';end $$;
create trigger infinity_v2_switches_frozen before update or delete on public.infinity_v2_switches
for each row execute function public.infinity_v2_append_only();
create trigger infinity_rules_versions_frozen before update or delete on public.infinity_rules_versions
for each row execute function public.infinity_v2_append_only();

alter table public.trades add column initial_sl numeric, add column initial_sl_at timestamptz, add column initial_risk_usd numeric;
alter table public.trades add constraint infinity_initial_risk_tuple check (
  (initial_sl is null and initial_sl_at is null and initial_risk_usd is null)
  or (initial_sl is not null and initial_sl_at is not null and initial_risk_usd is not null and initial_risk_usd>0)
);
create function public.infinity_v2_initial_risk_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and old.initial_sl is not null and
   (new.initial_sl is distinct from old.initial_sl or new.initial_sl_at is distinct from old.initial_sl_at or new.initial_risk_usd is distinct from old.initial_risk_usd)
 then raise exception 'OPENING_RISK_IMMUTABLE';end if;
 if new.initial_sl_at is not null and (new.initial_sl_at<new.opened_at or new.initial_sl_at>new.opened_at+interval '30 seconds')
 then raise exception 'OPENING_STOP_TOO_LATE';end if;
 return new;
end $$;
create trigger infinity_v2_initial_risk_guard before insert or update on public.trades
for each row execute function public.infinity_v2_initial_risk_guard();

alter table public.infinity_rules_versions enable row level security;
alter table public.infinity_v2_settings enable row level security;
alter table public.infinity_v2_pricing_profiles enable row level security;
alter table public.infinity_v2_switches enable row level security;
revoke all on public.infinity_rules_versions,public.infinity_v2_settings,public.infinity_v2_pricing_profiles,public.infinity_v2_switches from public,anon,authenticated;
grant select on public.infinity_rules_versions,public.infinity_v2_settings,public.infinity_v2_pricing_profiles,public.infinity_v2_switches to service_role;
revoke all on function public.infinity_v2_assign_version(),public.infinity_v2_append_only(),public.infinity_v2_initial_risk_guard() from public,anon,authenticated;
commit;
