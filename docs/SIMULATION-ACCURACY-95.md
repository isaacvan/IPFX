# Net P&L validation target

The owner accepted a target of at least 95% of intended closed trade streams having complete broker evidence and estimated net P&L within 5% of actual broker net, with a $0.01 minimum absolute tolerance. Missing and failed copies stay in the denominator. This is a validation target, not achieved accuracy or a live enablement rule.

`accuracy-target.ts` evaluates fixed, prospective held-out trials. A model prediction must be frozen before its trial and must not use the actual fills it is tested against. Trade/account/direction/quantity binding, authenticated statement evidence, complete costs and USD amounts are required. Repeated or conflicting intent IDs invalidate the run. Block-level bounds are descriptive and require an independently justified grouping design; inventing different labels does not establish independence.

The owner Brain overview exposes a service-only, read-only 30-day coverage summary. Closed Infinity source roots are the denominator, including roots missing from the estimate archive. Historical gross coverage and account-wide reported net totals are not matched per-trade net proof. Until a broker receipt adapter provides a real benchmark, paired broker net is explicitly zero and measured net accuracy is unavailable.

## Currency supplement

`e8_currency_model` reconstructs a gross USD mark for non-USD quote currencies, using archived same-account broker bid/ask and contract evidence observed before entry. It supports JPY/CAD/CHF through inverse USD pairs and GBP/EUR through direct pairs. Each partial/full exit uses its own quantity and an as-of conversion quote no more than 15 seconds old. Positive quote-currency cash uses bid to sell the foreign currency (or divides by inverse ask); a liability uses ask to buy it (or divides by inverse bid).

Missing, future, stale, late-entry, invalid-size or unsupported evidence withholds the supplement. Original simulation events/results remain unchanged. The wrapper displays a separate reconstructed FX mark, actual sampling waits, and a USD-account assumption. Actual broker currency conversion, fills, commission and swaps remain unverified; no reconstructed amount becomes confirmed net. Quote observation times are not broker execution times. Account-specific conversion rules can differ from this conservative mark.

No extra broker requests, order actions, credentials, classifier thresholds, live flags or funded-account enablement are introduced. E8 remains read-only. The Stage 2 +2.75% shortcut and owner model choices are unchanged. This release does not create a broker execution pool or supply missing broker receipts.
