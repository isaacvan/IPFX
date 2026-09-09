# IPFX Capital — Wave 3, Part A: Corrections to Waves 1 and 2

**Date:** 2026-09-09
**Status:** supersedes specific claims in `revenue-strategy-memo.md` and
`revenue-strategy-memo-wave-2.md`. Read this before acting on either.

Six load-bearing legal claims from the first two memos were put to independent adversarial review
against primary sources. **All six came back materially overstated**, five at high confidence. I have
personally verified the four statutory provisions that matter most, quoted below from
legislation.gov.uk rather than relayed.

This memo is the correction. It is not comfortable reading, and the most important finding is about
the **existing business**, not about the new ideas.

---

## 1. The finding that matters: RAO Article 85(1)(b) and the word "pretended"

Both memos, and `legal-hardening-memo.md` before them, lean on a single load-bearing assumption:
*IPFX's environment is simulated, therefore no specified investment is engaged, therefore the FCA
perimeter is not in point.*

**That inference is not safe, and the statute appears to have been drafted to defeat it.**

RAO 2001 (SI 2001/544) art 85(1) — verified verbatim:

> (a) a contract for differences; or (b) any other contract the **purpose or pretended purpose** of
> which is to secure a profit or avoid a loss by reference to fluctuations in — (i) the value or
> price of property of any description; or (ii) an index or other factor designated for that purpose
> in the contract.

"Pretended purpose" is doing exactly the work its drafting suggests. Article 85 is built around the
**economic reference**, not around whether a real instrument changes hands. On IPFX's facts: a real
fee is paid in, a real payout is made out, and the quantum is fixed by reference to fluctuations in
real FX and index prices. None of the art 85(2) exclusions (delivery, indexed deposit, National
Savings, qualifying insurance) applies.

If art 85 is engaged, entering into those contracts as principal is art 14 dealing in investments as
principal — a regulated activity, and therefore the FSMA s19 general prohibition, a criminal offence
under s23.

### The commercial consequence is sharper than the criminal one

FSMA 2000 s26 — verified verbatim:

> An agreement made by a person in the course of carrying on a regulated activity in contravention
> of the general prohibition is unenforceable against the other party.

and that party may recover

> any money or other property paid or transferred by him under the agreement

plus compensation for loss.

**If art 85 is engaged, every user can reclaim every pound they have paid, at their election, with no
cap.** That is a balance-sheet contingency that scales linearly with growth. At ~90 users it is
small. After an October 2026 launch it is not. **This is the cheapest moment this question will ever
be answerable.**

### The pincer — why "simulated" makes one limb worse, not better

Gambling Act 2005 s10(1) — verified verbatim:

> For the purposes of section 9(1) "bet" does not include a bet the making or accepting of which is a
> **regulated activity** within the meaning of section 22 of the Financial Services and Markets Act
> 2000.

That is the **only** carve-out from "bet" for market-linked wagering, and it is available only to
firms **inside** the FSMA perimeter.

So the two doors are both guarded:

| | Consequence |
|---|---|
| **Inside FSMA** (art 85 engaged) | Needs FCA authorisation. s19/s23 exposure, s26 unenforceability until resolved. |
| **Outside FSMA** (simulation argument succeeds) | **Forfeits the s10 carve-out**, leaving the Gambling Act s9/s11 analysis unanswered. |

The simulation argument does not deliver a "neither" outcome. It removes a defence on the gambling
limb in exchange for removing exposure on the FSMA limb.

### And on the gambling limb, the skill defence does not do what we assumed

GA 2005 s11 — verified verbatim. A person **makes a bet** if they participate in an arrangement where
participants guess matters in s9(1)(a)–(c), are required to pay, and on accuracy win a prize.
Critically:

> **s11(2):** "Guessing includes a reference to predicting using skill or judgment."

> **s11(4):** "Prize includes any money, articles or services — (a) whether or not described as a
> prize…"

The skill exemption everyone in this sector relies on is **s14(5), which operates only on the
*lottery* limb.** It does nothing about s11 betting. That distinction is the most commonly missed
feature of the Act, and IPFX's own marketing ("Four stages. Pure skill.") is evidence *for* the
prosecution on the s6 gaming limb, because s6(2)(a)(ii) defines a game of chance to include one
"that involves an element of chance that can be eliminated by superlative skill."

### Fair statement of the uncertainty

