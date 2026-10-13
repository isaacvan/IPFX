# Scoped copy-test latency

An admitted owner five-trade test uses fixed 0.01 lots and a separately enforced emergency-stop risk ceiling. Its broker submission path does not need the ordinary trader-history sizing calculation, policy/progress/treasury sizing inputs, group discovery, review destination, or live-trader population count.

`book-executor/open` now selects only the exact admitted test destination and its gold metadata. This removes twelve database requests in the successful synthetic baseline, including retrieval of up to 5,000 ledger rows. Ordinary A/B sizing, routing and cash-stop policy remain on the existing path. Opens still require atomic test admission, source eligibility, fresh USD gold metadata, owner risk ceiling, atomic risk reservation, current destination/monitor-alias protection, fresh broker capacity, unique journal claim, and exact fill/quantity/position receipts. Exits are unchanged.

The offline fixture executes the actual open function with synthetic database and broker I/O. It verifies that rejected admissions, duplicates, stale metadata, risk/capacity refusals and uncertain fills cannot cause extra sends. It also checks ordinary A/B sizing and test-destination isolation. This is not an E8 execution benchmark or a proof of launch-scale capacity.

The fixture comparison with the prior release removes twelve database requests. At an illustrative uniform 25 ms per synthetic service step, the modeled path saves 175 ms. Actual savings depend on database network latency, edge cold starts, token refresh and broker response time. No measured funded latency is asserted.

Further speed work should first measure admission, database/risk, capacity, order acknowledgement and confirmed-fill time separately. Acknowledgement and a quote are not execution proof. Avoid caching mutable holds, risk, account inventory or free margin. Config/schema caches must bind to account/environment/session identity rather than `accNum` alone; accNum is only a selector inside one login.

Do not increase fill polling or parallel broker calls without checking the account's current route and global quotas. TradeLocker publishes these through `/trade/config`; multi-account applications require developer access. Keep provider limits, the current receipt polling schedule and uncertain-order reconciliation intact.

Primary references: [TradeLocker API account identifiers, config and limits](https://public-api.tradelocker.com/docs/getting-started), [final order history and configured fields](https://public-api.tradelocker.com/reference/getordershistory).

Connecting/preparing still leaves copying off. Actual broker orders and final funded activation remain owner actions; no policy or connection enablement accompanies this optimization.
