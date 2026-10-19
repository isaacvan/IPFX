# Individual trader performance implementation

Read [OWNER_NOTE.md](OWNER_NOTE.md), [DATA_AUDIT.md](DATA_AUDIT.md), [PREREGISTRATION.md](PREREGISTRATION.md), [RESEARCH.md](RESEARCH.md), [METHODS.md](METHODS.md) and [JOURNAL.md](JOURNAL.md).

## Source and migration order

1. `20261019090000_e8_trader_statistics.sql`: per-person day/HAC statistics, descriptive empirical Bayes working probabilities, dependency adjustment, immutable prospective registry with explicit audited activation.
2. `20261019100000_e8_trader_performance.sql`: incremental execution cells, markouts, minute paths, compact owner cache readers, per-person details, watchdog and scheduled refresh.
3. `20261019110000_e8_trader_prospective_followup.sql`: immutable decisions linked to snapshots captured before entry and delayed outcome follow-up. Old history has no invented verdicts.
4. `20261019120000_e8_trader_allocator_replay.sql`: fixed-lot risk/crowd admission and selected-set portfolio. Refuses absent policy or stop risk. This changes only this feature's new simulation function.
5. `20261019130000_e8_trader_tick_metadata.sql`: accepts E8's single default tick band; unsupported tier schedules remain unknown.
6. `20261019140000_e8_trader_linear_fdr.sql`: equivalent reverse cumulative BY minima to avoid quadratic moving-frame rescans at production population size.
7. `20261019150000_e8_trader_empty_inference.sql`: reuse zero-observation inference and invalidate priors only when eligible peers change.
8. `20261019160000_e8_trader_replay_work_reuse.sql`: indexed source-control identities and shared quote marks across slippage cells.
9. `20261019170000_e8_trader_compact_family.sql`: narrow multiplicity payloads and avoid unchanged cache writes.
10. `20261019180000_e8_trader_fingerprint_blocks.sql`: hash quote minutes once, conservatively including boundary ticks; keep full markouts outside inference working arrays.
11. `20261019190000_e8_trader_allocator_working_set.sql`: retain closed cash observations while releasing their obsolete paths and risk/crowd reservations.
12. `20261019200000_e8_trader_cache_compression.sql`: LZ4 for this feature's new production cache values. PGlite's build lacks LZ4; pricing/statistics tests retain pglz.
13. `20261019210000_e8_trader_narrow_path_events.sql`: narrow portfolio minute events, fast temporary compression where supported, bounded 32MB sort memory for the advisory-locked compute worker.
14. `20261019220000_e8_trader_stat_work_reuse.sql`: reuse identical deterministic Student critical values and skip peer-prior moments outside existing eligibility gates.
15. `20261019230000_e8_trader_shared_horizon_quotes.sql`: observe each horizon quote/FX once per trade and entry latency, keeping separate costs and missingness for all slippage scenarios.
16. `20261019233000_e8_trader_nightly_refit.sql`: nightly full statistical refit revalidates every price fingerprint and replays changed prices. Explicit `p_rebuild=true` additionally forces unchanged price rewrites for diagnostics.

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

The brief requests migrations, service-role REST reads, anonymous denial, two independent scheduled successes, deployed-source reconciliation and Pages version verification. After automatic approval review rejected credential retrieval under the earlier rule, the owner explicitly granted a one-task exception. Credentials are used only in memory, never printed, saved or committed. Rollout evidence is recorded in JOURNAL.md; deployment is complete only when those checks have passed.

The deployed Brain source was downloaded through the existing CLI login and compared separately. Explicit UTF-8 comparison confirms it and its shared dependencies match origin/main before this feature's additive change.
