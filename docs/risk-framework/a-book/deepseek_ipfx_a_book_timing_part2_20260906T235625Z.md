# iPFX A-Book Engine — Part 2: Sequential Timing, Allocation and Challenge Path Model

**Scope.** This specification governs whether a trader remains in `B_BOOK_OBSERVE`, enters `SHADOW`, progresses to `PAPER_A_BOOK`, or is recommended for `PARTIAL_A_BOOK`/`FULL_A_BOOK`. It is implementable policy only. It does not guarantee profit. Payouts must be funded by iPFX reserves, never contingent on receipt of funds from any external firm.

---

## 1. State Machine

### 1.1 States

`NEW`, `B_BOOK_OBSERVE`, `SHADOW`, `PAPER_A_BOOK`, `PARTIAL_A_BOOK`, `FULL_A_BOOK`, `PAUSED_COOLDOWN`, `KILL_SWITCH`, `TERMINATED`.

### 1.2 Return codes

`INSUFFICIENT_EVIDENCE`, `PROVIDER_NOT_AUTHORISED`, `RISK_NO_GO`.

### 1.3 Transitions

| From | To | Condition | Human approval | Cooldown |
|---|---:|---|---|---|
| `NEW` | `B_BOOK_OBSERVE` | KYC/contract complete | Compliance | none |
| `B_BOOK_OBSERVE` | `SHADOW` | ≥30 independent trade ideas/days; no fraud flags; live event sound | Risk analyst | none |
| `SHADOW` | `PAPER_A_BOOK` | ≥60 independent signals; shadow fill rate ≥95%; shadow max drawdown ≤ desk limit; no execution kills | Risk analyst | none |
| `PAPER_A_BOOK` | `PARTIAL_A_BOOK` | ≥90 effective signals; posterior gate passes; paper drawdown/ES pass; capacity exists; provider permission if external; reserve cap >0 | Risk committee + capital owner | none |
| `PARTIAL_A_BOOK` | `FULL_A_BOOK` | ≥60 live days; net positive; no limit breach; reserve coverage passes; portfolio correlation cap passes | Risk committee + capital owner | none |
| any live | `PAUSED_COOLDOWN` | drawdown/ES breach, kill switch, permission revocation, model uncertainty spike, human override | Risk officer | 20 business days |
| `PAUSED_COOLDOWN` | max `PAPER_A_BOOK` | revised evidence and no unresolved risk | Risk committee | 20 days |
| any | `KILL_SWITCH` | global/account kill switch activated | System/Risk | until cleared |
| any | `RISK_NO_GO` | fraud, rule evasion, legal, reserve deficit, unresolved account owner mismatch | Risk committee | terminal review |
| any | `PROVIDER_NOT_AUTHORISED` | external copy requested without written permission or account not owned/controlled by iPFX | System | until permission |
| any | `INSUFFICIENT_EVIDENCE` | gate evidence not met | System | until evidence |

Every transition writes an audit event: `actor_type`, `previous_state`, `new_state`, `reason_code`, `evidence_hash`, `capital_delta`, `reserve_delta`, `approval_ids`.

No advancement to live capital may occur if a kill switch is enabled or a live hold override exists.

---

## 2. Sequential Decision Rule

### 2.1 Posterior evidence

Assume trade returns \(r_i|\theta\sim N(\theta,\sigma_e^2)\), prior \(\theta\sim N(\mu_0,\tau_0^2)\). After \(n\) independent trade ideas/days:

\[
\mu_n=\frac{\mu_0/\tau_0^2+\sum_i r_i/\sigma_e^2}{1/\tau_0^2+n/\sigma_e^2},\qquad
\tau_n^2=\frac{1}{1/\tau_0^2+n/\sigma_e^2}.
\]

Use a t-likelihood version when variance is not known.

### 2.2 Utility

For action \(a\in\{\text{WAIT},\text{SHADOW},\text{PAPER},\text{PARTIAL},\text{FULL}\}\), with capital \(C_a\) and expected number of trades \(F_a\):

\[
E[G_a]=C_aF_aT(\mu_n-c_a),
\]

where \(c_a\) is execution/carry cost. Trader payout applies to positive profit share \(p_s\):

