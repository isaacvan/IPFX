# IPFX Capital — Revenue Strategy Memo, Wave 2

**Date:** 2026-09-09
**Follows:** `docs/risk-framework/revenue-strategy-memo.md`
**Same constraints:** ≤ ~£3,000 total setup capital, no FCA authorisation, built from code that
already exists.

> [!WARNING]
> **Parts of this memo have been corrected.** An adversarial review against primary sources found
> six load-bearing legal claims across this document and its wave-2 companion to be materially
> overstated. Read `revenue-strategy-memo-wave-3-corrections.md` FIRST. In particular: the
> "simulated, therefore outside the FCA perimeter" reasoning used throughout is **not safe** (RAO
> art 85(1)(b) reaches a contract whose *"pretended purpose"* is profit by reference to price
> fluctuations), and the claim that shifting revenue to subscriptions reduces Gambling Act exposure
> is **wrong** (s6 gaming is payment-blind).

> Additionally in this memo: risk-priced evaluations (§3) are **withdrawn entirely**; the
> Counterfactual Engine (§1), employer assessment (§4) and Ulysses contracts (§2) each need
> redesign before building.



---

## 0. Where wave 1 stopped short

Wave 1 monetised what IPFX **has** — the audit chain, the statistics libraries, the challenge
engine. Reasonable, but several of those ideas (white-label, certification, sponsored seats) are
adjacent moves a competitor could copy in a quarter.

Wave 2 monetises what IPFX **can do that is physically impossible for anyone else.**

Because the market is simulated and IPFX owns the engine, IPFX can **re-run reality with one
decision changed**. A broker cannot do this — they do not own the market. A journal app cannot —
they own neither the tick data nor the execution engine. A competing prop firm running on a
white-label platform cannot, because they do not control the simulation.

That capability is the asset. Everything in this memo derives from it.

---

## 1. The Counterfactual Engine — "what it cost you"

**The product.** Replay a trader's actual session with exactly one of their decisions reversed,
and price the difference in pounds.

> You moved your stop on 11 trades last month.
> **As you traded them:** −$890.
> **Had you left every stop where you originally placed it:** +$1,240.
> **Your stop-moving cost you $2,130.**

**Why this is the strongest idea in either memo.** It is a *number*, it is *personal*, it is
*unarguable*, and it is derived entirely from the trader's own history. Every trading educator on
earth says "don't move your stops." None of them can tell you what it cost *you*, specifically,
last month. IPFX can.

It is also the most shareable output any trading product could produce. Traders will screenshot
"my stop-moving cost me $2,130" and post it, which is free acquisition of exactly the audience
IPFX wants.

**Extensions, all from the same engine:** what revenge-trading cost; what cutting winners early
cost; what trading the first 30 minutes after a news release cost; what your worst hour of the day
cost. Each is one counterfactual over data that is already stored.

### Feasibility — checked, not assumed

**What already exists:** `market_data_ticks` (sampled quote log), `market_data_candles` (1m and
up, OHLC per symbol), `order_audit_events` (open / close / reject with fill price, bid, ask,
spread, quote timestamp and latency), and `trades`.

**The data needed is already being captured.** `order_audit_events` records one row per order-type
action — `open`, `close`, `reject`, `modify`, `partial_close`, `place_pending`, `cancel_pending` —
with fill price, bid, ask, spread, quote timestamp and latency on each. Stop moves are in there.

This was *not* always true, and the history is worth knowing because it is the single biggest
constraint on how far back the product can look: the `event` check constraint originally allowed only
`('open','close','reject')`, so every `modify` insert was silently rejected by Postgres and swallowed
by `logAudit()`'s own `try/catch`. `order-position-id-integrity.sql` widened the constraint and is
deployed to production. **Consequence: stop-modification history only exists from that migration
forward.** Any counterfactual over earlier data will under-count stop moves, so the product must
either date-gate itself to post-migration trades or say plainly that earlier periods are incomplete.

**One residual fragility worth fixing cheaply.** `logAudit()` ends with
`catch (_) { return null; }`, and the Supabase client returns errors rather than throwing — so a
failed audit insert returns `null` and disappears without trace. That is exactly why the constraint
bug survived as long as it did. Keeping audit failures non-blocking is the right call, but they
should be *visible*: log the error to `feed_health_events` or at minimum to console. Ten minutes of
work, and it means the next silent audit failure is noticed in days rather than months.

**The one real limitation:**

- **Replay granularity is 1-minute, not tick.** `market_data_ticks` is explicitly commented
   "sampled, not every poll". So "would the original stop have been hit?" is evaluated against 1m
   candle highs and lows. That resolves the great majority of cases correctly, but not
   intra-candle path ambiguity — if a candle's range spans both the original stop and the target,
   the order of events within that minute is unknown. **State this in the product.** Report those
   cases as indeterminate rather than guessing. Being visibly honest about the one case you cannot
   resolve is what makes the other 95% credible.

