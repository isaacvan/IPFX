# Ongoing owner-selected A-book copying

The A-book page provides Connect/Disconnect and Execution ON/OFF for a saved E8/TradeLocker account. The old five-trade test remains available in historical database records but is no longer the page's active workflow. No trade-count quota is imposed by the new workflow; existing risk, crowding, margin, lot-step and provider limits still apply.

## Owner workflow

1. Sign in with Team MFA, open A-book and select a saved eligible E8 account, including the existing monitoring account. Set copy lots and maximum planned emergency-stop risk; confirm ownership and permitted signals. Connect saves execution OFF.
2. Find the exact registered IPFX trader and add them. Only active Infinity challenge accounts are eligible, including the person's subsequent stages. Practice Demo, external executions and historical opens are excluded.
3. Record genuine provider position/margin limits in Treasury and configure developer API access. These are checked on the server; client flags cannot satisfy them.
4. The human owner reviews and explicitly switches execution ON. Existing owner-model controls assign only selected people to A-book live. Adding another person while ON also needs explicit review. Changed selection/version invalidates an earlier ON review.
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
