# Strategy engine

Tests trading strategies two ways. First, is the edge real, or luck and overfitting? Second, can the strategy pass IPFX's challenges under the exact live rules? Plain Node 20+, no dependencies.

| File | What it does |
|---|---|
| `rules.mjs` | Live challenge presets, Infinity v3 qualification gates, engine constants and IPFX spreads. `tests/strategy-engine.test.mjs` fails if they drift from the migrations or the engine. |
| `challenge-sim.mjs` | Replays trades through a stage the way `trading-engine` and the SQL judge it. It covers effective-risk sizing, the 3× open-risk cap, the daily profit cap, static/trailing drawdown on intraday equity, the daily loss floor, the 60-second rule, profitable days, meaningful days, exposure sessions, the observation period and best-day share. It gives pass rates over rolling start dates and the full Infinity S1→S3 path. |
| `backtest.mjs` | Decides on the bar close and fills on the next open. Buys at the ask and sells at the bid. Gaps through stops fill at the open, and the stop is assumed hit first when a bar touches both. Results come back in R with open-trade excursions. |
| `library.mjs` | Strategy families built on the IPFX chart's own indicators, each with its reason for working written down before testing. |
| `stats.mjs` | PSR, Deflated Sharpe, MinTRL/MinBTL, PBO (CSCV), CPCV, White's Reality Check / Romano-Wolf StepM, stationary bootstrap. |
| `research.mjs` | The pipeline and its acceptance gates (see `GATES`), plus challenge pass rates at 0.5×, 0.75× and 1× of the allowed risk. |
| `registry.mjs` | Logs every configuration ever tried, so the Deflated Sharpe is charged for all of them. |

Results, the trial registry and downloaded data go to `.data/`, which git ignores. This repository is public, so never commit them.

## Running

A verdict needs 10+ years of intraday history. The chart feed has at most 2,000 bars, which is only enough for a smoke test.

```bash
npx dukascopy-node -i eurusd -from 2010-01-01 -to 2026-09-01 -t h1 -f csv
node research/strategy-engine/run.mjs --csv download/eurusd-h1-bid-2010-01-01-2026-09-01.csv --symbol EURUSD --tf 60
node research/strategy-engine/run.mjs --trades trades.json    # challenge odds for any trade list
```

A trade list is JSON: `[{ entryTime, exitTime, r, maeR, mfeR, peakBeforeTroughR }]`. Times are unix seconds. `r` is net R. `maeR` is the worst open loss in R, and `peakBeforeTroughR` is the best open profit before that loss.
