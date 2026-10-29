# Infinity v2: challenge rules (launch 1 November 2026)

**Status:** final draft for owner sign-off.

**Who is on which version:**
- **Every new run and every restart from 1 November 2026, 00:00 UTC, is on Infinity v2.**
- **Runs started before then stay on Infinity v1, unchanged,** until they breach or restart.
- **A v1 trader can switch their current run to v2 at any time.** Switching is one-way. Balance, drawdown floors and held Stage 2 profit carry over. The v2 requirements for the current stage count from the moment of switching.

---

## 1. Key terms

- **Counted trade:** one trade, or several trades on the same instrument and direction opened while one is still open or within 15 minutes of the last. Adding to a position counts as **one** trade, not several.
- **R (result):** a counted trade's profit or loss divided by the risk at its **opening** stop. For example, risk $5 and make $10 = +2R. Results are capped at +5R / −5R for the consistency score only; your balance always shows the full amount.
- **Consistency score:** how clearly your wins outweigh your losses across your counted trades, shown live on your dashboard. Formula: average R ÷ (spread of R ÷ √number of counted trades), with the spread treated as at least 0.5R. The more steady positive counted trades you have, the higher it goes. A few lucky trades won't push it far.

---

## 2. The stages

| | Stage 1 | Stage 2 | Stage 3 | Stage 4 (Professional) |
|---|---|---|---|---|
| Account | $1,000 | $5,000 | $10,000 | $25,000 |
| Profit target | 4% | 7% | 8% | none |
| Minimum counted trades | 20 | 40 new | 50 new | none |
| Consistency score to pass | **0.75** | **1.25** in Stage 2, and **1.65** over Stages 1–2 | **2.0** over Stages 1–3 | none |
| Best day | ≤ 35% of total profit | ≤ 35% | ≤ 30% | payout filters as today |
| Max risk per counted trade | 0.5% | 0.35% | 0.35% | 0.25% |
| Total open risk | 3 × the per-trade limit | 3 × | 3 × | 3 × |
| Daily loss limit | 2.5% | 2% | 2% | 2% |
| Max drawdown (trailing on closed balance) | 5% | 4% | 4% | 4% |
| Performance rule | — | — | — | Account ends if it loses 2% or more over any 40 consecutive counted trades |

**Passing a stage:**
- **All the requirements must be met at the same time, with no open trades.** You then move to the next stage automatically.
- **No minimum trading days, sessions or waiting period.** You pass as soon as your results show it.

**Ending a run:**
- **Breaches:** hitting the daily loss limit, the max drawdown, three stop-loss strikes, or the Stage 4 performance rule.
- **After a breach:** you can restart Stage 1 at the next monthly restart (one Stage 1 attempt a month).

---

## 3. Trading rules (all stages)

**Stops and holding:**
1. **Stop loss on every trade,** set when you open it or within 30 seconds. A trade still without one is closed and counts as a strike; three strikes end the run.
2. **Minimum stop distance: 8 × the current spread** for that instrument. The order ticket shows the minimum and won't accept a tighter stop.
3. **Stops can be tightened or moved to break-even or into profit, but never moved further away.**
4. **Minimum hold: 5 minutes.** Profit from a trade closed in under 5 minutes doesn't count toward your target or payout. Losses always count.
5. **Overnight and weekend holding allowed.** Markets can gap, and a gap can fill beyond your stop.

**Pauses and limits:**
6. **Pause after a stop-out:** when a stop loss is hit, new trades on that instrument are paused for 10 minutes.
7. **Risk per counted trade is measured from entry to your opening stop.** All trades that make up one counted trade share its risk limit. When your remaining daily or drawdown room is small, the limit tightens to protect the account.
8. **Daily loss is measured from your start-of-day closed balance,** resetting at 00:00 UTC. Open profit carried overnight doesn't count against you if the trade pulls back.
9. **No daily profit cap.** Open trades are never force-closed for making money.

**Positions and accounts:**
10. **Limits:** at most 20 open positions and 20 pending orders, and 5 new orders per 10 seconds.
11. **One account per person.** Linked accounts, opposite-side trading between accounts and identical trades across people are reviewed before any pass or payout.

---

## 4. Pricing and execution (same for everyone)

- **Spreads:** live market prices with spreads set close to our institutional reference feed, tighter than today on FX.
- **Commission:** **$[X] per lot round turn** (owner to confirm; set to match the copy venue).
- **Order fills:** market orders fill after a 0.3–0.9 second delay at the market price, plus normal slippage.
- **Stop fills:** stops fill at the market price when triggered, including any gap.

---

## 5. Payouts

**Unchanged from today:**
- **Stage 2 profit** is held.
- **After Stage 3:** 85% of (Stage 2 + Stage 3) closed profit, minimum $500, maximum $700. Requires identity verification and a payout method.
- **Stage 4:** 85% profit split, payable every 14 days, with the current payout filters.
- **Profit that doesn't count:** profit from trades under 5 minutes is excluded.

---

## 6. Terms that also apply

- **Simulated accounts:** all accounts are simulated.
- **Copying and hedging:** IPFX may copy or hedge trading activity for its own risk management. This doesn't change your account, rules or payouts.
- **Equal treatment:** rules and pricing are the same for every trader.
- **Corrections:** IPFX may correct pricing or scoring errors and will show any change on your dashboard.

---

## Owner notes (not for traders): why each rule exists, from the data

Evidence: 2,004 trades from 241 traders, 11–23 Oct, each scored against its opening stop and copied at recorded E8 prices (`historical/rules_test.py`).

| Rule | Evidence |
|---|---|
| Consistency score plus counted trades | Past profit alone predicted nothing (+0.05). Stacking counted as separate trades let 45% of no-edge players pass in simulation |
| Minimum stop 8 × spread | Stops under 4 spreads: −0.66R copied, almost all of it cost |
| 5-minute hold | Under 1 min: −0.83R; 1–5 min: −0.50R, losing on direction too |
| No widening stops | Widened-stop trades did no better (−0.32R), and widening hides true risk |
| 10-minute pause after a stop-out | Trades within 15 minutes of a loss: −0.46R, against −0.17R otherwise |
| No profit-cap close | Cap closures averaged +1.75R: it was cutting winners |
| Daily loss from closed balance | Stops overnight winners breaching on a normal pullback |
| Pricing near E8 | Copies beat trader results by +0.28R today. Spreads 2.4–3.6× E8's on FX fail good traders. A small margin keeps copy ≥ trader |
| Stage 4 performance rule | Mirrors the internal copy stop (−8R over 40 counted trades at 0.25% risk) |

**Must be built and tested before the email goes out.** The engine has to enforce every rule above:
- counted-trade grouping;
- the consistency score;
- minimum stop as a multiple of the spread;
- blocking stop widening, including the total-risk recheck;
- the 5-minute hold;
- the 10-minute pause after a stop-out;
- daily loss from closed balance;
- removing the profit-cap close;
- the new spreads and commission;
- the Stage 4 performance rule;
- the opt-in at restart.

If any of these isn't live by 31 Oct, **delay the launch to 1 Dec rather than promise rules the platform doesn't enforce.**

**Gold at Stage 1:** with a $5 risk cap and 0.01-lot minimum, an 8-spread gold stop (about $3.30) leaves only a $3.30–$5.00 range. Allow smaller gold lots or a higher gold risk cap, or gold will feel blocked at Stage 1.

**Commission:** fill in $[X] before sending.
