# iPFX A-Book Engine — Part 1: Statistical Skill and Evidence Model

**Scope.** This specification defines the mathematical and statistical core that turns account activity into calibrated, audited decision inputs for internal A-book allocation. It does not decide contractual payout eligibility. Payout eligibility must be maintained as a separate legal/policy process. No model guarantees profit. The engine deliberately returns `INSUFFICIENT_EVIDENCE` when data cannot support a cost-aware decision.

All formulas are deterministic unless MCMC/posterior simulation is explicitly stated. Numbers marked `(H)` are illustrative hypotheses; they must be calibrated on approved historical data before production use.

---

## 1. Independent Trade Ideas

A **trade idea** is an economically independent decision, not an order, fill, or ticket.

### 1.1 Definition

A trade idea is the unique tuple:

```
(trader_id, strategy_id, signal_family_id, risk_cluster_id, decision_window_ref)
```

A new idea is created when one or more of the following occurs:

- a new signal/decision hypothesis from the strategy,
- the previous exposure in the same risk cluster is closed and a new decision is made on a new, actionably independent information set,
- a materially different holding horizon or execution style begins,
- the instrument or risk factor changes outside the existing cluster.

### 1.2 Idea merging rules

Orders, partial closes, scaling in/out, and pyramiding are collapsed into the same idea if:

- same trader and strategy/signal family,
- same risk cluster,
- open or execution attempt within the same decision window,
- same intended directional thesis.

Risk clusters are built from:

- identical instrument,
- same underlying deliverable or yield/funding relation,
- trailing 60-day absolute return correlation ≥ 0.70 `(H)`,
- same major macro factor exposure,
- FX pairs sharing both base and quote currency exposures, e.g. EURUSD and GBPUSD are distinct but may be merged if they are executed as one USD-specific signal.

If multiple instruments are initiated from a single composite signal and are not liquidated independently, they are one idea. If they can be detached and managed independently with separate stops/targets, they may remain separate, but this must be coded as a strategy-level property.

### 1.3 Overlapping exposures

An overlapping order in the same risk cluster does not create a new idea. A re-entry after closing creates a new idea only if the new entry has a distinct catalyst or the strategy explicitly defines it as a new independent event.

Missing and rejected executions are attached to the same idea as an attempt outcome. They are not discarded.

---

## 2. Authoritative Net Return

### 2.1 Fill-level net P&L

For each fill `f`:

```
net_pnl_f =
  q_f · direction_f · (exit_price_f − entry_price_f) · contract_multiplier_f
  − commission_f
  − fees_f
  − swap_financing_f
  − borrow_cost_f
  − slippage_charge_f
  − latency_charge_f
```

where:

- `slippage_charge_f = q_f · direction_f · (fill_price_f − mid_at_decision_f) · contract_multiplier_f`
- `latency_charge_f` is the adverse move between signal time and order receipt/fill time when attributable to execution delay; otherwise zero. It is applied symmetrically to avoid overstating skill.
- All prices use versioned point-in-time data.

### 2.2 Partial closes and unfilled quantity

For a trade idea `i`, aggregate over all fills:

```
net_pnl_i = Σ_f net_pnl_f
```

Unfilled intended quantity receives an **opportunity charge** if the order was missed or rejected:

```
missed_rejected_pnl_i = −attempt_cost_i
```

The latent “would-have” P&L is stored separately as `theoretical_pnl_i`, never as authoritative P&L.

### 2.3 Risk budget and R-multiple

Comparable return is preferred as net R-multiple:

```
r_i = net_pnl_i / risk_budget_i
```

Risk budget order of preference:

1. `stop_distance_i · size_i`, if a verified stop was present at entry,
2. `size_i · realized_volatility_i · sqrt(holding_days_i) · 1.0`,
3. `notional_i · 0.01` as fallback `(H)`.

If `risk_budget_i ≤ 0` or missing, `r_i = NULL` and data quality is degraded to `INVALID`.

Costs include spread, commissions, financing, slippage, latency and attempted execution costs. A cost model version is stored with every return.

---

## 3. Hierarchical Bayesian Model