**Legal position.** Clean, and cleaner than most analytics. It reports what *already happened*
under a stated alternative assumption about the user's own past conduct, in a simulated
environment. It makes no recommendation about any instrument, so RAO Art 53 (advising) is not
engaged; it brings about no transaction, so Art 25 (arranging) is not engaged. Keep the framing
strictly retrospective — "this is what that habit cost you", never "you should therefore do X."
The moment it says what to do next, it moves toward advice.

**Cost:** £0 cash. The migration is trivial; the replay harness is real work but weeks, not months.

**Monetisation:** the anchor feature of the £19/mo subscription in wave 1 §1.2. On its own it
justifies the subscription in a way that generic analytics never will.

**First step:** write the replay harness for the single case of moved stops — read `modify` events
for one account from `order_audit_events`, pull the 1m candles spanning each position's life from
`market_data_candles`, and evaluate whether the *original* stop would have been hit before the actual
exit. One number, one screen. Everything else in this section is the same query with a different
predicate.

---

## 2. The Ulysses Contract — commitment devices, structured so IPFX never profits from failure

**The product.** A trader pre-commits to their own rule — "lock me out after three losses in a
day", "no positions larger than 1%", "no trading between 14:30 and 15:00". IPFX enforces it at the
engine level, where it cannot be overridden in the moment.

**The novel part.** Make the commitment financially real *without* IPFX gaining anything from a
breach. The trader stakes £20 on their own rule. If they break it, the £20 goes **to a charity of
their choosing — never to IPFX**. IPFX charges a flat service fee whether the trader succeeds or
fails.

That design is doing three jobs at once:

- It is the mechanic proven by StickK and Beeminder in other domains, imported into trading for the
  first time.
- It removes IPFX's conflict of interest entirely. A prop firm that profits when you fail is the
  industry's central credibility problem. This is a feature where IPFX visibly cannot.
- **It is what keeps it out of gambling regulation.** Betting under the Gambling Act 2005 requires
  a *prize*. Here nobody wins anything: the trader can only forfeit, and the forfeit goes to a
  third party of their own nomination. There is no stake pooled against an uncertain event, no
  prize allocated, and no operator gain. That is a pledge, not a bet.

**Flag for the solicitor:** confirm the forfeit mechanic does not constitute a bet under s9 or
gaming under s6, and confirm that handling a charitable forfeit does not make IPFX a payment
intermediary requiring registration. A simpler variant that sidesteps both: the trader sets up the
charitable payment themselves and IPFX merely *attests* whether the rule was kept. IPFX never
touches the money at all. **Prefer this variant** — it is materially cleaner and barely less
effective.

**Cost:** £0. The rules engine and drawdown sweep already do enforcement of this kind.

**Why it complements the model:** traders who use commitment devices fail fewer challenges, which
means fewer payouts denied on technicalities, fewer disputes, and a business whose revenue does not
depend on customers losing.

---

## 3. Risk-priced evaluations — charge good traders less

**The product.** Every prop firm in the world prices by account size. IPFX can price by *measured
probability of passing*, because `internal-control/lib/probability.ts` can actually compute it.

> Your assessed profile qualifies you for the £149 entry rather than £399.

**Why nobody has done it.** Because for a firm whose profit comes from failed evaluations, charging
good traders less is suicidal. It only works if the profit centre is the subscription rather than
the entry fee — which is exactly the structural change wave 1 §3 recommends. **The two ideas are
load-bearing for each other.**

**Why it is a weapon.** "We charge good traders less" is a devastating line against competitors
whose model requires failures, and it is *verifiable* against IPFX's own published statistics. It
inverts the industry's incentive in public.

**Legal position — the real constraint.** Automated individual pricing engages **UK GDPR Art 22**
(automated decision-making producing legal or similarly significant effects). That does not
prohibit it, but it requires: a lawful basis, meaningful information about the logic, a right to
human review, and a route to contest the decision. Build the human-review path from day one — it is
cheap now and expensive to retrofit. Also consider Consumer Rights Act 2015 fairness and, if any
input correlates with a protected characteristic, Equality Act 2010 indirect discrimination.
Use only trading-behaviour inputs; never demographic ones.

**Cost:** £0 build. Include in the solicitor's brief.

---

## 4. Trading aptitude assessment, sold to employers — a product outside the FS perimeter entirely

**The product.** Sell IPFX's assessment to firms hiring junior traders, as a recruitment screen.
Proprietary trading desks and market-making firms run aptitude tests; IPFX has a better instrument
than anything commercially available for this specific role, because it measures actual decision-
making under live risk rather than a proxy.

**The legal insight that makes this attractive.** Employment is not a transaction in a specified
investment, so **RAO Art 25 arranging is simply not engaged.** This is an HR assessment product,
sold on the SHL / HackerRank model, and it sits entirely outside financial-services regulation.
Wave 1 §2.1 had to tiptoe around Art 25 by charging the trader rather than the firm; here you can
charge the firm, which is where the real money is. Employers pay meaningfully for assessment.