\[
E[L_a]=p_sC_aE[(S_T-h)^+],
\quad S_T\sim N(F_aT(\mu_n-c_a),\sigma_e^2F_aT),
\]

where \(h\) is high-water mark.

Expected shortfall at level \(\alpha\):

\[
ES_{\alpha}(a)=C_a\left[-F_aT(\mu_n-c_a)+\sigma_e\sqrt{F_aT}\frac{\phi(z_\alpha)}{\alpha}\right],
\quad z_\alpha=\Phi^{-1}(\alpha).
\]

Decision utility:

\[
U(a|D_t)=E[G_a]-E[L_a]-o_a-\lambda_r ES_{\alpha}(a)-\lambda_\rho \rho_{\text{port}}(a)-\lambda_e \text{ExecLoss}(a)-\lambda_R \text{ReservePenalty}(a),
\]

where:

\[
\text{ReservePenalty}(a)=\max(0,ES_{\alpha}(a)-R_{\text{available}}).
\]

Value of waiting \(k\) blocks:

\[
VOI_k=E_{D_{t+k}}\left[\max_b U(b|D_{t+k})\right]-\max_b U(b|D_t)-\text{CostWait}_k.
\]

### 2.3 Pseudocode

```
function decide(D, state, risk, perms):
    if risk.kill_switch or risk.reserve_total < risk.reserve_min:
        return RISK_NO_GO
    post = update_skill_model(D)
    gates = compute_gates(post, D, risk, state)

    if not gates.sufficient_evidence:
        return INSUFFICIENT_EVIDENCE

    if state.external_requested and not perms.provider_written:
        return PROVIDER_NOT_AUTHORISED

    U = {}
    for action in [WAIT, SHADOW, PAPER, PARTIAL, FULL]:
        U[action] = expected_utility(action, post, risk)
        U[action] += value_of_information(action, post, risk)

    action = argmax(U)

    if requires_human(action) and not risk.human_approval:
        action = max_auto_allowed(state)

    if action.live and not perms.external_replication_allowed:
        action = PAPER_A_BOOK   # or WAIT if external is sole venue

    if action.live and not gates.capacity_ok:
        action = PAPER_A_BOOK

    return state_transition(state, action, gates)
```

The rule must update after every independent trade idea/day. Repeated copies, scale doubles, and resized duplicates do not count as independent evidence.

---

## 3. Joint Monte Carlo / Path Simulator

### 3.1 Inputs

Copied source skill distribution parameters \((\mu_s,\sigma_s)\), iPFX path parameters, destination external challenge parameters, execution degradation, correlation/stress, provider default hazard, payout delay, reset policy, fees.

### 3.2 Correlated stress

Use a common stress factor:

\[
F_t\sim 0.97N(0,1)+0.03N(-2.0,2.5).
\]

Source and destination follow:

\[
r_{s,t}=\mu_s+\beta_s F_t+\epsilon_{s,t},
\]

\[
r_{d,t}=\phi_t\eta_t r_{s,t}-\text{fee}_d-\text{slippage}_d+\epsilon_{d,t},
\]

where \(\phi_t\) is allocation fraction, \(\eta_t\in[0,1]\) is copy fill efficiency.

### 3.3 Path update

Destination phase conditions:

\[
\text{fail}= (B_t<B_{\text{start}}(1-\text{daily\_loss}))
\lor
(B_t<H_t(1-\text{max\_drawdown})),
\]

where \(H_t\) is trailing max balance.

Phase pass:

\[
B_t/B_{\text{phase\_start}}\ge 1+g_p
\quad\text{and}\quad
t-t_{\text{phase\_start}}\ge \text{min\_days}_p.
\]

### 3.4 Pseudocode