Let `j` index trader, `c(j)` index defensible cohort, `e(i)` index time epoch, `i` index trade idea.

Cohorts are defined by asset class, execution type, holding horizon, account denomination region, and approved strategy family. They must be pre-registered. No trader may be in a singleton cohort unless the cohort level has a strong prior `(H)`.

### 3.1 Likelihood

For executed ideas:

```
r_i = α_j + η_{j,e(i)} + β^T x_i + σ_{j,e(i)} ε_i
```

For missed/rejected ideas:

```
m_i = 1
r_i = −κ_i
```

with missingness model:

```
m_i ~ Bernoulli(logit^−1(γ_0 + γ_m^T x_exec_i + χ_j))
```

Latent true return for missed ideas is drawn from the same return equation and is treated as censored.

- `α_j`: trader-level persistent net edge after costs.
- `η_{j,e}`: time-varying deviation from trader baseline.
- `x_i`: pre-entry features affecting net return and cost burden.
- `σ_{j,e}`: time-varying conditional scale.
- `ε_i`: fat-tailed, asymmetric residual.
- `κ_i`: attempt cost of missed/rejected execution.

### 3.2 Time variation and edge decay

Epochs are 10 executed/attempted ideas or one calendar week, whichever contains more observations `(H)`.

```
η_{j,e} = ρ η_{j,e−1} + ξ_{j,e}
ξ_{j,e} ~ Normal(γ_j, σ_η^2)
```

`γ_j` is trader-specific drift in edge:

```
γ_j ~ Normal(μ_γ_c(j), τ_γ^2)
```

Posterior `P(γ_j < 0 | D)` is the edge-decay probability.

### 3.3 Skew, fat tails, conditional variance

Residuals follow a standardized skew Student-t:

```
ε_i ~ SGT(ν, λ)
ν ~ Gamma(4, 1) + 4           (H)
λ ~ Normal(0, 1), truncated to (−0.95, 0.95)   (H)
```

Conditional scale:

```
σ_{j,e} = exp(ψ_j + ζ_regime(e) + ω^T x_i)
ψ_j ~ Normal(0, 0.5^2)         (H)
ζ_regime ~ Normal(0, 0.3^2)    (H)
ω ~ Normal(0, 0.25^2)          (H)
```

### 3.4 Partial pooling hierarchy

```
α_j ~ Normal(μ_c(j), τ_α^2)
μ_c ~ Normal(0, 0.5^2)         (H)
τ_α ~ HalfStudentT(3, 0, 0.25) (H)
```

Other prior hypotheses:

```
β ~ Normal(0, 0.25^2)          (H)
ρ ~ Normal(0, 0.5^2), truncated to (−0.95, 0.95)  (H)
σ_η ~ HalfNormal(0, 0.2^2)     (H)
μ_γ_c ~ Normal(0, 0.05^2)      (H)
τ_γ ~ HalfNormal(0, 0.1^2)     (H)
γ_0 ~ Normal(0, 1^2)           (H)
γ_m ~ Normal(0, 0.5^2)         (H)
χ_j ~ Normal(0, 0.5^2)         (H)
```

### 3.5 Posterior and posterior predictive

Posterior:

```
π(α, η, ρ, γ, β, σ, ν, λ, μ, τ, χ | D)
  ∝ [ Π_i likelihood_i ] · [ priors ]
```

Posterior predictive for a future idea:

```
r* = α_j + η_{j,e_new} + β^T x* + σ_{j,e_new} ε*
```

Simulate `N` future paths for each horizon, preserving:

- trade frequency modeled by a trader-level Poisson-Gamma rate,
- epoch AR dynamics,
- execution-missing probability,
- current regime distribution.

---

## 4. Deterministic/Bootstrap Fallback

If the full Bayesian model has not passed validation, use the following fallback.

### 4.1 Weighted idea-level estimates

For trader `j`:

```
w_i = quality_i · decay^age_i · 1/(1 + concentration_i)

rbar_j = Σ w_i r_i / Σ w_i

ESS_j = (Σ w_i)^2 / Σ w_i^2

s_obs_j^2 = max(0, Σ w_i (r_i − rbar_j)^2 / ((ESS_j − 1)/ESS_j · Σ w_i))
```

