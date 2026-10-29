# Infinity v2 build report — 29 October 2026

Build and local integration complete. Deployment and activation are separate work. No production SQL, deployments, email sends, pushes to main, or real trader mutations were performed.

## Branch and changes

- Branch: `codex/infinity-v2`; worktree: `C:/Users/paula/New folder/ipfx-infinity-v2`.
- Latest fetched base: `origin/main` at `f725465ae0d7a96726b5294ac3d1746a084a4c69`. Rebase reported up to date; final verification ran afterward.
- Foundation commits: `19c256a`, `159a5b9`, `e60fc2a`, `3f712f0`, `f6f6345`, `49c0f29`, `bc135fe`.
- Integration commit: `ad71889`; final report is a separate documentation commit.
- Diff: versioned database enforcement, engine execution/pricing, progression/payout adapters, switch/restart transactions, review tooling, desktop controls, public rules, staged emails, hub deadline support, and regression tests. Existing v1 financial records are not rewritten.

## Verification

Final full-suite totals will be recorded here after the committed-code run completes.

Command: `node --test --test-concurrency=4 --test-timeout=180000 tests/*.test.mjs`. Environment: `DEMO_TEST_DEPS=C:/Users/paula/AppData/Local/Temp/ipfx-demo-validation`; TEMP/TMP use `C:/Users/paula/New folder/infinity-v2-test-tmp`. Hub loopback tests run outside the sandbox. Optional skips remain skips.

- Deno `check --no-config` passed for trading-engine, admin-console and email-outbox. Changed UI and hub JavaScript syntax checks passed.
- Local Chrome checks passed: actual trading page, consent gating, both Stage 2 score requirements, confirmation, close, dark/light layouts without horizontal overflow, and zero account mutations in preview.
- A second browser flow exercised actual engine switch/restart action code against synthetic PGlite accounts and real SQL transactions: one switch, one restart, one active v2 account. External/production requests were blocked. The public rules page rendered saved thresholds.
- PGlite checks cover immutable versions/risk, atomic admissions, grouping/partials, progression/recovery, midnight baseline, no profit cap, pricing fallback, canonical Stage 4 breach/strike audit, review clearances, monthly/free restarts, consent, financial preservation, and stale requests after switching/archiving.
- The actual shared provisioner used by claims, owner grants, resets and approval was replayed with the flag off, before cutover and live. Actual monthly/free-restart and stage-advance functions were replayed too.
- Source-close tests exercise the actual v2 close branch and execution wrapper, comparing copied and uncopied simulated outcomes.

Limits: local tests do not validate live venue credentials, production schema drift, real broker execution, production throughput or profitability. PGlite queues requests in one engine, so this is not a multi-session PostgreSQL load test. Browser authentication and lock-RPC transport are mocked; SQL ownership/consent/state rules are exercised locally.

## v1 evidence

Version branches preserve v1 execution/pricing, daily caps, the 60-second exclusion, stage rules and payouts. Wrappers clone legacy bodies and retain canonical function OIDs. Migrations capture prior definitions and abort on known source drift. Existing accounts become v1; child stages inherit even with new starts disabled.

Fixed before/after replays compare legacy cap/count/hold adapters and a real Stage 3 payout: $1,150 eligible gross, $700 capped share, unchanged split/status/event. The payout replay includes a 120-second winner eligible for v1 and an excluded 30-second winner. Existing regression tests cover v1 engine, progression, cap and payout behavior. The local fixture uses an explicit legacy qualification-result stub because its original function body is absent from this repository; that verifies wrapper routing, not a replay of the unavailable deployed body. Check the captured deployed definition during release rehearsal.

The v1 progress panel is retained, with the requested badge and gated switch control. While v2 starts are live, legacy order writes also lock the account row to serialize with explicit switches/restarts. This protects concurrency without changing financial rules; the disabled fast path is retained.

## Rules and implementation decisions

- New accounts receive an immutable version; stage children inherit. Flag off is the default; cutover is configurable. Switches are one-way, flat-only, consented, audited, repeat-safe and order-locked.
- Switches preserve balance, floors, daily state, strikes, held profit and stage. Only scored observations restart. Previously earned eligible profit retains its original hold treatment; new trades use 300 seconds. Combined scores include verifiable post-v2 lineage observations, without inventing opening risk for old v1 trades.
- Grouping is independent per account/symbol/side; the 15-minute boundary is inclusive. Partial slices share one root observation/risk denominator. Score uses sample SD (`n-1`), a 0.5 floor and ±5R scoring cap. Best-day share uses total eligible net profit.
- A missed-stop closure keeps losses and incurs the canonical strike. Without opening risk it cannot supply a scored observation; one strike does not permanently disqualify later trading. Three strikes end the run through the audited breach path.
- Stage 4 uses actual net P&L over any 40 valid completed groups, counting partials once. The canonical breach allowlist/event constraint accept the new v2-only performance reason.
- Progress reads use cron-cached results; stale/dirty results show scoring pending and cannot authorize passing. Authoritative pass/payout transactions recheck qualification and review holds.
- Linked identities, both ring participants and identical/herd evidence hold advancement/payout. Review requires owner MFA, an audit intent and an append-only evidence clearance with a reason. New evidence reopens the hold; heartbeat refreshes alone do not. Trading stays available.
- Restarts archive the old account with an explicit closed status/reason, retaining payouts/liabilities/history. First starts and restarts share the monthly allowance, including retired accounts. Eligibility, breach lockout and one-account protections remain.
- The supplied restart dialog keeps its styling and ended-run fallback. Preview is always read-only. Live numbers/terms come from saved rules; the generated preview uses the same row.

