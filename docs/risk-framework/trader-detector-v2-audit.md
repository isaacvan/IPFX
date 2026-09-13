# Trader detector v2 audit — 13 September 2026

This is a technical red-team review, using independent statistical, backend and trading-risk reviewers. No reviewer represents Jane Street, Citadel or IMC. Version 2 is research and review infrastructure. Predictive accuracy has not been established on IPFX future outcomes.

## Failures reproduced and repaired

| Failure | Why it mattered | Repair and verification |
|---|---|---|
| One crowded winning day followed by 29 losing days scored near certainty | Trade-weighted means let ticket count overwhelm the record | Infer from UTC daily blocks, use effective days, recent performance and best-day concentration. Reproduction now cannot alert. |
| Tiny winning trades counted as successful phases and regimes | Token trades could manufacture repeatability | At least five supported positive days per counted phase/regime; versioned settings. |
| Missing or duplicated inputs could disappear or become zero | A bad losing row could improve apparent results | Strict parsing, duplicate rejection, explicit unknown accounting, provenance checks. |
| Net P&L could be charged costs again | Real edge could be overstated or understated | Explicit net/gross basis; signed commissions/financing; execution shortfall remains diagnostic for actual-fill P&L. |
| A single-symbol specialist could be rejected for specialization | Symbol diversity is not evidence of skill | Symbol HHI is descriptive; profit dependence and portfolio exposure remain separate controls. |
| Current account stage could be applied to older trades | Historical phase evidence was invented | Point-in-time snapshots; only verified provisioned parent chains join phases. Breached accounts remain visible. |
| Final funding lost challenge metadata | Funded accounts could be scored against the wrong challenge | Preserve challenge type, stage and drawdown mode in funded-account provisioning. Existing records require audit; no historical values were guessed. |
| Worker called missing database columns and RPC | A passing unit suite hid a non-running backend | Follow-up migration creates provenance columns and transactional commit RPC; both migrations executed in isolated PostgreSQL. |
| Separate assessment/state/alert writes could partially succeed | A crash could lose an alert or leave contradictory state | Account-row lock, compare-and-swap, transaction, deduplication and stale-write rejection. |
| A source outage left a favourable old state visible | The dashboard could imply current evidence while scanning was broken | Error status, deterioration notification and successful-scan heartbeat; summary counts exclude errors and scans older than 15 minutes. |
| Counts used limited rows and historical assessments | Totals could omit accounts or count one account repeatedly | Exact database counts of current fresh states; historical table explicitly labelled. |
| A policy flag could turn a descriptive posterior into a forecast | Probability of a mean edge is not probability of future profitable trading | Separate immutable calibration, future forecast and risk-review records. Forecast binds account, policy, input hash, source cutoff and validity window. |
| Aggregate copying P&L looked sufficient | Unequal capital, omitted failures or execution selection could exaggerate replication | Live review requires fresh audited matched population, risk normalization, a positive lower edge, provider and reserve references. |
| Validation could finish before the declared study window | Early favourable results could masquerade as a completed prospective study | Full outcome horizon maturity required; fixed cohort, trader exclusion, explicit target and abstentions retained. |

## What the probabilities mean

The descriptive score estimates the mean net closed-P&L edge per UTC trading day under a simple shrinkage model. Its Gaussian approximation, prior, daily grouping and thresholds are hypotheses. It is always labelled uncalibrated. The one-sided lower bound uses the existing 1.64485 multiplier and should not be sold as guaranteed coverage under heavy tails.

A validated future forecast is a different object, produced for a declared future outcome and horizon by a separately validated model. The detector does not manufacture this forecast. An approved forecast with the exact input digest is needed for confirmation; a policy status alone cannot provide it.

Closed-trade accounting cannot establish floating equity drawdown, cash transfers, open exposure or futures EOD trailing-floor compliance. A fresh reconciled risk review must establish those independently. UTC daily scoring does not replace the contract's broker rollover/timezone risk calculation.

## Current data contract

