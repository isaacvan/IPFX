# Trader strategy detection — version 1

## Purpose

The detector turns a trader's closed-order history into an interpretable behavioural fingerprint. It supports owner review, trader segmentation, longitudinal drift monitoring and research cohorts. It does not decide whether a trader passes, fails, receives capital or has acted improperly.

Implementation: `internal-control/lib/strategy-profile.ts`
Owner view: `internal-control/dashboard/app/(owner)/traders/[personId]/page.tsx`
Tests: `internal-control/tests/strategy-profile.test.ts`

## Inputs

Each observation contains instrument, side, opening and closing timestamps, volume, entry/exit prices, stop loss, take profit and realized P&L. Invalid time ranges and non-positive sizes are excluded. A profile needs at least eight valid closed trades before it receives labels.

## Features

- Holding-time median and 90th percentile
- Trades per active UTC day
- Long/short share
- Dominant instrument share and instrument HHI
- Dominant fixed-UTC trading session and its share
- Stop-loss and take-profit usage
- Median planned reward-to-risk where both levels exist
- Position-size coefficient of variation
- Overlapping same-symbol, same-direction scale-in rate
- Rapid re-entry and median size change after a losing trade

## Labels

The current version can describe scalping, intraday, swing, instrument-specialist, directional, session-specialist, systematic/adaptive sizing, stop-defined, target-defined, scale-in and rapid post-loss resizing patterns. Every label includes its metric values, a plain-language explanation and low/medium/high evidence confidence.

It intentionally does not label trend following, breakout, mean reversion, news trading or latency arbitrage. Those require contemporaneous candles, volatility, spread, scheduled-event and decision-time data. Inferring them from order history alone would manufacture certainty.

## Comparison and drift

`fingerprintDistance()` compares two sufficiently supported profiles on normalized features. `clusterStrategyCohorts()` uses deterministic complete-link grouping, so every member of a cohort must be close to every other member. This prevents a chain of weak matches from combining unrelated styles. `strategyDrift()` labels longitudinal distance as stable, evolving or material change.

These thresholds are version-one research defaults. Before operational use, calibrate them on held-out IPFX history, measure stability under resampling, check sensitivity across instruments and account sizes, and lock the selected version in the model-governance tables.

## Review controls

- No automatic account action is exposed by the module.
- Fewer than eight trades returns `insufficient_evidence`.
- Coverage is displayed with every profile.
- Rapid post-loss resizing is review evidence, not an allegation.
- Pairwise copy/co-ordination detection remains separate in `similarity.ts` and uses cohort normalization plus false-discovery-rate control.
- Profiles should be recomputed at fixed cutoffs and stored with the source cutoff and feature-schema version before production decisions use them.

## Next data milestone

Capture decision-time mid price, spread, ATR/realized volatility, market-session timezone, scheduled-news proximity and order type. With those inputs, version two can test explicit hypotheses such as breakout continuation versus mean reversion, using out-of-sample replication rather than assigning labels from intuition.
