I cannot switch models or invoke a different model inside this interface. The following is the complete, self-contained architectural and risk review requested. It is written as a control and systems design, not as legal advice.

---

# 1. Executive verdict and fatal issues

**Verdict:** iPFX as proposed is **not live-ready**. The safe analytics, dashboard, versioned-rules, review-period, flag, alert, and shadow-copying portions can be built in guarded phases. The live Trade Syncer and any capital-allocation program should be **no-go until each Phase 6 gate is signed off by qualified counsel, independent risk, and an approved provider permission**.

No system is bulletproof. The only defensible requirement is measurable: versioned controls, confidence intervals, calibration, auditability, separation of duties, human decision authority, and failure-safe behavior. Anything else is marketing risk.

## Fatal issues

1. **Legal perimeter is unresolved.** “Challenge” products can be characterized as derivatives, commodity trading accounts, games, or consumer financial products depending on jurisdiction. That affects whether payouts are enforceable, whether marketing language is deceptive, and whether iPFX is operating without a license. **[LEGAL]**

2. **Trade Syncer provider permission is not established.** Copying even into an iPFX-owned account is not automatically permitted by brokers/providers. API automation may violate provider terms, margin agreements, or exchange rules. Written permission is a hard gate. **[LEGAL/PROVIDER]**

3. **Payout model can become insolvent.** If payouts are contractual and funded accounts are loss-bearing, iPFX is running a tail-risk book. Reserve mismatch, correlated trader losses, provider default, and execution degradation can create a negative-expected-value business even if challenge fees are profitable.

4. **Retrospective rules and arbitrary payout denial are not merely unfair; they create legal and reputational catastrophe risk.** The review process must bind iPFX to the exact rules accepted at purchase.

5. **Model risk is severe.** With small samples, a naive model can present a misleading “probability” as confident. For example, 8 wins out of 10 trades has a 95% Wilson interval near 49%–94% for true win rate. A high win rate can coexist with negative expectancy. Halfway progress is not evidence of future success.

6. **Copying cannot promise identical results.** Latency, slippage, partial fills, rejects, symbol mapping, trading calendar differences, and provider liquidity will produce different P&L. If iPFX markets “pass the challenge and get copied,” that is a legal liability unless disclosed and tested.

7. **Security and PII exposure.** An owner dashboard that shows identity documents, trades, devices, orders, and profitability is a high-value target. Client-side route hiding is not authorization. RLS alone is not enough.

**Conditional go/no-go:**  
- **Go** for Phase 0–3: audit, data integrity, deterministic metrics, review workflow, owner dashboard, flags, alerts, governance.  
- **Go only with legal sign-off** for Phase 4–5: replay, shadow, paper-provider adapters.  
- **No-go for live capital allocation and live Trade Syncer until Phase 6 formal approvals and pilot gates are met.**

---

# 2. Explicit assumptions and unknown facts

## Working assumptions

- iPFX uses Supabase/PostgreSQL or equivalent PostgreSQL-based store.
- Source trading events come from a provider API, broker demo account, or authenticated trader event stream.
- Destination brokers/providers are not yet confirmed as permitting automation.
- iPFX has or will have a legal entity, terms of service, privacy policy, KYC/AML provider, and payment processor.
- The product includes Traditional and Infinity challenges with versioned rules.
- The owner dashboard is internal-only.
- The Trade Syncer copies only into iPFX-owned/controlled accounts.
- Trader PII includes identity data, contact data, device data, trading data, and financial data.
- “Funder” means iPFX allocating its own capital; this is separate from contractual payout eligibility.

## Unknown facts that materially affect the design

- Jurisdiction(s) of incorporation, traders, and providers.
- Whether challenge products are regulated in offer jurisdictions.
- Provider written permissions for API and replication.
- Existing data quality and completeness.
- Existing rule versions and whether they were captured immutably.
- Actual pass rates, survival curves, payout rates, chargeback rates, and fraud rates.
- Whether source accounts are demo, simulated, or live; whether source fills are realistic.
- Broker symbol/contract specifications and liquidity.
- The exact payout split, fee schedule, time limits, trailing drawdown rules, and stage multipliers.
- Whether current marketing promises “funded account” or “payout” as automatic.
- Data retention and privacy requirements.
- Existing security posture and team size.

---

# 3. Legal and provider-permission gates requiring qualified counsel

The following items are gates, not implementation details. Each requires qualified legal advice in the relevant jurisdictions.

1. **[LEGAL]** Are challenge products a security, swap, commodity interest, CFD, gambling/betting product, or consumer contract? This changes licensing, disclosure, and complaint-handling duties.
2. **[LEGAL]** Do payout terms create a debt or contingent obligation owed to the trader? Does iPFX have authority to hold retail funds and owe payouts?
3. **[LEGAL]** Does “passing a challenge” create an investment or employment/agency relationship? Tax and withholding implications.
4. **[LEGAL]** Do marketing statements such as “funded account,” “payout,” “copy your trades,” or example returns violate CFTC Rule 4.41 or analogous advertising prohibitions? CFTC Rule 4.41 imposes required disclaimer language for hypothetical or past performance.
5. **[LEGAL]** Are terms and rule changes subject to consumer-protection, unfair-contract, or misleading-omission rules?
6. **[LEGAL]** Does using trader signals to allocate iPFX capital make traders “commodity trading advisors” or “investment advisers” or require registration?
7. **[LEGAL]** Does copying trader events into an account owned by iPFX require broker/platform written consent? Does it violate API terms, exchange-only rules, third-party autotrading restrictions, or market-abuse controls?
8. **[LEGAL]** Do the trader token and source-event API create an unauthorized transmission of order data or a financial data redistribution issue?
9. **[LEGAL]** Does PII/KYC retention satisfy GDPR, CCPA, wire-transfer, AML, and recordkeeping rules? SEC Rule 17a-4 and analogous record retention may apply to records produced by the business.
10. **[LEGAL]** Are electronic signatures and accepted-terms evidence enforceable in the trader’s jurisdiction?
11. **[LEGAL]** Are payout denials based on suspicious behavior legally safe? A flag must not become a de facto forfeiture without notice, evidence, and appeal.
12. **[LEGAL]** Does refusing to allocate capital to a “funded” trader, while retaining a fee, create a misrepresentation or unfair practice?
13. **[LEGAL]** Are chargeback, refund, and cancellation terms compliant with payment-network rules and consumer law?
14. **[LEGAL]** Does the owner dashboard processing of trader data require a legitimate business interest, data-protection impact assessment, or opt-in?
15. **[LEGAL]** Is the economic model an “off-exchange leveraged trading” arrangement requiring capital, segregation, or reporting obligations?

**Provider-permission gate for Trade Syncer:**  
- Signed, versioned permission letter or contract from each destination broker/provider.
- Statement permitting API automation and trade replication on the specific iPFX account.
- Confirmation of allowed order types, rate limits, netting/hedging behavior, and kill-switch API.
- Renewal date and automatic stop-on-expiry.

Without this, Phase 4 replay may proceed internally, but Phase 5/6 live adapter testing must not.

---

# 4. Review-period policy and state machine

## 4.1 Core principles

- The review checks the trader’s result against the exact immutable terms version accepted at challenge purchase/start.
- No retrospective rule may apply to an active challenge unless the trader affirmatively opts into a new version.
- A model may generate flags and evidence. Only a human may issue a rejection, unless there is an explicit deterministic rule violation with complete evidence and a human confirmation step.
- A trader must never be denied payment merely because they are unusually profitable or costly to iPFX.
- Payout eligibility is contractual. Internal capital allocation is a separate iPFX decision.

## 4.2 Rule-version anchoring

At challenge activation:

```
terms_version_id     -- immutable version at activation
rule_policy_id       -- immutable rule snapshot
content_hash         -- SHA-256 of canonical terms/rule JSON
accepted_at          -- UTC timestamp
acceptance_token     -- evidence of trader acceptance
```

Every rule and objective in the review screen is read only from this snapshot.

## 4.3 States

| State | Meaning |
|---|---|
| `active` | Challenge open; objective not met |
| `objective_met` | Automated deterministic objective check passed; review start timestamp set |
| `pending_review` | Queued for reviewer |
| `in_review` | Human reviewer assigned |
| `needs_more_data` | Evidence incomplete; trader or provider data requested |
| `compliance_escalation` | Fraud/compliance/security concern; separate human review |
| `approved` | Contractual payout eligibility approved |
| `rejected` | Eligibility rejected with reason codes and evidence |
| `appeal_requested` | Trader appealed |
| `appeal_in_review` | Appeal under independent review |
| `appeal_upheld` | Original rejection stands |
| `appeal_overturned` | Original rejection overturned; correct outcome applied |

## 4.4 Transitions and time bounds

```
active → objective_met                 -- within 24h of target
objective_met → pending_review         -- immediate, T+0
pending_review → in_review             -- T+2 business days
in_review → needs_more_data            -- if evidence missing
needs_more_data → in_review            -- when data received
in_review → approved / rejected / compliance_escalation
compliance_escalation → approved / rejected
rejected → appeal_requested             -- trader only, within 10 business days
appeal_requested → appeal_in_review
appeal_in_review → appeal_upheld / appeal_overturned
```

Time bounds:

