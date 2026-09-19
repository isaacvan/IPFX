begin;

create table if not exists public.chart_indicator_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.trading_accounts(id) on delete cascade,
  studies jsonb not null default '[]'::jsonb check (jsonb_typeof(studies) = 'array' and jsonb_array_length(studies) <= 25),
  timeframe text not null check (char_length(timeframe) between 1 and 12),
  chart_style smallint not null check (chart_style between 0 and 20),
  source text not null default 'ipfx_markets' check (source in ('ipfx_markets','setup_import')),
  observed_at timestamptz not null default now()
);
create index if not exists chart_indicator_events_account_time_idx
  on public.chart_indicator_events(account_id, observed_at desc);
create index if not exists chart_indicator_events_user_time_idx
  on public.chart_indicator_events(user_id, observed_at desc);

create table if not exists public.trader_strategy_hypotheses (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.trading_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  cutoff_date date not null,
  family text not null check (family in ('trend_following','mean_reversion','breakout','vwap_scalping','news_event','swing_trend')),
  confidence numeric(6,5) not null check (confidence between 0 and 1),
  evidence jsonb not null default '{}'::jsonb,
  contradictions jsonb not null default '[]'::jsonb,
  model_version text not null default 'strategy-lab-v2',
  created_at timestamptz not null default now(),
  unique(account_id, cutoff_date, family, model_version)
);
create index if not exists trader_strategy_hypotheses_account_cutoff_idx
  on public.trader_strategy_hypotheses(account_id, cutoff_date desc, confidence desc);

create table if not exists public.trader_strategy_paper_plans (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.trading_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  hypothesis_id bigint references public.trader_strategy_hypotheses(id) on delete set null,
  prediction_day date not null,
  family text not null,
  predicted_symbol text,
  predicted_side text check (predicted_side in ('buy','sell','balanced')),
  predicted_session text check (predicted_session in ('Asia','London','Overlap','New York','Off-hours')),
  predicted_trade_count numeric(8,2) not null default 0,
  predicted_sl_distance_pct numeric(12,6),
  predicted_tp_distance_pct numeric(12,6),
  status text not null default 'planned' check (status in ('planned','compared','insufficient_actuals')),
  actual_summary jsonb,
  comparison_score numeric(6,2) check (comparison_score between 0 and 100),
  model_version text not null default 'strategy-lab-v2',
  created_at timestamptz not null default now(),
  compared_at timestamptz,
  unique(account_id, prediction_day, model_version)
);
create index if not exists trader_strategy_paper_plans_due_idx
  on public.trader_strategy_paper_plans(prediction_day, status) where status = 'planned';
create index if not exists trader_strategy_paper_plans_account_idx
  on public.trader_strategy_paper_plans(account_id, prediction_day desc);

create table if not exists public.strategy_lab_runs (
  id bigint generated always as identity primary key,
  run_date date not null,
  model_version text not null,
  accounts_profiled integer not null default 0,
  plans_compared integer not null default 0,
  plans_created integer not null default 0,
  completed_at timestamptz not null default now()
);

alter table public.chart_indicator_events enable row level security;
alter table public.trader_strategy_hypotheses enable row level security;
alter table public.trader_strategy_paper_plans enable row level security;
alter table public.strategy_lab_runs enable row level security;

drop policy if exists "own indicator evidence insert" on public.chart_indicator_events;
create policy "own indicator evidence insert" on public.chart_indicator_events
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.trading_accounts a
      where a.id = account_id and a.user_id = (select auth.uid())
    )
  );

drop policy if exists "own layout insert" on public.user_chart_layouts;
create policy "own layout insert" on public.user_chart_layouts
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "own layout update" on public.user_chart_layouts;
create policy "own layout update" on public.user_chart_layouts
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.chart_indicator_events, public.trader_strategy_hypotheses,
  public.trader_strategy_paper_plans, public.strategy_lab_runs
  from anon, authenticated;
