# IPFX closed-preview operations runbook

Last reviewed: 20 September 2026

This runbook is the minimum safe operating procedure for the current research preview. It is not authorisation to launch paid challenges, payouts, live capital or trade copying.

## Non-negotiable operating state

The following controls must remain `false` until a documented go/no-go review is complete:

- `public_challenges_enabled`
- `paid_checkout_enabled`
- `payouts_enabled`
- `live_mirroring_enabled`

The matching Edge Function environment switches must also remain unset or unequal to `true`:

- `IPFX_PUBLIC_CHALLENGES_ENABLED`
- `IPFX_PAYOUTS_ENABLED`
- `IPFX_LIVE_MIRROR_ENABLED`

The owner preview account is for controlled testing only. It does not override the payment, payout or live-mirroring gates.

## Daily checks

1. Confirm the homepage and `/trading.html` are reachable.
2. Confirm the public closed-preview notice is visible.
3. Confirm a non-owner cannot submit a challenge application.
4. Confirm payout creation and live mirroring return a closed/unavailable response.
5. Review failed authentication, rate-limit, admin-audit and Edge Function error events. Do not copy credentials or identity data into tickets or chat.
6. Investigate any unexpected enabled mirror target, mirror-enabled account, requested payout or approved public application immediately.

## Weekly checks

1. Run every local test and `node scripts/website-launch-audit.mjs`.
2. Run Supabase security and performance advisors; assign every remaining finding an owner and written reason.
3. Review Team Login membership and remove access no longer required.
4. Review admin audit events and failed MFA attempts.
5. Check uptime-monitor failures and verify repository notification delivery.
6. Verify that no new public page promises a launch date, payout, live account, automatic scaling or guaranteed outcome.

## Incident response

Treat suspected exposure of credentials, identity documents, personal data, payment data, unauthorised admin access, unexpected live orders or database modification as a severity-one incident.

1. **Contain:** keep all four launch controls false; disable affected Edge Function or user access; revoke or rotate the smallest affected credential; do not delete logs or evidence.
2. **Record:** open an incident record with UTC detection time, reporter, systems affected, indicators, actions taken and decision owner. Store no full secrets, ID images or payment numbers in the record.
3. **Preserve:** retain relevant Supabase, hosting, authentication, admin-audit and deployment logs with access restricted to the response team.
4. **Assess:** determine data categories, people affected, access duration, attacker actions and whether unauthorised trading or financial state changed. Do not make claims before evidence is checked.
5. **Recover:** patch the cause, restore only from a verified source, run tests and reconcile accounts before re-enabling the affected component.
6. **Notify:** obtain qualified legal/privacy advice for any notification duty and deadline. Give affected people accurate, plain-language protective steps where required.
7. **Review:** document root cause, corrective action, owner and due date. Add a regression test before closing the incident.

## Safe rollback

1. Keep financial and mirroring controls false.
2. Revert only the faulty application release through the normal version-control/deployment path; never alter production tables manually to hide an error.
3. Re-run the complete local test set and website launch audit.
4. Verify database migrations are forward-safe. Do not run destructive down-migrations on production.
5. Reconcile challenge applications, accounts, orders, breaches, payouts and admin audit events for the affected period.

## Backup and recovery drill

Run restore drills only against a separate, access-restricted staging project.

1. Record the backup timestamp and staging project reference.
2. Restore the selected backup to staging.
3. Run `scripts/backup-restore-verification.sql` against staging.
4. Confirm required tables exist, referential checks pass, duplicate payment identifiers are zero and no orphaned trades are reported.
5. Record start time, recovery time, result and any missing data. Delete the staging copy securely after the retention period approved for the drill.
6. Never connect the restored staging project to production payment, email, market-data or mirroring credentials.

## Public-launch go/no-go

Do not enable any launch control unless all applicable items are evidenced:

- verified legal entity name, company number, registered office and authorised contracting party;
- qualified UK legal review of the business model, Terms, consumer rights, privacy, AML/KYC and regulatory perimeter;
- lawful market-data and charting licences for the intended use;
- approved payment provider, refund/chargeback process, tax/VAT position and reconciliation procedure;
- funded reserve and liquidity policy based on stress-tested liabilities;
- independent security review, dependency remediation and tested incident response;
- data-protection records, processor agreements, retention schedule and deletion workflow;
- validated pricing/risk model using representative data, with loss limits and manual overrides;
- completed staging restore drill and approved simultaneous-user test;
- named owners for compliance, security, finance, support and trading-risk decisions.

If any item is unknown, the decision is **no-go**. Enabling one component does not imply approval to enable another.

