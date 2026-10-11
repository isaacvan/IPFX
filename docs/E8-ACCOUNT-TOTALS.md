# Free read-only account totals and cost reconciliation

The monitor reads the documented `/trade/accounts/{accountId}/state` endpoint at most once per minute, after its existing quotes/history. Exact `accountDetailsConfig` column order decodes broker `accountDetailsData`; unknown fields are not copied. Route/global budgets and current read-only role/lease checks remain mandatory. Missing counters, fees, currency or calendar boundary remain unknown. Quote sampling survives a refused/malformed/failed account-state read, whose own status is visible.

Private append-only snapshots retain reported balance, broker-today gross/net/fees, open gross/net, volume and counts. Gross-minus-net is compared with both supported fee signs as a numerical consistency check. An unexplained residual may be financing or reporting timing: it is flagged for review, not declared incorrect broker accounting. Zero difference does not establish a commission-free account. Snapshots cannot set `trade_net_verified=true` and client roles cannot access them directly. Old fills/fees and trade history are not rewritten.

Owner-only E8 monitor and Brain show latest reported account amounts, freshness, missing fields, last read failure and scope. These are neither individual trader P&L, reverse execution, company cash receipts nor a verified fee schedule. “Today” has a broker-defined boundary; UK display time does not establish that boundary. Payouts, corrections and deposits are not fees inferred from balance changes. A snapshot with overlapping positions cannot allocate aggregate costs to each trade.

Free alternatives assessed:

1. Account-state snapshots: strongest supported automatic account-level gross/net/fee observation, no E8 support request needed for fields actually supplied. Cannot alone verify trade-level swaps/fees.
2. Owner platform closed-position rows: actual per-position costs can be manually retained with exact order/position references and arithmetic reconciliation. This avoids a firm support request; screenshots remain owner-supplied evidence. UI scraping is fragile and cannot be silently treated as a complete authoritative API history.
3. Public specifications plus observed fees from existing owner-selected trades: useful versioned calibration of instrument costs, but an observed single gold fee does not establish all symbols, directions, account variants or overnight swaps. Unknowns must remain labeled estimates.
4. Balance-delta allocation: rejected without a complete ledger of deposits, payouts, adjustments and all overlapping activity. A fee-like difference is not an identified fee or swap.
5. Negating trader P&L or using a different broker’s quotes: rejected as exact E8 replication. Bid/ask, costs, latency and fills differ; both directions can lose.
6. Approved pure-demo complete streams: useful actual same/reverse execution and failure/partial-close calibration, with measured differences against E8 quotes. Different venues do not guarantee identical E8 fills. No live/funded test orders are placed by this feature.

Source: [official account-state API](https://public-api.tradelocker.com/reference/getstate), [official SDK decoding](https://github.com/TradeLocker/tradelocker-python/blob/main/src/tradelocker/tradelocker_api.py), and account-specific saved schema. This change has no order method or policy/risk/payout/classifier update. E8 stays read-only and Stage2 +2.75% is preserved.
