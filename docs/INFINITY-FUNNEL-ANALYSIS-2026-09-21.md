# Infinity v3 funnel analysis — 21 September 2026

Decision support for the 1 October launch. Extends `docs/INFINITY-LAUNCH-MODEL-2026-09-20.md`,
which modelled Stages 1–2 only and did not price the payout, the population mix, or retries.

Scripts (all deterministic, seeded):

- `scripts/infinity-funnel-model.mjs` — full funnel to first cash, over a population with a
  distribution of skill, with retries.
- `scripts/infinity-rule-sensitivity.mjs` — ablation (which rule actually filters), style bias,
  cost and pacing sensitivity.
- `scripts/infinity-profitable-day-gaming.mjs` — what behaviour the profitable-day rule rewards.

## Headline

At the central cost assumption (0.10R per session), out of 60,000 simulated entrants:

| Step | Result |
|---|---:|
| Stage 1 pass, per attempt | 4.3% |
| Stage 1 pass, per trader (retries) | 9.1% |
| Stage 2 pass given Stage 1 | **1.9%** |
| Stage 2 pass, share of entrants | 0.17% |
| Reach the Stage 3 release milestone | 0.10% (1 in ~950) |
| Complete Stage 3 | ~0.01% (1 in ~10,000) |

At a more forgiving 0.05R cost the numbers roughly double (S1 19.4% per trader, milestone 0.24%),
but **Stage 2 given Stage 1 stays at 1.6%**. Stage 2 is the wall, and it is not the profit target.

For comparison: FPFX Tech's 300,000-account dataset gives 14% funded and 7% paid; Topstep's
official 2025 disclosure gives 16.8% per combine, 51.8% per trader, and 33.3% of funded paid.
Infinity as configured is roughly two orders of magnitude harsher than the industry.

## The filter works, in the sense that matters

Composition of each cohort, and the posterior we actually care about:

| Cohort | no edge | marginal | genuine edge | strong edge |
|---|---:|---:|---:|---:|
| entrants | 94.8% | 4.3% | 0.9% | 0.01% |
| passed Stage 1 | 71.4% | 21.1% | 7.5% | 0.06% |
| passed Stage 2 | 33.7% | 31.7% | 33.7% | 1.0% |
| first payout | 23.8% | 27.0% | 47.6% | 1.6% |

P(real edge | entrant) = 0.95% → P(real edge | first payout) = **49%**. A 52× lift. The filter has
excellent precision. It has almost no recall: it also rejects ~95% of the genuinely good traders.

## Three defects found

### 1. One rule is doing all the filtering, and it is the wrong one

Ablation, single attempt, cost 0.10R, p = 0.55:

| Rule removed | Stage 2 pass |
|---|---:|
| none (as published) | 11.9% |
| **profitable-day rule** | **82.4%** |
| best-day rule | 11.8% |
| session minimum | 11.9% |
| observation period | 12.5% |
| daily profit cap | 11.6% |

The best-day concentration rule, exposure sessions and observation period — the parts described as
the skill filter — are very nearly free. They filter almost nobody. The entire selection effect is
the profitable-day requirement.

### 2. The profitable-day rule measures pacing, not skill

`account_progress` counts a day as profitable when that day's closed P&L exceeds **0.25% of the
starting balance**. Stage 2 risk is 0.35% and a win is 1.2R = 0.42%. So a day needs net > 0.71R,
and the number of wins required is a step function of how many trades were taken that day.

Chance a day closes above the threshold (Stage 2 sizing):

| sessions/day | p=0.45 | p=0.50 | p=0.55 | p=0.60 |
|---:|---:|---:|---:|---:|
| 1 | 45.6% | 50.1% | 54.8% | 59.8% |
| 2 | 20.6% | 25.0% | 30.4% | 35.5% |
| 3 | 43.4% | 50.8% | 57.8% | 64.9% |
| 4 | 24.7% | 30.5% | 38.8% | 47.5% |
| 5 | 41.3% | 50.2% | 59.6% | 68.2% |
| 6 | 26.4% | 34.6% | 44.6% | 54.7% |

