# Individual trader performance: frozen implementation protocol

Registered 19 October 2026 before this implementation reads per-person production outcomes.

## Prior exposure

The owner and this chat have already seen aggregate results from the six-date frozen export, the >$20 filter and exploratory $5–$20 band. This is not a new pristine historical holdout. Historical classification replay is descriptive; only snapshots saved after deployment support a genuinely prospective evaluation. No thresholds are optimized to this week's results.

## Estimands and execution

Use the existing unfiltered E8 A/B replay as the cent reconciliation control. Direction is mid-to-mid in USD at the global alternating 0.06/0.07 lots. A = G − spread − commission − slippage; B = −G − spread − commission − slippage. Compare exactly the same trades, size and currency conversion. Risk-preserving B is a separate variant and is unavailable when a valid opposite stop cannot be established. Fixed horizons are separate exit variants, never silently substituted.

Stress grid: entry latency 1/2/5/15 seconds; exit latency fixed at existing 5 seconds; 0/1/2 adverse ticks at each side. Base is existing 2s/5s quote replay with zero unmeasured added slippage. Show calibration observations separately; six fills cannot estimate a reliable impact model. Quote-jump factor estimates are diagnostics, not measured actual fills. Never replace missing quotes with guessed prices. Swaps, margin/crowding restrictions and E8 policy verification are explicit availability fields.

## Evidence gates

Configuration defaults: <30 priced trades insufficient, 30–99 provisional, ≥100 reportable, ≥200 potentially actionable; ≥10 distinct completed trading days, both chronological halves net-positive in the selected direction, family q≤0.05 and a valid anytime evidence gate are also required. Stable weeks, sessions and volatility terciles require observations in each comparison; unknown regime support prevents actionability. More than 50% of favorable gross direction from the top three trades triggers concentration/tail review. Stopped means no new source entry for 14 days; behavior reset is a pre-specified change in size/frequency requiring new prospective evidence. No status label authorizes order routing.

Use day-clustered standard errors and partial pooling across people, with raw and shrunk estimates and explicit model assumptions. Intervals for accumulated net P&L mean uncertainty about repeated comparable samples, not a revision of realized cash P&L. Use dependency-conservative Benjamini–Yekutieli adjustment across both directional hypotheses. Posterior probability is not a frequentist q-value. Confidence sequences/e-processes require explicit bounded observations and a predictable process; unknown/breached bounds or historical fit prevent anytime-valid claims. An absent valid sequential statistic blocks an actionable verdict.

Exactly one class: INSUFFICIENT_DATA, COST_BLED, COPY_CANDIDATE, REVERSE_CANDIDATE, UNSTABLE, TAIL_RISK, E8_INCOMPATIBLE, STOPPED_TRADING. Class reasons carry the evidence tier (including provisional). Tiny data cannot establish cost-bleed equivalence; use insufficient rather than confusing absence of significance with evidence of no edge.

## Replay and controls

Information becomes available no earlier than actual ledger publication, and at least close+120s, plus a configurable 30s embargo. Earlier classifications cannot depend on later outcome, priors, variance estimates, FDR population, regime cuts or configuration learned later. Save immutable production snapshots with input cutoff and configuration version. Historical reconstruction is labeled reconstructed, not captured live.

Check A+B per trade; cent reconciliation with a/b views; no future mutation may change earlier decisions; planted positive/negative/noise paths at observed sample sizes; dependency-aware false discoveries; missing quote/stop/swap handling; stale-cache alerts; API only reads cache under existing owner+MFA gate; anon denied. Full suite, desktop UI, real REST path, and two scheduled successes are deployment gates.

## Trial log

One implementation specification registered here. Known earlier exploratory thresholds: >0, >5, >20, $5–$20, ≥3/≥5 closes, ≥50% win rate, ≥2 profitable days, ≥60s median hold, prior positive E8 paper P&L; all already inspected on the same historical sample. These histories cannot be treated as independent validation.