`quality_i` is 1 for A-quality executed ideas, 0.5 for partial/censored, 0 for invalid. `decay ∈ (0.9, 1.0)` `(H)` gives recent data more weight. `concentration_i` is the idea’s risk-cluster concentration penalty.

### 4.2 Shrinkage

```
θ_EAP_j = (ESS_j · rbar_j + κ · μ_c(j)) / (ESS_j + κ)
```

`κ = 2` `(H)`. Cohort mean `μ_c(j)` is estimated robustly by pooled median.

### 4.3 Block bootstrap

Resample weekly blocks of idea returns 10,000 times. Compute:

- mean,
- 1%, 5%, 50%, 95%, 99% quantiles,
- cumulative P&L over 20/60/120 ideas,
- daily-equivalent paths using trader-level trade frequency.

This fallback is intentionally conservative because it does not model tail dependence as richly as the full model.

---

## 5. Versioned Prediction Outputs

For each trader and horizon `h ∈ {20, 60, 120}` ideas and `d ∈ {30, 60, 90}` days, produce:

| Output | Definition |
|---|---|
| `p_pos_ideas_h` | Posterior predictive probability cumulative net P&L > 0 over next `h` ideas |
| `p_pos_days_d` | Posterior predictive probability daily-account net P&L > 0 over `d` days |
| `expected_pnl_dist` | Distribution of total net P&L; required quantiles: 1%, 5%, 25%, 50%, 75%, 95%, 99% |
| `expected_r_multiple_dist` | Same distribution in R-multiples |
| `expected_drawdown_dist` | Maximum peak-to-trough account-equity drawdown over horizon |
| `expected_shortfall_95` | `−E[P&L_h | P&L_h ≤ VaR_0.05]` |
| `expected_shortfall_99` | `−E[P&L_h | P&L_h ≤ VaR_0.01]` |
| `risk_of_ruin` | `P(min equity_h < floor_equity)` |
| `edge_decay_prob` | `P(γ_j < 0)` in full model; fallback uses recent-vs-early mean shift |
| `copyability` | Probability that net edge remains positive after copy-venue cost/offset and capacity constraints |
| `data_quality` | A, B, C, or INVALID |
| `evidence_confidence` | Posterior interval width and ESS-derived severity/confidence grade |

All predictions are versioned by `model_version`.

---

## 6. Evidence-Sufficiency Rule

Actions:

```
ALLOCATE
INSUFFICIENT_EVIDENCE
NO_ALLOCATE
```

### 6.1 Evidence gate

Return `INSUFFICIENT_EVIDENCE` if any of the following fail:

| Condition | Requirement |
|---|---|
| Effective sample size | `ESS ≥ N_min` |
| Posterior/interval width | 90% interval for expected future R-multiple ≤ 2ε |
| Regime coverage | At least 3 distinct pre-registered vol/trend regimes; each with ≥ 5 ideas `(H)` |
| Concentration | Risk/strategy Herfindahl-Hirschman ≤ 0.45 `(H)`; no single cluster > 25% of net P&L `(H)` |
| Stability | No single 20-idea epoch contributes > 50% of cumulative P&L `(H)` |
| Cost sensitivity | Expected edge remains same sign when cost model doubled |
| Data quality | Not `INVALID`; completion ≥ 0.90 `(H)`; fill/cost provenance adequate |

Here `ε` is the economic indifference width: the smallest expected per-idea edge that justifies allocation after risk charge. It is a business input, not a statistical significance level.

`N_min` is derived from the required interval width:

```
N_min = ceil( (1.645 · s_obs / ε)^2 )
```

where `s_obs` is the robust observed scale from fallback or posterior predictive scale.

### 6.2 Utility decision

Let `S = Σ_{i=1}^{120} r_i` be total R-multiple over the next 120 ideas.

```
V_alloc = E[S | D] − λ · ES_0.05(S | D) − c_alloc
V_wait  = −c_wait
```

where:

