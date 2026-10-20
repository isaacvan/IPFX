# Overnight test matrix

Use actual production functions in meaningful regression tests; browser transports must remain synthetic. No financial transactions or production account mutations.

| Area | First-pass evidence | Next action |
|---|---|---|
| Overlapping account refreshes | Reproduced late-response overwrite; sequence/context fix | Validate switch-away-and-back epoch and acknowledged actions amid polls |
| Session acquisition failures | Reproduced exception and hang; bounded abort/catch fix | Reconnection and signed-out display; no credential reads |
| Account switch during pending work | Reproduced wrong-account dispatch and stale response; captured context fix | Short-hold partial-close and account switch cases |
| Reverse | Reproduced wrong market, unconfirmed close, empty-market buy, changed account/market | Confirm no automatic second leg after partial failures |
| Close All | Reproduced false success and cross-account confirmation | Mixed stale quotes, close failures, duplicate clicks and confirmation cancellation |
| Fill/acknowledgement messages | Submitted symbol/volume now retained through edits | Pending acknowledgement must retain newly edited trigger/OCO fields |
| Lot entry, stops, cap | Existing guided-ticket regressions passing in initial group | Decimal edge cases, input-in-progress, symbol switch before 500ms refresh, account-specific defaults |
| Tour | Existing close/seen tests; actual HTML browser test pending | Auto-start races, keyboard focus restore, unavailable localStorage, late account load, resize |
| SL/TP steppers | Source audit pending | `adjSltp` uses digit buckets that may produce an inappropriate FX/JPY step; reproduce against actual symbol precision before editing |
| Selected-symbol feed freshness | Source audit pending | Stale/closed status while last tick is young, reconnect, crossed/zero prices; do not invent provider freshness |
| Non-USD risk/conversion | Existing JPY/missing conversion fixtures | Conversion quote expiry, gap/zero/crossed quotes, account switch |
| Pending orders | Existing stop-required and acknowledgement fixtures | Trigger precision, expiry around 22:00 UTC, cancel/OCO failures, minimum lots |
| Partial close/modify/trailing | Not yet tested in this audit | Remainder/step precision, repeated submit, stale trade/context during confirmation |
| Challenge/monthly inactive state | Existing breach refusal fixtures | UI state across restart boundary; do not change rules/records |
| Desktop layout/accessibility | Actual HTML browser checks passed at 1280/1440/1920 | Keyboard shortcuts inside inputs/dialogs, zoom/height, active tab controls and clutter regressions |
| Backend invariants | Broad repository suite pending | Existing atomic close/idempotency/risk fixtures; production read-only aggregate checks only if necessary |

At the cutoff summarize verified fixes, test evidence, deployments and still-untested areas. “Every possible bug” cannot be proven absent; do not claim exhaustive coverage.

Additional source concern: `buildDomLadder` and `animateDom` generate random volume and derive a spread from a digit bucket. Verify its visibility/labels before changing; distinguish a price ladder from real venue market depth and preserve the established layout.