1. `trades.pnl_basis`: `NET_AFTER_COSTS` or `GROSS_BEFORE_COSTS`. Gross basis requires signed cashflow commission and financing (charges negative, rebates positive). Do not bulk-backfill a basis without reconciling the upstream provider.
2. `trades.detector_stage` must agree with the applicable snapshot. Snapshot `rules` must identify `stage`, `challenge_type`, `drawdown_mode`, `starting_balance`, alongside the typed daily/overall limits and anchor fields. An arbitrary nonempty object is insufficient.
3. The worker hashes account, verified lineage, sibling account history, policy, closed trade records, open flags, rule snapshots, qualification contract and source cutoff. `input_sha256` on the resulting assessment is the binding key. Forecast/risk/copy outputs are excluded from this input hash to avoid circularity; the final evidence hash includes them.
4. `trader_detector_calibrations` records model hash, outcome definition, horizon, train/validation windows, independent holdout/prospective evidence and approval expiry.
5. `trader_detector_forecasts` binds the calibration to the same account, policy, source cutoff and input digest. Its probability is stored separately from the descriptive posterior.
6. `trader_detector_risk_reviews` binds the same input to a reconciled equity and stressed open-loss review. The review must be fresh within five minutes, unexpired, and above both daily and overall floors after stress.
7. Copy snapshot `provenance` must include `policy_id`, `input_sha256`, `source_cutoff_at`, `audit_sha256`, `verified_by`, `expires_at`, `matched_ideas_complete: true`, `risk_normalised: true`, `net_edge_lower90_bps > 0`, `provider_permission_reference` and `reserve_review_reference`. Reconciliation must include failed/rejected/missing copies, and normalization must use comparable risk capital.

Hashes bind supplied data; they cannot prove that a provider feed or human attestation is true. Independent provenance review remains necessary. Missing evidence blocks promotion.

## Running the checks

From `internal-control/dashboard`: `npm test` and `npm run build`.

From the repository root:

```
node scripts/check-trader-detector-types.cjs
node scripts/test-trader-detector-db.mjs PATH_TO_INSTALLED_PGLITE_PACKAGE
node --experimental-strip-types scripts/validate-trader-detector.ts INPUT.json NEW_REPORT.json
```

The database harness runs in-memory PostgreSQL WASM with minimal predecessor-schema fixtures. It executes both real detector migrations and tests privileges, transactions, immutable evidence, duplicate/stale writes, failed-scan recovery, calibrated bindings and invalid live review. This does not substitute for staging migration rehearsal against the complete production schema, concurrent network clients or hosted Edge gateway tests.

The validation CLI reads `{manifest, records}` according to the types in `internal-control/lib/detector-validation.ts`, writes a new report without overwriting an existing file, and exits 2 if research checks fail. Its test fixtures are synthetic and must never be registered as production validation.

## Deployment and remaining work

Apply the saved v1 and v2 migrations in order in staging. The v2 migration retires only shadow v1 policies and creates shadow v2 policies with explicit daily units. It never silently replaces a validated v1 policy. The worker rejects legacy inference units.

The scheduled POST now authenticates its application secret using `x-detector-secret: TRADER_DETECTOR_CRON_SECRET`. Supply the hosted gateway's appropriate Authorization/API authentication separately; do not put the arbitrary cron secret in a JWT bearer header. Verify the deployed function's gateway settings before scheduling.

No new production migration, external notification, live allocation, or copying was activated in this audit. Alerts remain internal. The worker uses a leased, persisted account cursor, processes at most 50 accounts per invocation, and yields after 40 seconds between accounts. The next invocation resumes the cursor; an expired ten-minute lease recovers a crashed worker. Inputs remain bounded at 100,000 rows per paginated dataset, with explicit failure above the limit. Load-test the scan cadence so the complete population is revisited within the dashboard freshness target; a single very large account still needs a measured timeout budget. The isolated runtime cannot establish hosted throughput.

The following are not solved by code-only tests: clean historical equity and event reconciliation, complete failed-attempt histories, independently trained and calibrated future-outcome models, prospective validation, provider-specific copy execution data, true portfolio stress/correlation, and consistent contractual website/database rules. The new interfaces support supplying this evidence; they do not fabricate it. A stronger detector is not a guarantee that a trader will remain profitable.

References used for the integration review: [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html), [Supabase function permissions](https://supabase.com/docs/guides/database/functions), [Supabase Edge authentication](https://supabase.com/docs/guides/functions/auth), and [scikit-learn probability calibration](https://scikit-learn.org/stable/modules/calibration.html).
