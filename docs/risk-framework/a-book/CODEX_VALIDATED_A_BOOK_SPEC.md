# iPFX Validated A-Book Foundation

Status: implementation contract for shadow and paper decision support only.

This document reconciles the two DeepSeek design reports with both adversarial verification reports and the live iPFX schema inspected on 2026-09-07. DeepSeek is design input, not empirical validation. Nothing in this specification authorizes live capital, external order submission, payout denial, or a claim that a probability is calibrated.

## 1. Safety boundary

- Contractual trader payouts are independent iPFX liabilities. They exist whether the internal recommendation is WAIT, SHADOW, PAPER, PARTIAL, FULL, or whether an external destination fails.
- External receipts are not liquid cash until settled. They cannot fund, defer, cancel, or condition a trader payout.
- `live_enabled` is database-constrained to `false` in every new live-capable record.
- A future live-enablement migration must remove that constraint explicitly and must still require two approvals from distinct authenticated humans, neither of whom is the requester.
- Critical risk events suspend the affected allocation immediately. They do not wait for a five-minute monitoring window.
- Statistical flags may open a review. They may not deny a payout.

## 2. Units and sign conventions

All percentages stored by this foundation are fractions in `[0,1]`: `0.05` means 5%. Money is `numeric` plus an ISO-4217 currency code. Prices and quantities use instrument-native units and require a versioned contract multiplier before notional or P&L is decision-grade.

Positive money is an asset, receipt, profit, deposit, or reserve increase. Negative money is a loss, payment, withdrawal, or reserve decrease. Payout liability amounts are stored as non-negative obligations. Expected shortfall is a non-negative loss magnitude:

```text
VaR_alpha(X) = quantile(X, alpha)
ES_alpha(X)  = max(0, -E[X | X <= VaR_alpha(X)])
```

A tail-limit breach is `ES_alpha > approved_limit`, never “below limit.”

Daily external flow uses the account-owner convention: deposits are positive and withdrawals are negative. The adjusted account return is:

```text
R_t = (E_t - E_(t-1) - F_t) / E_(t-1)
```

It is `NULL` when prior equity is non-positive or any required input is missing. Annualization uses the versioned market/session calendar attached to the observation set; there is no universal hard-coded calendar.

## 3. P&L contract and cost accounting

Two price bases are permitted and must never be mixed:

1. `ACTUAL_FILL_CASH`: price P&L is calculated from actual entry/exit fills. Spread, slippage, and latency are already reflected in those fills. Subtract commissions, fees, financing, borrow, and attempt costs only. Store execution shortfall separately for attribution.
2. `DECISION_BENCHMARK_GROSS`: price P&L is calculated from a versioned decision benchmark. Subtract commissions, fees, financing, borrow, attempt costs, and execution shortfall exactly once.

```text
net_pnl = price_pnl
          - commission
          - fees
          - financing
          - borrow
          - attempt_cost
          - (execution_shortfall if basis = DECISION_BENCHMARK_GROSS else 0)

r_multiple = net_pnl / risk_budget, only when risk_budget > 0
```

The theoretical result of a missed or rejected order is never authoritative P&L. A verifiable attempt cost may be recorded; otherwise the result remains incomplete.

## 4. Independent trade ideas

A trade idea is an economic decision, not an order or fill. The immutable group is identified by trader, grouping-model version, strategy/signal family, risk cluster, decision window, direction thesis, and point-in-time source references. Scale-ins, partial closes, retries, and linked instruments from one inseparable thesis are members of the same idea. A new idea requires a new independent information set or a pre-registered strategy rule.

No correlation cutoff is hard-coded. Correlation, concentration, regime, evidence, and coverage thresholds all belong to one versioned configuration snapshot.

## 5. Evidence and prediction contract

Weighted Kish ESS is descriptive only and does not establish independence. The baseline interface uses ordered idea/account returns, a declared block-selection method, a fixed seed, and coverage validation. Capital-grade evidence requires a block/dependence-aware result plus versioned calibration evidence.

Evidence states are:

