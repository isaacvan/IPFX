-- Individual trader statistics. Pure history helpers never authorize routing.
-- All dollars must be at the SAME size/currency; costs remain cash costs.
-- Population contract: {asof: exact p_asof, rows:[{trader_id,mean,variance,trades,active_days}]}.
-- variance is sampling variance of a person's GROSS MEAN, not trade variance.
-- Bare arrays/keyed objects require config.population_asof=p_asof. Empty/unsafe
-- priors use an explicitly weak ASSUMED prior. Person weighting is equal and
-- focal trader excluded. Caller MUST reconstruct the whole population as of cutoff.
-- No helper can certify a supplied aggregate was actually captured historically.
begin;

-- Student distribution CDF for integer df using the cosine-integral recurrence.
-- Numerical distribution evaluation does NOT make clustered t inference exact.
create or replace function public.ab_e8_trader_t_cdf(x double precision, df integer)
returns double precision language plpgsql immutable strict set search_path to '' as $$
declare theta double precision; s double precision; c double precision;
 j0 double precision; j1 double precision; z0 double precision:=pi()/2; z1 double precision:=1;
 j double precision; z double precision; m integer;
begin
 if df<1 then return null; end if;
 theta:=atan(abs(x)/sqrt(df::double precision)); s:=sin(theta); c:=cos(theta);
 j0:=theta; j1:=s;
 if df=1 then j:=j0; z:=z0;
 elsif df=2 then j:=j1; z:=z1;
 else
  for m in 2..df-1 loop
   j:=s*case when c<=0 or (m-1)*ln(c)<-700 then 0 else power(c,m-1) end/m+(m-1.0)/m*j0; z:=(m-1.0)/m*z0;
   j0:=j1; j1:=j; z0:=z1; z1:=z;
  end loop;
 end if;
 return greatest(0,least(1,.5+case when x<0 then -.5 else .5 end*j/z));
end $$;

create or replace function public.ab_e8_trader_normal_cdf(x double precision)
returns double precision language plpgsql immutable strict set search_path to '' as $$
declare t double precision; tail double precision;
begin
 if abs(x)>38 then return case when x>0 then 1 else 0 end; end if;
 t:=1/(1+.2316419*abs(x));
 tail:=exp(-x*x/2)/sqrt(2*pi())*t*(.319381530+t*(-.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));
 return case when x<0 then tail else 1-tail end;
end
$$;

-- Day cluster sandwich plus nonnegative Bartlett HAC inflation across ordered
-- observed UTC days. Missing calendar days are NOT silently independent resets.
create or replace function public.ab_e8_trader_moments(series jsonb, variance_floor double precision)
returns jsonb language plpgsql immutable set search_path to '' as $$
declare n integer; d integer; mu double precision; vv double precision; total double precision;
 scores double precision[]; base double precision; hac double precision; cross_term double precision;
 bandwidth integer; k integer; i integer; se double precision; cluster_se double precision;
begin
 select count(*)::integer,avg((v->>'v')::double precision),var_samp((v->>'v')::double precision),sum((v->>'v')::double precision)
 into n,mu,vv,total from jsonb_array_elements(series) v;
 select array_agg(score order by day_key),count(*)::integer into scores,d from
 (select v->>'day' as day_key,sum((v->>'v')::double precision-mu) score from jsonb_array_elements(series) v group by 1) q;
 if d>=2 then
  select sum(s*s) into base from unnest(scores) s;
  hac:=base; bandwidth:=least(d-1,greatest(1,floor(4*power(d/100.0,2.0/9))::integer));
  for k in 1..bandwidth loop
   cross_term:=0;
   for i in k+1..d loop cross_term:=cross_term+scores[i]*scores[i-k]; end loop;
   hac:=hac+2*(1-k::double precision/(bandwidth+1))*cross_term;
  end loop;
  cluster_se:=sqrt(greatest(base*d/(d-1.0)/(n::double precision*n),variance_floor/n));
  se:=sqrt(greatest(base,hac)*d/(d-1.0)/(n::double precision*n)+variance_floor/n);
 end if;
 return jsonb_build_object('n',n,'days',d,'mean',mu,'variance',vv,'total',coalesce(total,0),
  'se',se,'cluster_se',cluster_se,'hac_bandwidth',bandwidth);
end $$;

-- Immutable service-only prospective registry. There is no client-supplied
-- `prospective=true` shortcut. Registration starts TOMORROW UTC, at database time.
-- A caller must externally enforce |raw daily A|,|raw daily B|<=bound BEFORE
-- trading; no hindsight winsorization and no clipped-target substitution.
create table if not exists public.ab_e8_trader_processes (
 id bigint generated always as identity primary key,
 trader_id text not null, cell_id text not null, registered_at timestamptz not null default clock_timestamp(),
 first_day date not null, daily_bound double precision not null check(daily_bound>0 and daily_bound<1e100),
 inference_config jsonb not null, bound_evidence text not null,
 activated_at timestamptz, bound_control text, canonical_stream_control text,
 unique(trader_id,cell_id)
);
create table if not exists public.ab_e8_trader_process_days (
 process_id bigint not null references public.ab_e8_trader_processes(id), day date not null,
 recorded_at timestamptz not null default clock_timestamp(), a_net double precision not null,
 b_net double precision not null, valid boolean not null, n integer not null,
 sum_a double precision not null,sum_b double precision not null,
 max_log_e_a double precision not null,max_log_e_b double precision not null,
 primary key(process_id,day)
);
alter table public.ab_e8_trader_processes enable row level security;
alter table public.ab_e8_trader_process_days enable row level security;
revoke all on public.ab_e8_trader_processes,public.ab_e8_trader_process_days from public,anon,authenticated,service_role;

