# Infinity v2 build status — 29 October 2026

INCOMPLETE. Build only. Do not deploy these migrations or enable Infinity v2.

## Implemented in this branch

- Saved v2 thresholds and per-account snapshots, configurable cutover, disabled default.
- Existing Infinity accounts backfilled v1; stage children inherit; Stage 1 restarts are new runs.
- Guarded one-way version changes, append-only switch audit, immutable initial-stop fields.
- Service-only transactional switch routine: ownership, flatness, consent, idempotency and rate limit.
- Pure grouping/scoring and trading-validation kernels with behavioral tests.
- Supplied restart UI copied without redesign; only its script tag added to trading.html.
- Launch template staged inactive; allowlisted in the outbox; no queue rows or sends.

The settings row has an additional `integration_ready=false` gate. This is deliberate: enabling a partly implemented ruleset would misrepresent the terms traders accepted.

## Integration still required (release blockers)

1. Engine: load saved account version/config; route open, pending activation, modify, trailing, partial close, full close and enforcement to v2 validators. Implement atomic account risk reservations, including counted-group opening-risk budgets. Helpers alone do not provide atomicity.
2. Capture initial risk once from the first actual stop, including entry-time stops and stops set in the first 30 seconds. Bind partial-close slices to their original position, allocate opening risk once, and prevent slices from duplicating observations.
3. Qualification: normalize original positions and partial slices, load only version-eligible ancestor observations, and cache grouping/score progress outside the eight-second API budget. Integrate all three stages and all missing-child recovery paths. Keep ancestor switch cutoffs, not just the current account cutoff.
4. Version every creation path in integration tests. The insert trigger is tested in isolation; actual monthly, offer, admin, claim and recovery functions have not yet been replayed with it. Check BEFORE-trigger ordering against qualification attachment and legacy issuance.
5. Switch: acquire the same order lock as open/modify/activation, add authenticated engine action and dashboard flow, test concurrent opens versus switching, enforce eligibility and preserve every financial/loss/strike field in full-schema tests. The SQL routine is not currently exposed by the engine.
6. Restart: implement transactional `restart_infinity`, archiving, KYC/jurisdiction/age, monthly attempts and breach lockout, consent, exactly-once account creation, rate limit and engine status. Preserve existing claim fallback. No restart endpoint was added in this foundation.
7. Daily loss: change the v2 midnight baseline to closed balance throughout engine and database/hub guards. Exempt v2 from all daily profit cap paths. Record symbol stop-out pauses and enforce them on all new-entry paths. Add Stage 4 window enforcement.
8. Pricing: apply reference spreads/markup, commission and gold lot precision; decouple simulated fills from broker copies for v2; keep broker reconciliation and copy ledger intact. Helpers are not wired into order fills.
9. Payout SQL: use the five-minute exclusion for v2; preserve v1 amounts, liabilities and records. Gate pass/payout on relevant existing identity/ring/herd evidence with documented review/clear workflow. Do not treat stacking alone as conclusive coordinated cheating.
10. UI: source the supplied dialog's hard-coded table/terms ID from the saved version, include both Stage 2 score conditions, add version/switch/progress/ticket indicators, and test preview dark/light plus close/back/cancel. No browser validation has been performed yet.
11. Publish the owner's final terms (test fixtures are placeholders), verify commission and venue-supported gold quantity increments. Validate launch-email template variable names and recipient rendering before enabling any queue.
12. Full-schema PGlite tests and fixed v1 financial replays; broker-copy pricing equivalence tests; all boundary tests and local browser tests listed in the supplied spec. The focused foundation tests are not substitutes.

## Decisions/interpretations

- Score uses sample standard deviation (`n-1`), with the configured 0.5 floor. The spec does not distinguish sample from population SD; confirm before launch.
- Best-day share uses total eligible **net** profit as specified for v2, rather than v1's sum of positive days.
- Group 15-minute boundary is inclusive. Overlap is tracked using the maximum close time of every member; symbols, accounts and directions have separate streams.
- Both positions and pending orders must be absent for switching and stage readiness.
- An account's snapshots are fixed for the stage. Changing published thresholds requires another version, not rewriting accepted rules.
- Turning the new-start flag off cannot undo switches or change existing v2 runs back to v1. A full operational rollback must still serve those accounts under their accepted rules.

## Migration order

1. `20261029090000_infinity_v2_versions.sql`
2. `20261029091000_infinity_v2_switch.sql`
3. `20261029092000_infinity_v2_launch_template.sql`

Settings: `infinity_v2_settings.infinity_v2_enabled`, `cutover_at`, `terms_version`, `integration_ready`. Per-symbol pricing: `infinity_v2_pricing_profiles.spread_markup`, `commission_round_turn_per_lot`, `min_lot`. Commission is NULL until confirmed. Gold's proposed 0.001 is configuration only, not a claim of broker or engine support.

## 31 October go-live checklist (blocked until integration completes)

- Complete every release blocker above; rebase onto current origin/main and rerun the complete suite.
- Confirm accepted rules and terms, commissions, spreads, gold precision, v2-only bug-fix treatment for v1.
- Rehearse all migrations, switch and restart on local fixtures; verify financial invariants and v1 golden results.
- Verify owner test account flows; preview every launch-email substitution without queueing or sending.
- Enable at or after 1 November 2026 00:00 UTC; verify one new run, one restart and one inherited v1 stage.
- Verify v1 screens and fills unchanged; verify switched account retains balance/floors/strikes and counters start at switch time.
- Load launch template only; sending remains a separate explicit action.
- Disable new-start flag if needed; retain support and enforcement for already accepted v2 runs.
- If release blockers remain on 31 October, follow the supplied rules document: postpone launch rather than advertise unenforced rules.
