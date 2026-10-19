# Data audit

19 October 2026. The production CLI query stalled at `Initialising login role` and was stopped after several minutes. No live per-person data was retrieved. A separate attempt to obtain API credentials for the brief's REST checks was rejected by automatic approval review because of the earlier never-handle-credentials instruction. No alternate credential retrieval was attempted.

The independently available frozen export `infinity-v3-offline.zip` (SHA-256 `9781bb208f818ba91cfaa4e75e81d7e09c02ce4883114bfacb33a9f5569dcad2`) has cutoff 18 October 2026 23:10:53 UTC. It contains 1,535 source trade rows, 1,524 within the quote reference window, and 1,417 priceable trades across six entry dates, 11–16 October. The missing-price breakdown is 78 entry and 29 exit quotes. The source launch was 18 September; this is not a complete E8-priced history since launch.

## Actual priced trades per person in the frozen export

| Number of priced trades | People |
|---|---:|
| 0–29 (among people with at least one priced trade) | 186 |
| 30–99 | 4 |
| 100–199 | 0 |
| 200 or more | 0 |

190 people total, maximum 43 priced trades for one person. No trader in that snapshot passes the 100-trade reporting or 200-trade actionability gate. Six shared dates also cannot support ten independent daily observations, multiple market cycles, reliable tail estimates or a fitted multi-factor actual-fill model. The cache implementation recomputes current coverage from actual data; these frozen counts must not be hardcoded into the live UI.

The frozen control is A net −$1,582.39 and B net −$5,685.11 at average 0.065 lots. The all-copy A account reaches its daily-loss floor on 13 October 11:38 UTC. All-window P&L includes later hypothetical entries and is not collectible after a breach.

Identity handling: person linkage uses ledger person IDs when available, rather than counting restarts or multiple accounts as independent people. Public research documents contain aggregates only. Emails belong exclusively in the owner-protected cache/UI and are excluded from fixtures and commits.

## Required live verification before calling the feature complete

Production verification on 19 October at 23:25 UTC: 465 registered Infinity people, 1,683 closed source trades, 1,436 priced and 247 unpriced. Maximum priced observations per person: 43. All 465 remain `INSUFFICIENT_DATA`; none meets the 100-trade reporting gate. These counts include people without priced trades, unlike the frozen export's represented trading population.

The current raw totals reconcile to A −$1,861.88481320598 and B −$5,248.13082075465. These are all-window hypothetical sums, not collectible account returns after an E8 breach. Maximum absolute per-trade `A+B+2×cost` error across the 12 execution cells: exactly zero in PostgreSQL numeric arithmetic.

Unpriced base-case reasons: 95 lack an entry quote within 30 seconds, 30 lack an exit quote within 30 seconds, and 122 lack an unambiguous match in the existing source control cache. Unmatched records are retained with their reason; none is assigned invented prices.

Actual service-role REST reads succeeded: first page 197,093 bytes / 755ms; detail 267,058 bytes / 208ms; one-person portfolio 33,981 bytes / 239ms. The scheduling RPC passed safeupdate in 112ms. Anonymous RPC and table reads returned 401. The deployed edge denied a nonowner token (401), and its four source files matched the local feature exactly. Real Books HTML with saved production results rendered 100 rows, 465 population, drawer curves and selected portfolio at 1280/1440/1920 with zero page errors; owner sign-in was stubbed. Two autonomous runs were matched to actual successful feature-run records at 23:13 and 23:23 UTC. Final performance and website publication evidence is recorded in JOURNAL.md.
