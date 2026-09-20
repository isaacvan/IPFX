# Infinity-only launch decision — 20 September 2026

## Decision

- Infinity opens to public applications at 00:00 Europe/London on 1 October 2026.
- Traditional, Futures and PAC remain paused. Their information pages may remain visible, but public applications and checkout are unavailable.
- Existing accounts keep the rules stored on those accounts. The revised rules apply only to accounts provisioned under the published Infinity v3 contract.
- Stage 1 remains simulated. It is not evidence strong enough for automatic live mirroring.

## Published Infinity v3 rules

| Rule | Stage 1 | Stage 2 | Stage 3 | Stage 4 |
|---|---:|---:|---:|---:|
| Starting balance | $1,000 | $5,000 | $10,000 | from $25,000 |
| Profit target | 8% | 6% | 7% | none |
| Trailing drawdown | 5% intraday | 4% intraday | 4% intraday | 4% EOD |
| Daily loss | 2.5% | 2% | 2% | 2% |
| Base risk per trade | 0.50% | 0.35% | 0.35% | 0.25% |
| Daily profit cap | 1.50% | 1.25% | 1.25% | none |
| Minimum trading days | 10 | 15 | 10 | none |
| Independent exposure sessions | 30 | 60 | 40 | none |
| Minimum elapsed calendar days | 14 | 21 | 14 | none |
| Profitable-day requirement | none | 55% | 50% | none |
| Maximum best-day share of positive profit | 35% | 25% | 30% | payout rules |

An exposure session combines overlapping positions and positions opened within 60 minutes of returning flat. Splitting one idea into many tickets therefore does not create independent evidence.

## Quantitative rationale

`scripts/infinity-rule-model.mjs` is a deterministic Monte Carlo decision-support model. It uses four sessions per trading day, a 1.2R win, a 1R loss, intraday trailing drawdown, daily limits, minimum observations and the best-day rule.

With 100,000 simulated paths per cohort:

| Cohort assumption | Stage 1 pass | Stage 2 pass conditional on Stage 1 | Both stages |
|---|---:|---:|---:|
| Zero expectancy (45.45% win probability at 1.2R/1R) | 20.52% | 22.12% | 4.54% |
| Modest edge (50% win probability) | 56.94% | 64.05% | 36.47% |
| Strong edge (55% win probability) | 87.30% | 91.73% | 80.08% |

This does **not** prove that a particular trader has an edge. Real trades are serially correlated, transaction costs vary, traders adapt after losses, and win/loss sizes are not constant. The estimates are useful for comparing rule sets, not forecasting exact customer pass rates.

## Why these filters

- A profit target alone selects lucky paths. Requiring separate sessions, trading days and elapsed time adds observations.
- An intraday trailing drawdown and small fixed risk limit penalise gambling without requiring an unrealistic time limit.
- A best-day concentration limit rejects one-event luck while remaining transparent.
- Stage 2 is the main persistence test: 60 independent sessions, 15 trading days, a 55% profitable-day requirement and a 25% best-day cap.
- The first Stage 2 profit-share release should not occur before 5% closed profit in Stage 3 and completion of Stage 3's observation gates. This provides more evidence and more time to reserve the liability, but it does not itself create cash.

## Treasury and regulatory guardrails

The free-entry model cannot safely assume that simulated losses or future mirroring profits will fund payouts. Before accepting a real payout liability, IPFX needs a segregated operating reserve sized from stress losses, execution costs and concurrent eligible traders. Live copying must remain off until legal advice confirms the regulatory perimeter and the firm has an approved broker, capital allocation, kill switches and independent reconciliation.

The FCA says principal trading firms may require permissions depending on their activities, and it treats no-intervention copy trading as portfolio or investment management. Therefore Stage 1 is shadow analysis only; passing Stage 1 never enables live copying automatically.

## External evidence used

- Topstep's 2025 disclosure reports that 16.8% of initiated combines completed and 33.3% of funded participants received a payout: https://www.topstep.com/risk-disclosure
- FTMO's published objectives use equity-aware loss limits, minimum trading days and a best-day rule: https://ftmo.com/en/trading-objectives/
- Research on 888 trading algorithms found ordinary backtest statistics had very low out-of-sample predictive value, supporting prospective observation rather than a one-off result: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2745220
- FCA principal-trading perimeter guidance: https://www.fca.org.uk/firms/authorisation/wholesale-markets/principal-trading
- FCA copy-trading guidance: https://www.fca.org.uk/firms/copy-trading