```
for sim in 1..N:
    source_balance = source_start
    dest_balance = dest_start
    phase = 1
    phase_start_time = 0
    provider_alive = true
    t = 0
    liability_time = Inf
    dest_payout_time = Inf

    while t < T_max:
        t += 1
        F = stress_mix()
        r_s = mu_s + beta_s*F + idio_noise()
        eta = fill_model()
        r_d = phi*eta*r_s - fees - slippage + dest_noise()

        update_source_path(r_s)
        if source_eligible_for_payout():
            liability_time = t + review_window

        if provider_default_event(): provider_alive = false; break

        update_dest_path(r_d)
        if dest_fail():
            if resets_left and policy_allows_reset():
                apply_reset_fee()
                phase = 1
                dest_balance = reset_balance()
                resets_left -= 1
                phase_start_time = t
            else:
                break

        if phase_pass():
            if phase == 1:
                phase = 2
                phase_start_time = t
            else:
                dest_payout_time = t + payout_window
                break

    cashflow = internal_net(source_balance, liability_time)
             + external_net(dest_balance, dest_payout_time, provider_alive)

    record(liability_time, dest_payout_time, cashflow,
           reserve_breach = risk_reserve + cashflow < reserve_min,
           loss = cashflow < 0)
```

---

## 4. Required Outputs

For each decision or review cycle:

- \(P(T_{\text{dest payout}}<T_{\text{iPFX liability}})\)
- \(P(T_{\text{dest payout}}=T_{\text{iPFX liability}})\)
- \(P(T_{\text{dest payout}}>T_{\text{iPFX liability}})\)
- time-to-payout distributions, 5th/50th/95th percentiles
- expected iPFX cash flow, expected trader payout, expected external received
- probability of loss
- 95% expected shortfall
- reserve breach probability
- break-even \(\mu_s\) required for zero expected utility
- `IMPOSSIBLE` flag when:
  - destination minimum days exceed remaining time, or
  - no destination path can pay before liability, or
  - provider permission is absent for external copy, or
  - allocation fraction is capped to zero, or
  - reserve deficit exists.

---

## 5. Constrained Allocation Fraction

Fractional Kelly is an upper bound only:

\[
f_{\text{Kelly}}=\frac{\mu_n-c_a}{\sigma_e^2},
\qquad
f_{\text{quarter}}=\min\left(\frac{f_{\text{Kelly}}}{4},f_{\text{global max}}\right).
\]

Then apply:

\[
\phi=\min\left(
f_{\text{quarter}},
f_{\text{unc}},
f_{\text{drawdown}},
f_{\text{ES}},
f_{\text{corr}},
f_{\text{liq}},
f_{\text{provider}},
f_{\text{exec}},
f_{\text{reserve}},
f_{\text{conc}}
\right)
\]

where:

- \(f_{\text{unc}}=\min(1,\max(0,(\mu_n-z\tau_n-\theta_{\min})/\theta_{\text{scale}}))\)
- \(f_{\text{drawdown}}=\frac{\text{DD budget}}{\text{k}\sigma_d\sqrt{T_{\text{effective}}}}\)
- \(f_{\text{ES}}=\frac{\text{ES budget}}{\text{ES per fractional unit}}\)
- \(f_{\text{corr}}=\min_j \frac{\text{risk budget}_j}{\beta_j\sigma_p}\)
- \(f_{\text{liq}}=\min_s \frac{\text{ADV}_s\times\text{participation}_s\times\text{price}_s}{2\times\text{intended trade notional}_s}\)
- \(f_{\text{provider}}=\min_s \frac{\text{provider daily loss allowance}}{\text{adverse move estimate}_s}\)
- \(f_{\text{exec}}=\min_s \frac{\text{capacity before slippage exceeds threshold}_s}{\text{desired notional}_s}\)
- \(f_{\text{reserve}}=\max\left(0,\frac{R_{\text{available}}-\text{locked liabilities}}{\text{ES per unit}}\right)\)
- \(f_{\text{conc}}=\text{max single-trader allocation cap}\)

### Safe pre-launch hypothetical caps

These are calibration placeholders, not profit guarantees:

| Cap | Pre-launch calibration |
|---|---:|
| Global live fraction per trader | 0.50% of reserve at `PARTIAL`; 1.50% at `FULL` |
| Initial partial risk capital | min(0.25% reserve, USD 2,500 risk notional) |
| Max ES95 per trader | 0.75% of reserve |
| Max account daily loss | 1.50% of allocated capital |
| Max pairwise correlation with existing A-book | 0.35 |
| Minimum independent evidence | 50 for `PARTIAL`; 100 for `FULL` |
| Max p95 action latency live | 500 ms |
| Max adverse slippage vs mid | 1.5 bps |

These must be revised with prospective data.

---

## 6. Promotion Gates

