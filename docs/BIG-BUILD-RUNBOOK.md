# IPFX Big Build: runbook

Design rule: **Supabase keeps the records** (logins, accounts, trades, ID checks, payouts, the Brain). **The Oracle hub does what is fast and frequent**
(price fan-out, chart candles, tick-by-tick position watching, account nudges, keeping the price pump alive). Every hub part has an automatic
fallback to the Supabase path, so the hub being down never stops trading.

## What runs where

| Job | Where | If the hub is down |
|---|---|---|
| Price feed (pump) | Supabase Edge Function `trading-engine` action `pump`, started every 10s by pg_cron **and** by the hub when no price arrived for 4s | pg_cron keeps starting it |
| Prices to screens | hub WebSocket `wss://hub.ipfxcapital.com/ws` | pages use Supabase Realtime, then polling |
| Chart candles | hub `GET /candles` (6h tick store + Yahoo history) | page falls back to the `chart-candles` Edge Function |
| Account changes to screens | hub nudge (`{"t":"acct"}`), triggered by DB trigger `notify_account_change` | page opens the Realtime account channel; 30s safety poll |
| Stop-loss / take-profit / limits | hub watcher (tick by tick) + engine sweep every 10s | engine sweep every 10s; page checks every 2.25s with positions |
| Orders, fills, rules | Edge Function `trading-engine` (always) | unchanged |
| Brain, treasury, E8 research | Supabase (**unchanged on purpose**) | unchanged |

## Health checks (30 seconds)

1. `https://hub.ipfxcapital.com/health` should show `"ok":true`, `risk.healthy:true`, and, **while a market is open**, `quotes` above 0 and `ingestAgeMs` under 3000.
2. Brain page: the hub heartbeat is green (the Brain raises a red alert if the hub stops reporting while a market is open).
3. IPFX Markets: the feed badge says LIVE during market hours, not DELAYED or Connecting.
4. Supabase usage page: Realtime messages, Edge Function invocations and egress growing slowly; log ingestion trending down.

## If prices stop

- `ingestAgeMs` large but the hub is up: the hub restarts the pump itself within 4s of silence. Check `pumpKicks` / `pumpKickErrors` in `/health`.
- FXCM unreachable (the free rates feed): check from the hub with `curl https://rates.fxcm.com/RatesXML`. The market being closed (weekend) also gives no prices.
- Database slow: Supabase dashboard > Reports > Database. The pump no longer waits on the database, so prices keep flowing while the database is slow.

## Rolling back a part

- **Hub code:** `ssh -i ~/.ssh/ipfx_hub ubuntu@130.162.185.68`, then `ls /opt/ipfx-hub/rollback-*`, copy the files from the newest folder back to `/opt/ipfx-hub/`, `sudo systemctl restart ipfx-hub`. Every deploy makes a rollback folder first.
- **Page:** revert the commit on `main` (the site publishes in about a minute).
- **Engine:** `git revert` the commit, then `npx supabase functions deploy trading-engine --project-ref agulweemteoeagscmppy`.
- **Database functions** (`notify_account_change`, `hub_watch`): each migration states the previous definition's checksum; re-apply the older migration body.

## Deploy rules (unchanged)

Before any deploy: `git fetch`; download the live Edge Function / hub file and diff it against `origin/main` (compare with `tr -d '\r'`); run the full test suite
(`node --test tests/*.test.mjs`, with `DEMO_TEST_DEPS` set); rehearse database changes inside `begin; ... rollback;` first. Switch hub parts only while markets are closed.

## Capacity

Measured with `hub/loadtest.mjs` (see `docs/BIG-BUILD-LOADTEST.md`). The hub holds 2,000 traders at about 27% of one CPU; 10x the current traders is within one server.
If Oracle ever withdraws the free server, the hub moves to any 2 vCPU / 4 GB server in about an hour (`hub/deploy/install.sh`, copy `hub/*.mjs`, set `/etc/ipfx-hub.env`).

## Known limits

- The Brain's `trade-lows` job (`ipfx_trade_low_tick`, every 10s) and the treasury/E8/cost jobs are the largest remaining database writers. They were left alone on purpose; moving or slowing them is a Brain decision.
- Supabase compute is still Micro. If the database ever stalls again, Small (about $5 a month more) is the first lever.
