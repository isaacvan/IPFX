# IPFX free remediation summary

Date: 20 September 2026

## Completed in code and production

- Closed public challenge applications at the page, Edge Function and database-trigger layers.
- Closed card/crypto checkout unless an explicit future launch switch is enabled; existing payment code remains test-key-only.
- Closed payout requests at the dashboard, trading API and database-trigger layers.
- Disabled every mirror target and account mirror flag. Live mirroring now requires an explicit switch and service-role authentication.
- Added four independent launch flags, all false by default.
- Cleaned browser-role privileges, added explicit service-only RLS deny policies and safer default privileges.
- Added missing foreign-key indexes. The Supabase missing-FK-index advisor is clear.
- Consolidated redundant RLS policies and cached auth lookups. The RLS init-plan and multiple-policy findings are clear.
- Added a public closed-preview notice and removed unsupported October launch promises.
- Removed anonymous strategy uploads and unsupported backtest turnaround and data-source claims.
- Removed incentivised-review, automatic-scaling and currently available payout/live-capital claims from the main public path.
- Corrected the Terms on appeals, payment disputes, cancellation rights, unverified company details and closed-preview limitations.
- Updated support so launch, payment, payout, live-capital and copying questions fail closed.
- Added permanent launch-safety checks plus incident, rollback, restore and go/no-go procedures.

## Intentionally not changed automatically

- Enable Supabase leaked-password protection in Auth settings. This cannot be changed truthfully from repository code.
- pg_net remains in the public schema because this installed build is non-relocatable. Moving it requires a tested maintenance window.
- validate_promo_code remains callable before login because signup validates public codes. It returns only code, challenge name and challenge type.
- Ten authenticated SECURITY DEFINER functions remain callable because they are constrained user APIs used by RLS, enrolment, identity and promo flows.
- Unused indexes were not removed. There is too little representative traffic to justify destructive removal, and foreign-key indexes protect future writes.

## Cannot be completed for free in code

- Qualified UK regulatory, consumer-law and final legal review.
- Verified company and registered-office details if incorporation is incomplete.
- Market-data, charting and live-execution licences.
- Payment approval, tax/VAT setup and banking reconciliation.
- Capital reserves for future performance payments or live exposure.
- Independent penetration testing, external compliance review and signed desktop installers.

The correct operating state remains a closed, simulated research preview until those gates are evidenced.
