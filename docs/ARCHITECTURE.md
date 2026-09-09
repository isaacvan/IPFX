# IPFX Capital — How the whole thing works

Plain-English reference. Written 2026-09-09. Status facts verified live against
production, not recalled.

---

## 1. The one-sentence version

**IPFX is a very well-instrumented simulator of trading, where real money comes in as
fees, real money goes out as payouts, and the score is computed from real market
prices.** No real order ever reaches a real exchange. Nobody's money is ever at risk in a
market. The only real money movements are: customer pays a challenge fee → IPFX; IPFX
pays a payout → trader.

That single sentence is also the reason the regulatory question in
`risk-framework/revenue-strategy-memo-wave-3-corrections.md` §1 is sharp. Hold that
thought; it is not an architecture problem, it is a characterisation problem.

---

## 2. The four moving parts

```
   BROWSER                    SUPABASE                       OUTSIDE
┌──────────────┐      ┌──────────────────────┐        ┌─────────────────┐
│ 28 static    │      │  Postgres (~49 tbls) │        │ Market data     │
│ .html pages  │─────▶│  + Row Level Security│◀──────▶│ provider (real  │
│ (GitHub      │      │                      │        │ prices)         │
│  Pages)      │      │  Edge Functions      │        └─────────────────┘
└──────────────┘      │  (Deno, server-side) │        ┌─────────────────┐
       ▲              └──────────────────────┘        │ Stripe          │
       │                         ▲                    │ (NOT connected) │
       │                         │                    └─────────────────┘
┌──────────────┐                 │
│ Next.js      │─────────────────┘
│ owner        │
│ dashboard    │   (runs on your machine, not public)
└──────────────┘
```

### (a) The public website — 28 static HTML pages
No server. Plain HTML/CSS/JS pushed to GitHub Pages; every push to `main` deploys.
The important ones:

| Page | Job |
|---|---|
| `index.html` | Marketing home, the Infinity Challenge pitch, FAQ |
| `signup.html` | Account creation, promo codes, country screening |
| `start-challenge.html` | The 5-step paid checkout (tier → details → payment → review → done) |
| `login.html` | Auth |
| `dashboard.html` | Trader's home: accounts, stats, Journal, bot API key, promo redemption |
| `trading.html` | **The actual trading terminal** — charts, indicators, order entry, Journal |
| `terms.html`, `privacy.html` | The legal documents |
| `admin.html` | Lightweight admin surface |

Because the pages are static, **every page carries the public "anon key" in its source.**
That is normal for Supabase and safe *only if* Row Level Security is correct on every
table. It is why the `promo_codes` leak mattered — that key is readable by anyone.

### (b) Postgres — the database, ~49 tables
Split across a few migration files:

- `internal-control-core.sql` — **36 tables.** The serious spine: `person`,
  `trading_account`, `challenge_instance`, `trade_order`, `trade_fill`, `review_case`,
  `audit_event`, rule policies, and so on. Includes an **append-only cryptographic audit
  hash chain** (§8) — each audit row hashes the previous one, so tampering is detectable.
  Deployed and live-tested: the chain verifies clean, and deletion is genuinely blocked.
- `trading-engine-migration.sql` — 3 tables: `trades`, `trading_accounts`, and friends.
  This is the *live* trading path.
- `market-data-audit-migration.sql` — 7 tables: `market_data_ticks` (sampled quotes),
  `market_data_candles` (1m and up OHLC), `order_audit_events` (per-order forensics),
  `feed_health_events` (outages, stale prices).
- `payout-system-v2.sql` — 3 tables: `trader_kyc`, `payouts`, `payout_methods`.
- Plus smaller ones: promo codes, referrals, pending orders, drawdown sweep.

**Row Level Security** is the security model: the database itself decides what each user
can read, rather than trusting the browser. Two helper functions do the work —
`fn_is_admin()` and `fn_own_person_id()`.

### (c) Edge Functions — the only real server-side code
Deno/TypeScript running on Supabase. Five exist in the repo; **two are live**:

| Function | Lines | Status | What it does |
|---|---|---|---|
| `trading-engine` | 1555 | **LIVE** | The heart of the product |
| `admin-console` | 1237 | **LIVE** | Owner/admin operations |
| `create-payment-intent` | 81 | **404 — not deployed** | Would talk to Stripe |
| `live-mirror` | 124 | **404 — not deployed** | Would place real orders via MetaApi |
| `trade-syncer-shadow` | 348 | **404 — not deployed** | Dry-run copy logic, never places orders |

**`trading-engine` is the whole product.** 17 actions:

- *Trading:* `open`, `close`, `close_all`, `modify`, `partial_close`, `place_pending`,
  `cancel_pending`, `price`, `state`
- *Money:* `request_payout`, `list_payouts`, `payout_summary`, `add_payout_method`,
  `list_payout_methods`, `delete_payout_method`, `kyc_status`
- *Housekeeping:* `sweep` (the scheduled drawdown check)

It authenticates two ways: a normal logged-in session, **or** a bot API key
(`ipfx_bot_...` sent in the `X-IPFX-Bot-Token` header — it cannot go in `Authorization`,
because Supabase's gateway rejects anything that isn't JWT-shaped before your code runs).
Bot keys are deliberately restricted to the 9 trading actions — they cannot touch payouts,
KYC or settings. All 90 accounts have one issued.

**On `live-mirror`:** this is the only code that could ever place a real order. It is dead
three times over — the function returns 404, `mirror_targets` is empty, and `mirror_orders`
has zero rows. Nothing real has ever been placed.

