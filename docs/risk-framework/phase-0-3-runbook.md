# IPFX Capital — Phase 0-3 Internal Control Runbook

Companion to `docs/risk-framework/deepseek-ipfx-report.md`. This tracks what was
actually built against that report's Phase 0-3 scope, how to verify it, and
exactly what remains before Phase 4+ can even be discussed.

**Environment note, stated once and load-bearing for everything below:** the
session that authored this had no Node.js/npm installed. Every `.ts` file
under `internal-control/` was written and hand-reviewed but **never compiled
or run**. The SQL in `internal-control-core.sql` was deployed against the
live Supabase project's SQL editor, which is real Postgres — that part *was*
executed and its own errors (if any) are real. Treat that difference as the
line between "verified" and "authored, pending verification" throughout.

## What exists

| Area | File | Status |
|---|---|---|
| Full data model (36 tables incl. `person`/`review_case`/`audit_event`/etc.) | `internal-control-core.sql` | **Deployed to production Supabase, verified** — see "Deployment log" below |
| RLS: owner-only tables + trader-own-row tables | same file, §10 | Deployed; `rowsecurity=true` confirmed on a sample of owner-only and trader-visible tables |
| Append-only audit hash chain | same file, §8 | Deployed and **live-tested**: appended two real events, `fn_verify_audit_chain()` returned zero rows (chain intact), then confirmed the append-only trigger genuinely blocks deletion (attempted a cleanup delete on the test rows — correctly rejected) |
| Terms/rule-policy immutability once referenced by a live challenge | same file, §9a | Deployed, not yet live-tested with a real challenge_instance row (no traits have one yet — pre-launch) |
| Deterministic metrics (PF, expectancy, Sharpe/Sortino, drawdown, exposure, HHI, etc.) | `internal-control/lib/metrics.ts` | Authored, unexecuted |
| Block bootstrap, Monte Carlo path sim, BH-FDR, evidence confidence, data quality | `internal-control/lib/probability.ts` | Authored, unexecuted |
| Review state machine (human-only rejection, independent appeal reviewer) | `internal-control/lib/review-state-machine.ts` | Authored, unexecuted |
| Similarity scoring, cohort z-score, FDR, deterministic clustering | `internal-control/lib/similarity.ts` | Authored, unexecuted |
| Alert dedup/cooldown/throttle/quiet-hours/dead-letter | `internal-control/lib/alerts.ts` | Authored, unexecuted |
| Test suite mirroring §19.1 acceptance criteria | `internal-control/tests/core.test.ts` | Authored, unexecuted — **run this first** in any environment that picks this up |

## What does NOT exist yet (explicitly out of scope this pass)

- **The Next.js/React owner dashboard itself.** No `package.json`, no framework
  scaffold, nothing UI-shaped was created. Building one blind, with no way to
  `npm install` or `next build` and catch the errors that produces, would mean
  shipping unverified framework-glue code and calling it done — that's the
  "describe planned work as completed" failure mode this task explicitly
  prohibits. The data model and domain logic above are the real foundation a
  dashboard needs; wiring them into Next.js pages/server actions needs a
  session with a working Node environment.
- **Server-side session/MFA enforcement code.** This depends entirely on
  which auth stack the dashboard ends up using (Next.js middleware,
  Supabase Auth helpers, etc.) — there is no dashboard yet to attach it to.
  The RLS layer in `internal-control-core.sql` is real and deployed and is
  itself one full layer of the "RLS plus server authorization, never RLS
  alone" requirement — the *other* layer (server-side session check on every
  route) has to live in the dashboard app.
- **`app.settings.pii_key`** — not set. Every PII write will fail closed
  (`fn_pii_key()` raises) until an operator sets this via Supabase Vault or
  `ALTER DATABASE ... SET app.settings.pii_key = '<32+ char secret>'`. This is
  correct fail-closed behavior, not a bug: no PII should ever be written
  encrypted-with-nothing.
- **Cohort null-distribution calibration for similarity thresholds**
  (`PLACEHOLDER_LAMBDAS` in `similarity.ts`). The report is explicit that
  these must come from cohort permutation on real data, never intuition —
  there is no real trade population large enough yet (61 pre-launch users)
  to calibrate against. Do not point this at production trader pairs and
  treat its output as decision-grade until that calibration happens.
- **Independent model validation, out-of-sample calibration testing**
  (report §7.7/§7.8) — needs real historical data this pre-launch platform
  doesn't have yet.
- **Everything in Phase 4+** (shadow Trade Syncer, provider adapters, live
  pilot) — not started, and per the report's own gates, must not start
  before legal/provider sign-off regardless of engineering readiness.

## Deployment log

- **Deployed.** Ran clean against the live production Supabase project on
  the first attempt (all 36 tables, RLS, triggers, audit-chain functions).
  Supabase's own pre-run linter flagged "creates tables without enabling
  RLS" as a false positive — it can't see RLS being enabled via the
  `do $$ ... execute format('alter table %I enable row level security')
  ... $$` loops used for the owner-only table group; every table was in
  fact already covered. Chose "Run and enable RLS" anyway (harmless no-op
  where already covered, a safety net if this analysis missed anything).