- `λ = 2.5` `(H)` is risk-aversion input,
- `c_alloc` is the internal capital/operational charge for A-book allocation,
- `c_wait` is the cost of delaying allocation while maintaining monitoring.

If evidence gate passes:

```
if V_alloc > max(0, V_wait):
    ALLOCATE
else if V_alloc ≤ 0 and expected shortfall and tail risk exceed tail limits:
    NO_ALLOCATE
else:
    INSUFFICIENT_EVIDENCE
```

The tail limits are portfolio-level risk-committee inputs, not statistical p-values.

### 6.3 Why simple metrics are inadequate

- **Ten trades**: effective sample size is tiny; a 70% win rate can arise from `Bin(10,0.5)` with probability 0.17. Profit factor 2.33 is not convincing.
- **Win rate**: ignores payoff magnitude. A strategy can win 99% of small trades and lose 1% of catastrophic trades.
- **Sharpe**: assumes near-symmetry and usually serial independence; it is unreliable under skew, fat tails, regime changes, and irregular trade spacing.
- **Profit factor**: gross winners/gross losers can exceed 1.0 with negative expected utility if the loss tail is large or costs are hidden.
- None captures execution quality, missed/rejected selection, concentration, or edge decay.

---

## 7. Exact Deterministic Metrics

### 7.1 Return definitions

Per idea:

```
net_pnl_i = Σ fill_pnl − costs_i + missed_attempt_pnl_i
r_i = net_pnl_i / risk_budget_i
```

Daily account return:

```
daily_return_t = Δequity_t / equity_{t−1}
```

### 7.2 Annualization

Annualization uses daily returns:

```
annualized_mean = 252 · mean(daily_return)
annualized_vol = sqrt(252) · std(daily_return)
sharpe = annualized_mean / annualized_vol, if annualized_vol > 0 else NULL
```

Do **not** annualize per-trade Sharpe by multiplying by `sqrt(trades_per_year)` unless trade frequency is stable and validated.

### 7.3 Drawdown

```
equity_peak_t = max(equity_0, ..., equity_t)
drawdown_t = (equity_peak_t − equity_t) / equity_peak_t
max_drawdown = max_t(drawdown_t)
```

### 7.4 Expected shortfall

For return sample or posterior draws `R`:

```
VaR_α = quantile(R, α)
ES_α = −mean(R | R ≤ VaR_α)
```

### 7.5 Profit factor

```
ProfitFactor = gross_profit / abs(gross_loss)
```

defined only if `gross_loss < 0`; otherwise `NULL`. It is descriptive only, never an evidence gate.

### 7.6 Missing data

- Missing entry/exit price: idea return is `NULL`, data quality `INVALID`.
- Missing commission/financing: use conservative default and flag quality `C`.
- Rejected execution without verifiable signal: authoritative return is `−attempt_cost`, quality `C`.
- No risk budget: return is `NULL`.

Edge cases:

- Zero gross profit and zero loss: profit factor `NULL`.
- `std = 0`: Sharpe `NULL`.
- Constant equity: drawdown `0`.
- Single-trade history: ESS `1`; evidence gate fails.

---

## 8. Validation and Calibration

### 8.1 Splits

Use three holdout families:

1. **Time split**: train on data before `T`, validate on `T + 30/60/90` days.
2. **Trader-group split**: fit on 80% of traders, predict on held-out traders.
3. **Prospective split**: after model freezing, collect genuinely unseen trade ideas before evaluation.

No split may share trader if trader-level coefficients are being evaluated.

### 8.2 Metrics

- **Brier score** for binary positive-net-P&L events.
- **Log loss** for predicted probabilities.
- **Reliability**: buckets of predicted probability `[0,0.1), ..., [0.9,1]`; compare mean forecast to observed frequency.
- **Interval coverage**: actual hit rate of 80% and 95% predictive intervals.
- **Calibration-in-the-large**: logistic regression of observed positive event on logit(predicted); intercept should be 0.
- **Expected calibration error**:

```
ECE = Σ_b (n_b / n) · |obs_b − p̂_b|
```

