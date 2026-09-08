# IPFX Capital — Revenue Strategy Memo

**Date:** 2026-09-09
**Constraint set:** every idea below fits under ~£3,000 total setup capital (roughly what
buying a handful of prop-firm evaluations costs), requires no FCA authorisation, and uses
code that already exists in this repository.
**Companion to:** `docs/risk-framework/legal-hardening-memo.md`

---

## 0. The one-paragraph answer

IPFX's real asset is not the challenge product. It is that IPFX can **measure trading skill
more rigorously, and prove it more credibly, than anyone else in retail** — and the code to
do that is already written and unit-tested in this repo. The lawful way to monetise that
instinct is to **sell the measurement, not to trade on it**. That points at one structural
change to the business model: move the centre of gravity of revenue away from one-off entry
fees and toward recurring subscriptions for measurement tools. That change makes more money,
makes *better* money (recurring rather than churny), and — the part that matters — materially
improves the legal position, because "pay a fee for a chance at a payout" is the shape
regulators dislike, while "pay monthly for an analytics tool" is an ordinary consumer
software contract. **The legally safest version of this business is also the better
business.**

---

## 1. The three to build first

### 1.1 IPFX Verified — the tamper-evident track record

**What it is.** Every trader gets a shareable performance record that is *cryptographically
verifiable* and *statistically honest*.

**Why it wins.** Retail track records are worthless because they are unverifiable —
screenshots are faked daily, and Myfxbook-style tools verify a broker connection but perform
no statistics and offer no tamper-evidence. IPFX can produce a record where two things are
true that are true nowhere else in retail:

1. **The data cannot have been altered after the fact.** That is exactly what the append-only
   audit hash chain in `internal-control-core.sql` §8 proves — and it is already deployed and
   live-tested (`fn_verify_audit_chain()` returns clean; the append-only trigger was confirmed
   to genuinely reject deletions).
2. **The statistics are honest.** Bootstrap confidence intervals on Sharpe rather than a point
   estimate; Monte Carlo drawdown percentiles; an explicit sample-adequacy verdict.

**The detail that makes it a product rather than a feature:** it should report *what the
record does not prove*.

> 42 trades. Sharpe 1.8, 95% CI [−0.3, 3.4]. **Not statistically distinguishable from luck.**

Nobody in this industry publishes that. It is the single most credible thing a prop firm could
put its name to, and it costs nothing to build.

**Built from:** `internal-control-core.sql` §8 (audit chain), `internal-control/lib/metrics.ts`
(6/6 tests pass), `internal-control/lib/probability.ts` (7/7 tests pass), the existing trader
profile page.

**Pricing:** free basic record for every IPFX trader (acquisition); £29 one-off to mint a
signed permanent snapshot; £9/mo for a live-updating public page.

**Legal position.** This is factual reporting of a person's own record, at their request, and
published by them. It is not advising on investments (RAO Art 53 — no recommendation about a
specified investment is made) and not arranging deals (Art 25 — IPFX is not bringing about any
transaction). **The constraint:** keep IPFX out of the promotion. The trader shares their own
page. IPFX must not market it with return claims — that is precisely where FSMA s21 bites.

**Cost:** ~£0 build; allow £150 for hosting and certificate handling.

**Honest revenue.** At 90 users, negligible. At 2,000 users with 10% conversion at £9/mo,
roughly £21k/yr. The strategic value — differentiation, credibility, and being the foundation
that 1.2 and §2.1 sit on — exceeds the direct revenue for at least the first year. Build it for
that reason, not for the subscription line.

**First step:** add a `/verify/<hash>` public route that renders one trader's chain-verified
metrics and prints the chain hash alongside them.

---

### 1.2 The Overfit Detector — research-grade statistics for retail

**What it is.** A subscription tool that tells a trader whether their edge is real or noise:
deflated Sharpe ratio, probability of backtest overfitting, minimum track record length for
significance, block-bootstrapped confidence intervals, and FDR correction when they have tested
many strategy variants.

**Why it has never been seen.** This is routine at quant funds (López de Prado's work on PBO and
the deflated Sharpe ratio) and *entirely absent* from retail. Every retail trader over-fits by
testing many parameter sets and keeping the best; no retail tool corrects for it. IPFX already
has block bootstrap, Monte Carlo path simulation and Benjamini–Hochberg FDR **written and
passing tests** in `internal-control/lib/probability.ts`. This is the highest ratio of product
value to work remaining anywhere in the codebase.