This is a **statutory reading, not settled law.** The reviewers searched and found: no Gambling
Commission position statement on prop-firm challenges, no FCA perimeter publication on simulated-
account prop firms, and no case law on GA 2005 s11 applied to trading challenges. Prop firms operate
in the UK today without gambling licences or FCA authorisation.

So this is not "you are committing a crime." It is: **there is a serious, well-founded, untested
argument that the core product sits inside one of two regulatory perimeters, and the reasoning we
have been relying on to say otherwise is the weaker of the available arguments.**

### What to do about it

1. **This becomes question 1 of the solicitor's brief, above every other item, and it should displace
   lower-value items rather than be added after them:** *Is the IPFX challenge contract rights under
   a contract for differences within RAO art 85(1)(b), given that a real fee is paid, a real payout
   is made, and the payout is determined by reference to fluctuations in real market prices?* Get a
   specialist financial-services regulatory opinion, not a general commercial solicitor. Everything
   downstream — including whether FSMA s21 even applies to your marketing — turns on the answer.
2. **Stop writing "simulated, therefore outside the perimeter" in internal documents.** Both my memos
   do it and the legal memo does it. Successive documents repeating an unexamined inference build a
   record a claimant will characterise as a firm reassuring itself. Where the perimeter is
   unresolved, write that it is unresolved. I have added correction banners to both earlier memos.
3. Budget for this properly. It is the one opinion genuinely worth paying for out of the £3,000.

---

## 2. Correction: the structural recommendation does not buy the legal benefit I claimed

**Wave 1 §3 claimed** that shifting revenue from entry fees to subscriptions "materially reduces
Gambling Act 2005 exposure." **That is wrong**, for three reasons:

- **s6 gaming is payment-blind.** s6(4)(b): a person plays a game of chance for a prize "whether or
  not he risks losing anything at the game." Removing entry fees reduces s6 exposure by *zero*. The
  free Infinity Challenge already demonstrates this — it is the lowest-fee product with identical s6
  exposure. Implemented as written, my recommendation migrates the user base onto the one limb the
  fee change cannot touch.
- **The lottery limb I claimed to be reducing was already near-zero.** s14 requires allocation to rely
  *wholly* on chance, and the s14(5) deeming provision only bites where the skill requirement cannot
  be expected to prevent a significant proportion from winning. A low pass rate defeats that.
- **Relabelling a fee as a subscription does not remove it.** GA 2005 Sch 2 para 2(c) defines payment
  to include "paying for goods or services at a price or rate which reflects the opportunity to
  participate." That provision exists precisely for this manoeuvre. If the analytics subscription
  gates challenge access or is priced above standalone value, the payment element survives untouched.

**What survives.** The subscription shift is still the right commercial move — recurring revenue,
better margins, and a business that does not depend on customers failing. Those reasons stand on
their own. **It simply does not buy the regulatory benefit, and it must not be sold internally as a
compliance measure.** If the subscription is built, price it at genuine standalone value and never
gate challenge access on it.

---

## 3. Correction: drop risk-priced evaluations entirely (wave 2 §3)

I recommended pricing evaluations by assessed probability of passing. **Withdraw it.** It was the
worst idea in either memo:

- Against the s9(1) betting limb, IPFX's best available answer is that the fee is an
  outcome-independent service charge fixed by tier. **Risk-pricing destroys that answer** — a price
  calibrated to P(win) on a contingent payout *is odds*, and quoting odds against your own book is
  what accepting a bet means. GA 2005 Sch 1 para 1(c) makes it near-verbatim: paying includes "paying
  for goods or services at a price or rate which reflects the opportunity to participate."
- The model, its features and its per-user scores are **disclosable**. It converts a contestable
  perimeter question into a documented one, and supplies the exhibit rather than requiring it to be
  proved.
- My Equality Act reasoning was **wrong on the face of the statute**, not merely optimistic.
  "Only trading-behaviour inputs, so no protected characteristic is engaged" conflates direct with
  indirect discrimination. EA 2010 s19(2) requires no protected-characteristic input at all — only
  that a neutral practice puts a group at particular disadvantage. Price is a "term" under s29(2)(a);
  s136 shifts the burden once disparity is shown; and the Sch 3 para 20A risk-assessment exception is
  available only to firms "providing a financial service" — which IPFX's entire perimeter position
  denies. That is a genuine catch-22.