- **Decision utility**: realized utility of actions under the decision loss/cost matrix.
- **Model drift**: rolling log-loss, PSI on features, interval coverage CUSUM.

### 8.3 Calibration acceptance

A model version is production-acceptable if:

- ECE ≤ 0.05 `(H)`,
- 80% interval coverage between 0.75 and 0.85 `(H)`,
- 95% interval coverage between 0.93 and 0.97 `(H)`,
- calibration-in-the-large intercept 95% interval contains 0,
- decision utility exceeds fallback utility on prospective data.

---

## 9. Anti-Overfitting Protections

1. Thresholds are **pre-registered** by model version and data snapshot.
2. Any threshold selected on historical data is tested only on a separate selection-free evaluation set.
3. All model changes require versioned shadow models and a 90-day or 100-idea prospective run `(H)` before becoming default.
4. Use hierarchical shrinkage by cohort to reduce trader-level overfitting.
5. If many traders are evaluated repeatedly, apply false-discovery-rate control on the final action list, or use Bayesian false-discovery rate from posterior probabilities.
6. Decision thresholds may not be tuned on the current evaluation period.
7. All predictions and decisions are stored immutably; “off-cycle” changes are visible in audit provenance.
8. Use bootstrap of evaluation metrics; do not select the best of many metric windows.

---

## 10. SQL/Postgres/Supabase-Ready Schema

Schema is versioned. All tables have `created_at`, `updated_at`, `as_of_time`.

```sql
create type data_quality as enum('A','B','C','INVALID');
create type execution_status as enum('FILLED','PARTIAL','MISSED','REJECTED');
create type evidence_action as enum('ALLOCATE','NO_ALLOCATE','INSUFFICIENT_EVIDENCE');

create table traders (
  trader_id uuid primary key,
  cohort_id uuid not null,
  account_enabled boolean not null default true,
  point_in_time timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trade_ideas (
  trade_idea_id uuid primary key,
  trader_id uuid not null references traders(trader_id),
  strategy_id uuid not null,
  signal_family_id uuid not null,
  risk_cluster_id uuid not null,
  decision_window_ref text not null,
  idea_key uuid not null,
  opened_at timestamptz not null,
  closed_at timestamptz,
  source_order_ids uuid[] not null,
  execution_status execution_status not null,
  data_quality data_quality not null,
  point_in_time timestamptz not null,
  unique (trader_id, idea_key, opened_at)
);

create table trade_idea_fills (
  fill_id uuid primary key,
  trade_idea_id uuid not null references trade_ideas(trade_idea_id),
  order_id uuid not null,
  instrument text not null,
  qty numeric(20,6) not null,
  direction smallint not null check (direction in (-1,1)),
  entry_price numeric(20,6),
  exit_price numeric(20,6),
  mid_at_decision numeric(20,6),
  contract_multiplier numeric(20,6) not null,
  slippage_charge numeric(20,6) not null default 0,
  latency_charge numeric(20,6) not null default 0,
  commission numeric(20,6) not null default 0,
  fees numeric(20,6) not null default 0,
  swap_financing numeric(20,6) not null default 0,
  borrow_cost numeric(20,6) not null default 0,
  point_in_time timestamptz not null,
  unique (order_id, fill_id)
);

create table trade_idea_net_returns (
  trade_idea_id uuid references trade_ideas(trade_idea_id),
  return_version text not null,
  net_pnl numeric(20,6),
  risk_budget numeric(20,6) not null check (risk_budget >= 0),
  r_multiple numeric(20,8),
  cost_model_version text not null,
  theoretical_pnl numeric(20,6),
  data_quality data_quality not null,
  valid_from timestamptz not null,
  valid_to timestamptz,
  primary key (trade_idea_id, return_version)
);

create table feature_snapshots (
  trade_idea_id uuid primary key,
  feature_json jsonb not null,
  execution_features jsonb not null,
  cost_features jsonb not null,
  point_in_time timestamptz not null
);

create table model_versions (
  model_version text primary key,
  created_at timestamptz not null,
  model_hash text not null,
  prior_data_snapshot text not null,
  status text not null check (status in ('SHADOW','ACTIVE','RETIRED')),
  validated_until timestamptz
);

create table predictions (
  prediction_id uuid primary key,
  trader_id uuid not null references traders(trader_id),
  model_version text not null references model_versions(model_version),
  horizon_ideas smallint not null check (horizon_ideas in (20,60,120)),
  horizon_days smallint not null check (horizon_days in (30,60,90)),
  p_pos_ideas numeric(8,6),
  p_pos_days numeric(8,6),
  expected_pnl_quantiles numeric(20,6)[] not null,
  expected_r_multiple_quantiles numeric(20,6)[] not null,
  expected_drawdown_quantiles numeric(20,6)[] not null,
  expected_shortfall_95 numeric(20,6),
  expected_shortfall_99 numeric(20,6),
  risk_of_ruin numeric(8,6),
  edge_decay_prob numeric(8,6),
  copyability numeric(8,6),
  data_quality data_quality not null,
  evidence_confidence text not null,
  generated_at timestamptz not null,
  unique (trader_id, model_version, horizon_ideas, horizon_days)
);

create table calibration_results (
  calibration_id uuid primary key,
  model_version text not null,
  eval_start timestamptz not null,
  eval_end timestamptz not null,
  split_type text not null,
  brier_score numeric(8,6),
  log_loss numeric(8,6),
  ece numeric(8,6),
  coverage_80 numeric(8,6),
  coverage_95 numeric(8,6),
  calib_in_large_intercept numeric(8,6),
  decision_utility numeric(20,6),
  drift_statistic numeric(20,6),
  evaluated_at timestamptz not null,
  unique (model_version, split_type, eval_start, eval_end)
);

create table decision_inputs (
  decision_id uuid primary key,
  trader_id uuid not null,
  model_version text not null,
  input_hash text not null,
  evidence_action evidence_action not null,
  utility_alloc numeric(20,6),
  utility_wait numeric(20,6),
  allocation_percent numeric(8,6),
  decision_reason text not null,
  point_in_time timestamptz not null,
  unique (trader_id, model_version, input_hash)
);

create table audit_provenance (
  audit_id uuid primary key,
  entity_type text not null,
  entity_id uuid not null,
  model_version text,
  action text not null,
  actor text not null,
  metadata jsonb not null,
  occurred_at timestamptz not null
);

create index on trade_ideas(trader_id, opened_at);
create index on trade_ideas using gin(source_order_ids);
create index on predictions(trader_id, generated_at);
create index on calibration_results(model_version, eval_start);
create index on decision_inputs(trader_id, point_in_time);
```

