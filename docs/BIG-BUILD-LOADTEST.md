# Big Build load test (24 October 2026)

Run on a laptop that was also generating the load (so these numbers are pessimistic for a dedicated server), against a local copy of the hub
(`hub/server.mjs`). Scripts: `hub/loadtest.mjs` (traders + prices) and `hub/loadtest-candles.mjs` (chart requests). Needs `LOADTEST_KEY` and
`HUB_SECRET` on the test hub only; `MAX_PER_IP` and `CANDLE_RATE_PER_MIN` raised for a single-machine test.

**5,000 connected traders** (about 11x the 450 live Infinity accounts), each watching 11 of 30 symbols, with all 30 symbols changing every 250ms for 30 seconds,
**and 50 chart requests a second** for 25 seconds at the same time:

| Measure | Result |
|---|---|
| Traders connected / failed | 5,000 / 0 |
| Prices delivered | 195,006 a second (19,503 frames a second) |
| Price delay, hub receive to trader | p50 146 ms, p95 319 ms, p99 422 ms, max 483 ms |
| Price batches in | 117 sent, 0 errors |
| Chart requests | 1,165 answered, 0 errors, 0 rate-limited |
| Chart latency | p50 61 ms, p95 248 ms, p99 372 ms |

Earlier measurement on the real Oracle server: 2,000 traders used about 27% of one CPU core. The server has 2 cores and 12 GB.

What this does not cover: real internet latency to traders' browsers, the Supabase side (logins at that volume), or the position watcher with 10x the open trades
(`hub/bench-risk.mjs` covers 2,000 accounts x 3 positions).