### (d) The owner dashboard — Next.js, runs locally
`internal-control/dashboard/`. Not public, not deployed. Password login, server-side
authorisation via `requireOwner()`, and it reads through RLS rather than bypassing it with
the service-role key — so RLS stays a real second layer of defence.

Behind it sits genuinely serious analysis code in `internal-control/lib/`, all unit-tested
(26/26 pass):
- `metrics.ts` — profit factor, expectancy, Sharpe/Sortino, drawdown, exposure, concentration
- `probability.ts` — block bootstrap, Monte Carlo simulation, false-discovery-rate
  correction, evidence confidence
- `similarity.ts` — cohort z-scores, clustering (collusion / account-sharing detection)
- `review-state-machine.ts` — human-only rejections, independent appeal reviewer
- `alerts.ts` — dedup, cooldown, quiet hours

**This library is the best asset in the codebase and almost none of it is wired to a UI yet.**

---

## 3. What actually happens, step by step

**Someone signs up.** `signup.html` → Supabase Auth creates an `auth.users` row → a
database trigger `handle_new_user()` fires → creates their `user_profiles` row, generates a
referral code, records consent. (This broke completely until recently: the trigger was
missing `SET search_path`, so it couldn't find its own helper function. Fixed and verified.)

**They buy a challenge.** `start-challenge.html`, 5 steps. Step 3 would call
`create-payment-intent` → Stripe. **It doesn't, because Stripe isn't connected** — the page
detects the placeholder key and disables the step with an honest notice. So today nobody can
actually pay.

**They trade.** `trading.html` → every action POSTs to `trading-engine` → the engine pulls a
real price from `live_quotes`, applies spread and symbol specs, writes a row to `trades`, and
logs forensics to `order_audit_events`. Their equity updates. A scheduled job (`pg_cron`)
calls the `sweep` action to check drawdown breaches.

**They pass and request a payout.** `request_payout` → KYC check → `payouts` row → you pay
them manually. Split is up to 85/15 in their favour.

---

## 4. The business model, plainly

**Two ways in:**

| | Traditional Challenge | Infinity Challenge |
|---|---|---|
| Cost | $79 / $149 / $249 / $399 / $699 | **Free** |
| Size | 10K / 25K / 50K / 100K / 200K | $1K → $5K → $10K → $25K–500K |
| Structure | Pass the objectives | 4 stages, each harder |
| Split | up to 85/15 | 85/15 from Stage 2 |
| Retry | Buy again | Stage 1 free, 3×/month |

Plus a **PAC / Application Challenge** — bespoke parameters after a strategy review.

**Where the money comes from.** Challenge fees. That's it, today.

**Where it goes.** Payouts to traders who pass, plus running costs (which are near zero —
Supabase and GitHub Pages).

**The honest economics.** Because the trading is simulated, payouts are not funded by
trading profits — they are funded by *the fees of everyone who didn't pass*. That is the
prop-firm model industry-wide, and it is the thing that makes the sector's incentives look
bad from the outside: the house earns more when customers fail.

**The strategic problem this creates.** Revenue is one-off and churny, and the free Infinity
funnel currently generates no revenue at all while creating payout liability. That is the gap
the revenue memos were trying to close.

**The strategic asset.** You can measure traders more precisely and more verifiably than
anyone in retail — every decision, tamper-evident, with real statistics behind it. Selling
that measurement (tools, verification, licensing) is the direction that adds revenue without
depending on customers losing.

---

## 5. Where things actually stand

### Working and live
- Signup, login, email confirmation
- The trading terminal and the full order lifecycle
- The Journal and analytics in both `trading.html` and `dashboard.html`
- Payout request flow and KYC gating
- Bot API keys — all 90 issued, scoped to trade-only
- The audit hash chain — deployed, verified, tamper-resistant
- Owner dashboard — login, review queue, trader list, full trader profile
- Drawdown sweep on a schedule
- US/UK unblocked; only CU/IR/KP/SY screened

### Built but NOT deployed
- `create-payment-intent` + Stripe keys → **checkout is disabled**
- `live-mirror` → dead (and should stay dead)
- `trade-syncer-shadow` + its schema + `SYNCER_SHARED_SECRET`
- `fix-promo-code-exposure.sql` → **`promo_codes` is still readable by anyone**

### Built but not wired to anything
- `metrics.ts`, `probability.ts`, `similarity.ts` — the statistics stack. Nothing calls it
  on a schedule; `metric_run` / `prob_estimate` are empty. The trader-profile analysis
  panels have no data to render.

### Known open items
- Next.js is 14.2.35, two majors behind, with 2 high advisories
- `app.settings.pii_key` not configured
- Terms still name Canada/Ontario but nothing enforces it

---

## 6. What's left, in priority order

**Blocking launch (must do):**
1. **Answer the RAO art 85(1)(b) question.** Upstream of everything. See
   `risk-framework/revenue-strategy-memo-wave-3-corrections.md` §1.
2. Deploy `fix-promo-code-exposure.sql` — live data exposure, 2 minutes of work.
3. Connect Stripe: real publishable key + deploy `create-payment-intent` + set
   `STRIPE_SECRET_KEY`. Without this you cannot take a single payment.

**Should do before launch:**
4. Build the `metric_run` / `prob_estimate` pipeline so the statistics stack actually runs.
   It is the highest-value unwired asset you have.
5. Upgrade Next.js.
6. Decide on the two clean revenue products (IPFX Verified, Overfit Detector) — both are
   mostly wiring, both use code that already passes tests.

**Explicitly do not do:**
- Deploy `live-mirror`.
- Deploy `trade-syncer-shadow` against any live account.
- Build risk-priced evaluations (withdrawn — see corrections memo §3).
