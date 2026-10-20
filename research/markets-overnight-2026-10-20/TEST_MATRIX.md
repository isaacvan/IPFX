# Overnight test matrix

Use actual production functions in meaningful regression tests; browser transports must remain synthetic. No financial transactions or production account mutations.

| Area | First-pass evidence | Next action |
|---|---|---|
| Overlapping account refreshes | Late-response and old-lockout fixes; actual selector away/back regression passed | Acknowledged actions amid polls and auto-demo fallback |
| Session acquisition failures | Reproduced exception and hang; bounded abort/catch fix | Reconnection and signed-out display; no credential reads |
| Account switch during pending work | Reproduced wrong-account dispatch and stale response; captured context fix | Short-hold partial-close and account switch cases |
| Reverse | Reproduced wrong market, unconfirmed close, empty-market buy, changed account/market | Confirm no automatic second leg after partial failures |
| Close All | Reproduced false success and cross-account confirmation | Mixed stale quotes, close failures, duplicate clicks and confirmation cancellation |
| Fill/acknowledgement messages | Submitted symbol/volume retained; different-market pending trigger/OCO preservation passed | Same-market edits, duplicate submissions and HTTP-error detail |
| Lot entry, stops, cap | Existing guided-ticket regressions passing in initial group | Decimal edge cases, input-in-progress, symbol switch before 500ms refresh, account-specific defaults |
| Tour | Existing close/seen tests; actual HTML dismissal and manual replay passed | Auto-start races, keyboard focus restore, unavailable localStorage, late account load, resize |
| SL/TP steppers | Reproduced wrong FX/JPY/silver precision; five spot tick round trips pass; actual HTML stepper passed | Futures tick specifications and fractional bond-price precision require separate audit |
| Selected-symbol feed freshness | Source audit pending | Stale/closed status while last tick is young, reconnect, crossed/zero prices; do not invent provider freshness |
| Non-USD risk/conversion | Existing JPY/missing conversion fixtures | Conversion quote expiry, gap/zero/crossed quotes, account switch |
| Pending orders | Existing stop-required and acknowledgement fixtures | Trigger precision, expiry around 22:00 UTC, cancel/OCO failures, minimum lots |
| Partial close/modify/trailing | Eight reproduced failures fixed: repeated confirmation, account/position/dialog changes, late result, uncertain acknowledgement and own-symbol precision; valid-action payload control passes; actual HTML warning/cancel/confirmed-slice interaction passed | Decimal/futures slice precision, numeric input-in-progress and cross-action confirmation ownership |
| Challenge/monthly inactive state | Existing breach refusal fixtures | UI state across restart boundary; do not change rules/records |
| Desktop layout/accessibility | Actual HTML browser checks passed at 1280/1440/1920 | Keyboard shortcuts inside inputs/dialogs, zoom/height, active tab controls and clutter regressions |
| Backend invariants | Third-pass full suite: 1,207 passed, zero failed, ten optional skipped; frontend guards only | Existing atomic close/idempotency/risk fixtures; production read-only aggregate checks only if necessary |

At the cutoff summarize verified fixes, test evidence, deployments and still-untested areas. “Every possible bug” cannot be proven absent; do not claim exhaustive coverage.

Additional source concern: `buildDomLadder` and `animateDom` generate random volume and derive a spread from a digit bucket. Verify its visibility/labels before changing; distinguish a price ladder from real venue market depth and preserve the established layout.
