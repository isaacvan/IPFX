# Part 2 completion and adversarial technical review

## Execution evidence

Requested and returned model: deepseek-v4-pro. Thinking enabled, reasoning_effort max, max_tokens 64000. Exactly one request; zero retries; 600-second timeout; HTTP 200; finish_reason stop. Elapsed approximately 360 seconds. Daily cap USD 5.

Prompt tokens: 942. Completion tokens: 21758 (including 14376 reasoning tokens). Total: 22700.

Local cost estimate: USD 0.01933923, using (942 * 0.435 + 21758 * 0.87) / 1000000 from the existing provider price table. The API returned no dollar billing value. This is not independently verified billing.

The request crossed UTC midnight. The original runner subtracted daily spend after a date reset, incorrectly producing -0.017632725. Metadata now records the corrected token-based estimate, preserves that original delta, and explains the correction. The runner now calculates per-request cost from returned usage, avoiding this midnight error. No second request was used for this correction.

Only the Part 2 prompt was submitted. Its sole content edit before submission removed the standalone plus sign on the second line. No repository files, previous model answers or screenshots were transmitted. Credentials were used only for authentication.

## Exact paths and hashes

Prompt: C:\Users\paula\Documents\Codex\2026-09-04\pu\work\ipfx_a_book_timing_part2_prompt.md

Prompt SHA-256: 85fa116b505a718689bb005055034fd5e5aee9f5ef7c06abaeb7518cc857446d

Unedited response: C:\Users\paula\Documents\Codex\2026-09-04\pu\outputs\deepseek_ipfx_a_book_timing_part2_20260906T235625Z.md

Response SHA-256: f9f6ee4f660cc7f6b6381789bf0ade1bdb7a9126727832ef16c0390f5823170f

Metadata: C:\Users\paula\Documents\Codex\2026-09-04\pu\outputs\deepseek_ipfx_a_book_timing_part2_20260906T235625Z.json

## Completeness verdict

Read the entire response. All 12 numbered design areas are present, followed by a thirteenth section containing a machine-facing contract. The response includes sequential equations/pseudocode, a joint-path simulator, allocation formulas, a four-way challenge comparison, four synthetic cases, SQL schemas, acceptance tests and live gates, and ends cleanly. Hashes were independently verified.

Structural completeness: PASS.
Mathematical, operational and deployment readiness: FAIL pending corrections.

The four cases are sketches, not reproducible worked simulations. The challenge comparison is mostly qualitative and contains unsupported claims about the unspecified current product. No model or simulator was executed or empirically validated in this review.

## Findings requiring correction