- My Art 22 citation was **out of date**. UK GDPR Art 22 was replaced by Arts 22A–22D by the Data
  (Use and Access) Act 2025 s80. It is now a safeguards regime rather than a prohibition-plus-
  exception — so my prescription roughly matched current law by accident, while describing a
  structure that no longer exists.

**The salvage.** Use the model to *withhold* rather than to *discount*: where P(pass) is very low,
refuse or defer the paid entry and route the user to the free Infinity Challenge. That inverts it
from a prosecution exhibit into a consumer-protection control, costs nothing, and is the version a
regulator would look on favourably. Keep published tier prices flat, uniform and outcome-independent.
Flat discounts (referral, returning user, launch promo) are safe; anything that is a function of
P(win) is not, in any wrapper.

---

## 4. Correction: the Counterfactual Engine needs redesign, not abandonment

The idea survives — it is still the best thing in either memo — but my legal framing was wrong in a
way that changes the product.

**What I got wrong.** I said it is not advice because it makes no recommendation. The applicable test
is RAO art 53(1), and **as an unauthorised person IPFX cannot rely on the personal-recommendation
limitation in art 53(1A)**. And my art 25 reasoning ("no transaction results") is specific to art
25(1); art 26 does not touch art 25(2).

**Six design changes, in priority order:**

1. **Kill the aggregate headline.** "Your stop-moving cost you $2,130" must not ship. A statement
   about a *continuing practice* is prospective, and prospective is a course of action. Ship instead:
   *"Trade #4471, 14 Aug. You moved the stop from 1.0842 to 1.0871. As traded: −$120. With the
   original stop: +$310."* One trade, one decision, one number, no verdict, no habit named.
2. **The user selects, always.** They pick the trade and the counterfactual from a fixed menu. IPFX
   must never surface, rank, sort by cost, or notify. That is the difference between a calculator and
   a signal.
3. **Symmetry is mandatory, not cosmetic.** If you price "had you left every stop", you must equally
   price the trades where moving the stop *saved* money, and show both counts. A one-sided
   counterfactual is a steer however it is worded.
4. **Closed positions only, hard-coded.** A counterfactual on an open position is a hold/close signal
   in the present tense, and is advice on any reading.
5. **Delete the share affordance, or accept it is a promotion.** My "screenshot-able, free
   acquisition" rationale was the problem: if the share feature ships, the output is a financial
   promotion and needs s21 treatment (assuming art 85 is engaged — see §1).
6. **Honest error bars; drop the word "unarguable".** Given the pre-migration audit gap and 1-minute
   replay granularity, publish a range and a coverage date and mark intra-candle-ambiguous cases
   indeterminate. A confident pound figure over data known to be incomplete is a DMCCA 2024 s226
   misleading action with individual redress under s232 — and that exposure exists whether or not
   FSMA is engaged.

---

## 5. Correction: the employer assessment is safe for a different reason than I gave

**What I got right:** RAO art 25 is not engaged. Employment is not a transaction in a specified
investment. Conceded by the reviewer.

**What I got wrong, and it matters:** I attributed the safety to the trading being *simulated*. It is
not. Art 85(1)(b)'s "pretended purpose" defeats that. **The real reason it is safe is that in an
employer-pays model the candidate stakes nothing and receives no payoff referenced to simulated
P&L — so there is no art 85 contract with the candidate at all.**

That distinction is load-bearing. The moment the "assessment" is the existing $79–$699 challenge
repackaged for employers, art 85 revives with full force and my stated reasoning gives no defence.

**The trap I missed entirely.** I tested against the Conduct Regulations 2003. The gateway is
**Employment Agencies Act 1973 s13(2)**, which is much wider: the business of providing services
"**whether by the provision of information or otherwise**" for the purpose of finding persons
employment **or of supplying employers with persons**. There is no s13(7) exclusion for assessment or
testing vendors, and current DBT guidance expressly names **online platforms** as in scope.

Then **EAA s6(1)(a)**: an employment agency may not request or "directly or indirectly receive any
fee from any person" for services for the purpose of finding him employment. s13(1): "'fee' includes
any charge however described." **IPFX charges $79–$699 to exactly the population whose scores would
be sold.** If IPFX is an agency under s13(2) and markets the challenge as a route to a prop seat,
that fee is a fee indirectly received from a work-seeker — an offence under s6(2), with s3A
prohibition orders up to 10 years available. The reg 26 work-seeker-fee exception covers only
Schedule 3 occupations (entertainment, modelling, sport); trading is not there.