Idempotency:

- Each unique idea is keyed by `(trader_id, idea_key, opened_at)`.
- Recomputing returns inserts a new `return_version`; predictions are immutable by unique constraint.
- Upserts use `on conflict do nothing` or `on conflict update` only when allowed by versioning policy.

---

## 11. Worked Synthetic Cases

All priors below are the illustrative hypotheses from section 3 `(H)`.

### Case 1 — Ten lucky trades

Inputs: 10 ideas, R-multiples:

```
+1.0, +1.0, +1.0, −1.0, −1.0, +1.0, +1.0, +1.0, −1.0, +1.0
```

Simple stats:

- wins = 7/10 = 70%,
- net total = +4R,
- profit factor = 7 / 3 = 2.33,
- sample mean = 0.40R,
- naive standard error ≈ `1.0 / sqrt(10) = 0.316R`.

Fallback 90% interval approximately:

```
0.40 ± 1.645 · 0.316 = [−0.12, 0.92] R
```

Hierarchical model with weak cohort prior shrinks the mean to roughly `0.18R` `(H)`, 90% interval approximately `[−0.35, 0.70]R`.

Evidence gate fails: `ESS = 10`, regime coverage insufficient, interval width too wide. **Decision: `INSUFFICIENT_EVIDENCE`.**

### Case 2 — Many fills, few ideas

Inputs: 87 fills across EURUSD, GBPUSD, USDJPY and correlated instruments. All fills arise from three decision windows on one USD-index signal family.

