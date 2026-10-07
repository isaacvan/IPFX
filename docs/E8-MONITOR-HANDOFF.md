# E8 reference monitoring — 7 October 2026

Scope: a read-only TradeLocker reference monitor and an explicitly estimated trade replay. This does not activate copying, change challenge results, or alter classification policy. Production policy v4 already sends the guarded Stage 2 +2.75% shortcut to AB_LIVE; preserve that owner decision without requiring confirmed demo proof.

## Owner setup

Open `/team-e8-monitor.html` from Brain or Treasury. Sign in as owner with MFA. The owner personally enters the actual E8 broker login, exact server and broker account ID. The existing `ladder-admin` exchanges the password for encrypted tokens. Never read, type, log or commit these credentials. Select the connected account and start sampling. No E8 account was connected at build time. Confirm the owner's E8 platform before using this TradeLocker connector; MT5 and MatchTrader need separate read-only adapters.

## What runs

- `e8-reference`: POST with existing COST_MONITOR_SECRET; no JWT, no order methods. Cron kicks every ten seconds only when an enabled profile is due. A 45-second lease prevents concurrent ownership. Settings changes invalidate the lease. Completion must match an unexpired lease.
- Quotes carry actual request and reply times. Reply freshness is not provider tick freshness. No provider tick timestamp is invented. Quotes and dedicated E8 cost samples are retained seven days.
- Configuration is refreshed every fifteen minutes. Rate limits are parsed from `/trade/config`, including the official SDK's `QUOTES` and `GET_ORDERS_HISTORY` names. All applicable route/global windows are checked atomically at 80% of their reported limit (minimum one request). Unknown quote/history allowances fail closed. Auth/config bootstraps use conservative local pacing; this is not confirmation of provider permission or an exemption from external/shared limits. HTTP 429 backs off and remains visible.
- History is requested at most once per minute when allowance permits. Returned filled-order rows are revision-hashed into an append-only archive and current fee values updated. Missing commission/fee/swap stay null. This is the provider's returned order-history window; it is not proven complete execution history or complete P&L attribution. Existing fills are observed; IPFX never trades the E8 monitor to obtain calibration.
- Legacy `cost-monitor` excludes all accounts with dedicated profiles, even paused ones, so it does not independently refresh tokens or bypass the new monitor's windows. It otherwise retains existing behavior.
- `e8-monitor-admin`: owner + verified MFA + existing admin membership; origin and API rate checks. Provides status, start/pause and archived calibration replay. Account tokens are never returned.
- Database prevents monitor profiles from using execution accounts and prevents a configured reference account from being converted to an execution account. New tables are RLS protected and service-only. Fill revisions and projections reject updates/deletes.

## Simulation link and its limits

`_shared/e8-reference.ts` exports pure bid/ask pricing, reverse-aware P&L, and `replayReference`. The owner comparison tool uses the first observation requested after each open/close event plus an explicitly entered delay, supports up to fifty partial exits, requires matching total quantity, and records the extra sampling wait. Missing coverage produces unavailable/null, never a fabricated zero P&L. Each replay requires explicitly entered USD price value, total costs including financing, adverse slippage and the source of those assumptions. No automatic fee or currency-conversion calibration is claimed.

This rollout does **not** wire E8 replay into every trader's automatic lifecycle simulator/classifier, automatically handle simulated stop amendments/trailing exits, repair legacy broker partial-close execution, or make the existing shadow-funded-summary assumptions accurate. Those remain separate audited tasks. A ten-second sampler cannot reproduce millisecond broker execution; demo fills and actual E8 fills must remain separately labelled. Do not describe this as a complete broker replica.

## Verification and rollout

Node 24 tests: pure pricing/reversal/partial exits/missing data, production worker with fake broker/database, actual SQL under PGlite, existing Brain/cost/inline syntax, plus a headless browser fixture that blocks external traffic. Deno checks all three affected functions. The full repository suite initially reported 656/659 passing; the three existing failures concern payout milestone wording, Team Login text, and TradeSyncer text. They are unrelated launch-audit findings; no blanket green suite is claimed.

Before each existing-function deployment, download the current deployed source and merge changes against it and Git HEAD. Preserve JWT: worker/cost-monitor false, e8-monitor-admin true. Apply only `20261007140000_e8_reference_monitor.sql`, not pending demo-pool/MT5 migrations in another checkout. New profiles start disabled; no real or demo broker orders are required. Check wrong-secret denial, unauthenticated admin denial, cron metadata, policy preservation and no enabled monitors after deployment. After the owner connects, verify actual quotes/history and API allowances before claiming a functioning E8 connection.

Rollout checks: migration recorded; reference worker v1 (JWT false), admin v1 (JWT true), cost-monitor v2 (JWT false); unauthorised worker and admin requests both return 401. Production has zero connected monitor accounts and zero enabled profiles. Cron is installed and gated. Active policy remains v4, 2.75%, AB_LIVE. Broker connectivity and actual E8 calibration remain unverified until owner connection.

Local setup recovery: the owner confirmed TradeLocker. The local preview server now binds both IPv4 and IPv6 loopback addresses in a hidden persistent process. Team-access originally returned only the live site's CORS origin, causing a real localhost access-check failure that the first synthetic monitor-page test did not cover. The deployed fix allows exactly the live site and localhost:8127, preserves JWT/owner/admin checks, rejects other origins, and was checked with actual credential-free preflights and a 401 unauthenticated POST. Team Login now restores the password form on network/service failures, clears its password field and supports retry without falsely treating a temporary service failure as an owner denial. Five functional regression checks and ten existing auth/syntax checks pass. The local UI reads the updated file on reload; website publication remains pending main-branch approval.

Primary API references: [configuration](https://public-api.tradelocker.com/reference/getconfigusingget), [official SDK type definitions](https://github.com/tradelocker/tradelocker-python/blob/main/src/tradelocker/types.py).