1. **Payout liability wrongly depends on allocation.** Section 2 multiplies trader liability by action capital C_a, potentially removing customer obligations when WAIT has zero copied capital. Existing contractual liabilities must continue across all actions; additional contributor compensation, hedging cash flows and fixed obligations need distinct ledgers. Compare incremental action utility against the same liability baseline.
2. **Units are underdefined.** F_a is called expected number of trades but multiplied by T again. Choose frequency per unit time or total count. Define whether returns and high-water mark h are fractional returns, R-multiples or money. Dimensionless correlation penalties need money-valued coefficients. Provider/drawdown/liquidity caps need consistent numerator/denominator units before taking their minimum.
3. **Predictive uncertainty is understated.** The normal sum variance omits posterior uncertainty. Even in the stated independent normal model, a shared uncertain mean gives N*sigma_e^2 + N^2*tau_n^2, before serial/regime dependence. Draw one latent parameter per scenario and preserve dependence rather than treating estimated mean as certain.
4. **Cost double counting is possible.** The input model may already predict net returns, while c_a, slippage and ExecLoss are deducted again. Define gross/net input contract and incremental destination costs; do not subtract shortfall twice from actual-fill P&L.
5. **Sequential optimization is incomplete.** VOI lacks an explicit finite horizon, updated remaining opportunities and action-dependent observations. The code adds VOI to every action without a consistent Bellman continuation value. Restrict feasible actions by state and gates before argmax; define shadow/wait behavior when evidence is insufficient.
6. **Daily loss rule uses the wrong anchor.** B_start is not the current day-start equity/balance required by many daily-loss rules. Balance-only checks ignore open-equity breaches. Drawdown mode and absolute-versus-percentage floor rules must be versioned per provider, not universally trailing balance.
7. **Source liability clock is repeatedly overwritten.** source_eligible_for_payout can keep setting liability_time=t+review_window, artificially pushing the due date later. Freeze first eligibility and retain its contractual due date; review windows cannot be extended by simulator bookkeeping.
8. **Destination failure truncates source obligations.** break on provider default or final destination failure stops the joint path. Continue source trading and all customer liability/reserve timelines regardless of destination survival. Provider default must not erase customer liabilities or source losses.
9. **Phase/payout lifecycle is incomplete.** Phase transition does not explicitly reset destination balance, peak, day anchor or phase rules. Evaluation completion is treated as payout without a funded-profit lifecycle. Minimum trading days are treated as elapsed steps; funded profit, split/caps, denial, settlement delay and review behavior need explicit states.
10. **Reserve breach is tested only at the end.** A business can run out of cash mid-path and recover later. Test the minimum available cash across the full path, net of locked liabilities, fees, settlements and timing of actual receipts. Expected external payout is not current liquidity.
11. **Infinity and censoring need explicit outcomes.** Both dates may be infinite; a direct equality comparison can incorrectly count neither-pays as on-time. Separate never-eligible, default, horizon-censored and finite before/on/after outcomes. Estimate sampling uncertainty and conservative bounds.
12. **Impossible and unlikely are confused.** Case 1 assigns a 4% success probability then declares the same timing objective IMPOSSIBLE. Distinguish structural impossibility, policy inadmissibility, low probability and unfavorable economics. Zero successes in finite Monte Carlo does not prove zero probability.
13. **Allocation needs valid bounds and exposure units.** Negative Kelly can produce a negative final fraction. Clamp valid output to [0,1]; reject invalid or missing inputs. Fraction of source size, fraction of reserve capital and allowed loss risk are different quantities. Floors for zero denominators and treatment of signed beta are missing; absolute caps must be recomputed from portfolio stress, not ratios with negative beta.
14. **Promotion thresholds conflict.** State transitions use 30/60/90 samples, the caps table 50/100 and tests 50; these are not derived from the loss-based promotion rule. Fixed 95% fill, 1% reserve-breach and 0.35 correlation thresholds lack calibration. The posterior threshold formula is valid for its restricted two-class loss matrix, not a full capital-sizing utility model.
15. **Worked case 2 violates stated conditions.** It recommends PARTIAL at n=75 despite the transition table requiring 90 effective signals and gives correlation 0.6 despite a 0.35 cap, unless these refer to different explicitly defined correlations. A 0.30 copying fraction is not demonstrably within reserve-based capital caps. The 28k/9k expected profits have no capital, horizon or reproducible simulation inputs.
16. **Other examples and comparison lack evidence.** Case 3's 0.70 posterior threshold has no loss derivation; case 4 has no numerical calculations. The current-product pass-rate/fairness claims are unsupported by supplied current rules or data. Conditional comparisons must be generated under identical populations and cost assumptions.
17. **State and reason-code mismatch.** The transition table sends accounts to RISK_NO_GO, PROVIDER_NOT_AUTHORISED and INSUFFICIENT_EVIDENCE while the SQL state CHECK excludes them. Define stable lifecycle state separately from recommendation/denial reason and use one consistent action vocabulary.
18. **Idempotency can admit payload conflicts.** Including payload_hash in event uniqueness allows the same source event with changed payload to create another intent. Unique business event identity must be independent of payload; differing hashes must quarantine conflict. Persist stable account/provider execution IDs and reconcile ambiguous sends before any retry. Exactly-once external effects depend on provider capabilities, not a local constraint alone.
19. **Risk response is too slow or underspecified.** The instruction to break if over five minutes must not apply to drawdown breaches, permission revocation or position mismatches. Those require immediate gating. Canceling open orders does not flatten filled exposure; specify risk-reducing close/reconciliation paths. Include p99 latency, not only p50/p95/max.
20. **Schemas lack security and history enforcement.** No RLS/grants, immutable audit protection, authenticated actor binding, two-distinct-human approval records or live flag column is implemented. A claimed default false in prose is not enforcement. Permission allowed=true needs complete scoped evidence, ownership, expiry and revocation checks.
21. **Schemas lack financial/data integrity.** Add currency/unit declarations, bounded money quantities, probability [0,1] checks, nonnegative amounts, reconciliation account/stream identifiers, provider execution-ID uniqueness, foreign keys and query indexes. reserves needs transactional locks and an immutable ledger. simulator_runs needs seed, input/model/cost/rules snapshots and scenario FK. Generic orders/fills/limits tables require collision review against the actual application.
22. **Part 1 interface is not consumed faithfully.** n/sum_return/sum_return_sq cannot carry posterior draws, dependence, full cost provenance, calibration/evidence status and regime uncertainty from Part 1. Re-fitting a simplistic normal model discards that information. Define a common validated, versioned interface before integration.

## Required verification before implementation can be considered complete

Add deterministic fixtures for the daily anchor, open-equity breaches, phase resets, first-eligibility timestamp, source continuation after destination default, interim reserve troughs and never-payout outcomes. Property-test allocation bounds, cash-flow conservation, cost monotonicity, probability partitions and invariance to duplicate/conflicting events. Recompute all worked cases with specified seeds and inputs. Validate RLS, concurrent reserve locking, immutable history, approval identity and provider-permission expiration. Calibrate with holdout and prospective data before capital decisions.

No production system or trading was modified. The DeepSeek Markdown remains unedited. This document is a technical review, not empirical model validation.
