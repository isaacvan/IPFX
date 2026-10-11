# Selected-stream validation journal

Owner + MFA controls are on Team → Treasury. The journal starts **Off**, with no selected people. It is an experimental source/paper evidence layer, not broker execution or a new trader-facing challenge rule.

Find a registered trader, select future-stream recording and enter a reason. Paper direction can follow their A/B state at entry or be an independent same/reverse experiment. This does not change their live book profile. Recording mode supports Off/Paper only; neither enables accounts, uses broker credentials or places orders. Existing tracked streams retain their captured direction and closure observations after recording is disabled.

Migration `20261011080000_validation_source_journal.sql` adds service-only settings/enrolments, frozen entry snapshots, append-only trade/pending observations, per-stream leased work and append-only paper intentions. The paper-only SQL job runs every ten seconds and is a heartbeat/no-op when Off. Intended processing is bounded; burst throughput and hosted capacity still require measurement. Queue counts and age are observations, not a readiness certificate.

Capture failures do not veto the source trade transaction. They produce a sanitized failure heartbeat and unconfirmed coverage. Late/unknown entries and integrity holds remain ineligible observations, never invented historical fills. Pending intent/cancellation is not a reverse broker pending order. Sent/unknown work is blocked for reconciliation and is never blindly retried after a lease expires.

Mode/enrolment saves require owner/MFA through `ladder-admin`, a reason, an audit write and the expected settings version. Client SQL access is denied. A ten-second refresh preserves draft selections; changed versions require reload. No rows are backfilled from historic trades, no source balances/records are overwritten, and classifier policy—including the Stage 2 +2.75% shortcut—stays unchanged. E8 remains a read-only monitor.

This is the foundation for a later dedicated approved-demo adapter with physical partial/full receipts, account/contract/FX/capacity checks, append-only cost corrections, and statement/net reconciliation. Minimum-lot quote partials are not those receipts. Paper intentions never prove broker net or company cash income. Do not mark broker validation complete until the full selected source streams are reconciled against the actual approved demo.