grant insert on public.chart_indicator_events to authenticated;
grant usage, select on sequence public.chart_indicator_events_id_seq to authenticated;
revoke all on public.user_chart_layouts from anon;
revoke delete, truncate, references, trigger on public.user_chart_layouts from authenticated;
grant select, insert, update on public.user_chart_layouts to authenticated;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.run_strategy_lab_daily(p_run_date date default current_date)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_plan public.trader_strategy_paper_plans%rowtype;
  v_account record;
  v_hypothesis_id bigint;
  v_closed integer;
  v_actual integer;
  v_active_days integer;
  v_buy_share numeric;
  v_avg_hold numeric;
  v_med_hold numeric;
  v_avg_sl numeric;
  v_avg_tp numeric;
  v_top_symbol text;
  v_session text;
  v_studies jsonb;
  v_study_text text;
  v_style text;
  v_candidates jsonb;
  v_validation numeric;
  v_score numeric;
  v_symbol_match numeric;
  v_side_match numeric;
  v_session_match numeric;
  v_frequency_match numeric;
  v_risk_match numeric;
  v_profiled integer := 0;
  v_compared integer := 0;
  v_created integer := 0;
begin
  for v_plan in
    select * from public.trader_strategy_paper_plans
    where status = 'planned' and prediction_day < p_run_date
    order by prediction_day, id
  loop
    select count(*)::integer,
           coalesce(avg(case when symbol = v_plan.predicted_symbol then 1 else 0 end),0),
           coalesce(avg(case when side = v_plan.predicted_side then 1 else 0 end),0),
           coalesce(avg(case when
             (v_plan.predicted_session = 'Asia' and extract(hour from opened_at at time zone 'UTC') between 0 and 7) or
             (v_plan.predicted_session = 'London' and extract(hour from opened_at at time zone 'UTC') between 8 and 12) or
             (v_plan.predicted_session = 'Overlap' and extract(hour from opened_at at time zone 'UTC') between 13 and 16) or
             (v_plan.predicted_session = 'New York' and extract(hour from opened_at at time zone 'UTC') between 17 and 21) or
             (v_plan.predicted_session = 'Off-hours' and extract(hour from opened_at at time zone 'UTC') between 22 and 23)
           then 1 else 0 end),0),
           coalesce(avg(case when sl is not null and v_plan.predicted_sl_distance_pct is not null and
             abs(abs(open_price-sl)/nullif(open_price,0)*100-v_plan.predicted_sl_distance_pct) <= greatest(v_plan.predicted_sl_distance_pct*.5,.02)
           then 1 else 0 end),0),
           coalesce(avg(case when tp is not null and v_plan.predicted_tp_distance_pct is not null and
             abs(abs(tp-open_price)/nullif(open_price,0)*100-v_plan.predicted_tp_distance_pct) <= greatest(v_plan.predicted_tp_distance_pct*.5,.02)
           then 1 else 0 end),0)
      into v_actual, v_symbol_match, v_side_match, v_session_match, v_risk_match, v_validation
    from public.trades
    where account_id = v_plan.account_id
      and opened_at >= v_plan.prediction_day::timestamptz
      and opened_at < (v_plan.prediction_day + 1)::timestamptz;

    if v_actual = 0 then
      update public.trader_strategy_paper_plans
      set status = 'insufficient_actuals', actual_summary = jsonb_build_object('trades',0), compared_at = now()
      where id = v_plan.id;
    else
      v_frequency_match := greatest(0, 1 - abs(v_actual-v_plan.predicted_trade_count)/greatest(v_actual,v_plan.predicted_trade_count,1));
      v_risk_match := (v_risk_match + v_validation) / 2;
      v_score := round((v_symbol_match*.25 + v_session_match*.20 +
        case when v_plan.predicted_side='balanced' then .15 else v_side_match*.15 end +
        v_frequency_match*.20 + v_risk_match*.20) * 100, 2);
      update public.trader_strategy_paper_plans
      set status = 'compared', comparison_score = v_score,
          actual_summary = jsonb_build_object(
            'trades',v_actual,'symbol_match',round(v_symbol_match,4),
            'side_match',round(v_side_match,4),'session_match',round(v_session_match,4),
            'frequency_match',round(v_frequency_match,4),'risk_level_match',round(v_risk_match,4)
          ), compared_at = now()
      where id = v_plan.id;
      v_compared := v_compared + 1;
    end if;
  end loop;

  for v_account in select id, user_id from public.trading_accounts
  loop
    select count(*)::integer,
           count(distinct opened_at::date)::integer,
           coalesce(avg(case when side='buy' then 1 else 0 end),.5),
           coalesce(avg(extract(epoch from (closed_at-opened_at))/60),0),
           coalesce(percentile_cont(.5) within group (order by extract(epoch from (closed_at-opened_at))/60),0),
           avg(case when sl is not null then abs(open_price-sl)/nullif(open_price,0)*100 end),
           avg(case when tp is not null then abs(tp-open_price)/nullif(open_price,0)*100 end)
      into v_closed,v_active_days,v_buy_share,v_avg_hold,v_med_hold,v_avg_sl,v_avg_tp
    from public.trades
    where account_id=v_account.id and status='closed' and closed_at is not null
      and opened_at < (p_run_date + 1)::timestamptz;
    if v_closed < 8 then continue; end if;

    select symbol into v_top_symbol from public.trades
    where account_id=v_account.id and status='closed' and opened_at < (p_run_date + 1)::timestamptz
    group by symbol order by count(*) desc, symbol limit 1;
    select case
      when extract(hour from opened_at at time zone 'UTC') between 0 and 7 then 'Asia'
      when extract(hour from opened_at at time zone 'UTC') between 8 and 12 then 'London'
      when extract(hour from opened_at at time zone 'UTC') between 13 and 16 then 'Overlap'
      when extract(hour from opened_at at time zone 'UTC') between 17 and 21 then 'New York'
      else 'Off-hours' end into v_session
    from public.trades where account_id=v_account.id and status='closed'
    group by 1 order by count(*) desc limit 1;

    select coalesce(studies,'[]'::jsonb) into v_studies
    from public.user_chart_layouts where user_id=v_account.user_id;
    v_studies := coalesce(v_studies,'[]'::jsonb);
    v_study_text := lower(v_studies::text);
    select category into v_style from public.trader_style_profiles where account_id=v_account.id;
    select avg(comparison_score)/100 into v_validation from public.trader_strategy_paper_plans
      where account_id=v_account.id and status='compared';

    v_candidates := jsonb_build_array(
      jsonb_build_object('family','trend_following','score',least(.95,.18 +
        case when v_study_text ~ 'maexp|masimple|macd|adx|ichimoku|psar' then .42 else 0 end +
        case when v_buy_share >= .65 or v_buy_share <= .35 then .15 else 0 end +
        case when v_avg_hold between 30 and 1440 then .10 else 0 end),
        'evidence',jsonb_build_object('studies',v_studies,'buy_share',round(v_buy_share,4),'median_hold_minutes',round(v_med_hold,2)),
        'contradictions',case when v_studies='[]'::jsonb then jsonb_build_array('No chart-indicator evidence captured') else '[]'::jsonb end),
      jsonb_build_object('family','mean_reversion','score',least(.95,.18 +
        case when v_study_text ~ 'rsi|bb@|stochastic|cci|william|mf@' then .45 else 0 end +
        case when v_buy_share between .40 and .60 then .12 else 0 end +
        case when v_avg_hold < 360 then .10 else 0 end),
        'evidence',jsonb_build_object('studies',v_studies,'balanced_side_share',round(1-abs(v_buy_share-.5)*2,4),'median_hold_minutes',round(v_med_hold,2)),
        'contradictions','[]'::jsonb),
      jsonb_build_object('family','breakout','score',least(.95,.15 +
        case when v_study_text ~ 'bb@|atr@|adx|pivot|volume' then .40 else 0 end +
        case when v_avg_sl is not null and v_avg_tp is not null then .15 else 0 end),
        'evidence',jsonb_build_object('studies',v_studies,'avg_sl_distance_pct',round(v_avg_sl,4),'avg_tp_distance_pct',round(v_avg_tp,4)),
        'contradictions','[]'::jsonb),
      jsonb_build_object('family','vwap_scalping','score',least(.95,.12 +
        case when v_study_text ~ 'vwap' then .50 else 0 end +
        case when v_med_hold < 30 then .20 else 0 end +
        case when v_style in ('scalper','high_frequency_trader') then .08 else 0 end),
        'evidence',jsonb_build_object('studies',v_studies,'median_hold_minutes',round(v_med_hold,2),'style',coalesce(v_style,'unclassified')),
        'contradictions',case when v_med_hold >= 60 then jsonb_build_array('Holding time is longer than a typical scalp') else '[]'::jsonb end),
      jsonb_build_object('family','news_event','score',least(.95,.10 +
        case when v_style='news_event_trader' then .65 else 0 end),
        'evidence',jsonb_build_object('style',coalesce(v_style,'unclassified'),'macro_source','Trading Economics'),
        'contradictions',case when v_style is distinct from 'news_event_trader' then jsonb_build_array('No repeated high-impact event timing detected') else '[]'::jsonb end),
      jsonb_build_object('family','swing_trend','score',least(.95,.12 +
        case when v_study_text ~ 'maexp|macd|ichimoku' then .35 else 0 end +
        case when v_med_hold >= 240 then .30 else 0 end),
        'evidence',jsonb_build_object('studies',v_studies,'median_hold_minutes',round(v_med_hold,2)),
        'contradictions',case when v_med_hold < 240 then jsonb_build_array('Observed holding period is shorter than a swing profile') else '[]'::jsonb end)
    );

    insert into public.trader_strategy_hypotheses
      (account_id,user_id,cutoff_date,family,confidence,evidence,contradictions,model_version)
    select v_account.id,v_account.user_id,p_run_date,x.family,
      round((case when v_validation is null then x.score else (x.score*3+v_validation*least(v_closed,10))/(3+least(v_closed,10)) end)::numeric,5),
      x.evidence || jsonb_build_object('closed_trades',v_closed,'feature_cutoff',p_run_date),
      x.contradictions,'strategy-lab-v2'
    from jsonb_to_recordset(v_candidates) as x(family text,score numeric,evidence jsonb,contradictions jsonb)
    order by x.score desc limit 3
    on conflict (account_id,cutoff_date,family,model_version) do update
      set confidence=excluded.confidence,evidence=excluded.evidence,contradictions=excluded.contradictions,created_at=now();
    v_profiled := v_profiled + 1;

    select id,family into v_hypothesis_id,v_style
    from public.trader_strategy_hypotheses
    where account_id=v_account.id and cutoff_date=p_run_date and model_version='strategy-lab-v2'
    order by confidence desc limit 1;
    insert into public.trader_strategy_paper_plans
      (account_id,user_id,hypothesis_id,prediction_day,family,predicted_symbol,predicted_side,
       predicted_session,predicted_trade_count,predicted_sl_distance_pct,predicted_tp_distance_pct)
    values (v_account.id,v_account.user_id,v_hypothesis_id,p_run_date+1,v_style,v_top_symbol,
      case when v_buy_share>=.60 then 'buy' when v_buy_share<=.40 then 'sell' else 'balanced' end,
      coalesce(v_session,'Off-hours'),round(v_closed::numeric/greatest(v_active_days,1),2),
      round(v_avg_sl,6),round(v_avg_tp,6))
    on conflict (account_id,prediction_day,model_version) do nothing;
    if found then v_created := v_created + 1; end if;
  end loop;

  insert into public.strategy_lab_runs(run_date,model_version,accounts_profiled,plans_compared,plans_created)
  values (p_run_date,'strategy-lab-v2',v_profiled,v_compared,v_created);
  return jsonb_build_object('run_date',p_run_date,'accounts_profiled',v_profiled,'plans_compared',v_compared,'plans_created',v_created);
end;
$$;

revoke all on function private.run_strategy_lab_daily(date) from public, anon, authenticated;
grant execute on function private.run_strategy_lab_daily(date) to postgres, service_role;

do $$
declare v_job bigint;
begin
  select jobid into v_job from cron.job where jobname='ipfx-strategy-lab-daily';
  if v_job is not null then perform cron.unschedule(v_job); end if;
  perform cron.schedule('ipfx-strategy-lab-daily','10 0 * * *',
    $job$select private.run_strategy_lab_daily(current_date);$job$);
end $$;

select private.run_strategy_lab_daily(current_date);

commit;
