# Launch reliability repairs — 9 October 2026

Owner authorised fixing the overnight findings. Preserve the Stage 2 +2.75% shortcut, immutable classifier policy, E8 monitor/read-only protection, retired challenges, application exemption and identity privacy. Do not repeat the launch reset. Never commit credentials, customer identities or documents.

## Implemented

- Mandatory qualification snapshots on new Infinity Stage1–3 accounts; transactional stage advancement with existing progress, observation, risk and entry gates. Stage4 still requires operator review and is not execution enablement.
- Canonical no-stop closes record warnings transactionally; the third warning freezes the account. Linked stages inherit warnings; a fresh Stage1 starts at zero.
- Full-close intent blocks concurrent partial resizing and retains the original decision quote. Broker exits use absolute remaining source volume, one unresolved operation per leg, persisted planned/sent/unknown/confirmed states and exact order receipts. Unknown outcomes remain reserved; confirmations release risk idempotently.
- Paused owned demo execution destinations still allow exits. Monitoring accounts and live API environments remain excluded.
- Minimum-size validation freezes same/reverse direction from the trader's A/B state. Partial slices below the broker minimum remain explicitly labelled quote estimates, not broker executions or confirmed funded net profit.
- Sweep includes pending-only accounts, fails visibly on scan/lease faults, continues after individual errors and releases its lease in finally. Hub retries failed per-account checks without another quote and saves pending checks in a private durable journal. Crossed, nonfinite and out-of-order quotes are rejected.
- Pending-first applications, counts and pagination replace the latest500 mixed-status queue. Contacts come from a bounded private lookup. Document-review quotas and owner/MFA gates are unchanged; UI does not promise a universal24hour turnaround.
- Cash-read/detail-write errors invalidate Treasury completeness instead of substituting zero fees. Cash figures remain unreconciled estimates; dependence stress is shown separately from the independent-outcome model.
- Broker position slots are reserved atomically against fresh inventory, pending orders and conservative documented margin. Unknown account limits, developer access or margin fields block opens. Owner/MFA-only capacity controls record provider evidence and never enable execution.
- Infinity Stage4's payout request interval matches the published14day default. Other programme intervals are retained. Requests still need owner review; no payment occurs automatically.

## Verification and rollout

The merged repository baseline passed827 tests, zero failures and two optional browser skips. Separate integrated stage/payout SQL passed38 assertions; exit, warning, margin/capacity, restart, source-close concurrency and Treasury-fault cases were exercised with synthetic data. All five backend functions type-checked. The production-schema migration rehearsal rolled back successfully before applying the five migrations.

Deployment/evidence checkpoint: the chat workspace `launch-repairs/STATUS.md` and `launch-repairs/RESULT.md`. Source branch `codex/team-review-controls`, preserving concurrent Infinity-open main release f2fa827. Download deployed sources and compare against the last checked baseline before any further deployment; another agent changes main.

These tests do not establish production capacity for2000 active traders, authentic broker execution fees/slippage, provider permission, bank cash or full legal compliance. Keep internal estimates, broker confirmations and payoutable cash separate. Owner still supplies approved demo connections, documented limits/developer access, starting reserve and required signup configuration. Domain renewal remains an owner action.
