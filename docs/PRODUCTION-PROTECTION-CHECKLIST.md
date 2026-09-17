# IPFX production protection checklist

Last reviewed: 17 September 2026

This is the IPFX-specific interpretation of the 20-item launch list. “Implemented” means the repository contains an enforceable control and a test. “Owner action” means the control lives in a provider account and cannot truthfully be marked complete from source code alone.

| # | Protection | IPFX status | Evidence / remaining gate |
|---:|---|---|---|
| 1 | Rate limiting | Implemented | DB-backed fixed-window limiter shared across Edge Function instances; checkout and admin requests are limited per authenticated user. Trading payout mutations retain their separate abuse guard. |
| 2 | API limits | Implemented | Request bodies are capped, actions and identifiers are allow-listed, admin list responses are bounded, and the desktop release signer only accepts an exact release-path pattern. |
| 3 | Spending caps | Partly implemented; owner action | Checkout is test-key-only and catalog-priced, so this release cannot collect live money. Before live payments, set Stripe fraud/velocity limits and Supabase usage/spend alerts in their dashboards and record evidence below. |
| 4 | Error handling | Implemented | Checkout returns safe customer messages, structured request IDs, and sanitized server logs. Existing trading/admin responses fail closed. |
| 5 | Loading states | Implemented | Checkout, desktop downloads, trading connection, and admin detail flows show explicit loading/disabled states. |
| 6 | Empty states | Implemented | Trading positions/orders/history, desktop downloads, admin lists, and checkout unavailable states render explicit empty or unavailable copy. |
| 7 | Failed requests | Implemented | Checkout and download failures are caught and surfaced without claiming success; payment copy explicitly warns users not to create another payment after an uncertain result. |
| 8 | API timeouts | Implemented | Browser checkout aborts after 12 seconds; Stripe server calls time out after 10 seconds with one bounded network retry. Trading requests already use abort controllers. |
| 9 | Duplicate subscriptions | Not applicable to current product | IPFX challenge fees are one-time, not recurring subscriptions. Newsletter collection remains disabled until an owned endpoint is configured; that provider must enforce unique email addresses. |
| 10 | Duplicate payments | Implemented | Unique `(user_id, request_key)` and unique provider-intent constraints, an atomic order RPC, and a Stripe idempotency key derived from the immutable order ID. |
| 11 | Optimise DB queries | Implemented for audited hot paths | Auth lookups in RLS are cached per statement; large review lists are bounded; trade/payout queries use matching composite/partial indexes. Re-run Supabase performance advisors before each public release. |
| 12 | DB indexes | Implemented | Added indexes for closed trades, open pending orders, safety reviews, admin audit history, payout methods, consent history, and rate-limit expiry. |
| 13 | Paginate large results | Implemented for growing logs | Admin audit and safety-review APIs use bounded cursor pagination and expose `has_more` / `next_cursor`. Existing trading history calls retain explicit limits. |
| 14 | Compress files | Provider verified at deploy | Static pages/assets are served through the production CDN, which must be checked for Brotli or gzip after deployment. Desktop installers are already compressed packages and are chunked for transfer. Do not double-compress them. |
| 15 | Limit upload size | Implemented | The private release bucket is capped at 50 MiB per object; the CI uploader uses 40 MiB chunks; the signing function restricts object names and release version. |
| 16 | Cache repeat requests | Implemented where safe | Checkout catalog quotes are private-cacheable for 60 seconds and GitHub signing keys are cached for one hour. Trading prices, account state, orders, and payment state remain `no-store`. |
| 17 | Uptime monitoring | Implemented | Scheduled GitHub workflow checks the homepage and trading page every 15 minutes with bounded retries/timeouts. Configure repository failure notifications for the owner account. |
| 18 | Error logging | Implemented | Critical checkout/rate-limit failures emit sanitized structured events with request IDs. Admin actions continue to write the immutable admin audit log. Never log tokens, payment secrets, or full request bodies. |
| 19 | Test simultaneous users | Test harness implemented; production run requires approval | `node scripts/concurrency-smoke.mjs` runs a bounded read-only test locally. Production is locked unless `IPFX_ALLOW_PRODUCTION_LOAD_TEST=true` is deliberately set for an approved window. |
| 20 | Test backup restore | Verification implemented; restore drill requires owner action | `scripts/backup-restore-verification.sql` checks a restored staging project for required tables, row counts, orphans, and duplicate payment identifiers. Never run a restore drill against production. |

## Required owner evidence before public launch

- [ ] Supabase usage alerts/spend controls configured — date, limit, and screenshot/link:
- [ ] Stripe velocity/fraud controls configured before replacing test keys — date and evidence:
- [ ] Production responses verified with `Content-Encoding: br` or `gzip` — date and URL:
- [ ] GitHub Actions failure notifications verified for the uptime workflow — date and recipient:
- [ ] Approved simultaneous-user test completed — date, target, concurrency, requests, failures, p95:
- [ ] Backup restored into a separate staging project and verification SQL returned zero orphaned trades and zero duplicate payment identifiers — date and restore project ref:
- [ ] Supabase security and performance advisors re-run; all remaining findings accepted with an owner and reason:

## Safe commands

Local simultaneous-user smoke test:

```powershell
$env:IPFX_LOAD_TEST_URL='http://127.0.0.1:4173/'
node scripts/concurrency-smoke.mjs
```

Read-only restored-database verification (only after selecting a non-production project):

```powershell
npx --yes supabase@latest db query --linked --project-ref <staging-project-ref> --file scripts/backup-restore-verification.sql
```