Gates are derived from asymmetric costs, base rates, and posterior evidence, not arbitrary labels.

Define good trader as \(\theta\ge\theta_{\min}\). Let base rate \(\pi_0\) be historical probability that a trader is good. Let:

- \(C_{FP}\): full expected cost of promoting a bad trader
- \(C_{FN}\): expected opportunity cost of missing a good trader

Promotion threshold:

\[
P^\star=\frac{C_{FP}}{C_{FP}+C_{FN}}.
\]

Required Bayes factor:

\[
BF_{\text{req}}=\frac{C_{FP}}{C_{FN}}\cdot\frac{1-\pi_0}{\pi_0}.
\]

Promote only if:

\[
P(\theta>\theta_{\min}|D)\ge P^\star.
\]

Also require:

- `shadow_ok`: shadow fill rate ≥95%, latency p95 ≤500 ms, no kill switch
- `paper_ok`: paper max drawdown ≤ desk limit; paper ES95 ≤ desk limit
- `capacity_ok`: simulator reserve breach probability ≤1%
- `permission_ok`: provider written permission if external replication
- `human_ok`: risk committee and capital owner approval recorded

Example calibration: if \(\pi_0=10\%\), \(C_{FP}=30\text{k}\), \(C_{FN}=80\text{k}\), then \(P^\star=0.273\), \(BF_{\text{req}}\approx3.38\). These numbers must be calibrated from actual costs.

---

## 7. Challenge Design Comparison

| Design | Evidence quality | Conversion/pass rate | Payout timing/liability | Gaming risk | Fairness | Reserve impact |
|---|---:|---:|---:|---:|---:|---|
| Current product | Low; short sample, high variance | Low, often <15% | Slow, uncertain, provider-dependent | High; target-chasing, overleveraging | Low; penalizes steady strategies | High tail; dependency on external |
| Fair two-phase Traditional | Moderate | Moderate | Still slow | Medium | Moderate | Controlled if cheaper resets |
| Infinity with observation gates | High; observation is mandatory | Conditional pass higher; many stay in paper/shadow | Longer before live promotion, but lower liability tail | Lower; no arbitrary deadline | Higher; evidence-based | Better early tail control |
| Early shadow + authorised broker account | Highest; own execution data and external copy | Higher conditional conversion | Internal payout can occur independently | Lowest if controls enforced | Highest; no credential sharing/stealth | Best; reserves independent of provider |

Illustrative pass rates above are not guaranteed and must be validated prospectively.

---

## 8. Is Finishing an External Two-Phase Challenge Before iPFX Payout Structurally Realistic?

Generally **no**. External two-phase challenges require a target sequence, such as 8% then 5%, with daily loss and trailing drawdown limits. Under normal performance, the hitting time is driven by target divided by drift and is constrained by drawdown. For example, with \(\mu=0.15\%/\text{day}\), \(\sigma=1.2\%/\text{day}\), an 8% phase-1 target without breaching 5% daily/10% trailing limits may take 30–60+ trading days with meaningful failure probability. The iPFX payout date may occur before the external path completes.

Chasing the external payout before the iPFX liability date creates adverse incentives: increasing risk, violating replication constraints, or using challenge-passing services. iPFX must not rely on external payout to fund contractual trader payouts.

**Recommendation:** iPFX must hold independent reserves. External authorised replication is an optional hedge/evidence venue, never a funding precondition. If no external prop firm pays iPFX, internal A-book economics must still clear the utility and reserve gates.

---

## 9. Event-Driven Execution Design

### 9.1 Event contract

```
{
  "event_id": "uuid",
  "source_trader_id": "uuid",
  "source_event_id": "uuid",
  "source_sequence": 128,
  "occurred_at": "ISO-8601",
  "arrived_at": "ISO-8601",
  "event_type": "SIGNAL|ORDER_INTENT|CANCEL|CORP_ACTION",
  "symbol": "EURUSD",
  "destination_account_id": "uuid",
  "quantity": 0.25,
  "limit_price": 1.0845,
  "payload_hash": "sha256"
}
```

### 9.2 Idempotency

- Unique constraint: `(destination_account_id, source_event_id, event_type, payload_hash)`.
- Order intents use deterministic idempotency key.
- Duplicate events ack and skip.
- Processing must be exactly-once at effect level.