- Target final review decision: **10 business days** from `objective_met`.
- Maximum allowed extension: **20 business days** with explicit written notice and reason.
- `needs_more_data` may pause the clock for a maximum of **10 business days**, after which iPFX must decide on available evidence.
- If the deadline expires without a decision and there is no unresolved `compliance_escalation`, the default is **approved** for contractual payout eligibility. A later reversal is allowed only for newly discovered intentional misrepresentation or fraud, through the compliance escalation process, with the same reasons and appeal rights. **[LEGAL: counsel must confirm default-approval treatment]**

## 4.5 Decision fields

Every decision record includes:

```
decision_id
review_case_id
decision_type          -- eligibility / internal-allocation / compliance
outcome                -- approved / rejected / escalated / correction
reason_code            -- controlled vocabulary
reason_text            -- human-readable explanation
terms_version_id       -- exact rules used
rule_reference         -- rule_id, clamp values, observed values
evidence_document_id[] -- immutable references
model_contributions    -- optional flag/model inputs, never sole basis
decided_by             -- human user_id
decided_at             -- UTC timestamp
appeal_expiry_at
```

Reason codes must be structured. Examples:

- `BREACH_MAX_DRAWDOWN`
- `BREACH_DAILY_LOSS`
- `TARGET_MET`
- `TRAILING_DRAWDOWN_VIOLATION`
- `LATENCY_STALE_FEED`
- `UNAPPROVED_AUTOMATION`
- `COORDINATED_TRADING_EVIDENCE`
- `KYC_INCOMPLETE`
- `DATA_RECONCILIATION_FAILURE`
- `NOT_ELIGIBLE_CAPITAL_INTERNAL` — not a rejection of contractual payout eligibility.

“`NOT_ELIGIBLE_CAPITAL_INTERNAL`” must not be used to deny a promised payout. It is a separate internal-allocation status.

## 4.6 Appeal and correction

- Trader may view non-security/minimally redacted evidence summaries.
- The same reviewer must not decide the appeal.
- The appeal reviewer must be independent and bound by the same accepted terms.
- An overturned rejection must create a correction record and pay eligible amounts with interest, if any, per contract.
- Audit logs must capture every transition, actor, timestamp, and evidence hash.

---

# 5. Exact data model and entity relationships

This is an initial model. Table names and columns are illustrative but firm enough to implement.

## 5.1 Core identity/account

`auth_user`
- `id uuid PK`
- `email_domain_hash`
- `password_hash` or external OIDC subject
- `mfa_enabled bool`
- `created_at`
- `last_login_at`

`person`
- `id uuid PK`
- `auth_user_id FK`
- `legal_name_ciphertext`
- `country_code`
- `kyc_status`
- `risk_region`
- `retention_class`

`device`
- `id uuid PK`
- `person_id FK`
- `device_fingerprint_hash`
- `first_seen_at`
- `last_seen_at`
- `mfa_risk_level`

`session`
- `id uuid PK`
- `auth_user_id FK`
- `ip_hash`
- `user_agent_hash`
- `created_at`
- `revoked_at`
- `revocation_reason`

`api_token`
- `id uuid PK`
- `person_id FK`
- `scope_text[]`
- `token_hash_sha256`
- `key_fingerprint`
- `expires_at`
- `rotated_at`
- `revoked_at`
- `rate_limit_rps`

## 5.2 Trading account and challenge

`trading_account`
- `id uuid PK`
- `person_id FK`
- `provider_id`
- `external_account_id_ciphertext`
- `account_kind` — demo, simulated, live, internal
- `base_currency`
- `created_at`

`challenge_product`
- `id uuid PK`
- `name`
- `phase_count`
- `funding_structure`
- `published_terms_version_id`

`terms_version`
- `id uuid PK`
- `product_id FK`
- `version_no`
- `effective_from`
- `content_sha256`
- `published_by`
- `legal_approval_ref`

`rule_definition`
- `id uuid PK`
- `name`
- `data_type`
- `formula_ref`
- `description`

`rule_policy`
- `id uuid PK`
- `terms_version_id FK`
- `rule_definition_id FK`
- `params_jsonb`
- `effective_from`

`challenge_instance`
- `id uuid PK`
- `trading_account_id FK`
- `product_id FK`
- `terms_version_id FK`
- `rule_policy_id FK`
- `stage`
- `state`
- `started_at`
- `objective_met_at`
- `balance`
- `equity`

`accepted_terms`
- `id uuid PK`
- `challenge_instance_id FK`
- `terms_version_id FK`
- `accepted_at`
- `acceptance_token`
- `ip_hash`
- `content_hint`

`objective`
- `id uuid PK`
- `challenge_instance_id FK`
- `stage`
- `metric`
- `target`
- `comparison_operator`
- `observed_value`
- `satisfied_at`

## 5.3 Trading events

`order`
- `id uuid PK`
- `trading_account_id FK`
- `external_order_id`
- `source_event_id`
- `symbol`
- `side`
- `quantity`
- `order_type`
- `limit_price`
- `stop_price`
- `target_price`
- `time_in_force`
- `status`
- `created_at`
- `updated_at`

`fill`
- `id uuid PK`
- `order_id FK`
- `execution_id` — unique
- `price`
- `quantity`
- `fill_time`
- `commission`
- `swap`
- `spread_bps`
- `slippage_bps`
- `decision_price` — when available

`position`
- `id uuid PK`
- `trading_account_id FK`
- `symbol`
- `direction`
- `total_qty`
- `avg_entry_price`
- `opened_at`
- `closed_at`
- `closed_pnl`

`position_snapshot`
- `id uuid PK`
- `position_id FK`
- `qty`
- `mark_price`
- `notional`
- `margin`
- `equity`
- `recorded_at`

## 5.4 Reviews and decisions

`review_case`
- `id uuid PK`
- `challenge_instance_id FK`
- `status`
- `assigned_to`
- `due_at`
- `opened_at`
- `closed_at`

`review_event`
- `id uuid PK`
- `review_case_id FK`
- `actor_id`
- `transition`
- `from_state`
- `to_state`
- `timestamp`

`review_decision`
- `id uuid PK`
- `review_case_id FK`
- `outcome`
- `reason_code`
- `reason_text`
- `terms_version_id`
- `rule_policy_id`
- `evidence_hashes[]`
- `decided_by`
- `decided_at`

`review_evidence`
- `id uuid PK`
- `review_case_id FK`
- `type`
- `source_entity_id`
- `source_hash`
- `visible_to_trader` — boolean
- `redacted_summary`

`appeal`
- `id uuid PK`
- `review_decision_id FK`
- `requested_at`
- `reason`
- `status`
- `decided_by`
- `decided_at`

## 5.5 Metrics and models

`metric_run`
- `id uuid PK`
- `scope_type`
- `scope_id`
- `model_version`
- `input_sha256`
- `data_window_start`
- `data_window_end`
- `created_at`

`prob_estimate`
- `id uuid PK`
- `metric_run_id FK`
- `metric_name`
- `value` — can be null for insufficient evidence
- `credible_low`
- `credible_high`
- `ci_level`
- `horizon`
- `sample_size`
- `effective_sample_size`
- `calibration_status`
- `contributors_jsonb`
- `data_warnings_jsonb`

`flag_definition`
- `id uuid PK`
- `flag_code`
- `severity_default`
- `description`
- `required_evidence`
- `reviewer_actions`

`flag_case`
- `id uuid PK`
- `entity_type`
- `entity_id`
- `flag_code`
- `severity`
- `confidence`
- `evidence_jsonb`
- `status`
- `disposition`
- `reviewer_id`
- `created_at`

## 5.6 Risk, payout, capital

`risk_limit`
- `id uuid PK`
- `risk_policy_id FK`
- `dimension` — account, symbol, trader, strategy-cluster, provider, global
- `operator`
- `value`
- `hard_or_soft`

`kill_switch`
- `id uuid PK`
- `scope_type`
- `scope_id`
- `target`
- `enabled`
- `reason`
- `enabled_by`
- `expires_at`

`internal_capital_decision`
- `id uuid PK`
- `trader_id FK`
- `review_case_id FK`
- `amount`
- `risk_budget`
- `status` — draft, proposed, approved, rejected, active, suspended
- `approved_by`
- `approved_at`
- `risk_committee_ref`

`payout_request`
- `id uuid PK`
- `contract_id`
- `trader_account_id FK`
- `amount`
- `status`
- `review_decision_id`

`payout_payment`
- `id uuid PK`
- `payout_request_id FK`
- `processor_ref`
- `paid_at`
- `amount`
- `currency`

## 5.7 Replication

`broker_account`
- `id uuid PK`
- `provider_id`
- `account_ref_ciphertext`
- `permission_document_id`
- `automation_permitted_until`
- `api_mode`
- `netting_mode`

`replication_event`
- `id uuid PK`
- `source_event_id`
- `source_account_id`
- `source_sequence`
- `copy_request_id`
- `source_event_type`
- `payload_jsonb`
- `schema_version`
- `status`
- `idempotency_key_hash`

`dest_order`
- `id uuid PK`
- `replication_event_id FK`
- `broker_account_id FK`
- `external_order_id`
- `status`
- `filled_qty`
- `avg_fill_price`
- `error_code`

`reconciliation_run`
- `id uuid PK`
- `broker_account_id FK`
- `source_account_id`
- `window_start`
- `window_end`
- `match_status`
- `mismatch_jsonb`
- `recorded_at`

## 5.8 Audit

