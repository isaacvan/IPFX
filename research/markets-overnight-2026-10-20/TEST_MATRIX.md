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
| Pending orders | Reproduced cross-account cancellation in actual engine branch with synthetic rows; account filter added, own-account/owner/status/repeat controls pass. Live engine v112 source verified; existing stop-required/acknowledgement checks pass; expiry buffer explained by >60s server minimum | Trigger precision, OCO failures and minimum lots |
| Partial close/modify/trailing | Eight reproduced failures fixed: repeated confirmation, account/position/dialog changes, late result, uncertain acknowledgement and own-symbol precision; valid-action payload control passes; actual HTML warning/cancel/confirmed-slice interaction passed | Decimal/futures slice precision, numeric input-in-progress and cross-action confirmation ownership |
| Challenge/monthly inactive state | Existing breach refusal fixtures | UI state across restart boundary; do not change rules/records |
| Desktop layout/accessibility | Actual HTML checks passed at 1280/1440/1920. Reproduced tour hotkey dispatch and close-all arming across account/focus/modal changes; focused fixes pass. Actual tour/native-dialog hotkey blocking and normal post-dismissal trade passed | Zoom/height, active tab controls and clutter regressions |
| Backend invariants | Fourth-pass full suite: 1,214 passed, zero failed, eleven optional skipped; pending cancel adds account binding | Existing atomic close/idempotency/risk fixtures; production read-only aggregate checks only if necessary |

At the cutoff summarize verified fixes, test evidence, deployments and still-untested areas. “Every possible bug” cannot be proven absent; do not claim exhaustive coverage.

Test execution: run the isolated browser group after the broad PGlite suite, not concurrently. Concurrent runs produced intermittent management and startup timeouts; all four browser checks passed together after the suite completed. Root cause is not established.

Additional source concern: `buildDomLadder` and `animateDom` generate random volume and derive a spread from a digit bucket. Verify its visibility/labels before changing; distinguish a price ladder from real venue market depth and preserve the established layout.