- `INSUFFICIENT_EVIDENCE`: required sample, dependence, regime, concentration, provenance, interval-width, or calibration evidence is absent.
- `INVALID_INPUT`: units, source data, rule snapshot, or provenance is invalid.
- `SUFFICIENT_FOR_SHADOW`: enough evidence for a shadow recommendation, not probability-based live allocation.
- `SUFFICIENT_VALIDATED`: a separately trained and validated model has passed its registered acceptance contract.

If evidence is not `SUFFICIENT_VALIDATED`, calibrated probability fields are `NULL`. Descriptive simulator frequencies may be stored only with an explicit `SHADOW_UNCALIBRATED` label.

Every prediction row includes a unique row ID, `as_of_time`, generation time, model definition, feature snapshot, evidence assessment, rules/config/cost snapshots, seed/run provenance, horizon and units. Repeated forecasts for the same trader/model/horizon are allowed and immutable.

Distribution checks require ordered quantiles. For a common continuous horizon distribution, `q25 < 0` implies `P(P&L > 0) <= 0.75`; therefore the DeepSeek example pairing `q25=-4.1` with `p_pos=0.972` is rejected.

## 6. Predictive uncertainty

The simulator draws one latent mean per path. Under the illustrative independent normal special case:

```text
theta_path ~ Normal(mu_n, tau_n^2)
S_N | theta_path ~ Normal(N * theta_path, N * sigma_e^2)
Var(S_N) = N * sigma_e^2 + N^2 * tau_n^2
```

The implementation preserves the shared latent parameter within each path. Serial/regime dependence, fat tails, selection/censoring, missed execution, and skew require separately validated artifacts; the normal special case is not labelled Bayesian validation.

## 7. Allocation states and recommendations

Lifecycle state and recommendation are separate fields.

States:

```text
NEW -> B_BOOK_OBSERVE -> SHADOW -> PAPER_A_BOOK
PAPER_A_BOOK -> PARTIAL_A_BOOK -> FULL_A_BOOK
any active state -> PAUSED_COOLDOWN or KILL_SWITCH
PAUSED_COOLDOWN -> at most PAPER_A_BOOK
any state -> TERMINATED
```

Recommendations/reasons use a separate vocabulary: `WAIT`, `SHADOW`, `PAPER`, `PARTIAL`, `FULL`, `INSUFFICIENT_EVIDENCE`, `PROVIDER_NOT_AUTHORISED`, `RISK_NO_GO`.

No sample count in the state machine is a universal promotion rule. The active versioned config supplies evidence and correlation gates derived from business loss and prospective calibration. Feasible actions are filtered before utility comparison. Value-of-information is not added to every action; it requires a finite remaining horizon, future observation contract, and action-specific continuation model.

Allocation caps are dimensionally explicit. Fraction caps are fractions, money-risk caps are converted to fractions using a positive declared denominator, and invalid/missing/negative caps produce `INVALID_INPUT`. The final fraction is clamped to `[0,1]`; negative Kelly values produce zero, never negative allocation.

## 8. Daily-loss and challenge path rules

Each simulator scenario references an immutable rules snapshot. The snapshot declares:

- reset timezone/session;
- daily anchor mode (`START_OF_DAY_BALANCE`, `START_OF_DAY_EQUITY`, or `START_OF_DAY_MIN_BALANCE_EQUITY`);
- breach measure (`BALANCE`, `EQUITY`, or `MIN_BALANCE_EQUITY`);
- static or trailing maximum-drawdown mode;
- phase target, reset behavior, minimum active trading days, funded activation, payout threshold/split/cap, review delay, and settlement delay.

Open equity is included whenever the rule snapshot requires it. A phase transition resets phase balance, peak, day anchor and phase counters exactly as the snapshot states. Evaluation completion does not equal payout: evaluation, funded activation, funded profit, payout eligibility, review, approval/denial, settlement and default are distinct states.

First source payout eligibility and its contractual due time are frozen. Re-observation cannot push the date later.

## 9. Joint-path and reserve model

Source and destination paths share scenario stress but have independent idiosyncratic components. The source path and all source liabilities continue through the full horizon after destination breach, default, denial, or terminal failure.