`audit_event`
- `id uuid PK`
- `actor_id`
- `action`
- `entity_type`
- `entity_id`
- `before_sha256`
- `after_sha256`
- `ip_hash`
- `created_at`
- `prev_hash`
- `event_hash`

`audit_event.event_hash = SHA-256(prev_hash + canonical(current_fields))`

This makes the log tamper-evident. No user, including admins, may update deleted audit rows.

---

# 6. Exact metric definitions, formulas and examples

All model outputs carry:

- horizon;
- model version;
- timestamp;
- sample size `n`;
- effective sample size `n_eff`;
- 95% confidence/credible interval;
- cohort;
- data warnings;
- calibration status;
- interpretable contributors.

If evidence is insufficient, `value` must be `null` and `status = insufficient_evidence`.

## 6.1 Daily return series

Mark-to-market account equity adjusted for external flows:

\[
E_t = \text{equity at end of period }t,\quad F_t = \text{net external flow during }t
\]

A deposit into the account is positive flow from the account owner’s perspective; use a consistent sign convention.

\[
R_t = \frac{E_t - E_{t-1} - F_t}{E_{t-1}}
\]

If `E_{t-1} <= 0`, stop all calculations and record a breach/capital loss event.

Use daily account returns, not only closed-trade returns. Trade-only returns understate open-position volatility and gap risk.

## 6.2 Trade P&L after costs

For each closed trade idea \(i\):

\[
\text{PnL}_i = \sum_j \text{cash proceeds}_{ij} - \text{commissions}_i - \text{swap}_i - \text{spread cost estimate}_i - \text{slippage cost estimate}_i
\]

Where available, use actual costs first. If costs are missing, mark `data_quality` penalty and do not treat zero-cost return as actual.

## 6.3 Profitability metrics

### Net P&L

\[
\text{NetPnL} = \sum_i \text{PnL}_i
\]

### Profit factor

\[
\text{PF} = \frac{\sum_{i: \text{PnL}_i>0} \text{PnL}_i}{\sum_{i: \text{PnL}_i<0} |\text{PnL}_i|}
\]

If there are no losses, output `PF=null` with `data_warning = "no_losses"`; never `∞`.

### Expectancy

\[
E[\text{PnL}] = \frac{1}{n}\sum_i \text{PnL}_i
\]

Include 95% bootstrap CI. If costs are unmodeled, show `cost_unadjusted` and `cost_adjusted`.

### Win rate

