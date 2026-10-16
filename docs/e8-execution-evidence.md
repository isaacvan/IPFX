# E8 execution evidence

This release adds observations and owner review tools. It does not change trader routing, risk limits, Stage 2 promotion policy, account balances, copying selections or execution switches. No broker order is submitted by the monitor or evidence endpoints.

## Data flow

1. New source lifecycle events, durable full-close intents and pending-order changes enqueue quote demand. Demand is per event; reads coalesce per account/instrument. Extra wakeups are bounded to one per account per second and **1,000 per UTC day globally**, in addition to the existing lease and provider request budget. At the ceiling, queued events wait for existing scheduled monitoring. No new Realtime subscription or publication is created. These bounds reduce additional usage; they do not guarantee that existing hosting remains within its allowance. An event receives its actual observed sampling delay, never a backdated price.
2. The read-only worker prioritises event symbols inside the existing seven-symbol ceiling, then background rotation. It preserves request/receive/provider timestamps when actually supplied and exact instrument/route IDs. A missing provider timestamp remains unknown. The transport request timestamp starts after the request-budget wait.
3. The executor submits its unchanged authorised orders. A separate best-effort background RPC records send/acknowledgement and receipt lookup durations, matching a fresh pre-send stored quote only when one exists. The RPC has no order or retry capability. Failed evidence storage cannot cause a duplicate order.
4. The owner uses Costs & E8, or the classic A-book page, to review timings, import a position receipt, compare paired A/B paper results, or check an isolated balance interval. All actions retain verified owner authentication, MFA, request limits and server-side validation.

## Receipt rules

- Candidate IDs come from already-matched broker opening and closing records; long IDs stay strings.
- Every exit, including partials, must match the same account/position, symbol, opposite side and full original quantity.
- A pre-entry USD contract observation independently checks gross. Unknown or mismatching contract evidence refuses import.
- Charges and credits are signed. A fee that already includes commission is not charged twice. Empty costs never become zero.
- Receipt gross plus adjustments must match net within one cent. Imports are append-only; exact duplicates are idempotent, including reordered exit IDs. Conflicting revised receipts stay visible for review.
- Manual imports are labelled `OWNER_REVIEWED_POSITION_RECEIPT`, not an authenticated API statement. They cannot automatically satisfy the existing prospective 95% certification target.
- Clipboard import requires column headers and exactly one tab-separated row. It does not infer absent fields or convert GBP/EUR values to USD. Screenshot OCR and automatic browser-history capture are not included in this release; users can transcribe the displayed row.

## Balance rules

The interval must start/finish flat, contain one position, have complete settled history, no unrelated activity/unknown adjustments and stay within the same broker accounting day. Owner confirmations are archived and explicitly separated from machine-observed facts. If the broker omits currency, the owner may confirm USD from the statement; a reported foreign currency cannot be overridden. Result provenance remains an owner-attested interval check, not an authenticated position receipt.

## Paper A/B limits

Paired results use the same fresh pre-event observed quote path, opposite sides of the spread, actual exited quantities and a pre-entry broker contract. Missing costs leave net unknown. Future quotes, stale benchmarks and incomplete exit quantities refuse a completed result. For equal quantity and timing, the sum of A and reverse B gross equals the negative entry-plus-exit spread cost.

This calculator uses the recorded **source exit schedule only**. It does not prove the destination's independent pending trigger, stop/TP ordering, liquidity, actual opposite-side fill, swap or real slippage. The legacy delayed sampled estimates are preserved; this release does not rewrite old trader results or certify them. Dedicated delay-distribution calibration, a full destination lifecycle simulator and a persistent execution dispatcher remain follow-up experiments, conditional on new measurements and account capabilities.

## Release sequence

1. Review the committed diff against current main. Fetch/merge other agents' work and check deployed bundle drift.
2. Apply `20261015180000_e8_execution_evidence.sql` transactionally through authorised owner database access. It adds private tables, indexes, restricted RPCs and observational triggers. It contains no reset or policy changes. New triggers contain observation/wakeup failures so they do not roll back a source trade.
3. Deploy `e8-monitor-admin`, `e8-reference`, `book-executor` and `trading-engine` preserving each endpoint's existing authentication settings. The last two also include the already-tested pending latency patch.
4. Publish the website assets and verify anonymous backend requests are still denied. Download deployed sources and compare exact imports. Do not invoke the authenticated executor or enable copying as a smoke test.
5. Check the owner dashboard. Real end-to-end latency and cost coverage require later human-initiated orders and matched receipts. No funded trades are needed just to install these tools.

The previous automatic approval review rejected direct publication to main. That publication restriction remains until explicit approval for this concrete release; a feature branch is a review artifact, not a production deployment.

## Requested exits with delayed opening receipts

An ongoing copy can exist at the broker while its opening history receipt is still pending locally. On a requested full or partial exit, the executor now checks that exact saved opening order immediately, once, with no polling sleep. It verifies the complete quantity, string order/position identities and saved pre-entry inventory, then conditionally saves the confirmed opening receipt before the normal locked exit plan and unique dispatch claim. A confirmed opening uses the existing path without another opening-history request. Opening dispatch itself is unchanged.

Missing order identity, history outage, mismatched quantity/position, reused positions, a failed receipt write or a concurrent state change cannot cause a guessed close or risk release. Those cases retain reconciliation. This removes a scheduled-reconciliation wait when the exact receipt is already available; it cannot guarantee broker completion time or recover a missing acknowledgement without evidence.

## Read-only position diagnostic

The owner evidence panel can diagnose a copied broker position from saved records. The endpoint retains owner/MFA checks, accepts an exact string position ID, scopes the opening to the selected account's book, and uses bounded database reads. It makes no provider requests or record mutations. Complete, unique opening/exit receipts must match account, position, side, symbol, quantity and journal prices; a pre-entry USD contract must independently match the exact instrument and lot size.

The report separates source-to-dispatch timing, source-to-broker-order creation, request acknowledgement, receipt lookup and observed pre-send quote shortfall. Missing dispatch records are not reconstructed. Order creation and acknowledgement are not exact execution timestamps; source times are records/close requests, not measured mouse clicks. Quotes from another account/instrument, later quotes and stale quotes never become a slippage benchmark.

For an isolated flat interval with a stable subsequent snapshot, exact interval order IDs and consistent balance/daily gross/net/fee deltas, the report can show a **balance cost candidate**. It remains unverified and requires review of account currency, other adjustments, broker day and settlement. Unknown currency is explicit and any proposed USD result is conditional; foreign-currency balances cannot be mixed with USD gross. Combined cost does not establish commission versus swap. The tool does not set a cost model, rewrite trader P&L, certify accuracy or enable execution.

## Validation

The new tests execute real handlers with synthetic broker/database fixtures, PGlite migrations/RLS and isolated browser rendering. The 2,000-event test checks demand retention/coalescing only; it is not a production trading-capacity test. API request quotas, missing historical ticks and delayed provider postings remain external constraints. The complete suite and evidence screenshots are recorded in the chat audit workspace.