### 9.3 Risk translation

- Map source symbols to destination contracts: symbol, multiplier, tick, lot step, currency, timezone, session.
- Missing or stale mapping fails closed.

### 9.4 Stale, duplicate, reordered events

- Watermark per stream.
- Reject events older than watermark minus reorder window.
- Duplicate hash skip.
- Sequence gap: buffer up to 5 seconds; unresolved gap halts that symbol.

### 9.5 Partial fills

- Store `exec_qty`, `leaves_qty`, `price`, `venue_timestamp`, `commission`.
- `copy_intents.remaining_qty` is reduced only by reconciled fills.

### 9.6 Retries

- Exponential backoff 250 ms–2 s; max 5 attempts.
- Do not resend a possibly-live order without querying provider state.
- Retry must reuse idempotency key.

### 9.7 Reconciliation

- Every 30 seconds: compare local expected position, open orders, cash to provider snapshot.
- Nightly full snapshot.
- Mismatch beyond tolerance triggers cancel-only mode.

### 9.8 Latency metrics

- `event_arrival_lag = arrived_at - occurred_at`
- `action_latency = order_ack - intent_created`
- `fill_latency = fill_time - order_ack`
- p50/p95/max tracked per account, symbol, provider.

### 9.9 Circuit breakers and kill switches

Break if over 5 minutes:

- reject rate >2%
- p95 latency >1000 ms
- slippage vs mid >2 ticks
- position mismatch
- drawdown limit breach
- provider error rate >5%

Kill switches:

- scopes: `trader`, `account`, `provider`, `global`
- effect: cancel open orders, block new intents, set state to `KILL_SWITCH`
- live mode defaults off.

### 9.10 Live default

Live replication must require explicit two-person enablement. Hard default: `live_enabled=false`.

---

## 10. Supabase/Postgres-Ready Schemas

```sql
create table allocation_state (
  trader_id uuid primary key,
  state text not null check (state in ('NEW','B_BOOK_OBSERVE','SHADOW',
    'PAPER_A_BOOK','PARTIAL_A_BOOK','FULL_A_BOOK','PAUSED_COOLDOWN',
    'KILL_SWITCH','TERMINATED')),
  allocation_fraction numeric not null default 0 check (allocation_fraction between 0 and 1),
  state_since timestamptz not null default now(),
  reason_code text,
  updated_at timestamptz not null default now()
);

create table decision_events (
  id uuid primary key default gen_random_uuid(),
  trader_id uuid not null,
  state_from text not null,
  state_to text not null,
  decision text not null,
  posterior_mean numeric,
  posterior_sd numeric,
  p_good numeric,
  allocation_fraction numeric,
  reason_codes text[] not null default '{}',
  evidence_hash text not null,
  approval_ids uuid[],
  actor_type text not null,
  created_at timestamptz not null default now()
);

create table provider_permissions (
  id uuid primary key default gen_random_uuid(),
  provider_name text not null,
  destination_account_id uuid not null,
  allowed boolean not null default false,
  permission_document_ref text,
  allowed_instruments text[] not null default '{}',
  starts_at date not null,
  expires_at date,
  constraints jsonb not null default '{}',
  approved_by uuid not null,
  created_at timestamptz not null default now()
);

create table destination_accounts (
  id uuid primary key default gen_random_uuid(),
  legal_owner text not null,
  owner_type text not null check (owner_type in ('IPFX_OWNED','IPFX_CONTROLLED')),
  provider_name text not null,
  account_ref text not null,
  permission_id uuid references provider_permissions(id),
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table copy_intents (
  id uuid primary key default gen_random_uuid(),
  destination_account_id uuid not null references destination_accounts(id),
  source_trader_id uuid not null,
  source_event_id uuid not null,
  event_type text not null,
  symbol text not null,
  quantity numeric not null,
  remaining_qty numeric not null,
  intent_side text not null check (intent_side in ('buy','sell')),
  status text not null check (status in ('open','partial','filled','cancelled','rejected','stale')),
  occurred_at timestamptz not null,
  payload_hash text not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  unique(destination_account_id, source_event_id, event_type, payload_hash)
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  copy_intent_id uuid not null references copy_intents(id),
  destination_account_id uuid not null,
  provider_order_ref text,
  idempotency_key text not null unique,
  side text not null,
  symbol text not null,
  quantity numeric not null,
  limit_price numeric,
  status text not null,
  created_at timestamptz not null default now()
);

create table fills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  copy_intent_id uuid not null references copy_intents(id),
  exec_qty numeric not null,
  leaves_qty numeric not null,
  price numeric not null,
  commission numeric not null default 0,
  venue_timestamp timestamptz not null,
  event_id uuid not null unique,
  created_at timestamptz not null default now()
);

create table reconciliation_events (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  expected_value jsonb not null,
  actual_value jsonb not null,
  difference jsonb not null,
  action_taken text not null,
  created_at timestamptz not null default now()
);

create table limits (
  id uuid primary key default gen_random_uuid(),
  limit_type text not null,
  scope text not null,
  max_value numeric not null,
  current_value numeric not null default 0,
  reset_period text,
  updated_at timestamptz not null default now()
);

create table reserves (
  id uuid primary key default gen_random_uuid(),
  pool_name text not null unique,
  total numeric not null,
  locked numeric not null default 0,
  minimum numeric not null,
  updated_at timestamptz not null default now()
);

create table payout_liabilities (
  id uuid primary key default gen_random_uuid(),
  trader_id uuid not null,
  amount numeric not null,
  due_date date not null,
  status text not null check (status in ('pending','paid','cancelled')),
  reserve_pool_id uuid not null references reserves(id),
  created_at timestamptz not null default now()
);

create table overrides (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  action text not null,
  reason text not null,
  actor uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table kill_switches (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  enabled boolean not null default false,
  reason text,
  actor uuid not null,
  activated_at timestamptz not null default now()
);

create table simulator_runs (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null,
  params jsonb not null,
  outputs jsonb not null,
  version text not null,
  created_at timestamptz not null default now()
);

create table scenario_inputs (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  skill_model jsonb not null,
  internal_path jsonb not null,
  destination_path jsonb not null,
  execution jsonb not null,
  risk_caps jsonb not null,
  created_at timestamptz not null default now()
);
```

