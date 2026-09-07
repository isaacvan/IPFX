# IPFX Capital — Legal Hardening Research Memo

**Date:** 2026-09-07 (overnight session, ~3 hours autonomous)
**Author:** Claude, following a direct request to "make this all legally sound and clean" and "fact check with rules and regulations." This is real, sourced research — not model recall — done via live web search against current UK regulatory guidance and primary sources (the FCA's own site, legislation.gov.uk).

**This is legal research and draft documentation. It is not legal advice and is not a substitute for instructed UK legal counsel.** Everywhere this memo says something is "likely" or "probably" a problem, that is a research judgment, not a legal conclusion — several of the questions below (particularly §2) turn on facts (exact wording of your future features, actual marketing copy across every channel, your AML process in practice) that only a solicitor reviewing the live business can resolve with certainty. Treat this as the prep work that makes an actual solicitor engagement fast and cheap, not a replacement for one.

---

## 0. What prompted this

Earlier tonight you asked me to build a "trade syncer" that would copy trades from IPFX Markets onto a real account at HeroFX (via TradeLocker), and then to "make T&C and adjustments to allow this." While researching how to make that legally sound, I found that **the mechanism it would need already exists, live, in your own Terms of Service** — Section 11 ("Trading Replication Rights") granted IPFX an irrevocable right to copy any participant's trades onto real accounts at other proprietary trading firms, without telling the participant which firms, without paying them, and explicitly without disclosing to the destination firm that the activity was copied. That section directly contradicted your own Section 8.3, which absolutely prohibits copy trading "including where you are the signal provider."

That changed the shape of tonight's task. This isn't just "should I build a new feature carefully" — it's "there is live legal exposure on the site right now, for a business with 90 real registered users." I fixed the acute part (below) and spent the rest of the time on the research you asked for.

---

## 1. What I changed tonight (already live once pushed)

| File | Change | Why |
|---|---|---|
| `terms.html` §11 | Replaced the real-money trade-replication grant (old §11.3–§11.6) with a narrower clause: IPFX may use trading data only for platform operation, evaluation scoring, and **aggregated/anonymised** risk-model calibration — never to place real trades derived from an identifiable participant's activity, on any account, anywhere, without a separate opt-in arrangement with its own terms and compensation. | See §2 below — the old clause described conduct that is very likely both an unauthorised regulated activity and, independently, an unfair/void consumer contract term. It also contradicted your own §8.3. |
| `infinity.html`, `infinity-new.html` | Removed "risk-free" and "we don't make money here" marketing claims. | Financial promotions risk under FSMA s21 — see §3. |
| `start-challenge.html` | Added a required checkbox at checkout: *"I want my Challenge to start immediately... I understand I lose my 14-day right to a full refund"* — validated in JS, and the confirmation + timestamp is now stored with the signup record. | Your Terms already claimed this waiver (§6.1) but nothing in the actual checkout flow captured the consumer's explicit consent to it — see §5. Without a captured, timestamped, specific consent, that clause was assertion without evidence. |

Nothing else was changed. I did not touch pricing, challenge rules, payout logic, or anything unrelated to what's below.

---

## 2. The decisive finding: why the Trade Syncer / trade-replication idea can't be fixed by T&C drafting

This is worth being precise about, because it's the one place tonight's research produces a genuinely hard "no," not just "be careful."

**The FCA's own published position on copy trading** ([fca.org.uk/firms/copy-trading](https://www.fca.org.uk/firms/copy-trading)):

> This service falls within Article 4(1)(9) of MiFID... "managing portfolios in accordance with mandates given by clients on a discretionary client-by-client basis where such portfolios include one or more financial instruments."

The FCA draws the line on **automatic vs. manual execution**:
- If a system automatically executes trades derived from someone else's signal, with no per-trade manual confirmation by the account holder, that **is** portfolio management and **requires FCA authorisation**.
- If the account holder must confirm or place each trade themselves, it generally is not.

A trade syncer that copies trades "within milliseconds" is, by design, automatic execution with no manual step. Operating that — copying one source's trading activity onto other people's or other accounts' capital, at scale, as a service — without FCA authorisation is not a grey area or a contract-drafting problem. It's the **regulated activity of portfolio management**, and carrying on a regulated activity in the UK without authorisation is a criminal offence under s19 FSMA (the "general prohibition"), independent of anything any T&C says. You cannot contract your way out of a statutory authorisation requirement — a participant's "consent" in a Terms document has no bearing on whether the *operator* needs FCA permission to run the copying engine in the first place.

This is layered on top of, not instead of, the concern I raised earlier tonight about copying into a **third-party firm's account** (HeroFX) without their written permission — report §12.1 in your own commissioned risk report already flagged that as a Phase 5/6 gate requiring formal provider sign-off. The portfolio-management finding above means even copying only into **IPFX's own accounts**, at scale, for multiple participants, has a separate and independent regulatory bar.

**What would actually change this analysis:**
- A version where the destination account holder manually confirms every single trade before it executes — this plausibly falls outside portfolio management, though probably lands on "investment advice" or "arranging deals" instead, which have their own (lighter, but real) authorisation questions.
- IPFX becoming FCA-authorised for portfolio management — a real, legitimate path many firms take, but a multi-month process with capital and compliance-infrastructure requirements, not something achievable via a T&C rewrite.
- Confining it entirely to genuinely personal use (you, personally, moving your own capital based on your own trading, with no other participant's data involved and no service offered to anyone else) — this is a materially different, lower-risk activity, but it's also not what was described tonight ("connect any tradesyncer we design," "replicated on other prop firms").

I'd treat this as closed until you've had an actual conversation with a UK financial-services solicitor who can look at the specific mechanism you have in mind and tell you which side of the authorisation line it falls on.

---

## 3. Financial promotions (FSMA s21) — your most immediate, cheapest-to-fix exposure

This applies **regardless of whether IPFX itself needs FCA authorisation** — it's a separate rule about marketing.

> Any financial promotion must be issued or approved by an FCA-authorised firm... The FCA has aggressively enforced this rule. Between 2023–2025, regulators removed or amended thousands of financial promotions, including a significant number targeting retail traders. Violations carry unlimited fines and potential criminal liability.
> — [iDenfy, FCA Regulation and Prop Trading Firms in 2026](https://idenfy.com/blog/fca-regulation-prop-trading-firms/)

The FCA's 2026/27 work programme explicitly names prop trading and financial-influencer marketing as an enforcement priority.

**What I fixed tonight:** "risk-free," "we don't make money here" (two live instances).

**What I did not audit and you should, soon:**
- Every claim on `index.html`, `about.html`, `personalised-challenge.html`, `futures.html` about payout size, "profit potential," or implied returns. I spot-checked with a keyword search (guarantee/risk-free/passive income/etc.) across all `.html` files — that catches obvious phrasing, not implication or context.
- Your YouTube, TikTok, Instagram, Discord, X channels (linked from every page footer). I have no way to review video/social content — if marketing claims there are more aggressive than the website copy (common pattern), that's a real, live exposure I simply couldn't check tonight.
- The "Projections are hypothetical..." disclaimer already present near `index.html:4352` is good practice — keep that pattern and make sure every numeric profit example anywhere on the site sits near an equivalent disclaimer, not just the one page I found it on.

---

## 4. Gambling Act 2005 — genuine grey area, not a solved problem, but you have real tools

I couldn't find UK Gambling Commission guidance specific to prop-trading challenges (a general search returned nothing on point — this looks like an area the Commission hasn't spoken on directly yet, which is itself informative: it means there's no safe-harbour precedent to rely on, but also no adverse ruling to worry about). What I did find is a live, active debate:

> Italy's financial regulator Consob warned that some retail prop trading firms "simulate an online trading activity in a type of finance video game aimed at passing skill tests and making a profit."
> — [DailyForex, Prop Firm Regulations & Rules 2026](https://www.dailyforex.com/forex-articles/prop-firm-regulations/226504)

The core legal question under the Gambling Act 2005 is whether outcomes are determined predominantly by **skill** (not gambling) or **chance** (potentially gambling, requiring a Gambling Commission licence). This is exactly why your existing "consistency rules" (minimum trading days, minimum profitable-day percentage, drawdown discipline — already built into your trading-engine's pass-gate logic) matter legally, not just as anti-abuse mechanisms: they're your evidentiary basis that outcomes reward sustained skill, not a single lucky session. **Keep them, and make sure marketing never undercuts this positioning** — avoid any language that frames the challenge as luck-based, a "bet," or "try your chances." I found none of that in the spot-check, which is good.

The trade-replication clause I removed tonight also cut *against* this positioning, incidentally — if IPFX itself is copy-trading off participants, it's harder to argue the whole product is purely "an evaluation of your personal skill."

---

## 5. Consumer Contracts Regulations 2013 — cancellation right

> Consumers have the right to cancel a service contract within 14 days... with no obligation to provide a reason... If you want to receive the service within 14 days, you will have to give your express consent and acknowledge you'll lose the cooling-off right.
> — [Which?, Consumer Contracts Regulations](https://www.which.co.uk/consumer-rights/regulation/consumer-contracts-regulations-ajWHC8m21cAk); [LegalVision UK, Cancellation Rights](https://legalvision.co.uk/commercial-contracts/cancellation-rights-service-provider/)

Your Terms (§6.1) already *claimed* this waiver, but nothing in the checkout flow captured a consumer's specific, informed consent to it — a blanket "I agree to the Terms" checkbox almost certainly isn't enough on its own for this particular waiver, since CCR 2013 treats it as a distinct consent, not something that rides along with general acceptance of a long document. Fixed tonight (§1 above) with a dedicated checkbox and a stored, timestamped confirmation.

**Still worth checking:** does the same "activation" moment (first trade) exist consistently across every challenge type/entry point on the site, or are there other purchase flows (e.g. `personalised-challenge.html`, any admin-created accounts) that bypass `start-challenge.html` entirely? If so, they need the same checkbox.

---

## 6. Anti-Money Laundering (Money Laundering Regulations 2017)

> Firms conducting payment services or currency exchange could fall within scope despite lacking investment authorisation. Mandatory obligations include: identity verification before establishing client relationships, enhanced due diligence for higher-risk clients, transaction monitoring and suspicious activity reporting, Money Laundering Reporting Officer appointment.
> — [iDenfy, FCA Regulation and Prop Trading Firms in 2026](https://idenfy.com/blog/fca-regulation-prop-trading-firms/)

Your Terms §13 already has KYC/AML language, and `phase-0-data-inventory.md` (from earlier sessions) already flagged that KYC is currently "status-flag-only" — i.e., the legal text exists but the actual verification process behind it is thin. That gap is exactly what an AML regulator would look at first. Concretely, before payouts scale up:
- Confirm someone is formally designated as your Money Laundering Reporting Officer (MLRO), even if that's you personally for now — it should be a named, documented role, not implicit.
- Confirm there's an actual process for what happens when `trader_kyc.status` needs to move from `unverified` to `verified` (document collection, checks performed, who reviews) — not just a UI toggle.
- Consider at what payout threshold enhanced due diligence kicks in, and write that threshold down.

---

## 7. UK GDPR — the old §11 also had a consent problem, independent of the FCA issue

Not fully researched tonight (ran out of time), but worth flagging: UK GDPR consent must be "freely given, specific, informed, and unambiguous," and is explicitly **not** freely given where accepting an unrelated purpose is bundled as a condition of using the core service ("take it or leave it"). The old §11 language — accept this irrevocable data-use grant or you may not use the Challenge platform at all — is a textbook example of the bundling problem regulators have fined companies over. The rewritten §11 ties data use to purposes that are actually necessary for operating the platform (fraud detection, scoring, aggregated risk calibration), which sits on much firmer footing (likely "legitimate interests" rather than needing to lean on fragile bundled consent at all). Worth having a solicitor confirm this once other items are resolved.

---

## 8. Explicitly out of scope tonight, and why

- **Full read of every page's marketing copy.** I spot-checked with keyword searches; I did not read every word of every page. Recommend a full pass, ideally by someone reviewing against the actual current ASA CAP Code sections on financial promotions.
- **Social/video content review.** Not fetchable by me; needs a human to actually watch/read the YouTube, TikTok, Instagram, Discord, X content.
- **The "Trading Pot" feature.** Currently a harmless "Coming Soon" placeholder (`trading-pot.html`) — but the *commented-out* marketing copy still sitting in `index.html` describes exactly the peer-to-peer copy-trading/follower model this memo raises concerns about (§2), and directly contradicts your own §8.3 ban on copy trading. If this is ever built as that commented-out copy describes, it needs the same FCA authorisation analysis as the Trade Syncer, from scratch, before launch — not as an afterthought once it's built.
- **Company-structure/tax questions** (entity type, where IPFX Capital Ltd is incorporated, VAT registration threshold) — outside what I can usefully research without knowing facts about the company that aren't in this codebase.
- **Any actual filing, registration, or authorisation application** — obviously requires you and likely counsel, not something I can do.

---

## 9. Suggested next steps, roughly in priority order

1. Read this memo and the corrected `terms.html` §11 — confirm you're comfortable with the narrower data-use clause before treating it as final (I'm confident it's *much* safer than what was live, less confident it's perfectly worded — a solicitor pass would help).
2. Get an actual UK financial-services/FSMA-perimeter solicitor to review, specifically: (a) whether the current evaluation-challenge model as a whole needs FCA authorisation or falls in the currently-common "unregulated evaluation" category, (b) the Trade Syncer / any future Trading Pot feature, before either is built further.
3. Full financial-promotions audit of every marketing surface, website and social.
4. Formalise the AML/KYC process behind the existing legal text (§6 above).
5. Spot-check that the new cancellation-consent checkbox is the *only* path to activating a challenge — audit other entry points.
