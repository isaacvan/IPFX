# IPFX copier v2: IBKR bridge

The trading engine sends every Infinity trade event to the hub (`hub/copier.mjs`) the moment it happens. The hub
decides what to copy. This bridge executes the copies on an **IBKR paper account** and reports fills and timestamps.

```
trader clicks -> trading engine -> hub copier (memory: settings, news, who qualifies, sizes) -> this bridge -> IB Gateway -> IBKR
                 (no database in between; results are saved in batches afterwards)
```

## What is live now: shadow mode

Shadow mode needs nothing from you. Every Infinity trade is copied on paper from IPFX's own prices, with modelled costs:

- **Entry:** a limit order at the trader's fill plus 0.3 pips (gold 3, indices 1 to 3). It is checked from fill + 400 ms
  (modelled latency) for 1.5 s. If it isn't filled by then, the copy is "missed" and nothing chases it.
- **Pending orders:** they rest at the broker from the moment they're placed, so they fill at the trigger. Stops slip.
- **Stop loss and take profit:** they rest at the broker. Stops slip; take profits don't.
- **Commission:** IBKR style, a fraction of the notional with a minimum per order. The $2 minimum dominates small copies.
- **News:** copies within 2 minutes either side of high-impact news for either currency are skipped.

Results go to `copy_trades`. Who qualifies is in `copy_trader_quality`:

- average trade at least 5x the copy cost
- shadow-copied profit at least 70% of their own
- at least 30 trades
- A-book classifier state
- an edge that isn't made of stale IPFX prices

```sql
select * from copy_trader_quality order by qualifies desc, edge_multiple desc;
select symbol, count(*), round(avg(cost_pips),2) cost, round(avg(entry_slip_pips),2) entry_slip,
       count(*) filter (where entry_status='missed') missed, count(*) filter (where skip_reason like 'news:%') news
from copy_trades where mode='shadow' and opened_at > now()-interval '7 days' group by 1 order by 2 desc;
```

Settings are in `copy_settings` (one row) and `copy_symbols` (one row per symbol). `mode` can be `off`, `shadow` or
`paper`. `live` is not allowed by the database.

## Next step: paper (the owner does these steps; Claude never types IBKR logins)

1. In IBKR Client Portal, open or confirm a **paper trading account** (its number starts with `DU`). Give it
   permissions for Forex (IDEALPRO). Add Metals (spot gold) and CFDs (index CFDs) if wanted.
2. Install **IB Gateway** (stable) on the machine that runs this bridge. Ideally that is the machine nearest IBKR's
   servers; IBKR's European gateway is the closest to London.
   Sign in with the **paper** username and turn on API > Settings > "Enable ActiveX and Socket Clients".
   Socket port 4002, trusted IP 127.0.0.1, and untick "Read-Only API".
3. Install the Python packages: `pip install ib_insync websockets`
4. Set the environment and start the bridge:

```powershell
$env:HUB_COPIER_URL = "wss://hub.ipfxcapital.com/copier"
$env:COPIER_SECRET  = Get-Content "$HOME\.ssh\ipfx_copier_secret"
$env:IB_PORT = "4002"
python bridge\ibkr_copier.py
```

5. Switch the copier to paper: `update copy_settings set mode = 'paper';`. Only traders listed as qualifying
   are sent to the bridge. Everyone keeps being shadow-copied.

The bridge refuses to run against any account that isn't a paper account. The hub also refuses any bridge that
doesn't report a paper account.

Size guard (optional): `MAX_UNITS_EURUSD=200000` caps any single order for that symbol.

## What the paper run measures

Every paper row records timestamps in `copy_trades.latency`:

- `tc` client click
- `tr` engine received
- `te` engine fill
- `hub_rx` hub received
- `hub_tx` sent to bridge
- `bridge_rx` bridge received
- `submit_ts` order sent to IBKR
- `ack_ts` IBKR acknowledged
- `fill_ts` filled

The target is under 500 ms from the engine receiving the order to the order reaching the broker. With the bridge
connected, `copy_feed_parity` compares IPFX prices with IBKR's per symbol every 5 minutes, and `stale_gap_pips`
shows when a trader's fill was better than the broker's real price at that moment.