\[
\text{WinRate} = \frac{\#\{\text{PnL}_i>0\}}{n}
\]

Use only closed trade ideas. Do not rely on win rate alone.

### Payoff ratio

\[
\text{Payoff} = \frac{\text{mean positive PnL}}{\text{mean absolute negative PnL}}
\]

Undefined if negative PnL mean is zero.

## 6.4 Risk and return-quality metrics

### Annualized volatility

\[
\sigma_d = \sqrt{\frac{1}{n-1}\sum_t (R_t-\bar R)^2}
\]

\[
\sigma_{ann} = \sigma_d \sqrt{A}
\]

where \(A\) is the instrument calendar trading-day count, e.g. 252 for typical FX/equity, 365 for crypto if continuously traded.

### Downside deviation

\[
\sigma_{down,d} = \sqrt{\frac{1}{n}\sum_t \min(R_t - \text{MAR}_d, 0)^2}
\]

Default MAR = 0. Annualize with \(\sqrt{A}\).

### Sharpe ratio

On daily returns:

\[
S = \frac{\bar R_d - r_{f,d}}{\sigma_d}\sqrt{A}
\]

Use a short-horizon appropriate risk-free series or zero. Report standard error and CI; annualized Sharpe is noisy. See Lo (2002) for Sharpe interval methods.

### Sortino ratio

\[
S_{sort} = \frac{\bar R_d - r_{f,d}}{\sigma_{down,d}}\sqrt{A}
\]

### Maximum drawdown

Peak-equity drawdown:

\[
\text{DD}_t = \frac{E_t}{\max_{s \le t} E_s} - 1
\]

\[
\text{MaxDD} = \min_t \text{DD}_t
\]

### Drawdown duration

Calendar and active trading days from prior peak until equity recovers above that prior peak. Report longest duration and current drawdown.

### Exposure

\[
\text{Gross}_t = \frac{\sum_j |\text{notional}_{j,t}|}{E_t}
\]

\[
\text{Net}_t = \frac{\sum_j \text{directional notional}_{j,t}}{E_t}
\]

Notional = `quantity × price × contract multiplier × FX conversion`.

### Concentration

HHI over absolute gross notional:

\[
H_t = \sum_j \left(\frac{|\text{notional}_{j,t}|}{\sum_k |\text{notional}_{k,t}|}\right)^2
\]

Report top-1, top-3 instrument share.

### Position-size stability

Use risk-size proxies:

\[
s_i = |q_i| \times \text{stop distance}_i
\]

If no stop, use realized volatility × holding-period horizon as a proxy, flagged `stop_missing`.

\[
\text{CV}_{size} = \frac{\sigma(s_i)}{\bar s_i}
\]

### Holding time

For closed ideas:

\[
\text{HP}_i = \text{last exit time}_i - \text{first entry time}_i
\]

Report median and p90.

### Best-day concentration

\[
\text{BestDayShare} = \frac{\max(\text{NetPnL}_t,0)}{\sum_t \max(\text{NetPnL}_t,0)}
\]

### Spread/slippage sensitivity

Signed slippage per fill:

\[
\text{slip}_{ij} = \text{side}_{ij}\left(\frac{\text{fill price} - \text{decision mid}}{\text{decision mid}}\right)
\]

Report median, p95, and estimated P&L impact.

### Gap/news exposure

For scheduled high-impact news and weekend closures:

\[
\text{NewsExposure}_t = \frac{\sum_{\text{event symbols}} \text{notional}_{j,t}}{E_t}
\]

Report count of periods where the trader held through high-volatility events and resulting tail P&L.

## 6.5 Probabilistic performance estimates

### Probability of positive net P&L over horizon H

Use overlapping block bootstrap over daily returns, with horizon H defined in trading days.

For \(B=5{,}000\) resamples:

\[
P_{\text{pos}} = \frac{1}{B}\sum_{b=1}^B \mathbf{1}\left(\sum_{h=1}^{H} R^{(b)}_{t+h} > 0\right)
\]

Use a 95% percentile interval. Block length must be selected from significant autocorrelation and validated by simulation. Do not use IID bootstrap on strongly clustered returns.

### Probability of passing current challenge stage

This is path-dependent. Use Monte Carlo challenge-path simulation with current state:

- current equity `E0`;
- distance to target;
- current drawdown;
- daily loss limit;
- trailing drawdown rule;
- remaining time;
- modeled daily-return distribution;
- current open-position risk-factor exposure;
- cost/slippage distribution.

\[
P_{\text{pass}} = \frac{1}{M}\sum_{m=1}^M \mathbf{1}\left(\text{path }m \text{ hits target before breach or expiry}\right)
\]

Use \(M\) sufficient that Monte Carlo standard error is below 0.5 percentage points.

### Probability of first payout

A payout path includes:

1. pass current challenge stage;
2. review approval for payout eligibility;
3. provider funding/activation;
4. reach contractual payout threshold;
5. payment processor success.

\[
P_{\text{payout}} = \int_{\theta} P_{\text{pass}}(\theta)P_{\text{approval}|\text{pass},\theta}P_{\text{funded|laws,history}}P_{\text{threshold|funded},\theta}P_{\text{pay|threshold}}
\]

If internal capital allocation is separate and not contractually promised, report it separately.

### Probability of rule/drawdown breach

Same Monte Carlo structure, but indicator is hitting a rule breach before target/expiry.

### Risk of ruin

Do not use a naive binary gambler’s-ruin formula as primary output. If used, it must satisfy:

- fixed binomial payoff;
- constant position risk;
- independent trials;
- no stop/gap blowouts.

\[
p_{\text{ruin}} \approx \left(\frac{1-p_e}{1+p_e}\right)^{E/\text{risk unit}}
\]

Where \(p_e\) is win probability under fixed fractional risk. Because real markets violate these assumptions, primary risk-of-ruin must come from path simulation with gap jumps and costs.

### Execution/copyability score

Shadow/replay-based:

\[
\text{Copyability} = 100 \times \text{clamp}_{[0,1]}\left(\frac{\text{median destination net PnL}}{\text{median source net PnL}}\right)
\]

When denominator is non-positive or unavailable, output `null` and `status = shadow_data_insufficient`.

Components displayed:

- liquidity percentile per instrument;
- median delay \(\delta_{50}\) and \(\delta_{95}\);
- reject rate;
- gap/news exposure;
- cancel/rewrite frequency;
- average spread cost.

Exact formula for delay penalty, if using an estimated pre-live score:

\[
\text{copyability}_\text{pre} = 100 - w_1 f(\text{slippage}) - w_2 f(\text{latency}) - w_3 f(\text{news/gap}) - w_4 f(\text{rejects})
\]

Weights and penalty functions must be fit on shadow results and versioned. Do not ship unvalidated weights.

## 6.6 Evidence-confidence score

This is a continuous confidence score, not a pass/fail cutoff.

\[
C_{\text{evidence}} =
0.30(1-e^{-n_{\text{ideas}}/k_n})
+0.25(1-e^{-d_{\text{trading}}/k_d})
+0.20(1-e^{-n_{\text{eff}}/k_e})
+0.15\,R_{\text{regime}}
+0.10(1-g_{\text{data}})
\]

Where:

- \(n_{\text{ideas}}\): independent trade-idea count.
- \(d_{\text{trading}}\): number of distinct active trading days.
- \(n_{\text{eff}}\): effective sample size.
- \(R_{\text{regime}}\): 0–1 coverage across volatility/session/regime buckets.
- \(g_{\text{data}}\): missing-data penalty rate.
- \(k_n,k_d,k_e\): scale parameters chosen by validation to match CI-width objectives.

No single number grants a payout or allocation.

## 6.7 Effective sample size

For autocorrelated series:

\[
n_{\text{eff}} = \frac{n}{1 + 2\sum_{k=1}^{K}\rho_k}
\]

Where \(\rho_k\) is the lag-k autocorrelation of the relevant P&L or return series. Use a sign-preserving block bootstrap alternative if autocorrelation is unstable.

For win/loss trade sequence, effective trial count can be penalized by trade dependence:

\[
n_{\text{eff,trades}} \le n_{\text{ideas}}
\]

## 6.8 Data-quality score

Component penalties:

| Failure | Penalty |
|---|---|
| Duplicate order/fill IDs | 0.30 |
| Missing critical timestamp | 0.25 |
| Reconciliation mismatch unresolved | 0.30 |
| Missing commission/swap/funding | 0.20 |
| Missing decision/mid price | 0.15 |
| Stale equity snapshot | 0.20 |
| Symbol unsupported/unmapped | 0.30 |

\[
DQ = \max(0, 1 - \text{sum of applicable penalties})
\]

Classify:

- `DQ >= 0.90`: high;
- `0.70–0.89`: medium;
- `< 0.70`: low.

Low data quality cannot support allocation-grade probabilities.

## 6.9 Expected value to iPFX

For each allocation candidate over horizon H:

\[
EV_H = \text{fees}_H + E[\text{profit share}_H] - E[\text{payout liability}_H] - \text{operating cost}_H - \text{capital charge}_H - \text{tail loss allowance}_H - \text{provider/default cost}_H
\]

Where:

\[
\text{capital charge}_H = \rho \times \text{allocated risk capital}
\]

or:

\[
\text{capital charge}_H = \text{VaR}_{99,H} \times \text{hurdle}
\]

Use Monte Carlo distributions because all terms are uncertain. “Costly to iPFX” must never alter contractual payout eligibility.

## 6.10 Missing-data and edge-case behavior

- Never fabricate a probability.
- If daily equity is unavailable, derive from initial balance + audited fills/ledger and lower `DQ`.
- Missing timestamps: exclude affected rows from time-based metrics; do not impute.
- Duplicate events: deduplicate by idempotency key; if conflicting, quarantine the trade.
- Partial fills: use filled quantity only; do not assume unfilled quantity is executable.
- Negative equity or missing balances: halt evaluation and escalate.
- Zero variance returns: do not compute Sharpe/Sortino; mark `undefined`.
- One-sided trade P&L: PF/Payoff may be undefined.
- Symbols with unknown contract multiplier: no notional exposure calculation; mark `DQ`.
- Insufficient evidence: all probabilities return `null`, `status = insufficient_evidence`, with width of credible interval shown as incomplete.

---

# 7. Statistical evaluation, evidence sufficiency and validation

## 7.1 Why ten trades, high win rate, or halfway progress is not enough

- For 8 wins in 10 trades, the 95% Wilson interval is approximately **49%–94%**. That is not evidence of a robust edge.
- Win rate says nothing about average win/loss ratio. A trader can lose more on one loss than earned on many wins.
- Ten trades are rarely independent. Ten trades on EURUSD in one session may represent one market call, so effective sample size is far below 10.
- Halfway to a profit target is a path-state, not evidence. Future path probability depends on daily volatility, drawdown distance, remaining time, costs, gap risk, and behavior change.
- High win rate can be produced by holding winners and failing to close losers, or by selling tail-risk options-like profiles. Those can be catastrophically copying-incompatible.

## 7.2 Evidence-sufficiency procedure

Use:

- independent trade-idea count;
- trading-day count;
- effective sample size;
- regime coverage;
- concentration;
- credible-interval width;
- out-of-sample stability.

No fixed universal minimum trade count. Instead: if the 95% credible interval for a probability or net-PnL estimate excludes the economically meaningful null region, and the effect is stable across split-half or rolling out-of-sample windows, evidence is sufficient for decision class X.

Decision classes:

1. Display-only exploratory metrics: broad CI allowed.
2. Flag generation: wider FPR tolerated with human review.
3. Capital allocation: require narrower CI, calibration, and regime coverage.
4. Contractual payout denial: deterministic rule evidence or documented fraud; no statistical model alone.

## 7.3 Bayesian shrinkage

For trader daily mean returns:

\[
\mu^\text{shrunk}_i =
\frac{\frac{n_i}{\hat\sigma_i^2}\hat\mu_i + \frac{1}{\tau^2}\mu_0}
{\frac{n_i}{\hat\sigma_i^2} + \frac{1}{\tau^2}}
\]

For win rates, use Beta-Binomial:

\[
p^\text{shrunk}_i = \frac{\alpha_0 + w_i}{\alpha_0+\beta_0+n_i}
\]

Where \(w_i\) is win count and cohort prior \((\alpha_0,\beta_0)\) is fitted from a defined cohort.

## 7.4 Block bootstrap

- Use moving-block or stationary bootstrap.
- Select block length by autocorrelation and variance-cluster behavior.
- Validate nominal coverage of CIs under synthetic data.
- Bootstrap account-level daily returns, not individual trades if positions overlap.

## 7.5 Cohort baselines

Cohorts should be narrow enough to be informative but broad enough to avoid overfitting:

- product family;
- instrument class;
- trading session;
- account denomination range;
- volatility regime bucket;
- geography/trader type where legal and not discriminatory.

Cohort baselines must be updated daily and versioned.

## 7.6 Survival/path simulation

Full challenge path simulation requires these inputs:

- current equity;
- current open position risk-factor mapping;
- inferred daily return distribution;
- residual variance;
- cost distribution;
- remaining calendar time;
- all active rule constraints.

Use historical regime weighting. If a trader has never traded a high-volatility regime, do not extrapolate silently; report `regime_missing`.

## 7.7 Out-of-sample validation

- Every flag/score/model enters validation on historical data and then a time out-of-sample holdout.
- For probability outputs, compute Brier score and log loss.
- For binary decisions, compute calibration curve, PR-AUC, false-positive and false-negative rates.
- Track model drift with PSI/KL against training distribution.
- A live model that is uncalibrated is displayed as `uncalibrated` and cannot be used for capital allocation.

## 7.8 Calibration status

A probability model is `calibrated` only if:

- mean predicted probability by decile is within the observed frequency CI;
- calibration test is passed on a pre-registered out-of-sample window;
- no substantial drift in features;
- CI is not excessively wide for the intended use.

---

# 8. Strategy-hypothesis framework

The system must never assert “the trader used RSI” because trades resemble it. It may only label an observed, versioned **hypothesis** with evidence, contradictory evidence, alternatives, and confidence.

## 8.1 Hypothesis definitions and evidence

| Hypothesis | Supporting observable evidence | Common alternative explanations |
|---|---|---|
| Trend following | Positive P&L when entry direction matches higher-timeframe trend; winners held longer; positive correlation with trend continuation. | Momentum, beta exposure, luck in one trend session. |
| Momentum | Entry after short-term continuation; better P&L on high-momentum names; short holding. | Trend following, news drift, liquidity provision. |
| Mean reversion | Negative P&L autocorrelation; profits after short-term adverse moves; entry near range extremes. | Bid-ask bounce, delayed fill, reversal whipsaw. |
| Breakout | Entry near range/volatility bands; conditional P&L after breakouts. | News trading, stop-run, liquidity cascade. |
| Event exposure | Clustering around economic calendar; gap P&L over events. | Public news scalping, market-making. |
| Grid | Multiple limit orders along price ladder; repeated scale-ins/outs. | Position scaling, hedging, order-book-making. |
| Martingale | Position size increases after losses. | DCA, portfolio rebalancing. |
| Averaging down | Adding to losing position without new edge. | Grid, value averaging, reversal. |
| Scalping | Median holding time below minutes; high trade count; cost-sensitive P&L. | Hyperactive execution, latency trading. |
| Latency sensitivity | Large difference between decision and fill P&L under replay delays. | Slippage, illiquid instruments. |
| Session behavior | P&L concentration by session/day/time. | Trader availability, market regime. |
| Correlated-pair trading | Simultaneous opposite positions in correlated symbols; spread P&L more stable than legs. | Index/basket arbitrage, sector hedge. |
| Hyperactive order behavior | High cancel/rewrite ratio; low fill-to-order ratio. | Algo execution, quote negotiation. |

## 8.2 Evidence extraction

For each hypothesis, define a contrast:

\[
\Delta = \text{mean outcome in hypothesized condition} - \text{mean outcome in non-condition}
\]

Report:

- effect size;
- 95% CI;
- effective sample size;
- q-value after multiple-testing correction;
- out-of-sample repeatability;
- contradictory evidence count.

## 8.3 Confidence labels

Define confidence by CI, replication, and multiplicity-corrected q-value:

- `no_signal`: CI includes zero.
- `weak`: CI excludes zero in-sample only.
- `moderate`: CI excludes zero in-sample and out-of-sample single split.
- `strong`: replicated across non-overlapping windows and not explained by simpler alternative.

No strategy label is proof of intent or future performance.

---

# 9. Flag catalogue and similarity-detection framework

A flag is **evidence for review**, never proof, and never an automatic failure.

## 9.1 Similarity-detection inputs

For each pair of trades or account events:

- normalized instrument: base symbol, product class, exchange;
- side;
- entry and exit timestamps;
- price proximity normalized by volatility;
- stop/target distance similarity;
- size ratio;
- holding-time similarity;
- sequence similarity;
- rolling window alignment;
- market-event proximity;
- graph-cluster membership.

## 9.2 Similarity score

For pair \((i,j)\):

\[
s_{\text{time}} = e^{-\lambda_t \Delta t}
\]

\[
s_{\text{price}} = e^{-\lambda_p |p_i - p_j|/\sigma_{ATR}}
\]

\[
s_{\text{size}} = e^{-\lambda_s|\log(q_i/q_j)|}
\]

\[
s_{\text{stop}} = e^{-\lambda_{st}\max(|d_i-d_j|/ATR, |u_i-u_j|/ATR)}
\]

\[
s_{\text{hold}} = e^{-\lambda_h|\log(HP_i/HP_j)|}
\]

Combine:

\[
s_{ij} = w_1 s_{\text{time}} + w_2 s_{\text{price}} + w_3 s_{\text{size}} + w_4 s_{\text{stop}} + w_5 s_{\text{hold}}
\]

Any thresholds must be chosen by cohort permutation to control false-positive rate, not by intuition.

## 9.3 Cohort normalization

Build a null distribution for matched instrument/session/volatility event windows. Compare observed similarity to the null:

\[
z_{ij} = \frac{s_{ij} - \hat\mu_{\text{null}}}{\hat\sigma_{\text{null}}}
\]

Correct for multiple testing with Benjamini-Hochberg FDR, not Bonferroni alone.

## 9.4 Graph clustering

Where pairwise similarity is frequent:

- build graph of accounts/trades;
- edge when similarity z-score exceeds calibrated threshold;
- run Leiden/DBSCAN or other deterministic clustering;
- compare cluster size and prevalence to matched-population null.

## 9.5 Flag catalogue

Each flag includes: code, severity, confidence, evidence refs, model/rule version, innocent explanations, reviewer actions, status, disposition, false-positive feedback.

| Flag | Detection concept | Severity | Innocent alternative |
|---|---|---|---|
| `FLG_SIM_TIME_PRICE` | Similar entry time and price beyond cohort null | High if cluster | Same public signal/live class |
| `FLG_SIM_SIG_FLOW` | Similar stop/target/size ratios | High | Common strategy template |
| `FLG_SHARED_DEVICE` | Same device fingerprint across accounts | Medium | Shared household/device |
| `FLG_SAME_IP_ACTIVITY` | Same IP with divergent identities | Medium | Corporate network, VPN |
| `FLG_STALE_FEED_EXPLOIT` | Fill-price dependent on stale provider quote | High | Good execution |
| `FLG_LATENCY_ARB` | PnL vanishes when adding realistic delay | High | Scalper/market-maker |
| `FLG_HYPERACTIVE_ORDER` | Extreme cancel/order ratio, low fill ratio | Medium | Algo order management |
| `FLG_UNREALISTIC_FILL` | Limit orders always filled at touch or better | High | Deep liquid markets |
| `FLG_NEWS_WINDOW` | Repeated high-volatility event exposure | Medium | Event strategy |
| `FLG_GAP_EXPLOIT` | Overweight positions around gaps | Medium | Informed macro trader |
| `FLG_CROSS_ACCOUNT_HEDGE` | Opposite correlated positions across controlled accounts | High | Independent accounts |
| `FLG_ACCOUNT_ROLLING` | Repeated reset/new identity after breach | High | Legitimate new challenge |
| `FLG_MARTINGALE` | Size increases after losing streaks | Medium | Portfolio averaging |
| `FLG_LEVERAGE_ESCALATION` | Sudden notional increase after loss | High | Volatility compression |
| `FLG_CORRELATED_OVEREXPOSURE` | Many traders same direction same instrument | High | Common market signal |
| `FLG_STOP_MANIPULATION` | Tight stop triggered then reversal | Medium | At-market execution |
| `FLG_SIZE_RATIO_STABLE` | Fixed size ratio across accounts | High | Same capital scaling |
| `FLG_API_ABUSE` | Scoped token used beyond scope/rate | High | Misconfig |
| `FLG_PAYOUT_FRAUD` | Multiple identities/payment account reuse | High | Shared household |
| `FLG_CHARGEBACK_FRAUD` | Payment dispute pattern | High | Service issue |
| `FLG_DATA_TAMPERING` | Hash mismatch, edited record | Critical | ETL bug |

Every flag disposition:

- `open`
- `in_review`
- `confirmed`
- `false_positive`
- `escalated`
- `remediated`
- `closed`

False-positive feedback logs the conditions under which the flag fired and the reviewer’s reason for clearing it. These labels become retraining/test data.

## 9.6 Multiple-testing control

Because thousands of trader pairs are compared daily, set a pre-registered false-discovery target, e.g.:

- routine similarity monitoring: FDR ≤ 5%;
- capital-allocation gate flags: FDR ≤ 1% or use more conservative thresholds.

No automatic account failure based on similarity. Alerts must be triage.

---

# 10. Owner-dashboard information architecture

## 10.1 Access model

- Owner/admin roles only.
- Server-side authorization for every route and API.
- MFA required.
- Short-lived session plus HTTP-only secure cookies.
- Supabase RLS as an additional layer, never as the only layer.
- Service-role secrets only in trusted server functions.
- Client-side hiding never counts as authorization.
- All reads are logged.
- Sensitive PII is masked by default and opened only with a reason.

## 10.2 Screens

### Owners console

- global exposure;
- aggregate payout liability;
- aggregate copied losses;
- revenue and fees;
- active challenges by stage;
- review queue;
- high-priority alerts;
- capital-review cases;
- syncer latency p50/p95/p99;
- reconciliation mismatches;
- provider status.

### Trader list

Columns:

- masked name/ID;
- country/region;
- product/stage/state;
- accepted rule version;
- account age;
- equity;
- net PnL after costs;
- max drawdown;
- profit factor;
- expectancy;
- review status;
- flag count by severity;
- payout history;
- last activity.

### Trader profile

Dense institutional dark layout with:

- Summary band: equity, balance, net P&L, product, stage, terms version, review status.
- Identity/KYC panel: masked identifier, country, KYC status, risk region, account relationships.
- Challenge panel: accepted terms hash, rule snapshot, stage, target/limits, elapsed time.
- Performance panel: metrics with CI, model version, warnings.
- Probability panel: horizon, value, interval, n, n_eff, calibration, contributors.
- Trade-idea table: open/close times, instrument, side, executed price, stop/target, net P&L, costs, holding time, flags.
- Orders and fills: order ID, position ID, execution ID, source ID, type, status, rejection reason.
- Exposure/concentration panel: gross, net, top symbols, HHI.
- Drawdown timeline.
- Payout and review history.
- Flags/model results.
- Audit log.

Design tokens:

- background near-black `#0B0E11`;
- panels `#11151B`;
- labels muted grey `#8B99A6`;
- main text white `#F5F7FA`;
- focus constrained blue `#2F6FED`;
- buys/profits green `#2EBE86`;
- sells/losses red `#E45555`;
- numeric alignment: tabular-nums, right-aligned money, no ambiguous abbreviations;
- all colors paired with text/icons for accessibility.

## 10.3 PII minimization

- Owner dashboard defaults to masked email/phone/name.
- Full details require a one-time reason and are audit-logged.
- KYC documents opened from a separate protected endpoint with watermarking where possible.
- PII fields encrypted at rest with key per environment.
- Retention periods must be defined; no indefinite raw identity cache.

---

# 11. Alert architecture

## 11.1 Alert classes

| Alert | Trigger | Severity |
|---|---|---|
| Near failure | Trader within x% of daily loss/max drawdown | Medium |
| Severe drawdown | Down x% in day | High |
| High-priority review | Review deadline risk | High |
| Suspicious similarity | Cluster z-score | High |
| Behavior change | Metric distribution shift | Medium |
| Capital-review eligibility | Model creates case | Low |
| Reconciliation mismatch | Unreconciled P&L/positions | Critical |
| Provider rejects | Repeated order rejects | High |
| Stale data | No heartbeat or time lag > threshold | Critical |
| Copier latency | p99 > SLO | High |
| Loss-limit breach | Breached soft/hard limit | Critical |
| Provider permission expiry | Expiring written permission | High |
| Model drift | PSI/calibration degradation | Medium |
| Payout-liability stress | Reserve coverage < threshold | High |
| Security anomaly | Impossible travel, session compromise | Critical |

## 11.2 Delivery channels

- owner email;
- SMS for critical only;
- push for verified devices;
- in-app for all owners.

All channels opt-in where required. Test mode must clearly label alerts.

## 11.3 Deduplication, cooldown, throttling

- Dedup key: `alert_type + scope + severity_band + normalized evidence hash`.
- Cooldown: same key muted for the configured window unless severity increases.
- Throttle: maximum N alerts per channel per owner per hour/day.
- Quiet hours configured per recipient.
- Acknowledgement required for high/critical; unacked escalates after X minutes.

## 11.4 Delivery records

Every alert records:

- recipient;
- channel;
- send attempt;
- provider response;
- retry count;
- delivery timestamp;
- ack timestamp;
- ack actor.

Failures go to a dead-letter queue and operational pager.

---

# 12. Trade Syncer architecture, failure modes and controls

## 12.1 Legal boundary

The Trade Syncer may copy only to an account owned or controlled by iPFX where the broker/prop provider has **expressly permitted API automation and replication in writing**.

It must not:

- share credentials between traders and destination accounts;
- impersonate traders;
- evade provider or challenge rules;
- pass third-party challenges as a service;
- automatically purchase external challenges;
- use “stealth” or anti-detection techniques.

## 12.2 Logical components

1. Source ingress: authenticated trader/source-provider event stream.
2. Durable event log/outbox.
3. Schema validation.
4. Permission and source-eligibility service.
5. Pre-trade risk engine.
6. Symbol mapper.
7. Risk-normalized sizing.
8. Destination rule/authorization gate.
9. Provider adapter.
10. Ack/fill/reconciliation worker.
11. Kill-switch and control plane.
12. Monitoring and audit.

## 12.3 Event flow

```
SourceEvent
  → SourceIngestor (authn/authz)
  → DurableEventLog (idempotency)
  → SchemaValidator
  → EligibilityService
  → PreTradeRisk
  → SymbolMapper
  → SizeNormalizer
  → DestinationRuleCheck
  → AuthorizationGate
  → ProviderAdapter
  → DestinationAck
  → ReconciliationWorker
  → AuditEvent
```

## 12.4 Idempotency and ordering

- Unique key: `(source_event_id, source_account_id, event_type)`.
- `copy_request_id` generated once per copy intention.
- Provider-facing order sends use idempotency keys where provider supports.
- State machine tracks `new`, `validated`, `approved`, `sent`, `ack`, `filled`, `cancelled`, `rejected`, `reconciled`.
- Reordered events: buffer by source sequence; do not act out-of-order on open/close/modify.
- Duplicate events: return existing copy request without new order.

## 12.5 Pre-trade risk

Checks:

- global kill switch;
- provider kill switch;
- account kill switch;
- allocation switch;
- symbol switch;
- trader switch;
- max gross/notional by scope;
- max per-symbol notional;
- price band staleness;
- margin check;
- daily-loss limit;
- duplicate-close prevention.

Any failure marks the copy request `blocked` with reason.

## 12.6 Symbol mapping

Canonical instrument:

```
base_asset
product_class
exchange/venue
denomination currency
```

Provider mapping resolves suffix, contract size, tick/min increment, margin, hedging/netting, session hours, and spread/commission characteristics.

Examples of suffixes that must be mapped deterministically:

- `EURUSD.fx`, `EURUSD=`, `EURUSD_otc`, `EURUSD.cfd`;
- futures rolls;
- crypto denominated in USDT/USD/COIN.

Mapping changes are versioned and tested in shadow mode before live.

## 12.7 Risk-normalized sizing

If source gives explicit stop:

\[
\text{dest risk units} = \text{source risk fraction} \times \text{dest equity}
\]

\[
\text{size} = \frac{\text{dest risk units}}{\text{stop distance} \times \text{point value}}
\]

If stop is missing:

\[
\text{stop proxy} = k \times \sigma_{\text{ATR}} \times \sqrt{H}
\]

with a conservative \(k\) and \(H\), and marked `stop_proxy`. Size is rounded down to lot minimum and capped by:

- destination margin leverage cap;
- per-symbol ADV cap;
- account concentration limit.

Never scale purely by source notional if underlyings or account sizes differ.

## 12.8 Destination rule checks

- If netting account, opposite order may close existing position rather than open a hedge.
- If hedging account, allow only if provider permits and system distinguishes.
- Cancel/modify must propagate only for orders previously sent by this syncer.
- Rejects must not auto-retry without risk review after threshold.

## 12.9 Failure modes

| Failure | Control |
|---|---|
| Duplicate source event | Idempotent dedupe |
| Reordered events | Per-source sequence buffer |
| Stale event | Reject if older than allowed and source state moved |
| Source disconnect | Stop opening new destination positions; allow cancels/closes only |
| Provider throttle | Backoff and queue; alert high severity |
| Partial fill | Reconcile actual size; no hidden assumption of fill completion |
| Reject | Record reason; repeated rejections open kill switch |
| Rapid source close | Explicit close event propagates; if possible provider IOC close; do not infer close from silence |
| Restart recovery | Rebuild state from durability log, then reconcile against destination before any new copy |
| Emergency flatten | Two-person break-glass cancels all/open orders and flattens destination account |

## 12.10 Measurable targets

These are operational SLO targets, not promises:

- event received to ACK persisted: p50 ≤ 500 ms, p95 ≤ 2.5 s, p99 ≤ 10 s excluding provider latency;
- order send to provider: p50 ≤ 100 ms, p95 ≤ 1 s after local validation;
- provider fill confirmed in local ledger: p50 ≤ 1 s, p95 ≤ 5 s, p99 ≤ 15 s after provider ack;
- daily reconciliation completed within 15 minutes of scheduled close;
- kill-switch effective p99 ≤ 1 s after trigger;
- no silent data loss; event log durability flush confirmed before provider send.

Do **not** promise identical fills or zero latency.

## 12.11 Trader source token

Scopes:

- `source.trade.read`
- `source.trade.write` if submitting signal events
- `source.account.read`
- `source.challenge.read`

Never include:

- `owner.admin`
- `destination.read`
- broker account credentials
- owner trading authority

Security:

- token stored as SHA-256 or Argon2id HMAC hash only;
- key fingerprint visible;
- short-lived access tokens;
- rotation grace period;
- revoke all on suspicion;
- rate limit per token and IP;
- event payload schema-versioned and signature-validated where possible;
- all token use audit-logged.

## 12.12 Rollout path

- Historical replay: deterministic, no live order.
- Deterministic simulation: same event input produces same intended output.
- Shadow mode: no real orders; compare shadow P&L to source.
- Paper/provider sandbox adapters.
- Tiny authorized pilot with formal written provider permission and hard capital cap.
- Controlled expansion.

Live mode defaults **off**.

---

# 13. Capital-allocation and unit-economic framework

## 13.1 Decision separation

A model output may create a capital-review case. It cannot buy an account, commit funds, or activate live copying. Those actions require a human risk committee and formal approvals.

## 13.2 Inputs

- trader uncertainty and credible intervals;
- remaining trades and path-dependent pass probability;
- expected time to completion;
- time to payout;
- challenge/reset fee revenue;
- payout split and delay;
- provider denial/default probability;
- execution degradation;
- correlation to existing allocation book;
- liquidity;
- stress losses;
- opportunity cost;
- reserve impact;
- existing payout liabilities.

## 13.3 Capital-review eligibility

A capital-review case may be generated when:

- review outcome is `approved` for payout eligibility, if applicable;
- strategy hypothesis has at least moderate evidence;
- probability CI is narrow enough for the intended allocation;
- copyability score is above a validated minimum or shadow result supports;
- liquidity/concentration checks pass;
- correlation with existing book is within limit.

None of this is automatic approval.

## 13.4 Hard gates

Modeled as configurable risk-limit table:

| Limit | Purpose |
|---|---|
| Global copied AUM cap | prevent concentration |
| Per-trader capital cap | single-name loss |
| Per-strategy cluster cap | stop correlated strategies |
| Per-symbol ADV cap | liquidity |
| Per-provider exposure cap | counterparty default |
| Aggregate daily loss cap | emergency stop |
| Gross/notional leverage cap | margin/liquidity risk |
| Reserve coverage minimum | payout liability |
| Provider permission expiry | legal stop |

Limits must be set by risk committee and included in audit.

## 13.5 Reserve calculation

\[
\text{Reserve} \ge \text{known payout liability} + \text{VaR}_{99\%,H} + \text{tail concentration} + \text{provider default exposure} + \text{processor holdback}
\]

If existing payout liabilities plus stress losses exceed liquid reserves, copying must not expand; existing risk may need reduction.

## 13.6 When the business model is economically impossible

The model is not viable if:

- expected net value per funded trader is negative after executing costs and capital charge;
- execution degradation turns positive source expectancy into negative destination P&L;
- provider payout default probability times exposure exceeds risk budget;
- per-copied-trader infrastructure cost exceeds expected net margin;
- payout liabilities grow faster than retained cash flow under realistic pass/payout assumptions;
- correlation across funded traders is so high that a single market move breaches reserve limits;
- challenge fees are a loss leader but copied losses are unlimited.

These must be stress-tested, not assumed away.

---

# 14. One-phase versus two-phase products

## 14.1 Evaluation criteria

| Criterion | One-phase | Two-phase |
|---|---|---|
| Trader conversion | Higher initial conversion | Lower initial conversion |
| Payout liability | Higher earlier liability | Lower early liability |
| Evidence gained | Less repeatability | Second independent phase |
| Gaming incentive | More one-luck potential | Requires repeated behavior |
| Complexity | Lower | Higher |
| Fairness risk | Simpler expectations | More terms to manage |
| Cash flow | Faster activation | More fees/resets possible |
| Legal/consumer risk | Can look like pass/fail game | Still needs clear terms |

## 14.2 Infinity stages

Infinity products should be divided into explicit stages, but without retroactive change. Each stage should add evidence before capital scale-up.

## 14.3 Recommended stress-testing process

Before publishing a final structure:

1. Use counterfactual historical data to simulate one-phase and two-phase gates.
2. Compare survival curves, payout probability, tail loss, and cash flow.
3. Vary target, drawdown, and time limit under adversarial trader distributions.
4. Run gameability analysis: martingale, cross-account hedging, lag exploitation, news gap.
5. Run legal review of whether time limits or trailing rules are unfair.
6. Use feature flags and dark rollout on new cohorts.

## 14.4 Preliminary recommendation

Given present unknowns, the safer preliminary structure is:

- **Traditional:** two-phase, with Phase 1 establishing net-positive expectancy and consistency, Phase 2 confirming repeatability before full payout exposure. Avoid a single decisive pass based on ten lucky trades.
- **Infinity:** staged micro-account scaling, where initial capital is capped and increases only after repeated validation.

Do not alter active accounts. Publish only after legal approval.

---

# 15. Bankruptcy-risk register

Likelihood/impact scale: `L` low, `M` medium, `H` high, `E` extreme. These are relative enterprise judgments, not precise probabilities.

| Risk | L | I | Leading indicators | Preventive controls | Detective controls | Capital limit | Response | Accountable role | Residual |
|---|---|---|---|---|---|---|---|---|---|
| Payout-reserve mismatch | M | E | Rising payout floor, falling fee reserve | Reserve formula, liability cap | Daily reserve coverage | Hard cap | Restrict new liabilities | CFO/Risk | H |
| Copied losses | H | H | Destination P&L drift, slippage | Pre-trade limits, kill switches | Reconciliation | Daily loss cap | Halt copying | Head of Risk | H |
| Trader/strategy correlation | H | H | Cluster similarity, HHI | Cluster limit | Correlation monitor | Cluster cap | Reduce cluster | Risk | H |
| Concentration | M | H | Top symbol exposure | Symbol/ADV caps | Exposure report | Per-symbol cap | Hedge/flatten | Risk | M |
| Gaps | H | H | News/weekend exposure | Event exposure limits | Gap P&L | Exposure cap | Reduce overnight | Risk | M |
| Liquidity failure | M | H | Wide spreads, low ADV | ADV caps | Slippage monitor | Smaller size | Stop trading | Risk | M |
| Leverage/margin | M | E | Margin use | Leverage cap | Pre-trade margin | Hard cap | Flatten | Risk | M |
| Model error/drift | M | H | PSI, calibration decay | Versioning, CI, validation | Calibration monitor | Allocation cap | Model rollback | Model Risk | M |
| Data/feed failure | M | H | Heartbeat gaps | Multiple feeds, stale checks | Heartbeat alerts | Halt on stale | Fail-safe | Engineering | M |
| Stale price handling | M | E | Price staleness | Price band | Reject stale | Hard max age | Cancel/stop | Engineering/Risk | M |
| Execution/reconciliation failure | M | E | Mismatch frequency | Idempotency, outbox | Reconciliation | Halt on mismatch | Flatten | Engineering | M |
| Broker/provider default | L | E | Provider financial/news | Multiple providers, caps | Exposure | Provider cap | Withdraw/halt | CFO/Risk | M |
| Payment processor freeze | L | H | Chargeback rate | Processor diversity | Settlement monitor | Reserve | Partner review | CFO | M |
| Chargeback/fraud | M | H | Chargeback ratio | KYC, 3DS, flags | Dispute monitor | Reserve | Dispute response | Fraud/Ops | M |
| Coordinated trading fraud | M | H | Similarity clusters | Flags, review | Cluster monitor | Halt payouts | Investigate | Fraud/Compliance | M |
| Regulatory perimeter | M | E | Enforcement/news | Legal review | Compliance calendar | Stop product | Counsel response | Legal | H |
| Consumer protection/unfair terms | M | E | Complaints | Clear versioned terms | Complaint monitor | Remediation reserve | Amend terms going forward | Legal/Compliance | H |
| Privacy breach | M | E | Asset inventory gaps | Encryption, minimization | SIEM | Incident reserve | Notify legal | CISO | M |
| Cyberattack | M | E | MFA bypass attempts | MFA, WAF, patching | SIEM | Cyber reserve | Incident plan | CISO | M |
| Credential compromise/insider abuse | M | E | Anomalous audit | Least privilege, separation | Audit review | Access revoke | Revoke | CISO | M |
| Vendor lock-in/outage | M | H | Outage history | Adapter abstraction | SLO monitor | Exit path | Failover | Engineering | M |
| Accounting/tax errors | M | H | Reconciliation breaks | Separation, controls | Audit | Finance reserve | Restate | CFO | M |
| Marketing overpromise | H | E | Complaints | Legal approval, disclaimers | Monitor ads | Marketing halt | Retract | Legal | H |
| Dispute/reputation | H | H | Complaints, social media | Fair terms, appeals | Monitor | Legal reserve | Early resolution | Legal/Support | M |
| Founder/key-person | M | E | Dependence | Docs, redundancy | Access review | Continuity | Succession | Board | M |

## Fatal risks

1. Legal/regulatory product misclassification.
2. Live Trade Syncer without provider permission.
3. Payout-reserve insolvency under correlated losses.
4. Fraud rings defeating similarity controls.
5. Overt model trust causing large copied losses.
6. Security compromise exposing trader PII.
7. Broker/provider default with commingled exposure.
8. Marketing promises inconsistent with actual internal capital decision.

## Minimum viable redesign

- Freeze all live copying and capital allocation until legal sign-off.
- Implement immutable rules, review state machine, audits, and appeals first.
- Run historical replay and shadow only.
- Maintain a liquidity reserve separate from operating cash.
- Do not display a single profitability percentage.
- Require independent model validation and human approval for all allocations.

## Go/no-go

- **As submitted: no-go** for live commercial payout/capital replication.
- **Conditional go:** legal perimeter clearing, provider permission, reserve stress test, shadow validation, independent approval.
- **Go now:** Phase 0–3 safe construction of internal controls and analytics.

---

# 16. Model governance, privacy, security, audit and appeals

## 16.1 Model governance

- Model inventory: ID, version, owner, purpose, training window, inputs, outputs, CI method, calibration.
- Every model output stores its version and data hash.
- Independent model validation before any decision use.
- No model may unilaterally deny payout or allocate capital.
- Change management for any rule, threshold, symbol map, or metric.
- Canary/dark rollout before production.

## 16.2 Privacy

- Data minimization by role.
- Masking defaults.
- Retention schedule by data class.
- GDPR art. 5/17/25/32 duties where applicable; CCPA/CPRA where applicable. **[LEGAL]**
- Data-protection impact assessment for trader profile and trader intelligence. **[LEGAL]**

## 16.3 Security

- NIST SP 800-63B style MFA.
- OWASP ASVS-aligned auth checks.
- TLS 1.2+ everywhere.
- Secrets manager for broker/internal credentials.
- RLS plus server authorization.
- WAF/rate limits on all public APIs.
- Least privilege; break-glass access logged.
- Immutable or tamper-evident audit trail.

## 16.4 Audit

Every state change, model decision, flag disposition, alert, payout, token use, access, and export must produce an immutable audit event with actor, timestamp, version, evidence hash, IP hash, and prior hash link.

## 16.5 Appeals

- Human-reviewed.
- Independent reviewer.
- Evidence access rules pre-approved.
- Time-bound.
- Overturned decisions generate correction and payment where due.
- All appeals logged.

---

# 17. Dependency-ordered implementation plan

## Phase 0 — repository, data and legal-perimeter audit

Goals:

- inventory current data sources and quality;
- identify legal/regulatory perimeter questions;
- repository and environment bootstrap;
- secrets handling;
- immutable audit baseline.

Exit gates:

- legal question register open;
- data source gaps documented;
- no live code shipped;
- audit logging foundational.

## Phase 1 — data integrity, identifiers, versioned rules, reviews, owner authorization

Goals:

- canonical identifiers for orders/fills/positions/executions/accounts;
- immutable terms versions and rule snapshots;
- review state machine;
- server-side owner/admin authz, MFA, session revocation;
- PII minimization.

Exit gates:

- all review transitions audited;
- RLS/authorization tests pass;
- no service-role secret in client.

## Phase 2 — deterministic metrics and owner dashboard

Goals:

- daily equity, P&L, drawdown, exposure, costs;
- exact metric definitions;
- dark owner dashboard.

Exit gates:

- known fixtures produce expected values;
- missing data returns `null`, not fabricated;
- PII masking operates.

## Phase 3 — flags, similarity, notifications and independent validation

Goals:

- strategy hypotheses;
- suspicious behavior flags;
- similarity engine with cohort null;
- alert pipeline;
- independent model validation.

Exit gates:

- FDR-controlled flag tests pass;
- no flag auto-denies payout;
- alert delivery retry/ack works;
- model governance registers all metrics.

## Phase 4 — historical replay and shadow Trade Syncer

Goals:

- durable event log;
- idempotency;
- deterministic replay;
- shadow copy.

Exit gates:

- duplicate/reordered/stale event tests pass;
- no live orders;
- copyability measured in shadow.

## Phase 5 — approved paper-provider adapters

Goals:

- provider sandbox/paper adapters;
- written permission management;
- kill switches.

Exit gates:

- provider permission recorded;
- adapter error paths tested;
- no production credentials in test environments.

## Phase 6 — controlled live pilot only after formal approvals

Hard gates:

- qualified legal approval; **[LEGAL]**
- written provider permission; **[PROVIDER]**
- reserve stress test;
- independent model sign-off;
- risk committee approval;
- small maximum capital;
- live default off and manual enable;
- emergency flatten tested;
- monitoring and audit active.

Exit criteria:

- pilot loss not exceeding pre-defined limit;
- reconciliation mismatch below SLO;
- no material legal/compliance exception;
- full kill-switch test demonstrated.

---

# 18. Detailed Claude Code implementation handoff prompt

Below is a ready-to-paste implementation prompt for the safe phases. It intentionally does not include live Trade Syncer activation, business thresholds, or legal conclusions.

---

> Implement the safe internal-control core for iPFX Capital in TypeScript, PostgreSQL/Supabase migrations, and a Next.js or React owner dashboard. Do not implement live broker order submission. Do not invent business rules.
>
> **Phase scope:** Phase 0 through Phase 3 only: data integrity, versioned rules, review state machine, owner authorization, deterministic metrics, dashboard, flags/similarity/notifications, and model governance scaffolding. Phase 4 shadow/replay is allowed only as a dry internal service with no external order sending.
>
> **Data model**
> Create migrations for the following tables with UUID primary keys, `created_at`, `updated_at`, unique constraints, and foreign keys:
> `auth_user`, `person`, `device`, `session`, `api_token`, `trading_account`, `challenge_product`, `terms_version`, `rule_definition`, `rule_policy`, `challenge_instance`, `accepted_terms`, `objective`, `order`, `fill`, `position`, `position_snapshot`, `review_case`, `review_event`, `review_decision`, `review_evidence`, `appeal`, `metric_run`, `prob_estimate`, `flag_definition`, `flag_case`, `risk_limit`, `kill_switch`, `internal_capital_decision`, `payout_request`, `payout_payment`, `broker_account`, `replication_event`, `dest_order`, `reconciliation_run`, `audit_event`.
>
> Use encrypted columns or a separate column-level encryption pattern for PII and external provider account identifiers. Use SHA-256 for identity/token hashes. Do not store plaintext tokens or external credentials.
>
> **Authorization**
> Enforce owner/admin authorization on every dashboard route and API using server-side session validation. Require MFA for owner/admin. Add Postgres row-level security policies so ordinary traders cannot select owner-only tables. Never use Supabase service-role key in the client. Never rely on client-side route hiding.
>
> **Versioned rules**
> Each challenge instance must store `terms_version_id` and `rule_policy_id`. Add a unique hash of the canonical terms JSON. Add an accepted-terms table. Ensure reviews always read the snapshot associated with the challenge instance.
>
> **Review state machine**
> Implement states: `active`, `objective_met`, `pending_review`, `in_review`, `needs_more_data`, `compliance_escalation`, `approved`, `rejected`, `appeal_requested`, `appeal_in_review`, `appeal_upheld`, `appeal_overturned`.
> Every transition must write an immutable `review_event` and `audit_event`. A model/flag may never directly create a rejection. Only a human can reject. Deadline and extension values must be configuration, not hardcoded business policy.
>
> **Metrics**
> Implement daily return series from equity adjusted for external flows. Implement net P&L after commissions, swap, spread, and slippage where present. Compute:
> `profit_factor`, `expectancy`, `win_rate`, `payoff_ratio`, `annualized_volatility`, `downside_deviation`, `Sharpe`, `Sortino`, `max_drawdown`, `drawdown_duration`, `gross/net exposure`, `HHI`, `position_size_cv`, `median_holding_time`, `best_day_share`, `spread/slippage_sensitivity`, `news/gap_exposure`.
> All values must include sample size, effective sample size, model version, input hash, CI where applicable, data-quality score, and warnings. If evidence is insufficient, store `value = null` and `status = insufficient_evidence`. Never fabricate probabilities.
>
> **Probabilities**
> Implement block bootstrap for positive-net-performance over a configurable horizon. Implement Monte Carlo challenge-path simulation for pass/breach/first-payout probabilities, reading the active rule snapshot. Return 95% CIs and calibration status. Do not use a naive pass threshold based on number of trades.
>
> **Flags**
> Implement the flag catalogue as data-driven `flag_definition` rows. Implement a pair-similarity score for time, price, size, stop/target, holding time. Implement cohort normalization and Benjamini-Hochberg FDR. Graph clustering should be deterministic and serializable. Flags only create review cases; they never fail an account automatically.
>
> **Alerts**
> Implement an alert table, dedup key, cooldown, throttling, quiet hours, retry queue, acknowledgement, and dead-letter queue. Add test mode.
>
> **Audit**
> Implement an append-only `audit_event` hash chain. Add non-updatable audit rows to the extent enforceable by database policies.
>
> **Dashboard**
> Build a near-black internal dashboard with muted labels, white primary text, restrained blue focus, green for buys/profits, red for sells/losses, compact tables, tabular numbers. Show all requested trader profile sections. Mask PII by default.
>
> **Do not**
> - Do not submit live brokerage orders.
> - Do not bypass provider rules.
> - Do not expose destination credentials in source events.
> - Do not automatically allocate capital.
> - Do not auto deny payout from a model.
> - Do not make marketing or legal claims in UI text.
> - Do not hardcode trading thresholds as business rules.
> - Do not invent terms of service.
>
> **Tests**
> Include unit and integration tests for idempotency, stale/reordered events, authorization, RLS, review transitions, CI calculations, missing data, flag FDR, alert dedupe, token rotation, and audit hash-chain integrity.
>
> **Acceptance**
> Provide a runbook showing that a non-owner cannot access owner APIs, a missing-data metric returns `null`, a versioned rule snapshot cannot be altered for an active challenge, a flag cannot finalize a payout denial, and an audit immutability test fails if an event is altered.

---

# 19. Acceptance tests and live-activation checklist

## 19.1 Acceptance tests

### Review and rules

- Active challenge uses immutable accepted terms version.
- A new terms version does not change active challenge results.
- Objective-met timestamp starts bounded review.
- Human rejection required for non-deterministic flags.
- Reason code and evidence references are mandatory.
- Appeal assigns independent reviewer.
- Deadline default behavior tested.

### Authorization and privacy

- Non-owner cannot access dashboard or API.
- RLS rejects direct role misuse.
- MFA required for owner.
- Session revocation terminates access.
- Full PII masked by default and unmask is audited.

### Metrics and statistics

- Known fixture returns expected drawdown/equity.
- Missing timestamp does not fabricate a metric.
- Probability with insufficient data is `null`.
- Bootstrap CI reproducibility is deterministic with set seed.
- Sharpe/Sortino undefined where variance is zero.
- Cost-missing data lowers data-quality score.

### Flags and alerts

- Similarity threshold chosen from cohort null on test data.
- Repeated identical alerts deduplicated.
- Critical alert retries and acknowledges.
- Flag no automatic failure.

### Shadow syncer

- Duplicate events processed once.
- Reordered events do not generate conflicting orders.
- Stale events blocked.
- Kill switch stops new orders.
- Restart recovery reconciles before acting.
- No external order submission in Phase 4 tests.

## 19.2 Live-activation checklist

- [ ] Qualified counsel has opined on product, marketing, payout, and copying legality.
- [ ] Each destination broker/provider has written API automation permission.
- [ ] Provider permission expiry is tracked and active.
- [ ] Independent risk model validation complete.
- [ ] Reserve stress test passed under correlated loss scenario.
- [ ] Shadow copyability SLOs measured and approved.
- [ ] Emergency flatten tested in sandbox.
- [ ] All kill switches scopes tested.
- [ ] Live mode is default off and manually enabled.
- [ ] Pilot capital is hard-capped and approved by risk committee.
- [ ] Audit trail and alerting active.
- [ ] Source tokens scoped and revocable; destination credentials in secrets manager.
- [ ] Live-incident runbook and on-call exist.
- [ ] Legal/compliance sign-off recorded in immutable audit log.

---

## Key references

- CFTC Regulation 4.41, advertising and promotional material.  
- SEC Rule 17a-4, records retention principles.  
- NIST SP 800-63B, Digital Identity Guidelines: Authentication.  
- NIST SP 800-53 Rev 5, Security and Privacy Controls.  
- ISO/IEC 27001:2022, information security controls.  
- OWASP Application Security Verification Standard.  
- GDPR Arts. 5, 17, 25, 32; CCPA/CPRA where applicable.  
- Lo, A. W. (2002), “The Statistics of Sharpe Ratios,” *Financial Analysts Journal*.  
- Wilson, E. B. (1927), “Probable Inference,” *Journal of the American Statistical Association*.  
- Benjamini, Y., and Hochberg, Y. (1995), “Controlling the False Discovery Rate.”  
- Politis, D. N., and White, H. (2004), automatic block-length selection methods.

---

This concludes the design review. The next action is not to begin live copying. The next action is to complete Phase 0 data/legal audit, freeze any ambiguous rule changes, and build the review, metrics, authorization, and shadow-testing perimeter with the handoff prompt above.