**Built from:** `internal-control/lib/probability.ts`, `backtest.html`,
`strategy-backtest-setup.sql`.

**Pricing:** £19/mo standalone; bundled free with any active paid challenge — which makes the
paid challenge better value without discounting the headline price.

**Legal position.** The cleanest idea in this memo. Its output is a statement about the
*strength of evidence in the user's own data*. It never names an instrument and never
recommends a position, so no specified investment is engaged: not advice, not arranging.
Marketing must still avoid performance claims.

**Cost:** ~£0. The libraries exist; this is UI plus wiring.

**Why it complements the model.** It gives traders a reason to pay IPFX monthly *between*
challenges — exactly the point in the funnel where the business currently earns nothing. And
traders who use it fail fewer challenges, which improves the payout narrative rather than
depending on failure.

**First step:** wire `probability.ts`'s bootstrap and FDR functions to the Journal data already
loading in `dashboard.html`, and ship one screen: "is your edge real?"

---

### 1.3 Dual-licence the statistics stack

**What it is.** Publish `internal-control/lib/{metrics,probability,similarity}.ts` as open source
under AGPL-3.0, and sell a commercial licence to any prop firm, broker or fintech that wants to
use it without open-sourcing their own product.

**Why it works.** A proven mechanic (Sidekiq, MongoDB pre-SSPL, Qt) that no prop firm has ever
used. It costs nothing and it inverts the credibility problem: a pre-launch prop firm has no
reputation, but a pre-launch prop firm whose risk-analytics library other firms depend on has
one. It also generates precisely the B2B inbound that §2.2 and §2.4 need in order to work.

**Pricing:** AGPL free; commercial licence £1,200–£3,000/yr per firm.

**Legal position.** Pure software licensing — no financial-services perimeter at all. Two things
to confirm: that IPFX owns the code outright (it does — written in-house), and that no
dependency's licence conflicts with AGPL redistribution.

**Cost:** ~£400 for a solicitor to review the commercial licence template. Otherwise £0.

**First step:** split those three files into a standalone repo with the test suite attached —
the passing tests *are* the marketing.

---

## 2. The next tier

**2.1 IPFX Certified.** A paid, statistically-scored competence assessment producing a portable
credential. Charge the *trader* (~£49); let firms consume it free. **Critical:** do not take
money from firms for introducing traders to them — that risks being "arranging deals in
investments" under RAO Art 25. Examining is not arranging; get paid for the exam.

**2.2 White-label the challenge engine.** The rules engine, payout system, audit chain and
simulated terminal are a sellable product at £300–£1,500/mo per firm. Needs sales effort, not
capital. Honest caution: the white-label market is crowded, so lead with the audit chain and the
statistics — the things competitors don't have — not with "we have a platform".

**2.3 The IPFX Retail Trader Index.** A quarterly public research report on how retail traders
actually behave, drawn from aggregated anonymised IPFX data — which the current Terms §11.3
expressly permit. Not direct revenue: it is the cheapest customer-acquisition channel available
and the only content a pre-launch firm can publish that nobody can copy. **Caveats:** there is no
dataset at 90 users, so this is a scale play; and genuine anonymisation of trading histories is
hard (ICO motivated-intruder test — timestamps plus instruments are highly re-identifiable).
Aggregate to cohort level and never publish individual paths.

**2.4 Risk-rules-as-a-service for brokers.** The drawdown sweep, rule engine and alerting stack
solve a problem every small broker has. B2B, no retail-facing exposure.

**2.5 Sponsored evaluation seats.** A broker or tool vendor pays IPFX to give challenge seats to
their audience — B2B revenue funding the free funnel. Watch: the *sponsor's* promotion may itself
be a financial promotion under FSMA s21; put responsibility for their own compliance in the
contract.

**2.6 Bot directory on the existing API.** Every account already holds an `ipfx_bot_` token scoped
to trade-only actions. Let traders publish bots that others run against *their own* account, with
IPFX taking a cut. **Hard caveat:** if IPFX ever hosts or executes those bots on a user's behalf,
that is the copy-trading problem wearing a new costume, and it becomes fatal the moment real money
attaches. The only safe framing is a directory: IPFX hosts nothing and executes nothing; the trader
runs the code against their own key. Get this one specifically reviewed before building it.

---

## 3. The adaptation to the business model — answered directly

The instinct is right, and it can be had. Stated plainly, what you want is: *IPFX can see which
traders are genuinely good, better than anyone else can, and should be paid for that.*

Three lawful structures deliver exactly that:

- **Sell the measurement to the trader** (§1.1, §1.2, §2.1) — they pay for proof and for tools.
- **Sell the measurement to businesses** (§1.3, §2.2, §2.4) — firms pay for the machinery.
- **Sell the aggregate insight** (§2.3) — the market pays in attention, which converts.

What is not available is executing trades derived from what you can see. That is settled and is
not revisited here. But notice what the surviving structures actually do: they monetise the
**judgement**, which is durable, rather than the **signal**, which is the illegal one. Signals
decay in days. A reputation as the firm that measures honestly does not.

### The structural change worth making before launch

Rebalance the revenue mix away from entry fees and toward subscriptions. Concretely: keep the
paid challenges, but make the free Infinity route the front door to a paid *tools* subscription
rather than only to a paid challenge. This does four things at once:

1. Creates recurring revenue where there is currently none.
2. Earns money from the large majority who never pass, without needing them to repeatedly re-buy
   entries — which is the mechanic that makes prop firms look predatory and attracts regulators.
3. Moves the product's shape from "pay for a chance at a prize" — the Gambling Act 2005 exposure
   flagged in the legal memo §4, and the shape the FCA and ASA are most hostile to — toward "pay
   for software", an ordinary consumer contract.
4. Gives an honest answer to the question the current model cannot answer: *how does the free
   Infinity Challenge pay for itself?*

---

## 4. What was rejected, and why

- **Trade replication in any form.** Settled by the legal memo §2: the FCA's published position
  makes automatic execution of another party's signals portfolio management under MiFID Art
  4(1)(9); doing it unauthorised is a criminal offence under s19 FSMA. Not revisited.
- **A real A-book on IPFX's own capital.** Not unlawful — but it breaks the capital constraint
  outright. `internal-control/lib/a-book-simulator.ts` already exists in the repo (untracked).
  Keep simulating it; it costs nothing and it means the modelling is done when there is revenue
  to fund it.
- **Paying for, or being paid for, trader introductions.** RAO Art 25 risk with no corresponding
  upside over §2.1, which achieves the same thing by charging for the exam instead.

---

## 5. Capital arithmetic

| Item | Cost |
|---|---|
| §1.1 IPFX Verified — hosting, certificates | £150 |
| §1.2 Overfit Detector — build | £0 |
| §1.3 Dual licence — solicitor review of licence template | £400 |
| Solicitor: 2–3 hours on the perimeter questions below | £900–£1,500 |
| Contingency | £500 |
| **Total** | **£1,950 – £2,550** |

Under the £3,000 ceiling with room to spare. The solicitor line is the highest-value spend in
the table — it is the item that converts "probably fine" into "known".

### The four questions to put to the solicitor

1. Does IPFX's wholly **simulated** environment mean no "specified investment" under the RAO is
   engaged, so that Arts 25, 37 and 53 are not in point? Does that conclusion survive the fact
   that real money enters (fees) and leaves (payouts)?
2. Does the current paid-challenge structure engage the **Gambling Act 2005**, and does the s14(5)
   skill exemption apply on our facts?
3. Does publishing a trader's verified record (§1.1), or selling a certification that firms rely
   on (§2.1), amount to **arranging deals in investments** under RAO Art 25?
4. Which of our current marketing statements are **financial promotions** under FSMA s21, and
   what specifically must change?

---

## 6. Sequence

**Now → launch (Oct 2026).** Build §1.1 and §1.2 — both are effectively free and both run on code
that already passes its tests. Open-source the libraries (§1.3). Book the solicitor and get the
four questions answered.

**At launch.** Subscription live alongside the challenges. Certification (§2.1) as an upsell.

**After launch.** White-label (§2.2) once there is a reference customer. The Retail Trader Index
(§2.3) once there is a dataset worth aggregating. Reassess the A-book only when revenue — not
capital — can fund it.

---

## Appendix: outstanding deployment blockers (unrelated to the above)

- `fix-promo-code-exposure.sql` — **written and committed, not yet deployed.** Until it is run in
  the Supabase SQL editor, `promo_codes` remains readable by any anonymous caller holding the
  public anon key, including three codes with `max_uses = NULL` (unlimited free 100K Challenges).
- `create-payment-intent` is not deployed and `STRIPE_PUBLISHABLE_KEY` is still a placeholder.
  Checkout is correctly self-disabling rather than broken, but this is a launch blocker.
- `trade-syncer-shadow` schema and function are committed but not deployed, and
  `SYNCER_SHARED_SECRET` is not set.
