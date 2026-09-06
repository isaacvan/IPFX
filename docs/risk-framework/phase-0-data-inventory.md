# Phase 0 — repository, data, and legal-perimeter audit

Per `deepseek-ipfx-report.md` §17 Phase 0 exit gates: "legal question register
open; data source gaps documented; no live code shipped; audit logging
foundational." The report's §3 already IS the legal question register — this
document does the other half: an honest inventory of what data actually
exists in this specific repository today, gathered by reading the code, not
assumed.

## What this platform actually is, as of this audit

A pre-launch (site says "Launching October 2026"), UK-based, simulated
prop-trading-challenge platform with **61 real registered users already in
the live production database**, backed by Supabase. Confirmed via a
screenshot of the live Supabase Users table earlier in this project's history
— this is not a design exercise on a green field, there are already real
signups, though (per the codebase) no live payment processing is connected
yet (Stripe integration is on placeholder test keys) and no funded-account
payout has ever actually been paid.

## Existing data sources and their quality

| Source | Table(s) | Quality notes |
|---|---|---|
| Trading accounts | `trading_accounts` | Has `starting_balance`, `balance`, `max_drawdown_pct`, `daily_loss_pct`, `profit_target_pct`, `status`. Added this project: `phase`, `challenge_type`, `stage`, `drawdown_mode`, `trailing_peak`, `total_paid_out`. **Gap**: no `terms_version_id` — the live engine has never anchored an account to an immutable rule snapshot; `challenge_presets` rows are mutable and a preset's numbers can change under a currently-active account. This is exactly the report's §4.2 "no retrospective rule" problem, present in production today. |
| Trades (= positions) | `trades` | One row per position, `open->closed`. Has `pnl`, `close_reason`, `sl`/`tp`. **Gap**: no distinct Order ID existed until this project's most recent session added `order_audit_events.id` as one — that fix has not yet been deployed (see the trading-engine deployment note below). |
| Pending (resting) orders | `pending_orders` | Added this project. Reasonably complete: status lifecycle, `filled_trade_id` link. |
| Order/fill audit trail | `order_audit_events` | Exists. **A real, previously-undiscovered bug was found and fixed, and the fix is now deployed**: the `event` check constraint was missing `partial_close`/`place_pending`/`cancel_pending` (an earlier pass had already added `modify`, confirmed live before this deploy — `open`/`close`/`reject`/`modify` were already accepted), so those three action types were being silently rejected and swallowed by `logAudit()`'s own try/catch. `order-position-id-integrity.sql` deployed clean, widening the constraint and adding `pending_order_id`. |
| KYC | `trader_kyc` | Status-flag only (`unverified/pending/verified/rejected`), no real document-verification vendor integrated. Explicitly scoped out as "a separate, larger feature" in an earlier session. |
| Admin/owner access | `admins` | A flat allow-list table, no MFA requirement enforced anywhere in the stack today. This is the single biggest gap against report §10.1/§16.3 ("MFA required for owner/admin") — reused as the authorization backbone for the new `internal-control-core.sql` RLS policies (`fn_is_admin()`), but MFA itself is a Supabase Auth project setting that has not been confirmed on. |
| Jurisdiction/restriction | `restricted_countries`, `user_profiles.restricted_jurisdiction` | Explicitly a "starter list, not a real OFAC/sanctions-screening integration" per its own migration comment. |
| Multi-accounting detection | `shared_ip_accounts` (view) | Informational only, exactly matching report §9 ("flags create review cases, never automatic failure") — already built correctly to that standard before this audit. |
| Payout lifecycle | `payout-system-v2.sql` (`payouts`, RPCs) | 7-day cadence, $50 minimum, KYC-gated, investigation-hold-gated. No payout has ever actually been paid (pre-launch). |
| Price/market data | Yahoo Finance's unofficial free endpoint | Explicitly documented elsewhere in this codebase as "not launch-grade," no real bid/ask, no SLA. Relevant to report §6 metrics: cost data (spread/slippage) derived from this feed inherits its low reliability — expect `data_quality` penalties to bite here specifically. |
| Real historical trader performance | — | **Does not exist.** 61 users, pre-launch, no completed challenges, no real payout history. Every probability/calibration requirement in report §6.5-§7.8 (block bootstrap, Monte Carlo path sim, calibration curves, PSI drift) has no real population to validate against yet. This is not a defect in the new code — it is a hard, current fact about this business that every model built now must display `insufficient_evidence`/`uncalibrated` honestly rather than mask it with synthetic confidence. |

## Legal/regulatory perimeter — status, not resolution

Every `[LEGAL]` item in `deepseek-ipfx-report.md` §3 remains genuinely open;
nothing in this session resolves any of them, and nothing here should be read
as legal advice or a legal conclusion. Two items are worth flagging as
**already live, not hypothetical**, given the 61 existing users:

1. The mirroring/copy-trading feature (mirroring a trader's positions onto
   another prop firm's funded account) is already built and disclosed in
   `privacy.html`, but no broker/provider has given written permission for
   this per report §3's provider-permission gate. `internal-control-core.sql`
   encodes this as a hard database constraint going forward
   (`broker_account.api_mode` can only be `'live'` with a current, unexpired
   `automation_permitted_until`), but that constraint only governs the *new*
   schema — it does not and cannot retroactively govern whatever the existing
   mirroring feature does through its own tables.
2. Terms-of-service versioning: the live `challenge_presets` table has been
   edited multiple times this project (see `challenge-recalibration.sql`)
   while real user accounts may already exist against the superseded
   numbers. Whether any of those 61 users has an active challenge whose
   terms changed underneath them is a real, checkable question — not
   something this audit can answer without querying `trading_accounts.
   created_at` against each preset migration's deployment timestamp.

## No live code shipped

Confirmed: `internal-control-core.sql` and `internal-control/lib/*.ts` are
purely additive — nothing in the existing live trading engine
(`supabase/functions/trading-engine`, `supabase/functions/admin-console`) was
modified to call into this new schema or logic. The Phase 0 exit gate's "no
live code shipped" condition holds for this specific body of work.

## Audit logging foundational

`public.audit_event` (append-only, hash-chained, `fn_verify_audit_chain()`)
exists in `internal-control-core.sql`, not yet deployed. The existing
`admin_audit_log` table (from an earlier session, still live) is a good-faith
predecessor but is NOT hash-chained or tamper-evident — it is a plain table
an admin's own service-role access could in principle edit. `audit_event` is
the harder-guarantee replacement the report calls for; migrating existing
`admin_audit_log` history into it, if desired, is future work not attempted
here (a data migration between two audit systems needs its own careful
review, not a rushed autonomous pass).
