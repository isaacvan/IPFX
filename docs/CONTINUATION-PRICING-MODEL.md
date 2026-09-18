# Challenge continuation pricing — v1

## Decision

The continuation offer is a convenience product: it creates a clean attempt at
the same evaluation stage. It never restores a breached account, reopens a
position, changes a breach, or advances a stage.

The price is calculated once by the server for each breached account and stored
as an immutable offer. The browser cannot submit or override the amount.

## Infinity formula

Stage bases and caps (GBP):

| Stage | Base | Cap |
|---|---:|---:|
| 1 | £9.99 | £19.99 |
| 2 | £16.99 | £34.99 |
| 3 | £24.99 | £49.99 |

Funded Stage 4 is not eligible because it is not an evaluation.

Let `p` be the highest verified progress towards the stage target, clamped to
0–1. Let `n` be this trader's continuation failure number, starting at 1.

`raw = base × (1 + 0.35 × p²) × (1 + 0.20 × (n - 1))`

The displayed price is rounded up to a `.99` ending and cannot exceed the stage
cap. The squared progress term keeps early-stage offers approachable while
charging more when continuing preserves more completed work. The repeat factor
makes every later failure more expensive. A trader's identity, age, address,
nationality, payment method and device are never pricing inputs.

Examples before the cap:

| Stage | Progress | Failure # | Offer |
|---|---:|---:|---:|
| 1 | 0% | 1 | £9.99 |
| 1 | 50% | 1 | £10.99 |
| 1 | 90% | 1 | £12.99 |
| 2 | 90% | 2 | £26.99 |
| 3 | 90% | 3 | £44.99 |

Traditional and Futures use 35% of the original phase-one fee as the base,
with a £12.99 floor and a 70% original-fee cap. The same progress and repeat
factors apply. PAC uses a £39.99 base and £79.99 cap until an owner-approved PAC
fee schedule exists.

## Why this is a launch hypothesis, not a claimed optimum

There is no production conversion, failure, refund, support-cost or downstream
payout dataset in this repository. Therefore no statistically defensible
profit-maximising price can be estimated yet. This v1 model is bounded,
transparent and auditable; it intentionally avoids pretending that simulated
elasticity is observed customer behaviour.

After launch, evaluate cohorts by challenge, stage, progress band and failure
number. Measure offer views, checkout starts, paid conversions, refunds,
subsequent pass rates, first-payout rates and support cost. Do not optimise on
short-term continuation revenue alone. Require enough observations per cohort,
pre-register price tests, and retain the hard caps and protected-attribute ban.

## Abuse and consumer safeguards

- One offer per breached account and one continuation order per source account.
- Amount, inputs, formula version and timestamp are stored for audit.
- A paid continuation starts clean at the same stage; it cannot erase history.
- The exact amount is shown before payment and repeated in the consent text.
- Live payments remain disabled until underwriting, tax, consumer-terms and
  fulfilment controls are signed off.