---

## 11. Worked Synthetic Cases

### Case 1 — Trader found too late for external two-phase path

- \(n=40\), \(\mu=0.15\%/\text{day}\), \(\sigma=1.4\%\)
- Destination phase targets 8%/5%, min days 15, iPFX liability in 21 days
- Simuli: \(P(\text{dest payout before liability})=4\%\)
- Expected external cashflow negative after fees/resets
- Expected shortfall exceeds reserve budget

**Decision:** `INSUFFICIENT_EVIDENCE` for external; remain `SHADOW` or `PAPER_A_BOOK`. External result is `IMPOSSIBLE` before liability under allowed caps.

### Case 2 — Early shadow/broker allocation dominates

- \(n=75\), \(\mu=0.35\%/\text{day}\), \(\sigma=0.9\%\)
- Slippage \(0.04\%\), correlation \(0.6\)
- \(P(\theta>\theta_{\min})=0.94\), paper drawdown within limits
- Simuli: internal `PARTIAL` expected net \(28k\); authorised external expected net \(9k\)

**Decision:** `PARTIAL_A_BOOK`, external authorised copy fraction \(0.30\), total allocation below reserve cap. Early shadow data dominated waiting.

### Case 3 — High variance / recent wins only

- \(n=25\), recent large wins
- Posterior \(\mu=1.2\%/\text{day}\), but \(\sigma=5\%\), effective sample small
- \(P(\theta>\theta_{\min})=0.61<0.70\) threshold
- Drawdown cap fails

**Decision:** `INSUFFICIENT_EVIDENCE`; transition to `SHADOW`, no live capital.

### Case 4 — Provider not authorised

- Strong statistical evidence, all internal gates pass
- No written provider permission for API automation; external account not owned/controlled by iPFX

**Decision:** external action returns `PROVIDER_NOT_AUTHORISED`. Internal `PAPER_A_BOOK` or `PARTIAL_A_BOOK` may continue if iPFX reserves independently support the liability.

---

## 12. Acceptance Tests and Live Activation Gates

### Acceptance tests

