# Owner model controls — 8 October 2026

Owner + MFA: Team → Brain → choose a trader. The login page authenticates; the Brain contains performance and controls. Registered names can be searched and added before their first closed trade. Addition starts automatic B-book demo and never resets an existing profile. Duplicate accounts map through `ab_person_of` to the same person.

Enter a reason and choose **A-book demo**, **A-book live**, **B-book demo**, **B-book live**, or **Automatic**. Manual choices atomically update the backend profile and append lifecycle/admin evidence. They persist until Automatic is selected. Optimistic expected-state/expected-manual checks reject stale owner screens. Automatic resumes on the next classifier pass; it does not immediately reset the current book. Integrity flags/investigations still suspend a manually chosen trader and clear the override. These controls do not release a suspension or bypass risk limits.

| Choice | New trades | Current readiness |
|---|---|---|
| A-book demo | Internal same-direction estimates | Available when integrity clear |
| B-book demo | Internal reverse estimates | Available when integrity clear |
| A-book live | Existing A executor, subject to per-order checks | Refused unless an enabled, token-connected funded ladder account exists in the person's FNV signal group and the books are not halted |
| B-book live | Intended live reverse execution | Refused: current B review adapter supports demos, no live reverse connection is configured |
| Automatic | Existing policy controls later transitions | Policy v4 unchanged |

**The connected E8 funded reference remains read-only.** It is not an execution destination and cannot be enabled by a model button. No funded/live connection was activated, no trader was promoted and no order was placed during this rollout. An A-live classification from the existing automatic shortcut can exist while execution is unavailable; a label is not a broker fill. `ab_route_for_user` now excludes monitor/shadow roles when checking ladder availability. Existing configured review demo/ladder routing otherwise remains intact. The A executor can still skip an order for risk, symbol, margin/capacity, market, sizing or connection reasons. Live readiness is a configuration check, not proof of successful execution or provider permission.

Existing positions retain their frozen internal direction and recorded broker legs. Partial/full closes use those original IDs, not the person's new state. A model change applies to new orders whose routing decision occurs after the saved change; it cannot rewrite an order already in flight. Legacy practice mirrors and same-direction shadow copies are separate subsystems, not reverse/funded execution proof.

## Records and timing

- IPFX source closes, balance credits and exit rows commit atomically. Owner account balances and source positions/closed/partial rows are read directly in the trader drawer, refreshing every ten seconds, including while a reason is being typed.
- The classifier and statistical ledger are scheduled once per minute. The main board uses minute statistics and ten-second pulses. A source close can appear before its win rate/statistical evidence changes.
- Per-person internal estimates and pending-order history are shown alongside source results. IPFX decision gross uses recorded server quotes with a zero-delay assumption; sampled E8 gross waits for matching observations. Both remain estimates, and automatic net is unverified. Cancelled/expired/rejected/deleted pending orders retain history.
- Broker book orders/skips remain separately visible in the same drawer. They are the evidence for dispatch/fill failures; a statistical promotion does not prove an order filled.

## Existing automatic policy, unchanged

The worker evaluates quote-replayed risk-unit evidence, not win rate alone. Ordinary A-demo/B-live entry requires at least 40 trades over 20 days, average edge above 0.02R, a positive daily lower confidence bound, proof e-value at least 10, largest winning trade share at most 30%, five-day dwell and permitted holding/price-gap behavior. A-demo→A-live uses new evidence since entering A-demo. The owner's Stage 2 +2.75%→AB_LIVE shortcut remains: at least 15 copyable replay trades, nonnegative copy average, median holding at least 60 seconds, at most 50% under a minute, permitted copy gap and no blocked herd. It does not require confirmed broker-demo fills. Manual choices pause these performance-based moves; Automatic restores them.

A-live confirmed weakness sends the person to A-demo; failed A-demo after 80 test trades sends them to B-demo. B-live reverse losses with positive recent copy evidence can send the person to A-demo; faded reverse evidence sends them to B-demo. See `_shared/ab-classifier.ts` for exact per-state conditions and thresholds. No fixed win-rate percentage guarantees promotion or profitability.

## Rollout and validation

Migration `20261008090000_owner_model_controls.sql` and `brain-monitor`/`ab-classifier` backend changes were applied after deployed-source drift checks, type checks and hosted rollback rehearsal. JWT remains true for Brain and false for the secret-authenticated classifier. SQL/API checks cover persistent owner states, Automatic restoration, integrity priority, stale screens, monitor/group/halt exclusion, registration, public-access denial, frozen old positions, fresh closes and audit rollback. An isolated browser fixture exercises adding a registered name, saving a demo choice and ten-second refresh without erasing a draft reason. No launch-scale or funded fill guarantee is claimed.

The reviewed website files are on `codex/e8-reference-monitor`; publication to main still needs the outstanding explicit approval. The new buttons and trade drawer will not appear on the live website until publication. Keep private identity/trade evidence outside this public repository. The current E8 monitor must not be repurposed as an execution connection; any funded execution setup needs its own owner-authorized connection and venue-rule checks.
