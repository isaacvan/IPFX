# Brain source-account labels — 8 October 2026

The All traders board has separate **Account / challenge** and **Routing model** columns. Demo practice is identified by actual account phase/status, including practice accounts retaining an Infinity challenge_type. Infinity/Traditional/Futures/PAC show their account stage and status. Mixed usable accounts are shown together. The Latest order hint comes from the most recent actual trade entry or pending-order creation, not the person's A/B classification or their current browser selection.

The account filter selects people; performance remains the person's existing aggregate history. It does not recalculate per-challenge P&L. The drawer labels each account and each source trade. Account context refreshes in the ten-second pulse while existing statistics keep their minute cycle. Failed/revoked accounts with outstanding positions remain visible; other closed history stays in the drawer. An unavailable account read is shown as unavailable, never assumed to be Demo.

`ab_brain_account_context(uuid[])` is read-only, service-role-only and maps duplicate identities through `ab_person_of`. The existing owner + MFA API exposes it. No trades, model choices, classification thresholds, Terms or E8 permissions are changed. Earlier unpublished review controls are excluded from this release.

Validation: 11 focused tests, Deno check, isolated browser checks for mixed accounts/filtering/drawer labels and ten-second updates, hosted schema verification and rolled-back SQL rehearsal, plus deployed-source/shared-dependency drift checks. Deployment order: migration, Brain function with JWT verification retained, then website.