| ID | Given | Expected |
|---|---|---|
| AT-01 | \(n<50\) for partial | Return `INSUFFICIENT_EVIDENCE`; no live allocation |
| AT-02 | External copy requested without written provider permission | Return `PROVIDER_NOT_AUTHORISED`; no external order |
| AT-03 | Reserves below minimum or reserve breach probability >1% | Return `RISK_NO_GO`; no promotion |
| AT-04 | Switch to live requested without two-person human approval | Remain max `PAPER_A_BOOK` |
| AT-05 | Duplicate copy event with same source event ID/hash | Exactly one order/fill effect |
| AT-06 | Stale event older than reorder window | Reject stale, increment breaker |
| AT-07 | Kill switch enabled for trader | Cancel open orders, block new intents |
| AT-08 | Allocation proposed above min cap | Clamp to \(\phi=\min(caps)\) |
| AT-09 | Monte Carlo reference scenario | Outputs match expected histogram within tolerance |
| AT-10 | Live default flag | `live_enabled=false` on new deployment |
| AT-11 | Drawdown breach in live | Transition to `PAUSED_COOLDOWN`, 20-day cooldown |
| AT-12 | Payout liability recorded | Liability funded from iPFX reserve pool, not external receivable |

### Live activation gates

- Written provider permission for automation/replication
- Destination account verified as owned/controlled by iPFX
- Reserve funded to cover 99% liability stress independently
- ≥30 trading days shadow/paper at required evidence sample
- Posterior gate passed using calibrated base rates and costs
- Max drawdown, ES95, correlation, liquidity caps pass
- Kill switch and reconciliation tests passed
- Human capital approval recorded
- `live_enabled` default false and requires two-person enablement
- No unresolved provider permission issue

---

## 13. Machine-Implementable Contract

Inputs from the separate skill model:

```
evidence = {
  n, sum_return, sum_return_sq, last_date,
  shadow_metrics, paper_metrics
}
permissions = {
  internal_allowed, external_replication_allowed,
  provider_permission_id, account_owner_verified
}
risk = {
  reserve_total, locked_reserve, reserve_min,
  es_budget, dd_budget, corr_limit,
  kill_switch, human_approval
}
```

Decision function contract:

```text
if kill_switch:
    return KILL_SWITCH
if reserve_total - locked_reserve < reserve_min:
    return RISK_NO_GO
if external_requested and not provider_permission:
    return PROVIDER_NOT_AUTHORISED

post = skill_model.update(evidence)
gates = promotion_gates(post, evidence, risk)

if not gates.evidence_ok:
    return INSUFFICIENT_EVIDENCE

utility = {
  WAIT: u_wait(post, risk) + evsi(WAIT),
  SHADOW: u_shadow(post, risk) + evsi(SHADOW),
  PAPER: u_paper(post, risk) + evsi(PAPER),
  PARTIAL: u_partial(post, risk),
  FULL: u_full(post, risk)
}

action = argmax(utility)

if action in {PARTIAL, FULL}:
    if not gates.shadow_ok or not gates.paper_ok:
        action = PAPER
    if not gates.capacity_ok:
        action = PAPER
    if not gates.human_ok:
        action = PAPER
    if not gates.permission_ok:
        action = PAPER

phi = allocation_fraction(post, risk, action, gates)

write decision_event(
    state_from, state_to=action,
    allocation_fraction=phi,
    gates, posterior, evidence_hash
)

return decision_event
```

### Codex can safely build now in Supabase

- State machine tables and state transition enforcement
- Evidence collector and normal/t posterior updater with configurable priors
- Deterministic decision contract with user-supplied calibration parameters
- Monte Carlo path simulator with shadow/paper inputs
- Shadow and paper execution engine
- Idempotent copy-intent/order/fill store
- Reconciliation, limit checks, kill switches, dashboards
- Audit logs and acceptance test harnesses

### Must wait for real data, permission, legal review, prospective validation

- Real promotion thresholds and cost base rates
- Provider permissions and account ownership verification
- Live A-book capital allocation and reserve funding
- Live external replication activation
- Final slippage, latency, liquidity and correlation caps
- External challenge pass-rate validation
- Any treatment of external expected payout as usable liquidity
- Any guaranteed pass rate or profit statement

**No external firm payment shall be required to make contractual trader payouts.**