Clustering produces 3 independent trade ideas, net total `+5.2R`.

`ESS = 3`. Interval for mean is extremely wide:

Approximate 90% interval with `s = 1.5R`:

```
mean ± 1.645 · 1.5 / sqrt(3) = mean ± 1.42R
```

Evidence gate fails on ESS and concentration. **Decision: `INSUFFICIENT_EVIDENCE`** despite high raw profit factor.

### Case 3 — Stable moderate edge

Inputs: 150 ideas over six months, three volatility regimes, no material autocorrelation, moderate concentration.

Observed mean `0.35R`, robust scale `1.2R`, ESS after quality/decay weighting `≈ 118`.

Bayesian posterior `(H)`:

- posterior mean `0.30R`,
- 90% interval `[0.10, 0.50]R`,
- `p_pos_120` ≈ `0.99`,
- `edge_decay_prob` ≈ `0.08`,
- `ES_95` over 120 ideas ≈ `−28R` under large but acceptable tail.

Cost doubling reduces mean to `0.19R`, still positive. Evidence gate passes. Utility with `λ=2.5`, `c_alloc` charged at 60R-equivalent `(H)`:

```
E[S] ≈ 36R
ES_95 ≈ −28R
V_alloc ≈ 36 − 2.5·28 − 60 = 36 − 70 − 60 = −94R
```

This would not allocate if `c_alloc` is that high. With realistic lower capital charge or higher edge, allocation may occur. The critical point is that the model derives `ALLOCATE` only from cost-aware utility; this case is structurally high-evidence but allocation depends on business costs. **Possible decision: `ALLOCATE` at low internal charge; otherwise `INSUFFICIENT_EVIDENCE`.**

### Case 4 — Profitable-looking martingale/tail risk

Inputs: 60 ideas. 59 wins of `+0.2R` and one loss of `−11.5R`.

Raw totals:

- gross profit `59 · 0.2 = +11.8R`,
- gross loss `−11.5R`,
- net `+0.3R`,
- profit factor `11.8 / 11.5 = 1.026`.

Mean is positive but tiny: `0.005R`. Tail is severe:

- 99% expected shortfall ≈ `−11.4R` `(H)`,
- risk of ruin under 1% risk budget per idea: one tail event is `−11.5%` equity; sequential martingale size doubling can breach floor quickly,
- autocorrelation is high because the rare loss follows repeated grind wins,
- effective sample is not 60 independent Gaussian trades; the model detects negative skew and dependence.

Evidence gate may pass on ESS, but utility is negative under any meaningful tail penalty:

```
V_alloc ≈ 0.3R expected total − 2.5·ES_95 − c_alloc
```

If `ES_95` over horizon is `−18R` `(H)` and `c_alloc=10R`, then `V_alloc < 0`. **Decision: `NO_ALLOCATE`.**

---

## 12. Implementation-Grade Pseudocode and Tests

```python
def build_trade_ideas(orders, clusters, signal_families, window_rule):
    ideas = []
    active = {}
    for o in orders_sorted_by_time(orders):
        cluster = clusters.get(o.instrument, o.instrument)
        key = (
            o.trader_id,
            o.strategy_id,
            signal_families[o.signal_id],
            cluster,
            current_decision_window(o),
        )
        if key in active and not is_new_independent_decision(o, active[key]):
            attach_order(active[key], o)
        else:
            idea = create_idea(key, o)
            active[key] = idea
            ideas.append(idea)
    return ideas

def compute_net_pnl(idea, cost_version):
    if idea.execution_status in ("MISSED", "REJECTED"):
        return -attempt_cost(idea, cost_version), "C"
    pnl = 0
    for fill in idea.fills:
        pnl += fill_pnl(fill, cost_version)
        pnl -= fill.slippage_charge
        pnl -= fill.latency_charge
        pnl -= fill.commission
        pnl -= fill.fees
        pnl -= fill.swap_financing
        pnl -= fill.borrow_cost
    if idea.risk_budget is None or idea.risk_budget <= 0:
        return None, "INVALID"
    return pnl / idea.risk_budget, "A"

def fallback_predict(trader_id, history, cost_version):
    weights = [quality(i) * decay^age(i) / (1 + concentration(i))
               for i in history]
    ess = sum(weights)^2 / sum(w^2 for w in weights)
    mean = sum(w * i.r for w, i in zip(weights, history)) / sum(weights)
    scale = robust_scale(history)
    n_min = ceil((1.645 * scale / epsilon)^2)
    if ess < n_min:
        return EvidenceGateFail(ess, n_min)
    draws = block_bootstrap(history, blocks_by_week(history), B=10000)
    quantiles = quantile(draws, [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99])
    utility = mean(draws) - lam * expected_shortfall(draws, 0.05) - c_alloc
    return Prediction(quantiles=quantiles, utility=utility)

def decide(prediction, gate):
    if not gate.passed:
        return "INSUFFICIENT_EVIDENCE"
    if prediction.utility_alloc > max(0, prediction.utility_wait):
        return "ALLOCATE"
    if tail_risk_limits_breached(prediction):
        return "NO_ALLOCATE"
    return "INSUFFICIENT_EVIDENCE"
```