create or replace function public.ab_e8_trader_start(p_trader_id text,p_cell_id text,p_bound double precision,p_config jsonb,p_bound_evidence text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare r public.ab_e8_trader_processes;
begin
 if coalesce(length(p_trader_id),0)=0 or coalesce(length(p_cell_id),0)=0 or
 not coalesce(p_bound>0 and p_bound<1e100,false) or coalesce(length(p_bound_evidence),0)<20 then
  raise exception 'Prospective registration requires trader, cell, fixed enforced raw daily bound and evidence';
 end if;
 insert into public.ab_e8_trader_processes(trader_id,cell_id,first_day,daily_bound,inference_config,bound_evidence)
 values(p_trader_id,p_cell_id,(clock_timestamp() at time zone 'UTC')::date+1,p_bound,coalesce(p_config,'{}')-'anytime_process_id',p_bound_evidence)
 returning * into r;
 return to_jsonb(r)||jsonb_build_object('assumptions','Externally enforced raw daily bound; complete nonoverlapping ordered days; conditional null E[day net | past]<=0. No restart after outcomes.');
end $$;

-- Activation is an explicit service-side AUDIT ATTESTATION, not an inference
-- that a finite bound exists merely because none has yet been breached.
-- Control references must identify (1) the ex ante enforced loss AND profit
-- cap including gaps/slippage/fees for the exact paper strategy, and (2) the
-- canonical day stream and publication/completeness seal. Stop losses or E8's
-- daily loss rule alone do not bound both tails. If those controls do not exist,
-- do not activate. The database cannot independently verify external controls.
create or replace function public.ab_e8_trader_activate(p_process_id bigint,p_bound_control text,p_canonical_stream_control text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare r public.ab_e8_trader_processes;
begin
 if coalesce(length(p_bound_control),0)<20 or coalesce(length(p_canonical_stream_control),0)<20 then
  raise exception 'Activation requires audited bound and canonical complete-stream control references';
 end if;
 update public.ab_e8_trader_processes set activated_at=clock_timestamp(),bound_control=p_bound_control,canonical_stream_control=p_canonical_stream_control
 where id=p_process_id and activated_at is null and clock_timestamp()<(first_day::timestamp at time zone 'UTC') returning * into r;
 if not found then raise exception 'Activation must precede the immutable prospective start and cannot be repeated'; end if;
 return to_jsonb(r)||jsonb_build_object('status','Conditional on externally audited controls; not independently validated by database');
end $$;

-- Append EVERY UTC day in order, including zero-trade days, only after it ends
-- plus 150 seconds. Service caller seals the complete day (all eventual ledger
-- publications); if this cannot be guaranteed, it MUST NOT call append.
-- Hoeffding mixture: E_n=average_l exp(l*S/B-n*l^2/2), l fixed below.
-- Valid under conditional-mean null with raw X in [-B,B]; serial independence
-- is unnecessary. Ville gives anytime p=min(1,exp(-running max log E)).
-- Source: https://arxiv.org/abs/1808.03204 ; https://arxiv.org/abs/1810.08240
create or replace function public.ab_e8_trader_append(p_process_id bigint,p_day date,p_a_net double precision,p_b_net double precision,p_complete boolean)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare r public.ab_e8_trader_processes; prev public.ab_e8_trader_process_days;
 outrow public.ab_e8_trader_process_days; expected date; n integer; sa double precision; sb double precision;
 la double precision; lb double precision; ok boolean;
begin
 select * into strict r from public.ab_e8_trader_processes where id=p_process_id for update;
 if r.activated_at is null then raise exception 'Prospective process needs audited activation before append'; end if;
 select * into prev from public.ab_e8_trader_process_days where process_id=p_process_id order by day desc limit 1;
 expected:=coalesce(prev.day+1,r.first_day);
 if p_day is distinct from expected or not coalesce(p_complete,false) or
  clock_timestamp()<((p_day+1)::timestamp at time zone 'UTC')+interval '150 seconds' then
  raise exception 'Append needs the next complete prospective UTC day, after publication embargo';
 end if;
 if not coalesce(abs(p_a_net)<1e100 and abs(p_b_net)<1e100,false) then raise exception 'Nonfinite daily payoff'; end if;
 if p_a_net+p_b_net>.011 then raise exception 'Canonical A+B must equal negative twice nonnegative costs'; end if;
 ok:=coalesce(prev.valid,true) and abs(p_a_net)<=r.daily_bound and abs(p_b_net)<=r.daily_bound;
 n:=coalesce(prev.n,0)+1; sa:=coalesce(prev.sum_a,0)+p_a_net; sb:=coalesce(prev.sum_b,0)+p_b_net;
 -- Log-sum-exp avoids overflow. A bound breach permanently invalidates this process.
 select max(v) into la from (select l*sa/r.daily_bound-n*l*l/2 v from unnest(array[.015625,.03125,.0625,.125,.25,.5,1.0]) l) z;
 select la+ln(avg(exp(greatest(-700,l*sa/r.daily_bound-n*l*l/2-la)))) into la from unnest(array[.015625,.03125,.0625,.125,.25,.5,1.0]) l;
 select max(v) into lb from (select l*sb/r.daily_bound-n*l*l/2 v from unnest(array[.015625,.03125,.0625,.125,.25,.5,1.0]) l) z;
 select lb+ln(avg(exp(greatest(-700,l*sb/r.daily_bound-n*l*l/2-lb)))) into lb from unnest(array[.015625,.03125,.0625,.125,.25,.5,1.0]) l;
 insert into public.ab_e8_trader_process_days(process_id,day,a_net,b_net,valid,n,sum_a,sum_b,max_log_e_a,max_log_e_b)
 values(p_process_id,p_day,p_a_net,p_b_net,ok,n,sa,sb,greatest(0,coalesce(prev.max_log_e_a,0),la),greatest(0,coalesce(prev.max_log_e_b,0),lb)) returning * into outrow;
 return to_jsonb(outrow)||jsonb_build_object('p_copy',case when ok then exp(greatest(-700,-outrow.max_log_e_a)) end,'p_reverse',case when ok then exp(greatest(-700,-outrow.max_log_e_b)) end);
end $$;

create or replace function public.ab_e8_trader_infer(p_trades jsonb,p_population jsonb,p_config jsonb,p_asof timestamptz)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare cfg jsonb:=coalesce(p_config,'{}'); t jsonb; obs jsonb:='[]'; hist jsonb:='[]'; pop jsonb;
 gs jsonb; aa jsonb; bb jsonb; rs jsonb:='[]'; flags jsonb:='[]'; stability jsonb;
 n integer; observed integer; d integer; embargo double precision; floorvar double precision;
 cost double precision; g double precision; a double precision; b double precision;
 casha double precision:=0; cashb double precision:=0; c double precision; gm double precision;
 sega double precision; sea double precision; seb double precision; crit double precision; lo double precision; hi double precision;
 pcopy double precision; prev double precision; pvca double precision:=1; pvrb double precision:=1;
 prior_n integer:=0; prior_mean double precision:=0; tau double precision; mean_var double precision:=0;
 prior_var double precision; post_var double precision; post_mean double precision; model text;
 model_post_var double precision; weight double precision; cost_se double precision; net_post_se double precision; cs jsonb;
 tier text; cls text:='INSUFFICIENT_DATA'; direction integer:=0; equivalence boolean:=false;
 half_a boolean:=false; half_b boolean:=false; regime_a boolean:=false; regime_b boolean:=false;
 regime_known boolean:=false; regime_json jsonb; favorable double precision; top3 double precision; concentration double precision;
 tail boolean:=false; subminute double precision; trader text; last_entry timestamptz; oldest_entry timestamptz;
 process public.ab_e8_trader_processes; dayrow public.ab_e8_trader_process_days;
 anytime jsonb:=jsonb_build_object('valid',false,'reason','Need immutable prospective registration and externally enforced raw daily net bound; history is descriptive');
 gate_a boolean:=false; gate_b boolean:=false; samplegap bigint; needed numeric;
 historical_p_copy double precision; historical_p_reverse double precision;
 behavior_reset timestamptz; volume_multiple double precision:=coalesce((cfg->>'volume_change_multiple')::double precision,2);
 n_min integer:=coalesce((cfg->>'min_trades')::integer,30);
 n_report integer:=coalesce((cfg->>'reportable_trades')::integer,100);
 n_action integer:=coalesce((cfg->>'actionable_trades')::integer,200);
 days_min integer:=coalesce((cfg->>'min_days')::integer,10);
 stopped_days integer:=coalesce((cfg->>'stopped_days')::integer,14);
begin
 if p_asof is null or jsonb_typeof(coalesce(p_trades,'[]'))<>'array' or jsonb_typeof(cfg)<>'object' then raise exception 'Invalid inference inputs'; end if;
 embargo:=coalesce((cfg->>'embargo_seconds')::double precision,30); floorvar:=coalesce((cfg->>'variance_floor')::double precision,.000001);
 if not(embargo>=30 and embargo<86400 and floorvar>0 and floorvar<1e100 and n_min>=30 and n_report>=greatest(100,n_min)
  and n_action>=greatest(200,n_report) and days_min>=10 and stopped_days>=1 and volume_multiple>=2 and volume_multiple<=10) then raise exception 'Invalid configuration'; end if;
 -- Filter timestamps BEFORE touching outcomes, including malformed future outcomes.
 for t in select value from jsonb_array_elements(coalesce(p_trades,'[]')) loop
  if t->>'available_at' is null or t->>'closed_at' is null or t->>'opened_at' is null then continue; end if;
  if greatest((t->>'available_at')::timestamptz,(t->>'closed_at')::timestamptz+interval '120 seconds')+make_interval(secs=>embargo)>p_asof then continue; end if;
  if t->>'reason' is not null or t->>'gross' is null or t->>'a_net' is null or t->>'b_net' is null then continue; end if;
  if (t->>'opened_at')::timestamptz>(t->>'closed_at')::timestamptz then raise exception 'Trade closes before opening'; end if;
  g:=(t->>'gross')::double precision; a:=(t->>'a_net')::double precision; b:=(t->>'b_net')::double precision;
  -- Missing slippage is zero added slippage, explicitly the preregistered base.
  if t->>'spread' is null or t->>'commission' is null then raise exception 'Missing priced cost'; end if;
  c:=(t->>'spread')::double precision+(t->>'commission')::double precision+coalesce((t->>'slippage')::double precision,0);
  if not(abs(g)<1e100 and abs(a)<1e100 and abs(b)<1e100 and c>=0 and c<1e100)
   or (t->>'spread')::double precision<0 or (t->>'commission')::double precision<0 or coalesce((t->>'slippage')::double precision,0)<0 then raise exception 'Invalid finite payoff/cost'; end if;
  if abs(a-(g-c))>.011 or abs(b-(-g-c))>.011 or abs(a+b+2*c)>.011 then raise exception 'Per-trade A/B cost invariant violated'; end if;
  if trader is null then trader:=t->>'trader_id'; elsif trader is distinct from t->>'trader_id' then raise exception 'Inference requires one trader'; end if;
  t:=t||jsonb_build_object('g',g,'a',a,'b',b,'c',c,'day',((t->>'closed_at')::timestamptz at time zone 'UTC')::date);
  obs:=obs||jsonb_build_array(t); casha:=casha+a; cashb:=cashb+b;
  last_entry:=greatest(last_entry,(t->>'opened_at')::timestamptz); oldest_entry:=least(oldest_entry,(t->>'opened_at')::timestamptz);
  if t->>'ledger_publication_identified' is distinct from 'false' and ((t->>'closed_at')::timestamptz at time zone 'UTC')::date<(p_asof at time zone 'UTC')::date then hist:=hist||jsonb_build_array(t); end if;
 end loop;
 observed:=jsonb_array_length(obs);
 -- A source-size change is visible at entry, independent of its later payoff.
 -- Compare within symbol, against the previous 20 observations only. Old cash
 -- remains visible; infer skill only in the most recent behavior window.
 with h as materialized(select v,row_number() over(order by (v->>'opened_at')::timestamptz,v->>'trade_id') seq from jsonb_array_elements(hist)v)
 select max((cur.v->>'opened_at')::timestamptz) into behavior_reset from h cur
 cross join lateral(select percentile_cont(.5) within group(order by vol) med,count(*) cnt from
 (select (prior.v->>'source_volume')::double precision vol from h prior
 where prior.seq<cur.seq and prior.v->>'symbol'=cur.v->>'symbol' and (prior.v->>'source_volume')::double precision>0
 order by prior.seq desc limit 20)z) baseline
 where baseline.cnt=20 and (cur.v->>'source_volume')::double precision>0 and
 ((cur.v->>'source_volume')::double precision>baseline.med*volume_multiple or
 (cur.v->>'source_volume')::double precision<baseline.med/volume_multiple);
 if behavior_reset is not null then
 select coalesce(jsonb_agg(v),'[]') into hist from jsonb_array_elements(hist)v where (v->>'opened_at')::timestamptz>=behavior_reset;
 flags:=flags||jsonb_build_array('BEHAVIOR_WINDOW_RESET'); rs:=rs||jsonb_build_array('Source lot size changed materially; evidence restarts at '||behavior_reset::text);
 end if;
 n:=jsonb_array_length(hist);
 -- Duplicate ids would otherwise count evidence twice.
 if exists(select 1 from jsonb_array_elements(obs) v where v->>'trade_id' is not null group by v->>'trade_id' having count(*)>1) then raise exception 'Duplicate trade_id'; end if;
 select public.ab_e8_trader_moments(coalesce(jsonb_agg(jsonb_build_object('v',v->'g','day',v->'day')),'[]'),floorvar),
 public.ab_e8_trader_moments(coalesce(jsonb_agg(jsonb_build_object('v',v->'a','day',v->'day')),'[]'),floorvar),
 public.ab_e8_trader_moments(coalesce(jsonb_agg(jsonb_build_object('v',v->'b','day',v->'day')),'[]'),floorvar),avg((v->>'c')::double precision),
 public.ab_e8_trader_moments(coalesce(jsonb_agg(jsonb_build_object('v',v->'c','day',v->'day')),'[]'),floorvar)
 into gs,aa,bb,cost,cs from jsonb_array_elements(hist) v;
 d:=(gs->>'days')::integer; gm:=(gs->>'mean')::double precision;
 sega:=(gs->>'se')::double precision; sea:=(aa->>'se')::double precision; seb:=(bb->>'se')::double precision;
 tier:=case when n<n_min then 'insufficient' when n<n_report then 'provisional' when n<n_action then 'reportable' else 'potential' end;
 rs:=rs||jsonb_build_array('Evidence tier: '||tier);
 if d>=2 then
  lo:=0; hi:=1000;
  for i in 1..55 loop crit:=(lo+hi)/2; if public.ab_e8_trader_t_cdf(crit,d-1)<.975 then lo:=crit; else hi:=crit; end if; end loop;
  crit:=(lo+hi)/2;
 end if;
 -- Exact cutoff match prevents mixing final-fit priors into a historical replay.
 pop:=case when jsonb_typeof(p_population)='object' and p_population ? 'rows' then p_population->'rows' else coalesce(p_population,'[]') end;
 if coalesce((case when p_population ? 'rows' then p_population->>'asof' else cfg->>'population_asof' end)::timestamptz=p_asof,false) then
  if jsonb_typeof(pop)='object' then select coalesce(jsonb_agg(value||jsonb_build_object('trader_id',key)),'[]') into pop from jsonb_each(pop); end if;
  if jsonb_typeof(pop)='array' then
   select count(*)::integer,avg((v->>'mean')::double precision),
    greatest(0,var_samp((v->>'mean')::double precision)-avg((v->>'variance')::double precision)),
    coalesce(var_samp((v->>'mean')::double precision),0)/greatest(count(*),1)+power(avg(sqrt((v->>'variance')::double precision)),2)
   into prior_n,prior_mean,tau,mean_var from jsonb_array_elements(pop) v
   where (v->>'trader_id') is distinct from trader and (v->>'trades')::integer>=30 and (v->>'active_days')::integer>=10
    and abs((v->>'mean')::double precision)<1e100 and (v->>'variance')::double precision>=0 and (v->>'variance')::double precision<1e100;
  end if;
 end if;
 if prior_n>=5 then
  prior_var:=greatest(coalesce(tau,0),floorvar)+coalesce(mean_var,0);
  model:='empirical_bayes_normal_normal_approximation';
 else
  prior_n:=0; prior_mean:=0; mean_var:=0; tau:=null;
  prior_var:=greatest(1000000,100*coalesce((gs->>'variance')::double precision,0));
  model:='weak_prior_normal_normal_approximation';
 end if;
 if sega is not null then
  model_post_var:=1/(1/(sega*sega)+1/prior_var); weight:=prior_var/(prior_var+sega*sega);
  post_mean:=weight*gm+(1-weight)*prior_mean;
  -- No independence gain from peers sharing the focal person's market days.
  -- Worst positive covariance envelope; never report more precision than raw.
  post_var:=greatest(sega*sega,model_post_var+2*weight*(1-weight)*sega*sqrt(prior_var));
  cost_se:=(cs->>'se')::double precision;
  net_post_se:=sqrt(post_var)+cost_se;
  pcopy:=public.ab_e8_trader_normal_cdf((post_mean-cost)/net_post_se);
  prev:=public.ab_e8_trader_normal_cdf((-cost-post_mean)/net_post_se);
  if d>=days_min then
   pvca:=public.ab_e8_trader_t_cdf(-(aa->>'mean')::double precision/sea,d-1);
   pvrb:=public.ab_e8_trader_t_cdf(-(bb->>'mean')::double precision/seb,d-1);
   -- Demonstrated conservative 95% two-sided inclusion in (-cost,+cost)
   -- using BOTH paired net intervals, with measured random costs included.
   equivalence:=(aa->>'mean')::double precision+crit*sea<0 and (bb->>'mean')::double precision+crit*seb<0;
  end if;
 end if;
 select coalesce(bool_and(h.a>0),false),coalesce(bool_and(h.b>0),false) into half_a,half_b from
 (select half,sum((v->>'a')::double precision) a,sum((v->>'b')::double precision) b from
  (select v,case when row_number() over(order by (v->>'closed_at')::timestamptz,v->>'trade_id')<=n/2 then 1 else 2 end half from jsonb_array_elements(hist) v) h group by half) h;
 -- Regimes may only use PRE-outcome labels/cuts frozen before this cutoff.
 -- UTC week/session are deterministic. Volatility labels require provenance.
 with r as (select v,'week' kind,to_char((v->>'opened_at')::timestamptz at time zone 'UTC','IYYY-IW') bucket from jsonb_array_elements(hist) v
 union all select v,'session',floor(extract(hour from (v->>'opened_at')::timestamptz at time zone 'UTC')/8)::text from jsonb_array_elements(hist) v
 union all select v,'volatility',v->>'volatility_regime' from jsonb_array_elements(hist) v),
 buckets as(select kind,bucket,count(*) cnt,avg((v->>'a')::double precision) a,avg((v->>'b')::double precision) b from r where bucket is not null group by 1,2),
 kinds as(select kind,count(*) buckets,min(cnt) min_n,bool_and(buckets.a>0) a,bool_and(buckets.b>0) b from buckets group by kind)
 select coalesce(jsonb_object_agg(kind,jsonb_build_object('buckets',buckets,'min_trades',min_n,'copy_positive',kinds.a,'reverse_positive',kinds.b)),'{}'),
 coalesce(bool_and(kinds.a),false),coalesce(bool_and(kinds.b),false),count(*)=3 and coalesce(bool_and(min_n>=5 and buckets>=case when kind='week' then 2 else 3 end),false)
 into regime_json,regime_a,regime_b,regime_known from kinds;
 regime_known:=regime_known and (coalesce((cfg->>'regime_asof')::timestamptz<=p_asof,false) or
 coalesce((select avg(case when v->>'volatility_regime' is not null and (v->>'regime_label_at')::timestamptz<=(v->>'opened_at')::timestamptz then 1.0 else 0 end)>=.9 from jsonb_array_elements(hist)v),false));
 direction:=case when gm>cost then 1 when gm < -cost then -1 else 0 end;
 select sum(greatest(0,direction*(v->>'g')::double precision)) into favorable from jsonb_array_elements(hist) v;
 select sum(x) into top3 from (select greatest(0,direction*(v->>'g')::double precision) x from jsonb_array_elements(hist) v order by x desc limit 3) z;
 concentration:=top3/nullif(favorable,0); tail:=coalesce(concentration>.5,false);
 select avg(case when (v->>'hold_s')::double precision<60 then 1.0 else 0 end) into subminute from jsonb_array_elements(hist) v;
 if tail then flags:=flags||jsonb_build_array('TOP_THREE_CONCENTRATION'); end if;
 if not regime_known then flags:=flags||jsonb_build_array('REGIME_SUPPORT_UNKNOWN'); end if;
 if exists(select 1 from jsonb_array_elements(hist) v where v->>'risk_b_net' is null) then flags:=flags||jsonb_build_array('RISK_PRESERVING_REVERSE_UNAVAILABLE'); end if;
 if cfg ? 'anytime_process_id' then
  select * into process from public.ab_e8_trader_processes where id=(cfg->>'anytime_process_id')::bigint and registered_at<=p_asof and trader_id=trader and cell_id=coalesce(cfg->>'cell_id','base') and inference_config=cfg-'anytime_process_id';
  if found and (behavior_reset is null or process.registered_at>=behavior_reset) then
   select * into dayrow from public.ab_e8_trader_process_days where process_id=process.id and recorded_at<=p_asof order by day desc limit 1;
   if found then anytime:=jsonb_build_object('valid',dayrow.valid,'process_id',process.id,'registered_at',process.registered_at,'days',dayrow.n,
    'p_copy',case when dayrow.valid then exp(greatest(-700,-dayrow.max_log_e_a)) end,'p_reverse',case when dayrow.valid then exp(greatest(-700,-dayrow.max_log_e_b)) end,
   'target','raw bounded UTC day net; conditional-mean null, not clipped returns',
    'verification','Conditional on service-audited external bound and canonical stream controls; database does not verify external enforcement',
    'daily_bound',process.daily_bound,'assumptions','Externally enforced bound; complete sealed days; no outcome-based restart; conditional day net mean <=0 under null'); end if;
  end if;
 end if;
 gate_a:=n>=n_action and d>=days_min and half_a and regime_known and regime_a and not tail and coalesce(subminute,0)<=.5
  and coalesce((anytime->>'valid')::boolean,false) and coalesce((anytime->>'days')::integer,0)>=days_min
  and coalesce(post_mean-cost-1.96*net_post_se>0,false);
 gate_b:=n>=n_action and d>=days_min and half_b and regime_known and regime_b and not tail and coalesce(subminute,0)<=.5
  and coalesce((anytime->>'valid')::boolean,false) and coalesce((anytime->>'days')::integer,0)>=days_min
  and coalesce(-post_mean-cost-1.96*net_post_se>0,false);
 historical_p_copy:=pvca; historical_p_reverse:=pvrb;
 -- Valid prospective processes supply the family test p-values. This avoids
 -- presenting approximate historical t p-values as exact anytime FDR control.
 if coalesce((anytime->>'valid')::boolean,false) then
  pvca:=(anytime->>'p_copy')::double precision; pvrb:=(anytime->>'p_reverse')::double precision;
 end if;
 if n>=n_min and d>=days_min then
  if last_entry<p_asof-make_interval(days=>stopped_days) then cls:='STOPPED_TRADING';
  elsif subminute>.5 then cls:='E8_INCOMPATIBLE';
  elsif tail then cls:='TAIL_RISK';
  elsif direction<>0 and (case when direction=1 then not half_a else not half_b end) then cls:='UNSTABLE';
  elsif equivalence and n>=n_report then cls:='COST_BLED';
  end if;
 end if;
 rs:=rs||jsonb_build_array('Historical clustered inference is approximate; no routing authorization');
 if n<n_action then rs:=rs||jsonb_build_array('Need at least '||n_action||' inference-eligible trades for a candidate'); end if;
 if d<days_min then rs:=rs||jsonb_build_array('Need at least '||days_min||' completed UTC trading days'); end if;
 if not regime_known then rs:=rs||jsonb_build_array('Need supported frozen weeks, sessions and volatility regimes'); end if;
 if not coalesce((anytime->>'valid')::boolean,false) then rs:=rs||jsonb_build_array(anytime->>'reason'); end if;
 if cls='INSUFFICIENT_DATA' then rs:=rs||jsonb_build_array('No demonstrated equivalence or complete directional evidence gates'); end if;
 -- Power is descriptive at observed serial inflation and edge, not a promise.
 if sega is not null and abs(gm)-cost>0 then
  needed:=ceil(power(1.96*(case when gm>0 then sea else seb end)*sqrt(n)/(abs(gm)-cost),2));
  samplegap:=greatest(0,least(needed,2147483647)-n)::bigint;
 end if;
 stability:=jsonb_build_object('halves',jsonb_build_object('copy_positive',half_a,'reverse_positive',half_b),'regimes',regime_json,'supported',regime_known);
 return jsonb_build_object('trader_id',trader,'trades',observed,'inference_trades',n,'active_days',d,'a_net',casha,'b_net',cashb,
  'a_interval',case when sea is not null then jsonb_build_array((aa->>'total')::double precision-n*crit*sea,(aa->>'total')::double precision+n*crit*sea) else 'null'::jsonb end,
  'b_interval',case when seb is not null then jsonb_build_array((bb->>'total')::double precision-n*crit*seb,(bb->>'total')::double precision+n*crit*seb) else 'null'::jsonb end,
  'gross_per_trade',gm,'gross_spread_multiple',(select avg((v->>'spread_multiple')::double precision) from jsonb_array_elements(hist) v),'cost_per_trade',cost,
  'p_copy',pcopy,'p_reverse',prev,'pvalue_copy',pvca,'pvalue_reverse',pvrb,'q_copy',null,'q_reverse',null,
  'evidence_class',cls,'reasons',rs,'tier',tier,'stability',stability,'flags',flags,'sample_gap',samplegap,
  'posterior',jsonb_build_object('model',model,'mean',post_mean,'variance',post_var,'interval',case when post_var is not null then jsonb_build_array(post_mean-1.96*sqrt(post_var),post_mean+1.96*sqrt(post_var)) else 'null'::jsonb end,
   'prior_people',prior_n,'prior_mean',prior_mean,'prior_variance',prior_var,'prior_mean_variance',mean_var,'between_person_variance',tau,
   'conditional_independent_variance',model_post_var,'cost_mean_se',cost_se,'net_se_envelope',net_post_se,
   'calibrated',false,'probability_label','Gaussian empirical-Bayes working probabilities with covariance envelopes; not calibrated posterior coverage',
   'assumptions','Gaussian working likelihood with day HAC SE. Shared-peer mean variance bounded by squared average sampling SD, not divided by people. Focal/prior covariance envelope and raw-SE floor; cost-mean uncertainty included by SD sum. Between-person variance remains plug-in; these are descriptive working probabilities, not a calibrated hierarchical posterior. Candidate FDR comes solely from audited prospective evidence.'),
  'raw',jsonb_build_object('gross_mean',gm,'gross_variance',gs->'variance','se_gross',sega,'se_cluster_gross',gs->'cluster_se','se_a',sea,'se_b',seb,'hac_bandwidth',gs->'hac_bandwidth','equivalence',equivalence,
    'a_mean',aa->'mean','b_mean',bb->'mean','a_net',aa->'total','b_net',bb->'total','pvalue_copy',historical_p_copy,'pvalue_reverse',historical_p_reverse,
    'model','CR1 day clusters; max(CR1,Bartlett HAC); approximate Student t with day df'),
  'details',jsonb_build_object('asof',p_asof,'anytime',anytime,'candidate_gates',jsonb_build_object('copy',gate_a,'reverse',gate_b),
   'behavior',jsonb_build_object('reset_at',behavior_reset,'rule','Within-symbol source size differs by more than configured multiple from previous 20 source sizes','multiple',volume_multiple),
   'inference',jsonb_build_object('trades',n,'observed_trades',observed,'a_net',aa->'total','b_net',bb->'total','interval_basis','95% approximate repeated-sample NET TOTAL uncertainty on completed UTC-day inference subset; not realized cash uncertainty',
    'publication_rule','max(available_at,closed_at+120s)+embargo <= asof; no inferred publication timestamp','embargo_seconds',embargo),
   'tail',jsonb_build_object('favorable_top3_share',concentration),'subminute_share',subminute,
   'power',jsonb_build_object('additional_trades',samplegap,'method','1.96^2 * serial-inflated per-trade variance / observed net-edge^2; fixed-look heuristic, excludes family/sequential penalties')));
end $$;

-- Dependency-conservative BY over EVERY person and BOTH directions. Missing
-- tests are p=1 and remain in m. Do not call separately by side or selected set.
-- For stress grids: declare the whole displayed inferential family in caller;
-- adjusting each cell separately supports per-cell claims only, not cell search.
-- https://www.math.tau.ac.il/~ybenja/depApr27.pdf
create or replace function public.ab_e8_trader_adjust(p_rows jsonb,p_config jsonb)
returns jsonb language plpgsql immutable set search_path to '' as $$
declare result jsonb; alpha double precision:=coalesce((p_config->>'fdr_alpha')::double precision,(p_config->>'q_max')::double precision,.05);
begin
 if jsonb_typeof(p_rows)<>'array' or not(alpha>0 and alpha<=.05) then raise exception 'Invalid BY configuration'; end if;
 if exists(select 1 from jsonb_array_elements(p_rows) v cross join lateral (values(v->>'pvalue_copy'),(v->>'pvalue_reverse')) p(x)
  where x is not null and not(x::double precision>=0 and x::double precision<=1)) then raise exception 'Invalid p-value'; end if;
 with rows as(select value row,ordinality id from jsonb_array_elements(p_rows) with ordinality),
 tests as(select id,direction,coalesce((row->>('pvalue_'||direction))::double precision,1) p,
  case when coalesce((row#>>'{details,anytime,valid}')::boolean,false)
    and coalesce((row->'details'->'candidate_gates'->>direction)::boolean,false)
    and coalesce(row->>'evidence_class','INSUFFICIENT_DATA') not in ('STOPPED_TRADING','E8_INCOMPATIBLE','TAIL_RISK','UNSTABLE','COST_BLED')
   then coalesce((row->'details'->'anytime'->>('p_'||direction))::double precision,1) else 1 end candidate_p,
  coalesce((row#>>'{details,anytime,valid}')::boolean,false) prospective
 from rows cross join (values('copy'),('reverse')) d(direction)),
 ranked as(select *,row_number() over(order by p,id,direction) rank,row_number() over(order by candidate_p,id,direction) candidate_rank,
  count(*) over() m,bool_or(prospective) over() any_prospective from tests),
 harmonic as(select sum(1.0/k) h from generate_series(1,jsonb_array_length(p_rows)*2) k),
 adjusted as(select *,least(1.0,min(p*m*h/rank) over(order by p,id,direction rows between current row and unbounded following)) q,
  least(1.0,min(candidate_p*m*h/candidate_rank) over(order by candidate_p,id,direction rows between current row and unbounded following)) cq from ranked cross join harmonic),
 pairs as(select id,max(q) filter(where direction='copy') qc,max(q) filter(where direction='reverse') qr,
  max(cq) filter(where direction='copy') cc,max(cq) filter(where direction='reverse') cr,max(m) m,bool_or(any_prospective) prospective from adjusted group by id),
 final as(select id,row||jsonb_build_object('q_copy',case when prospective then cc else qc end,'q_reverse',case when prospective then cr else qr end,
  'evidence_class',case
   when row->>'evidence_class' in ('STOPPED_TRADING','E8_INCOMPATIBLE','TAIL_RISK','UNSTABLE','COST_BLED') then row->>'evidence_class'
   when cc<=alpha then 'COPY_CANDIDATE'
   when cr<=alpha then 'REVERSE_CANDIDATE'
   else 'INSUFFICIENT_DATA' end,
  'details',coalesce(row->'details','{}')||jsonb_build_object('fdr',jsonb_build_object('method','Benjamini-Yekutieli','hypotheses',m,'alpha',alpha,'scope','all supplied rows, both directions',
   'mode',case when prospective then 'prospective candidate family; all eligibility gates masked BEFORE BY' else 'descriptive historical family; no actionable FDR claim' end,
   'candidate_q_copy',cc,'candidate_q_reverse',cr,'descriptive_q_copy',qc,'descriptive_q_reverse',qr,
   'limitation','Snapshot FDR only for prospectively valid bounded-process nulls; historical cluster t q-values are descriptive approximations. Does not control union over changing rosters/epochs/cells')),
  'reasons',coalesce((select jsonb_agg(reason order by ord) from jsonb_array_elements(coalesce(row->'reasons','[]')) with ordinality rr(reason,ord)
    where reason#>>'{}' not like 'BY adjusted over %'),'[]')||jsonb_build_array('BY adjusted over '||m||' hypotheses; candidate needs family q and all prospective/stability gates')) row
 from rows join pairs using(id)) select coalesce(jsonb_agg(row order by id),'[]') into result from final;
 return result;
end $$;

revoke all on function public.ab_e8_trader_t_cdf(double precision,integer),public.ab_e8_trader_normal_cdf(double precision),public.ab_e8_trader_moments(jsonb,double precision) from public,anon,authenticated;
revoke all on function public.ab_e8_trader_infer(jsonb,jsonb,jsonb,timestamptz),public.ab_e8_trader_adjust(jsonb,jsonb),public.ab_e8_trader_start(text,text,double precision,jsonb,text),public.ab_e8_trader_activate(bigint,text,text),public.ab_e8_trader_append(bigint,date,double precision,double precision,boolean) from public,anon,authenticated;
grant execute on function public.ab_e8_trader_infer(jsonb,jsonb,jsonb,timestamptz),public.ab_e8_trader_adjust(jsonb,jsonb),public.ab_e8_trader_start(text,text,double precision,jsonb,text),public.ab_e8_trader_activate(bigint,text,text),public.ab_e8_trader_append(bigint,date,double precision,double precision,boolean) to service_role;
commit;
