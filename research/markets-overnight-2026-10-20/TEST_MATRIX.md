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
| Selected-symbol feed freshness | Reproduced stale timer renewal, invalid/crossed/zero quote caching, symbol mismatch, older response overwrites, invalidation losing its watermark and auth poll lock; 17 lifecycle cases pass; actual HTML refuses stale-price orders and recovers on a valid push; db6ab1f verified live | Initial upstream snapshot/replay age and quiet-feed server semantics remain unproven; rotate to backend conversion freshness next |
| Non-USD risk/conversion | Client expiry/invalidation/recovery and required-pair availability pass. Backend stale/invalid conversion, unknown margin/risk totals and pending-loss-on-outage failures reproduced; 74 focused checks and full suite pass with valid currency formulas and healthy quiet-feed behavior preserved | Publish/verify engine. Bid/ask risk conservatism, future provider timestamps and multi-stage feed reconnection remain untested |
| Pending orders | Reproduced cross-account cancellation in actual engine branch with synthetic rows; account filter added, own-account/owner/status/repeat controls pass. Live engine v112 source verified; existing stop-required/acknowledgement checks pass; expiry buffer explained by >60s server minimum | Trigger precision, OCO failures and minimum lots |
| Partial close/modify/trailing | Eight reproduced failures fixed: repeated confirmation, account/position/dialog changes, late result, uncertain acknowledgement and own-symbol precision; valid-action payload control passes; actual HTML warning/cancel/confirmed-slice interaction passed | Decimal/futures slice precision, numeric input-in-progress and cross-action confirmation ownership |
| Challenge/monthly inactive state | Existing breach refusal fixtures | UI state across restart boundary; do not change rules/records |
| Desktop layout/accessibility | Actual HTML checks passed at 1280/1440/1920. Reproduced tour hotkey dispatch and close-all arming across account/focus/modal changes; focused fixes pass. Actual tour/native-dialog hotkey blocking and normal post-dismissal trade passed | Zoom/height, active tab controls and clutter regressions |
| Backend invariants | Sixth-pass full suite: 1,240 passed, zero failed, twelve optional skipped. Final 74-case serial group includes no source credit when FX disappears after a hedge | Deploy/verify engine; production read-only aggregate checks only if necessary |

At the cutoff summarize verified fixes, test evidence, deployments and still-untested areas. “Every possible bug” cannot be proven absent; do not claim exhaustive coverage.

Test execution: run the isolated browser group after the broad PGlite suite, not concurrently. Concurrent runs produced intermittent management and startup timeouts; all four browser checks passed together after the suite completed. Root cause is not established.

Fifth pass also observed a guided-card startup timeout after the broad suite ended. Fixture mount readiness now permits 30 seconds; action deadlines remain ten seconds. The final five-test browser group passed together. The underlying intermittent resource/startup cause is still not established.

Additional source concern: `buildDomLadder` and `animateDom` generate random volume and derive a spread from a digit bucket. Verify its visibility/labels before changing; distinguish a price ladder from real venue market depth and preserve the established layout.