### Required unit/property tests

1. **Idea clustering**: two correlated instruments same signal/window → one idea.
2. **Independence**: close then re-enter with distinct catalyst → two ideas.
3. **Cost monotonicity**: adding $1 commission reduces `net_pnl` by exactly $1.
4. **Risk-budget edge**: zero risk budget returns `INVALID`, never divides by zero.
5. **Idempotency**: repeated return computation with same cost model produces identical `r_multiple`.
6. **Fallback shrinkage**: all-zero returns yield mean near zero, not positive.
7. **Decision determinism**: same prediction and gate always produce same action.
8. **Model versioning**: updating model version does not mutate old predictions.
9. **Calibration property**: on simulated known-prior traders, predictive intervals have correct coverage.
10. **Martingale detection**: negative skew and high autocorrelation lower utility relative to naive mean.

---

## 13. Machine-Implementable Contract for Next Model

The downstream timing/allocation model must consume the following JSON, versioned and immutable:

```json
{
  "contract": "iPFX.allocator_input.v1",
  "producer": "iPFX-stat-evidence-engine",
  "model_version": "stat-evd-2025-01-13.a",
  "generated_at": "2025-01-13T09:30:00Z",
  "trader_id": "02d69c3e-...",
  "decision": {
    "action": "ALLOCATE",
    "evidence_gate": true,
    "utility_alloc": 12.47,
    "utility_wait": -3.20,
    "reason": "sufficient evidence and positive risk-adjusted utility"
  },
  "prediction": {
    "horizon_ideas": 120,
    "horizon_days": 90,
    "p_pos": 0.972,
    "expected_pnl_quantiles": {
      "q01": -38.2,
      "q05": -22.7,
      "q25": -4.1,
      "q50": 11.3,
      "q75": 29.8,
      "q95": 74.2,
      "q99": 121.0
    },
    "expected_shortfall_95": 26.4,
    "expected_shortfall_99": 44.8,
    "risk_of_ruin": 0.013,
    "edge_decay_prob": 0.062,
    "copyability": 0.91
  },
  "limits": {
    "max_allocation_percent": 10.0,
    "risk_per_trade_r_multiple": 0.25,
    "max_open_ideas": 5,
    "daily_loss_circuit_breaker": 5.0,
    "weekly_loss_circuit_breaker": 9.0,
    "review_after_ideas": 20,
    "kill_switch_conditions": [
      "posterior_p95_theta_below_0",
      "expected_shortfall_99_below_limit",
      "edge_decay_prob_above_0.80",
      "data_quality_INVALID"
    ]
  },
  "required_refresh": {
    "recompute_after_ideas": 20,
    "recompute_after_days": 30,
    "max_prediction_age_hours": 24
  }
}
```

The timing/allocation model must not allocate unless:

- `decision.action == "ALLOCATE"`,
- all `limits` are satisfiable by current portfolio state,
- no `kill_switch_conditions` are true,
- the prediction is within its refresh window.

**End of Part 1.**