- **A real bug was found and fixed during deployment, not just review.**
  `fn_append_audit_event()` initially failed with
  `function digest(text, unknown) does not exist` on its first live call.
  Cause: Supabase installs `pgcrypto` into the `extensions` schema, not
  `public` — confirmed via `select extnamespace::regnamespace from
  pg_extension where extname='pgcrypto'` → `extensions`. `fn_sha256`,
  `fn_encrypt_pii`, and `fn_decrypt_pii` all called pgcrypto functions
  without `extensions` in their `search_path`, which only breaks at CALL
  time, not CREATE time — exactly why running this for real mattered more
  than the hand-review alone. Fixed by adding
  `set search_path = public, extensions` to all three; re-verified live
  with two real `fn_append_audit_event()` calls forming a genuine two-link
  chain, `fn_verify_audit_chain()` returning zero rows (intact), and a
  direct attempt to delete the two test rows being correctly rejected by
  the append-only trigger (`fn_audit_immutable`) — proving the immutability
  guarantee holds even for the two harmless test rows, which is why they
  were left in place rather than fought past.
- Verification queries used (safe to re-run any time):
  `select * from public.fn_verify_audit_chain();` → zero rows.
  `select public.fn_is_admin();` while authenticated as an existing
  `public.admins` row → `true`; as any other user → `false`.

## How to verify each §19.1 acceptance item

### Review and rules
- *Active challenge uses immutable accepted terms version* — insert a
  `challenge_instance` row, then try `update public.terms_version set
  content_sha256 = 'x' where id = <that terms_version_id>;` — must raise
  `terms_version_immutable`.
- *Human rejection required for non-deterministic flags* — run
  `internal-control/tests/core.test.ts`, test `"a model may never directly
  produce a rejection"`.
- *Reason code mandatory, `NOT_ELIGIBLE_CAPITAL_INTERNAL` never denies
  eligibility* — same test file, plus the DB trigger
  `fn_block_capital_reason_on_eligibility` (try inserting a
  `review_decision` row with that reason_code and `decision_type=
  'eligibility'` directly in SQL — must raise).
- *Appeal assigns independent reviewer* — test `"independent-reviewer rule
  rejects the same reviewer on appeal"`.

### Authorization and privacy
- *Non-owner cannot access owner-only tables* — as a non-admin authenticated
  user, `select * from public.flag_case;` (or any table in the owner-only
  list in §10 of the SQL file) must return zero rows, not an error (RLS
  filters rather than denies outright, which is correct Postgres RLS
  behavior — confirm the row count is 0, not that the query throws).
- *RLS rejects direct role misuse* — same as above, for every owner-only
  table.
- *MFA required for owner* — **not yet enforceable**: no dashboard exists to
  gate. `public.person.` has no MFA flag; Supabase Auth's own MFA settings
  are the real control here and must be turned on in the Supabase Auth
  dashboard independent of anything in this SQL file.
- *Full PII masked by default* — **not yet enforceable**: masking is a
  presentation-layer concern with no dashboard yet to enforce it. The data
  layer's contribution is that `person.legal_name_ciphertext` etc. are
  already `bytea`/encrypted-at-rest, so an unmask requires a `fn_decrypt_pii`
  call that a real dashboard should itself audit-log per open.

### Metrics and statistics
- Run `internal-control/tests/core.test.ts` — covers the known-fixture
  drawdown/PF value, missing-timestamp/zero-variance null behavior, Wilson
  interval matching the report's own 8/10 example, and bootstrap
  reproducibility with a fixed seed.

### Flags and alerts
- Same test file — BH-FDR reduces significant count at a stricter target,
  deterministic clustering, alert cooldown/severity-escalation/throttle/
  dead-letter behavior.

### Shadow syncer (Phase 4 boundary, enforced at the DB layer)
- Try `update public.dest_order set status = 'sent' where id = <any row>;`
  where the row's `broker_account.api_mode <> 'live'` — must raise
  `phase4_boundary`. Since **no `broker_account` row in this deployment has
  `api_mode = 'live'`** (none has a written permission on file — see
  `automation_permitted_until`), this should be impossible to trigger at all
  right now, which is the correct state for a pre-launch platform with zero
  Phase 5/6 approvals.

## Next steps, in order

1. An operator sets `app.settings.pii_key` via Supabase Vault before any
   `person.legal_name_ciphertext` write is attempted.
2. A session with Node.js runs `internal-control/tests/core.test.ts` and
   fixes anything it reveals (expected: a handful of TypeScript nits, since
   this was written without a compiler in the loop; the logic itself was
   reasoned through carefully and each function traces back to a specific
   report formula/requirement in its doc comment).
3. Scaffold the actual Next.js/React dashboard app in that same
   Node-equipped session, wiring `internal-control/lib/*.ts` in as the
   business logic layer and adding the server-side session/MFA
   enforcement the report requires on every route.
4. Route the legal question register in report §3 to qualified counsel —
   nothing here resolves a single `[LEGAL]` item, by design.