**Two constraints to design around, both real:**

- **Do not introduce candidates.** Selling an assessment *tool* keeps IPFX outside the Conduct of
  Employment Agencies and Employment Businesses Regulations 2003. Introducing candidates for
  employment brings IPFX inside them. Sell the instrument, not the person.
- **Equality Act 2010.** Any instrument used in hiring must be defensible against adverse-impact
  claims. This is a genuine obligation, not a formality — but IPFX is unusually well placed to meet
  it, because the statistics stack can actually measure differential impact, which most vendors
  cannot.

**Cost:** £0 build — it is the existing challenge with a different report at the end. Sales effort,
not capital.

---

## 5. Chain attestation — become the referee of the industry you compete in

**The product.** Other prop firms are permanently accused of manipulating prices to hit stops and
of inventing reasons to deny payouts. IPFX has a working append-only cryptographic audit chain
(`internal-control-core.sql` §8, deployed and live-verified). Licence it to competitors and publish
attestations of chain integrity.

**Why it is a strong strategic position.** A firm that becomes the neutral verification layer of its
own sector captures something no amount of marketing buys. It also pairs perfectly with wave 1 §1.3
— open-source the libraries, sell the attestation.

**The genuine risk, stated plainly.** Making public statements about another firm's conduct invites
defamation and malicious-falsehood claims. The attestation must be **narrowly and literally scoped**:
"we verify that this firm's event log is internally consistent and has not been altered since
recording." It must never say, or imply, that the firm is honest, solvent, or fair. Get the wording
drafted by the solicitor, not by you.

**Cost:** included in the £400 licence-review line from wave 1.

---

## 6. Scenario replay laboratory

**The product.** Because IPFX owns the environment, it can replay historical stress events — the
2015 CHF depeg, March 2020, a flash crash — against a trader's actual rules and sizing.

> Trade the 2015 CHF depeg. See what your risk rules do when the market gaps through your stop.

Nobody sells this to retail. It is a subscription-retention feature rather than a standalone
product, and it makes the difficult, honest point that a stop is not a guarantee — which is exactly
the kind of consumer-protective content that plays well under Consumer Duty-style scrutiny.

**Cost:** £0 if built on stored candles; the constraint is having the historical data, not the code.

---

## 7. Classroom licence

Universities and colleges teaching finance pay real money for trading-room software. IPFX has a
complete simulated environment with a rules engine and a genuinely research-grade statistics stack.
A classroom edition has **no real money anywhere in it**, so the financial-services perimeter is not
engaged at all, and the statistical rigour is a selling point to academics rather than a curiosity.

Unglamorous, and probably the most reliable recurring B2B revenue in either memo.

---

## 8. Deliberately rejected in this wave

- **Failure insurance** ("fail because of one tilt event and we refund your fee"). This is
  economically insurance. It engages the FCA regime for insurance distribution and would require
  authorisation. §2 achieves the same behavioural goal with none of the exposure. Do not let anyone
  sell you this one.
- **A public broker execution-quality league table.** IPFX has the market-data infrastructure to
  build it, but publishing comparative judgements about named firms carries defamation risk, is
  expensive to defend, and is arguably a financial promotion. High cost, contested benefit.
- **Any bot marketplace where IPFX hosts or executes the bots.** Covered in wave 1 §2.6 — it is the
  copy-trading problem in a new costume. A passive directory where the trader runs the code against
  their own API key is fine; IPFX executing anything on a user's behalf is not.

---

## 9. Capital

Every idea in this wave builds on code that exists. Combined additional cash cost over wave 1:

| Item | Cost |
|---|---|
| §1 Counterfactual replay harness (audit data already captured) | £0 |
| §2 Commitment device (attestation-only variant) | £0 |
| §3 Risk-priced evaluations | £0 |
| §4 Employer assessment | £0 |
| §5 Attestation wording — folded into wave 1's £400 licence review | £0 |
| §6, §7 | £0 |
| Additional solicitor time for §2, §3, §4 questions | £300–£600 |
| **Additional total** | **£300 – £600** |

Running total across both memos: **£2,250 – £3,150**. At the top end that is marginally over the
ceiling; drop the contingency line from wave 1 or defer §4's Equality Act review until there is a
paying employer, and it fits.

---

## 10. What to do first

1. **Build the counterfactual for moved stops.** One number, one screen. The audit data is already
   there; this is the highest-value thing in either memo and it costs nothing but time.
2. Make `logAudit()` failures visible (ten minutes). The constraint bug that cost the earlier stop-
   modification history survived only because audit write failures were silent.
3. Add §2's attestation-only commitment device — nearly free, and the clearest possible signal that
   IPFX does not profit from failure.
4. Add §3 and §4 to the solicitor's brief alongside wave 1's four questions.