**Four hard rules, none optional, if this is built:**

1. Licence the **instrument** to employers, who administer it to *their own* candidates. IPFX never
   sources, shortlists, ranks or recommends a person.
2. **No candidate pipeline, ever** — no employer-visible leaderboard, no certified-trader directory,
   no talent pool, no "make me visible to hiring firms" toggle.
3. **No marketing to traders that mentions employment.** Under reg 2 a person becomes a "work-seeker"
   the moment IPFX "holds itself out as being capable of providing work-finding services". The copy
   alone does it, with no introduction made. This is the rule a growth-minded founder is most likely
   to break, and it is the one that turns $79–$699 into a s6 offence.
4. **Zero-stake sessions:** no candidate fee, no payout, no funded account, no prize, no discount, no
   progression credit. That is what keeps art 85 and the Gambling Act out.

Plus: do **not** repurpose the existing ~90 users' data — current Terms permit aggregated anonymised
use only, and a named score sold to an employer is identifiable processing for a new purpose. And ship
a **descriptive report, not a predictive score**: *Spring v Guardian Assurance* [1995] 2 AC 296 (HL)
means a rejected candidate can sue IPFX directly in negligence for a carelessly prepared assessment,
and with ~90 users and no criterion-validity study there is no defence to that yet.

---

## 6. Correction: the Ulysses Contract reasoning was wrong on the statute

I argued it is not gambling "because no prize exists". **s9 betting has no prize element** — only s6
and s14 do. The better argument is absence of mutuality at common law. And the fact that IPFX gains
nothing is **legally irrelevant**: GA 2005 Part 5, s19 and ss297–302 regulate gambling run entirely
for charity.

Worse, the charity framing creates a *new* regime I did not consider: **Charities Act 1992 ss58–60**
commercial-participator rules bite on any representation that money goes to charity.

**The salvage, which is cleaner than what I proposed:**

- Rules must be **purely behavioural** and never price- or P&L-referenced: max trades per day, no
  trading between set hours, cooldown after consecutive losses, journal entry required before entry.
  Ban "max daily loss", "max drawdown", "profit target" and anything derived from simulated price.
  This removes the art 85 tail risk *and* makes compliance determinable from IPFX's own order log.
- **Non-refundable, paid up front, primary obligation.** The stake goes to the nominated payee whether
  the trader succeeds or fails; success earns an acknowledgement only. The trader cannot receive money
  in any state of the world, which removes the s6(5)(b) "winnings" analysis and the *Makdessi* penalty
  analysis in one move. If that kills the behavioural incentive, the honest answer is that it does.
- **Either** never name, list, curate or suggest charities and let the trader nominate any payee — so
  IPFX makes no s58(1) representation — **or** accept commercial-participator status with written
  s59(2) agreements.

---

## 7. Net position

**Unaffected and still worth building:** IPFX Verified (wave 1 §1.1), the Overfit Detector (wave 1
§1.2), dual-licensing the statistics stack (wave 1 §1.3), scenario replay, classroom licensing. None
of these takes a stake or pays out against simulated P&L, which is the fact pattern that attracts
every problem in this memo.

**Redesign before building:** Counterfactual Engine (§4), employer assessment (§5), Ulysses contracts
(§6).

**Withdrawn:** risk-priced evaluations (§3).

**Reframed:** the entry-fee-to-subscription shift is a commercial improvement, not a compliance
measure (§2).

**Escalated above everything:** the art 85(1)(b) question (§1). It is upstream of the entire business,
not just of these ideas, and it is cheapest to answer now.

### Revised solicitor's brief, in priority order

1. Is the challenge contract within RAO art 85(1)(b), given real fees in, real payouts out, and
   quantum fixed by real market prices? *(specialist FS regulatory counsel)*
2. If not, does the paid Traditional Challenge constitute betting under GA 2005 s9/s11, given that
   s10 is unavailable to an unauthorised firm and s11(2) defeats the skill answer?
   *(specialist gambling counsel — a different specialism from 1)*
3. Would the employer-assessment licence model, as scoped in §5, fall outside EAA 1973 s13(2)?
   *(employment counsel)*
4. Which current marketing statements are financial promotions under FSMA s21 — contingent on 1.

Questions 1 and 2 are the ones worth the money. If the £3,000 ceiling forces a choice, buy those two
and defer everything else.