Each reserve path tracks:

```text
liquid_cash_t
locked_open_liabilities_t
settled_external_receipts_t
available_cash_t = liquid_cash_t - locked_open_liabilities_t
reserve_trough = min_t available_cash_t
```

Reserve breach is tested at every step, not only at the horizon. Existing liabilities are modeled independently of copied capital. Destination payouts are receivables until settlement.

Timing outcomes are mutually exclusive: `DEST_BEFORE_SOURCE`, `DEST_ON_SOURCE`, `DEST_AFTER_SOURCE`, `DEST_NEVER_SOURCE_FINITE`, `SOURCE_NEVER_DEST_FINITE`, `BOTH_NEVER`, `HORIZON_CENSORED`, and structural `IMPOSSIBLE`. Zero Monte Carlo successes is not structural impossibility.

## 10. Event identity and reconciliation

The business idempotency key is `(provider_id, destination_account_id, provider_event_id)`. Payload hash is evidence, not part of uniqueness. A duplicate identity with a different payload hash is quarantined as a conflict and never creates another intent. Provider order/fill IDs are unique within provider and destination account. An ambiguous send is reconciled against provider state before retry.

Critical events include drawdown breach, provider permission revocation/expiry, stale price beyond hard limit, position mismatch, reserve deficit, and data-integrity failure. They block new risk immediately. Cancel-only and risk-reducing close are distinct from flatten confirmation; cancellation alone does not imply exposure is flat.

## 11. Security and immutability

- Every `public.a_book_*` table has RLS enabled.
- `anon` has no privileges.
- `authenticated` receives read access only through an admin-check policy; ordinary traders see zero rows and receive no write grants.
- Writes are server-side/service-role only after server authorization.
- Immutable snapshots/events reject update and delete through triggers.
- Financial values have non-negative/range/currency/unit constraints and indexed foreign keys.
- Privileged helper functions are not browser APIs: execute is revoked from `PUBLIC`, `anon`, and `authenticated`.
- No authorization decision uses user-editable JWT metadata.

## 12. Deviations from DeepSeek

1. Actual-fill P&L does not subtract spread/slippage/latency a second time.
2. Expected shortfall is consistently a non-negative loss.
3. DeepSeek case 3 is not `ALLOCATE`: its stated utility is `-94R`, and even zero capital charge leaves `-34R`.
4. The inconsistent `p_pos=0.972`, `q25=-4.1` example is invalid.
5. Dependence-aware block evidence replaces reliance on Kish ESS alone.
6. Prediction identity includes point-in-time snapshots and permits repeated forecasts.
7. Daily returns adjust external cash flows and carry calendar provenance.
8. All fixed thresholds are unvalidated configuration, not promotion truth.
9. Payout liability is independent of allocation action/capital.
10. Predictive-mean uncertainty is included with an `N^2 * tau_n^2` contribution in the normal special case.
11. Daily-loss anchors and measures are versioned; open equity is not silently ignored.
12. Source liability time freezes at first eligibility and source paths continue after destination failure.
13. Funded and payout lifecycle states, delays, denials, caps and reserve troughs are explicit.
14. Structural impossibility is separated from low probability and policy inadmissibility.
15. Allocation outputs cannot be negative and all cap units are declared.
16. Lifecycle state is separate from reason/recommendation codes.
17. Event uniqueness excludes payload hash; changed duplicate payloads quarantine.
18. Critical risk events suspend immediately and p99 latency is recorded.
19. `live_enabled=false` and two-distinct-human future approval are database constraints.
20. The Part 1/Part 2 handoff is a full versioned snapshot contract, not `n/sum/sum_sq`.

## 13. Deployment boundary

Postgres stores authoritative snapshots, constraints, state, audit and deterministic scalar calculations. The seeded joint-path simulator lives in the server-side `internal-control` TypeScript module because long Monte Carlo loops do not belong in a static browser or a latency-sensitive SQL transaction. Its input and result contracts are stored in Postgres. It remains shadow-only and uncalibrated until a scheduled trusted worker persists signed runs and independent holdout/prospective validation is attached.