A trader with a 60% win rate at 1.2R — an outstanding edge — **cannot reach 55% profitable days**
if they take 2, 4 or 6 trades a day. The requirement is mathematically unreachable for them, at any
skill level, because of an interaction between the threshold and the risk cap. The same trader
taking 3 or 5 trades a day passes comfortably.

Holding expectancy constant at +0.10R and varying how it is earned gives Stage 2 pass rates of
39.5% (1:1 at 60%), 2.2% (1.5R at 48%), 37.2% (2R at 40%) and 7.6% (3R at 30%). Same edge,
wildly different outcomes.

### 3. It rewards chasing a losing day

Two behaviours, same skill, Stage 2:

| Skill | Behaviour | Pass | Avg days |
|---|---|---:|---:|
| p=0.55 | disciplined (3 trades, accept red days) | 60.8% | 122 |
| p=0.55 | chaser (keep trading until the day is green) | **86.1%** | 72 |
| p=0.50 | disciplined | 15.8% | 216 |
| p=0.50 | chaser | 22.1% | 204 |

The rule pays traders to refuse to accept a small losing day. That is the exact habit that destroys
funded accounts, and we would be selecting for it.

## The payout plumbing does not connect

Independently of the odds:

- Infinity Stage 2 and Stage 3 accounts are provisioned with `phase = 'evaluation'`.
  `fn_request_payout` rejects anything that is not `phase = 'funded'`. There is no code path by
  which the Stage 2 profit share or the 3% milestone pays cash.
- The Stage 2 share is 85% × 6% × $5,000 = **$255**. Completing Stage 3 adds 85% × 7% × $10,000 =
  $595. Total **$850** — below the **$1,000** minimum payout set on 19 September.
- The first withdrawable cash therefore requires a Stage 4 account and ~4.7% on $25,000.
- The public page says the milestone is 3%; the launch model says 5%; the engine implements neither.

## Cost drag is a launch risk at $1,000

Stage 1 risks 0.5% = $5 a trade. On a 10-pip stop that is 0.05 lots, and the engine's synthesised
EURUSD spread of 0.0002 costs $1.00 round turn — **0.20R**. At 0.20R, a p=0.55 trader passes Stage 1
22.5% of the time instead of 81%. At 0.30R nobody passes at all.

| cost/session | S1 coin-flip | S1 p=.50 | S1 p=.55 |
|---:|---:|---:|---:|
| 0.00R | 20.0% | 74.7% | 99.9% |
| 0.05R | 7.3% | 42.0% | 97.5% |
| 0.10R | 2.0% | 19.3% | 81.5% |
| 0.20R | 0.2% | 2.5% | 22.5% |
| 0.30R | 0.0% | 0.2% | 3.0% |

Tight-stop styles are close to unwinnable at this account size. That is a pricing decision, not a
skill filter.

## Recommendations

1. **Replace the profitable-day rule.** It is the only rule doing work, and it selects for pacing
   and loss-chasing. A rolling-window expectancy or t-statistic on per-session returns measures the
   same thing without the threshold artefact and without a style preference.
2. If it is kept, set the threshold as a multiple of the account's own risk unit (e.g. > 0.5R)
   rather than a fixed 0.25% of balance, and state the required win rate honestly.
3. **Decide the milestone once** — 3% or 5% — and make the page, the Terms and the engine agree.
4. **Connect the payout path** before launch, or say plainly on the page that Infinity pays cash
   only from Stage 4. Today a trader can do everything right and have no way to withdraw.
5. **Re-check the $1,000 minimum against Infinity.** Either lower it for Infinity accounts or
   raise Stage 2/3 balances so a completed run clears it.
6. **Measure cost drag** on the real feed before launch and quote it in the Terms.

## Model limitations

Fixed 1.2R payoff, independent sessions, a static per-trader win probability, no adaptation, no
serial correlation, no fat tails, and a skill prior calibrated to published retail studies rather
than to IPFX's own customers. Useful for comparing rule sets; not a forecast of customer results.
Re-run with IPFX data once Stage 1 has a few hundred completed accounts.
