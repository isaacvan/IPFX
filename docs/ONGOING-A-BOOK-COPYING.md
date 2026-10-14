# Ongoing owner-selected A-book copying

The A-book page provides Connect/Disconnect and Execution ON/OFF for a saved E8/TradeLocker account. The old five-trade test remains available in historical database records but is no longer the page's active workflow. No trade-count quota is imposed by the new workflow; existing risk, crowding, margin, lot-step and provider limits still apply.

## Owner workflow

1. Sign in with Team MFA, open A-book and select a saved eligible E8 account, including the existing monitoring account. Set copy lots and maximum planned emergency-stop risk; confirm ownership and permitted signals. Connect saves execution OFF.
2. Find the exact registered IPFX trader and click **Start A-book live copying**, or use **Start A-book live** on an already-saved trader's row. This single explicit human action selects the person, records AB_LIVE and enables their future eligible copies atomically. No separate ON action follows. Practice Demo, external executions and historical opens are excluded.
3. Genuine provider position/margin limits are still required in Treasury. The saved login supplies JWT access/refresh tokens for one active execution account; multi-account execution needs developer access. A failed prerequisite leaves no partial selection/model/activation change.
4. Starting one trader does not start other saved traders. After a global stop, starting one person resumes only that person. ON/OFF labels distinguish saved selections from actually active routing. Per-order risk, inventory, margin, rate limits, holds and broker receipt checks still apply.
5. OFF, Disconnect or Stop copying trader stops new admissions. Orders already in flight may finish. Owned partial/full exits and uncertain opening receipts remain bound to the original account and continue to be tracked. Moving a selected person to a demo model, suspending them or placing them on integrity hold also blocks new copying.

## Components

- `supabase/migrations/20261013193000_ongoing_owner_copy.sql`: service-only RLS connection/selection/intention tables, private owner controls, immutable physical-account scope, version checks, duplicate admission, route, exit-link trigger and narrow patches to existing risk/capability/capture functions. Installation creates no connection, selection, ON setting or trade.
- `_shared/ongoing-copy-controls.ts` and `ladder-admin`: existing owner/admin/MFA gate; never expose credentials. They manage settings and return safe status, not broker orders.
- `trading-engine`: selected ongoing route precedes ordinary classifier/legacy-test routing. Eligible A-book opens use the existing hedge-first path; pending orders copy only when filled into an eligible source position.
- `book-executor`: admission, actual instrument/lot validation, risk reservation, fresh capacity snapshot, final permission check, durable opening journal, then one broker submission. Broker receipts require exact string IDs and quantity. Source changes during opening trigger exit catch-up. Ambiguous outcomes are reconciled rather than resent.
- `_shared/ongoing-execution.ts`: bounded cache of immutable instrument metadata only. `_shared/tradelocker.ts` config cache is scoped to environment, account selector and hashed token, rather than selector alone. Mutable permissions, risk, margin and inventory are not cached.
- `assets/js/ongoing-copy.js`: owner controls, stale-ON blocking, authoritative OFF/Disconnect acknowledgments, selected models, refused/uncertain intentions and broker receipts. Treasury/Brain distinguish monitoring from actual ongoing execution status.

## Monitoring and execution separation

The saved monitor's role and `execution_enabled=false` constraint remain unchanged. The monitoring client has no order methods. A separate ongoing scope can authorise execution for an exact admitted source/physical account, only after human ON. Generic monitor execution and alternate connections to that monitor remain denied. OFF/disconnect retain only the scoped access needed to read and close already-owned copies.

## Recovery and evidence

Opening journals persist the prior broker position IDs before dispatch. A reused/netted position cannot be accepted as a new hedged copy, including after a lost response. Missing inventory, malformed IDs, wrong quantity or unresolved receipts block confirmation/new entries. Historical absence never releases risk as proof of no fill.

The dashboard lists the latest 100 records; database history is retained. Gross P&L is calculated from recorded fills and instrument conversion. Complete broker fees/swaps and net reconciliation are still required before a verified-net claim. No 95% accuracy or production-scale throughput claim follows from synthetic tests.

Tests are entirely synthetic: real SQL in PGlite; actual open/destination/reconcile functions with mocked I/O; schema cache isolation; and a network-blocked browser fixture. Production publication is not proof of a funded fill. The agent must not switch funded execution ON or submit source orders that trigger it.

JWT-only extension: migration20261014001500 adds a private single-account capability and activation mode. Activations serialize on a transaction advisory lock; a second active physical execution destination blocks default-access admission. Owned exits remain available. Ordinary/legacy multi-account capacity paths retain their developer guard. HTTP429 responses are failures, never blindly retried as new orders; standard provider limits continue to apply. Basic authentication and scale/developer access are separate concerns.

One-action extension: migration20261014010000 adds per-selection live_selected, server-derived copying_on status and private ongoing_copy_start_trader. Selection, connection activation and the existing owner AB_LIVE transition commit together. Global legacy ON remains an explicitly reviewed bulk action, while the active page uses per-trader Start and global OFF. Installation starts nobody; old saved-only selections remain off. Repeated current-state starts are idempotent.

The A-book page includes E8 position and margin limits: choose the connected execution account, enter maximum combined open positions/pending orders, conservative USD margin per full lot and the documented source, then Save capacity settings. Values use the existing owner/MFA capacity_set endpoint. Saved values can be loaded, edits survive polling, and this form never changes execution enablement.
