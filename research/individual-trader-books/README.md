# Individual trader performance implementation

Read [OWNER_NOTE.md](OWNER_NOTE.md), [DATA_AUDIT.md](DATA_AUDIT.md), [PREREGISTRATION.md](PREREGISTRATION.md), [RESEARCH.md](RESEARCH.md), [METHODS.md](METHODS.md) and [JOURNAL.md](JOURNAL.md).

## Source and migration order

1. `20261019090000_e8_trader_statistics.sql`: per-person day/HAC statistics, descriptive empirical Bayes working probabilities, dependency adjustment, immutable prospective registry with explicit audited activation.
2. `20261019100000_e8_trader_performance.sql`: incremental execution cells, markouts, minute paths, compact owner cache readers, per-person details, watchdog and scheduled refresh.
3. `20261019110000_e8_trader_prospective_followup.sql`: immutable decisions linked to snapshots captured before entry and delayed outcome follow-up. Old history has no invented verdicts.
4. `20261019120000_e8_trader_allocator_replay.sql`: fixed-lot risk/crowd admission and selected-set portfolio. Refuses absent policy or stop risk. This changes only this feature's new simulation function.

The `brain-monitor` change adds three cache-reader actions behind existing owner/admin/MFA checks. `workspace/books.html` mounts `ws-books-traders.js` and its scoped CSS after the existing Books modules. No existing trading, Terms or financial-record function is changed.

## Local verification

Set `DEMO_TEST_DEPS` to the existing validation dependencies and run:

```powershell
node --test --test-concurrency=8 tests/*.test.mjs
$env:E8_BROWSER_TEST='1'
node --test tests/e8-trader-perf-ui.test.mjs
```

The browser tests execute actual production SQL in PGlite with synthetic identities and run the UI against the resulting payloads. They cover polling/focus, filters, drawers, scenario changes, nulls, hostile content, stale/error results and selected sets. The separate local preview script serves the real Books HTML with a synthetic owner transport, never production authentication.

`e8-trader-perf-export-frozen.py` and `e8-trader-perf-offline.mjs` reproduce inference and cent controls from the supplied research archive. Write outputs outside the repository; even masked financial data must stay private.

## Interpretation limits implemented deliberately

- Actual cash sums include every priced close; inference excludes unpublished results and incomplete UTC days. Wholly unpriced P&L is NULL. Intervals specify their completed-day subset.
- All people, both directions and all 12 displayed execution cells form one BY family. Approximate historical p-values and working probabilities do not authorize candidates.
- Source size changes reset the inference window using a fixed within-symbol rule against the previous 20 sizes. A prior prospective process cannot survive a behavior reset automatically.
- Quote-volatility labels use completed pre-entry minutes with at least 30 prior minutes for trailing terciles. At least 90% regime provenance and supported week/session/volatility buckets are needed for stable classification.
- Fewer than six actual gold/FX fills cannot identify a robust factor slippage model. Zero additional slippage is the benchmark; 1/2 tick cells are assumptions. Horizon conversion uses a fresh FX quote at that horizon.
- The allocator replay uses a frozen **current** policy, not a fabricated history of historical owner settings. It reserves whole round-turn costs and a gross-margin approximation. Connection-specific stop interventions, actual broker fills, financing and gaps are not reconstructed. Output stays `executable:false`.
- Marginal portfolio effects are stopped-net differences holding the admitted set and lots fixed, explicitly labeled. They are not Shapley values or a rerun of admissions after removing a person.
- Sequential evidence needs an immutable start, audited external two-tail bounds and a canonical complete daily stream. These are not supplied by the old data; the feature does not activate them automatically.

## Production verification gate

The brief requests migrations, service-role REST reads, anonymous denial, two independent scheduled successes, deployed-source reconciliation and Pages version verification. Automatic approval review rejected retrieving the service-role key under the earlier never-handle-credentials instruction. No alternate credential retrieval was attempted. Deployment must not be represented as complete until that explicit exception is resolved and the checks run.

The deployed Brain source was downloaded through the existing CLI login and compared separately. Explicit UTF-8 comparison confirms it and its shared dependencies match origin/main before this feature's additive change.