These fixes are v2-only: no stop widening/removal, counted-group and aggregate risk checks, eight-spread minimum stops, ten-minute symbol pauses, closed-balance midnight baseline, no daily cap, fractional gold sizing, and simulated fills independent of copying. Extending them to v1 remains an owner decision.

## Migrations, in order

1. `20261029090000_infinity_v2_versions.sql` — disabled settings, immutable account versions and opening risk.
2. `20261029091000_infinity_v2_switch.sql` — switch transaction/consent audit.
3. `20261029092000_infinity_v2_launch_template.sql` — inactive launch template, no queue.
4. `20261029100000_infinity_v2_runtime.sql` — atomic risk/grouping/pricing and progress cron/cache.
5. `20261029101000_infinity_v2_adapters.sql` — versioned loss/cap/progression/payout adapters.
6. `20261029102000_infinity_v2_restart.sql` — archive status, eligibility, monthly attempts and restart.
7. `20261029103000_infinity_v2_pending_and_partials.sql` — pending enforcement/fractional partials.
8. `20261029104000_infinity_v2_authority.sql` — matching marks, cached reads and canonical strikes.
9. `20261029104500_infinity_v2_performance_breach.sql` — canonical performance breach reason.
10. `20261029105000_infinity_v2_review.sql` — evidence clearance/owner advancement gate.
11. `20261029105500_infinity_v2_stage_recovery.sql` — qualified missing-child recovery.
12. `20261029106000_infinity_v2_release.sql` — activation prerequisites/versioned lifecycle emails.
13. `20261029107000_infinity_v2_hub_deadline.sql` — per-account hub stop deadline.

Release the matching engine, admin-console, email-outbox, hub and frontend together. Resolve source-drift exceptions against deployed definitions; do not bypass them.

## Settings and owner decisions

- `infinity_v2_settings.infinity_v2_enabled` remains **false**; `cutover_at` defaults to `2026-11-01T00:00:00Z`.
- `integration_ready` becomes true in the final integration migration; that alone does not enable starts.
- `terms_version` must reference the owner's published Terms row in `platform_legal_documents`, with a URL. Test documents are placeholders, not final legal terms.
- `infinity_v2_pricing_profiles.spread_markup` defaults to 1.15; confirm per symbol.
- `commission_round_turn_per_lot` stays NULL until confirmed. Activation refuses missing values for enabled symbols; use explicit zero only intentionally.
- `min_lot` defaults to 0.01 and XAUUSD to 0.001. Local engine/database/partial/margin paths support it. Confirm live copy-venue quantity increments before releasing gold.
- Threshold/version rows and accepted account snapshots are immutable. Later threshold changes need a new accepted version design. Review sample-SD and mixed-version lineage interpretations before final Terms.

The launch template stays inactive; no email was queued or sent. Two v2 lifecycle templates prevent new-run emails from describing v1 rules after release; v1 selection stays unchanged. Launch sending requires explicit HTTPS rules/terms/unsubscribe substitutions and separate sending authorization.

## 31 October go-live checklist

1. Confirm final Terms, commissions, markups, gold quantity and interpretations above. Keep v2 disabled until resolved.
2. Fetch current main, resolve parallel changes and rerun all tests/browser checks. Rehearse on a production-schema test copy, including deployed qualification definitions, ACLs and cron permissions.
3. Under separate release authorization, apply migrations in order and deploy matching functions/frontend/hub. Confirm the flag stays off and launch email inactive, without queueing mail.
4. Set published Terms/pricing. At or after **1 November 2026 00:00 UTC**, enable the flag; leave existing v1 runs unchanged.
5. On designated owner test accounts, verify one new start/restart is v2, retries create one account, allowance drops, and a v1 child remains v1. Test a flat consented switch and confirm carried financial state/fresh score observations.
6. Check v1 screen/fill/payout preview; v2 stop/pause/hold displays, gold partials, fresh progress, advancement/review holds and canonical breach audit. Observe latency and copied/uncopied simulation on test accounts.
7. Preview launch/lifecycle variables without sending. Sending is a separate explicit action.
8. Rollback: turn `infinity_v2_enabled` off to stop new starts/restarts/switches. **It cannot undo accepted switches or revert existing v2 runs.** Continue serving/enforcing their accepted rules; do not reverse migrations or delete financial/audit history.
