// ============================================================
// IPFX Capital — trading-engine Edge Function
//
// All order flow goes through here. The browser never decides
// a fill price and never writes to the database.
//
// Actions (POST JSON):
//   { action: "state" }                                   -> account + positions + equity
//   { action: "open", symbol, side, volume, sl?, tp? }    -> market order
//   { action: "close", trade_id }                         -> close one position
//   { action: "close_all" }                               -> flatten
//   { action: "modify", trade_id, sl?, tp? }              -> move SL/TP on a live position
//   { action: "partial_close", trade_id, volume }         -> bank part of a position
//   { action: "place_pending", symbol, side, order_type,  -> resting limit/stop order
//              volume, trigger_price, sl?, tp?, expires_at? }
//   { action: "cancel_pending", order_id }                -> cancel a resting order
//   { action: "price", symbol }                           -> quote for the order ticket
//
// PRICING — SINGLE PROVIDER, TESTING TIER ONLY
//   The only quote source is SOURCE_ID (see market_data_sources in the
//   DB — registered as tier='testing'). It is an unofficial, delayed,
//   free endpoint with no real bid/ask: we synthesize bid/ask from a
//   mid price using each instrument's configured spread. This is NOT a
//   launch-grade feed. Before accepting real payouts, swap fetchQuote()
//   for a paid single-source provider (broker/MetaApi, OANDA pricing
//   stream, Twelve Data WebSocket, Polygon) and keep bid/ask genuine.
//   No crypto instruments — forex/metals/indices only.
//
// FAIL-CLOSED: if no fresh quote is available, is stale, spread is too
// wide, the symbol is disabled, or the market is closed, the order is
// REJECTED. We never fill blind and never fill from browser-supplied
// prices.
//
// Rules enforced on every call:
//   - profit target  (realized balance >= start * (1 + target%)) AND
//                     the pass gate below -- target alone is not enough
//   - pass gate      min trading days, min trades, min profitable-day %
//   - max drawdown   static | trailing_intraday | trailing_eod -> breach
//   - daily loss     (equity <= dayStart - start*daily%) -> breach
//   - risk per trade max % of starting balance, measured off the stop
//   - daily profit cap  blocks NEW orders once hit (not a breach)
//   - SL/TP          (auto-close when crossed)
// The rule set per account comes from challenge_presets -- see
// challenge-rules-engine.sql.
// On breach all open positions are closed and the account locks.
//
// Every open/close/reject writes a row to order_audit_events with
// requested price, fill price, bid, ask, spread, quote timestamp,
// server timestamp, and latency — see logAudit().
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-ipfx-bot-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// The one official quote source. Must match a row in market_data_sources.
const SOURCE_ID = "yahoo-demo";

// ---------- instrument registry (forex, metals, indices — no crypto) ----------
type Inst = {
  code: string;        // provider symbol
  alt?: string;        // fallback provider symbol
  digits: number;
  spread: number;      // synthesized full spread in price units (testing feed has no real bid/ask)
  maxSpread: number;   // reject fills if effective spread exceeds this
  contract: number;    // units per 1.00 lot (per point for indices)
  quote: string;       // quote currency for PnL conversion
  cls: "forex" | "metal" | "index";
};

const I = (code: string, digits: number, spread: number, contract: number, cls: Inst["cls"], quote = "USD", alt?: string, maxSpread?: number): Inst =>
  ({ code, digits, spread, maxSpread: maxSpread ?? spread * 4, contract, quote, alt, cls });

const INSTRUMENTS: Record<string, Inst> = {
  // forex — 100,000 units per lot
  EURUSD: I("EURUSD=X", 5, 0.0002, 100000, "forex"),
  GBPUSD: I("GBPUSD=X", 5, 0.0003, 100000, "forex"),
  USDJPY: I("USDJPY=X", 3, 0.03,   100000, "forex", "JPY"),
  AUDUSD: I("AUDUSD=X", 5, 0.0003, 100000, "forex"),
  USDCAD: I("USDCAD=X", 5, 0.0003, 100000, "forex", "CAD"),
  USDCHF: I("USDCHF=X", 5, 0.0004, 100000, "forex", "CHF"),
  NZDUSD: I("NZDUSD=X", 5, 0.0004, 100000, "forex"),
  GBPJPY: I("GBPJPY=X", 3, 0.05,   100000, "forex", "JPY"),
  EURJPY: I("EURJPY=X", 3, 0.04,   100000, "forex", "JPY"),
  EURGBP: I("EURGBP=X", 5, 0.0003, 100000, "forex", "GBP"),
  EURCAD: I("EURCAD=X", 5, 0.0005, 100000, "forex", "CAD"),
  AUDCAD: I("AUDCAD=X", 5, 0.0006, 100000, "forex", "CAD"),
  // metals — oz per lot
  XAUUSD: I("XAUUSD=X", 2, 0.30, 100,  "metal", "USD", "GC=F"),
  XAGUSD: I("XAGUSD=X", 3, 0.05, 5000, "metal", "USD", "SI=F"),
  XPTUSD: I("PL=F",     2, 0.80, 100,  "metal"),
  XPDUSD: I("PA=F",     2, 1.20, 100,  "metal"),
  // indices — $10 per index point per lot (CFD convention, uniform)
  SPXUSD: I("^GSPC",  1, 0.5, 10, "index"),
  NSXUSD: I("^NDX",   1, 1.5, 10, "index"),
  DJI:    I("^DJI",   0, 2.0, 10, "index"),
  UK100:  I("^FTSE",  1, 1.0, 10, "index", "GBP"),
  GER40:  I("^GDAXI", 1, 1.5, 10, "index", "EUR"),
  FRA40:  I("^FCHI",  1, 1.5, 10, "index", "EUR"),
  JPN225: I("^N225",  0, 8.0, 10, "index", "JPY"),
  US2000: I("^RUT",   1, 0.8, 10, "index"),
};

const ALIASES: Record<string, string> = {
  US500: "SPXUSD", SPX500: "SPXUSD", NAS100: "NSXUSD", US30: "DJI",
};

const LEVERAGE = 100;
const MAX_OPEN_POSITIONS = 20;

// ---------- market session (weekend closure) ----------
// Forex/metals/indices via this feed: closed Fri 22:00 UTC -> Sun 22:00 UTC
// (approximates the real FX week close). Coarse but real, fail-closed.
function marketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun 6=Sat
  const hour = now.getUTCHours();
  if (day === 6) return false;                    // all Saturday
  if (day === 0 && hour < 22) return false;        // Sunday before 22:00 UTC
  if (day === 5 && hour >= 22) return false;       // Friday from 22:00 UTC
  return true;
}

function cleanSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.toUpperCase().replace(/^[A-Z]+:/, "").replace(/[^A-Z0-9]/g, "");
  if (ALIASES[s]) s = ALIASES[s];
  return INSTRUMENTS[s] ? s : null;
}

// ---------- price feed (server-side, cached, fail-closed) ----------
// TESTING TIER: single provider (Yahoo, unofficial), no real bid/ask.
// providerTs = the provider's own reported tick time when available;
// STALE_MS is generous because this feed cannot promise sub-second
// freshness — this is exactly the launch-blocking gap documented above.
type Quote = { symbol: string; mid: number; bid: number; ask: number; spread: number; providerTs: number | null; receivedTs: number };
const quoteCache = new Map<string, Quote>();
const CACHE_TTL_MS = 4000;
const STALE_MS = 90_000; // testing-tier threshold; tighten drastically once on a real feed

async function fetchYahooRaw(code: string): Promise<{ price: number; ts: number | null } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?interval=1m&range=1d`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; IPFXEngine/1.0)" } });
    if (!r.ok) return null;
    const j = await r.json();
    const meta = j?.chart?.result?.[0]?.meta;
    const p = meta?.regularMarketPrice;
    const t = meta?.regularMarketTime; // unix seconds, may be absent
    if (typeof p !== "number" || !isFinite(p) || p <= 0) return null;
    return { price: p, ts: typeof t === "number" ? t * 1000 : null };
  } catch (_) { return null; }
}

// Own lazily-created client rather than threading `db` through every one
// of fetchQuote's ~15 call sites. Cheap: created once per warm isolate,
// same credentials the request-scoped client uses.
let cacheClient: Db | null = null;
function getCacheClient(): Db {
  if (!cacheClient) {
    cacheClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  }
  return cacheClient;
}

async function fetchQuote(symKey: string): Promise<Quote | null> {
  // Level 1: in-process Map. Free, but only shared with other requests
  // that happen to land on this exact warm isolate.
  const hit = quoteCache.get(symKey);
  if (hit && Date.now() - hit.receivedTs < CACHE_TTL_MS) return hit;
  const inst = INSTRUMENTS[symKey];
  if (!inst) return null;

  // Level 2: shared Postgres cache. Under load, hundreds of concurrent
  // isolates each missing their own local Map would otherwise all hit
  // the upstream feed independently for the same symbol at the same
  // moment — exactly the pattern that gets an unofficial, rate-limited
  // feed blocked. This makes the cache actually shared across them.
  try {
    const db2 = getCacheClient();
    const { data: cached } = await db2.from("live_quotes").select("*").eq("symbol", symKey).maybeSingle();
    if (cached) {
      const ageMs = Date.now() - new Date(cached.received_at).getTime();
      if (ageMs < CACHE_TTL_MS) {
        const q: Quote = {
          symbol: symKey, mid: Number(cached.mid), bid: Number(cached.bid), ask: Number(cached.ask),
          spread: Number(cached.spread),
          providerTs: cached.provider_ts ? new Date(cached.provider_ts).getTime() : null,
          receivedTs: new Date(cached.received_at).getTime(),
        };
        quoteCache.set(symKey, q);
        return q;
      }
    }
  } catch (_) { /* shared cache is an optimisation, never a hard dependency */ }

  let raw = await fetchYahooRaw(inst.code);
  if (raw === null && inst.alt) raw = await fetchYahooRaw(inst.alt);
  if (raw === null) return null;
  const q: Quote = {
    symbol: symKey, mid: raw.price,
    bid: round6(raw.price - inst.spread / 2), ask: round6(raw.price + inst.spread / 2),
    spread: inst.spread, providerTs: raw.ts, receivedTs: Date.now(),
  };
  quoteCache.set(symKey, q);
  try {
    const db2 = getCacheClient();
    await db2.from("live_quotes").upsert({
      symbol: symKey, mid: q.mid, bid: q.bid, ask: q.ask, spread: q.spread,
      provider_ts: q.providerTs ? new Date(q.providerTs).toISOString() : null,
      received_at: new Date(q.receivedTs).toISOString(),
    });
  } catch (_) { /* best-effort write-through — a failed cache write must never block the quote itself */ }
  return q;
}
function round6(n: number) { return Math.round(n * 1e6) / 1e6; }
function quoteStale(q: Quote): boolean {
  const refTs = q.providerTs ?? q.receivedTs;
  return Date.now() - refTs > STALE_MS;
}

// backward-compatible mid-price accessor for PnL/conversion math
async function mid(symKey: string): Promise<number | null> {
  const q = await fetchQuote(symKey);
  return q ? q.mid : null;
}

// USD value of 1 unit of a quote currency (for PnL conversion)
async function usdPerQuote(quote: string): Promise<number | null> {
  if (quote === "USD") return 1;
  if (quote === "JPY") { const r = await mid("USDJPY"); return r ? 1 / r : null; }
  if (quote === "GBP") { return await mid("GBPUSD"); }
  if (quote === "CAD") { const r = await mid("USDCAD"); return r ? 1 / r : null; }
  if (quote === "CHF") { const r = await mid("USDCHF"); return r ? 1 / r : null; }
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// PnL in USD for a trade at a given exit price
async function tradePnl(t: Tr, exit: number): Promise<number | null> {
  const inst = INSTRUMENTS[t.symbol];
  if (!inst) return null;
  const conv = await usdPerQuote(inst.quote);
  if (conv === null) return null;
  const dir = t.side === "buy" ? 1 : -1;
  return (exit - Number(t.open_price)) * dir * inst.contract * Number(t.volume) * conv;
}

// ---------- live copier hook ----------
// Fire-and-forget a fill to the live-mirror function. Never blocks or fails
// the trader's order. Only fires when the account has mirror_enabled=true.
// EdgeRuntime.waitUntil keeps the worker alive until the call completes.
// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;
function fireMirror(acct: Acct, t: Tr, event: "open" | "close") {
  // deno-lint-ignore no-explicit-any
  if (!(acct as any).mirror_enabled) return;
  const p = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/live-mirror`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify({
      source_trade_id: t.id, user_id: acct.user_id, event,
      symbol: t.symbol, side: t.side, volume: Number(t.volume),
    }),
  }).catch(() => {});
  try { EdgeRuntime.waitUntil(p); } catch (_) { /* local/dev: fetch still fired */ }
}

// ---------- types ----------
type Acct = {
  id: string; user_id: string; label: string;
  starting_balance: number; balance: number;
  profit_target_pct: number; max_drawdown_pct: number; daily_loss_pct: number;
  day_start_equity: number; day_start_date: string;
  status: string; breach_reason: string | null;
  total_paid_out?: number;
  phase?: string; funded_from_account_id?: string | null; funded_at?: string | null;
  investigation_hold?: boolean; profit_split_pct?: number; challenge_fee_usd?: number | null;
  // ---- challenge rule set (see challenge-rules-engine.sql) ----
  challenge_type?: string; stage?: number; preset_id?: string | null;
  min_trading_days?: number; min_trades?: number;
  max_risk_per_trade_pct?: number | null;
  daily_profit_cap_pct?: number | null;
  min_profitable_days_pct?: number | null;
  drawdown_mode?: string;
  trailing_peak?: number | null; trailing_peak_date?: string | null;
  require_stop_loss?: boolean;
};

// Derived progress counters from public.account_progress.
type Progress = { trading_days: number; trades_closed: number; profitable_days: number; profitable_days_pct: number | null };

// Challenge tier -> starting balance / fee, matching start-challenge.html.
// user_metadata.challenge_tier is set at signup; provisioning must honor
// whatever tier the trader actually paid for instead of the schema
// defaults (which are a flat $100K regardless of tier).
const TIER_BALANCE: Record<string, number> = { "10k": 10000, "25k": 25000, "50k": 50000, "100k": 100000, "200k": 200000 };
const TIER_FEE: Record<string, number> = { "10k": 79, "25k": 149, "50k": 249, "100k": 399, "200k": 699 };

// Called the moment an evaluation account passes. Follows the preset
// chain: a Traditional Phase 1 pass provisions Phase 2, an Infinity
// Stage 1 pass provisions Stage 2, and only the LAST link in the chain
// (next_preset_id null) provisions a funded account. Without this a
// Phase 1 pass jumped straight to funded, skipping Phase 2 entirely.
// Idempotent: if a descendant already exists this is a no-op, which
// protects against enforce() running twice in a race.
async function provisionNextStage(db: Db, evalAcct: Acct): Promise<void> {
  const { data: existing } = await db.from("trading_accounts")
    .select("id").eq("funded_from_account_id", evalAcct.id).maybeSingle();
  if (existing) return;

  let next: Record<string, unknown> | null = null;
  if (evalAcct.preset_id) {
    const { data: cur } = await db.from("challenge_presets")
      .select("next_preset_id").eq("id", evalAcct.preset_id).maybeSingle();
    if (cur?.next_preset_id) {
      const { data: np } = await db.from("challenge_presets")
        .select("*").eq("id", cur.next_preset_id).maybeSingle();
      next = np ?? null;
    }
  }

  // End of the chain -> real funded account.
  if (!next) { await provisionFundedAccount(db, evalAcct); return; }

  // Next evaluation stage/phase, carrying that preset's own rule set.
  // Phase 2 of a Traditional challenge restarts at the ORIGINAL starting
  // balance (profit from Phase 1 does not carry) — that is how two-phase
  // evaluations work everywhere.
  const startBal = Number(next.starting_balance);
  const { data: provisioned } = await db.from("trading_accounts").insert({
    user_id: evalAcct.user_id,
    label: String(next.label),
    preset_id: next.id,
    challenge_type: next.challenge_type,
    stage: Number(next.stage ?? 1),
    phase: "evaluation",
    status: "active",
    starting_balance: startBal, balance: startBal, day_start_equity: startBal,
    day_start_date: new Date().toISOString().slice(0, 10),
    profit_target_pct: Number(next.profit_target_pct),
    max_drawdown_pct: Number(next.max_drawdown_pct),
    daily_loss_pct: Number(next.daily_loss_pct),
    drawdown_mode: next.drawdown_mode,
    trailing_peak: startBal,
    min_trading_days: Number(next.min_trading_days ?? 0),
    min_trades: Number(next.min_trades ?? 0),
    max_risk_per_trade_pct: next.max_risk_per_trade_pct ?? null,
    daily_profit_cap_pct: next.daily_profit_cap_pct ?? null,
    min_profitable_days_pct: next.min_profitable_days_pct ?? null,
    require_stop_loss: !!next.require_stop_loss,
    profit_split_pct: Number(next.profit_split_pct ?? 85),
    challenge_fee_usd: evalAcct.challenge_fee_usd ?? null,
    funded_from_account_id: evalAcct.id,
    total_paid_out: 0,
  }).select("id").single();

  // Opt into qualification-v2 (see 20260909212000_qualification_v2_activation.sql)
  // if a published version exists for this challenge_type/stage -- a no-op
  // for anything but Infinity today, and a no-op entirely if that
  // migration has not been deployed yet. Never blocks provisioning: a
  // trader always gets their next stage even if this call fails.
  if (provisioned?.id) {
    try { await db.rpc("accept_qualification_v2", { p_account_id: provisioned.id }); }
    catch (_) { /* never block provisioning on this */ }
  }
}

// Terminal step of the chain: a real funded account. Idempotent for the
// same reason as above.
async function provisionFundedAccount(db: Db, evalAcct: Acct): Promise<void> {
  const { data: existing } = await db.from("trading_accounts")
    .select("id").eq("funded_from_account_id", evalAcct.id).maybeSingle();
  if (existing) return;

  const startBal = Number(evalAcct.starting_balance);
  await db.from("trading_accounts").insert({
    user_id: evalAcct.user_id,
    label: evalAcct.label?.replace(/challenge/i, "Funded") || "Funded Account",
    phase: "funded", status: "active",
    starting_balance: startBal, balance: startBal, day_start_equity: startBal,
    day_start_date: new Date().toISOString().slice(0, 10),
    profit_target_pct: 0, // funded accounts don't "pass" again — see enforce()
    max_drawdown_pct: evalAcct.max_drawdown_pct, daily_loss_pct: evalAcct.daily_loss_pct,
    profit_split_pct: evalAcct.profit_split_pct ?? 85,
    funded_from_account_id: evalAcct.id, funded_at: new Date().toISOString(),
    total_paid_out: 0,
  });
}

// ---------- pending orders (limit / stop) ----------
// Trigger test against the live quote. Uses the price the order would
// actually FILL at (ask for a buy, bid for a sell), never the mid.
function pendingTriggered(o: Record<string, unknown>, q: Quote): boolean {
  const trig = Number(o.trigger_price);
  const isBuy = o.side === "buy";
  const px = isBuy ? q.ask : q.bid;
  if (o.order_type === "limit") return isBuy ? px <= trig : px >= trig;
  return isBuy ? px >= trig : px <= trig; // stop
}

// Shared rule gate applied to BOTH market orders and pending fills, so a
// resting order cannot be used to sneak past the per-trade risk cap.
// Returns null when the order may proceed, or a rejection reason.
function ruleGate(
  acct: Acct, inst: Inst, volume: number, fill: number, sl: number | null,
  conv: number, equityNow: number, usedMargin: number,
): string | null {
  const startBal = Number(acct.starting_balance);

  if (acct.daily_profit_cap_pct != null) {
    const gain = round2(equityNow - Number(acct.day_start_equity));
    const cap = round2(startBal * Number(acct.daily_profit_cap_pct) / 100);
    if (gain >= cap) return `Daily profit cap reached ($${cap.toFixed(2)})`;
  }
  if (acct.require_stop_loss && sl === null) {
    return "This challenge requires a stop-loss on every order";
  }
  if (acct.max_risk_per_trade_pct != null && sl !== null) {
    const riskUsd = Math.abs(fill - sl) * inst.contract * volume * conv;
    const maxRisk = round2(startBal * Number(acct.max_risk_per_trade_pct) / 100);
    if (riskUsd > maxRisk + 0.01) {
      return `Risk $${riskUsd.toFixed(2)} exceeds the ${acct.max_risk_per_trade_pct}% cap ($${maxRisk.toFixed(2)})`;
    }
  }
  const needed = (inst.contract * volume * fill * conv) / LEVERAGE;
  if (usedMargin + needed > equityNow) {
    return `Insufficient margin ($${Math.round(needed)} needed)`;
  }
  return null;
}

// Called from enforce() on every pass. Fills or rejects any resting order
// whose trigger has been crossed.
async function processPendingOrders(
  db: Db, acct: Acct, open: Tr[], equityNow: number,
): Promise<Tr[]> {
  if (acct.status !== "active") return open;
  const { data: pendings } = await db.from("pending_orders")
    .select("*").eq("account_id", acct.id).eq("status", "pending").order("created_at");
  if (!pendings || !pendings.length) return open;

  let working = [...open];
  for (const o of pendings) {
    // Expiry first — an expired order never fills.
    if (o.expires_at && new Date(o.expires_at).getTime() < Date.now()) {
      await db.from("pending_orders").update({
        status: "expired", resolved_at: new Date().toISOString(),
      }).eq("id", o.id).eq("status", "pending");
      continue;
    }

    const symbol = String(o.symbol);
    const inst = INSTRUMENTS[symbol];
    if (!inst) continue;
    const q = await fetchQuote(symbol);
    if (q === null || quoteStale(q)) continue;      // never fill on a bad quote
    if (!marketOpen()) continue;
    if (!pendingTriggered(o, q)) continue;

    const reject = async (reason: string) => {
      await db.from("pending_orders").update({
        status: "rejected", reject_reason: reason, resolved_at: new Date().toISOString(),
      }).eq("id", o.id).eq("status", "pending");
      await logAudit(db, {
        user_id: acct.user_id, account_id: acct.id, event: "reject",
        reject_reason: "pending: " + reason, symbol, side: String(o.side),
        requested_volume: Number(o.volume), requested_price: Number(o.trigger_price), quote: q,
      });
    };

    if (working.length >= MAX_OPEN_POSITIONS) { await reject(`Max ${MAX_OPEN_POSITIONS} open positions`); continue; }
    const spec = await symbolCheck(db, symbol);
    if (!spec.ok) { await reject(spec.reason || "Symbol disabled"); continue; }
    if (q.spread > (spec.maxSpread ?? inst.maxSpread)) { await reject("Spread too wide at trigger"); continue; }

    const fill = o.side === "buy" ? q.ask : q.bid;
    const sl = o.sl === null || o.sl === undefined ? null : Number(o.sl);
    const tp = o.tp === null || o.tp === undefined ? null : Number(o.tp);
    // Levels must still make sense against the actual fill, not the trigger.
    if (sl !== null && ((o.side === "buy" && sl >= fill) || (o.side === "sell" && sl <= fill))) {
      await reject("Stop-loss is on the wrong side of the fill price"); continue;
    }
    if (tp !== null && ((o.side === "buy" && tp <= fill) || (o.side === "sell" && tp >= fill))) {
      await reject("Take-profit is on the wrong side of the fill price"); continue;
    }

    const conv = await usdPerQuote(inst.quote);
    if (conv === null) { await reject("No conversion rate at trigger"); continue; }
    const usedMargin = await usedMarginUsd(working);
    const gate = ruleGate(acct, inst, Number(o.volume), fill, sl, conv, equityNow, usedMargin);
    if (gate) { await reject(gate); continue; }

    // Claim the order BEFORE inserting the trade, and check that this
    // call actually won the claim. Two concurrent enforce() passes for
    // the same account (a manual action racing the 8s state poll, or the
    // cron sweep racing either) can both reach this point having seen the
    // same status='pending' row — without claiming first, both would
    // insert a trade and double-fill the same order. The conditional
    // .eq("status","pending") makes the UPDATE itself atomic; .select()
    // is what makes "did I actually win it" visible to check, exactly
    // the same pattern as the closeTrade fix above.
    const { data: claimed } = await db.from("pending_orders").update({
      status: "filled", fill_price: fill, resolved_at: new Date().toISOString(),
    }).eq("id", o.id).eq("status", "pending").select("id");
    if (!claimed || claimed.length === 0) continue; // lost the race — the other caller fills it

    const { data: inserted, error } = await db.from("trades").insert({
      account_id: acct.id, user_id: acct.user_id, symbol, side: o.side,
      volume: Number(o.volume), open_price: fill, sl, tp,
    }).select("*").single();
    if (error || !inserted) {
      // We claimed the order but the fill itself failed — put it back
      // rather than leaving it stuck "filled" with no trade behind it.
      await db.from("pending_orders").update({
        status: "rejected", reject_reason: "Order failed at fill", resolved_at: new Date().toISOString(),
      }).eq("id", o.id);
      continue;
    }
    await db.from("pending_orders").update({ filled_trade_id: inserted.id }).eq("id", o.id);

    await logAudit(db, {
      trade_id: inserted.id, user_id: acct.user_id, account_id: acct.id, event: "open",
      symbol, side: String(o.side), requested_volume: Number(o.volume),
      requested_price: Number(o.trigger_price), fill_price: fill, quote: q,
    });
    fireMirror(acct, inserted as Tr, "open");
    working.push(inserted as Tr);
  }
  return working;
}

// Derived counters straight from the trade log — see account_progress
// in challenge-rules-engine.sql. Never stored, so they cannot drift.
async function fetchProgress(db: Db, accountId: string): Promise<Progress> {
  const { data } = await db.from("account_progress").select("*").eq("account_id", accountId).maybeSingle();
  return {
    trading_days: Number(data?.trading_days ?? 0),
    trades_closed: Number(data?.trades_closed ?? 0),
    profitable_days: Number(data?.profitable_days ?? 0),
    profitable_days_pct: data?.profitable_days_pct == null ? null : Number(data.profitable_days_pct),
  };
}

// The requirements that must ALL hold, alongside the profit target,
// before an evaluation account is allowed to pass. Returns the unmet
// items so the trader can be shown exactly what is left.
async function passGate(db: Db, acct: Acct): Promise<{ ok: boolean; unmet: string[]; progress: Progress }> {
  const p = await fetchProgress(db, acct.id);
  const unmet: string[] = [];
  const needDays = Number(acct.min_trading_days ?? 0);
  const needTrades = Number(acct.min_trades ?? 0);
  const needProfPct = acct.min_profitable_days_pct == null ? null : Number(acct.min_profitable_days_pct);

  if (p.trading_days < needDays) unmet.push(`${p.trading_days}/${needDays} trading days`);
  if (p.trades_closed < needTrades) unmet.push(`${p.trades_closed}/${needTrades} trades`);
  // Only explicitly accepted v2 contracts apply; legacy terms remain intact.
  const qualification = await db.rpc("qualification_progress_v2", { p_account: acct.id });
  if (qualification.error || !qualification.data) unmet.push("Qualification verification unavailable");
  else if (qualification.data.applies && !qualification.data.eligible) {
    unmet.push(...(qualification.data.unmet ?? ["Extended qualification incomplete"]));
  }
  if (needProfPct !== null && (p.profitable_days_pct ?? 0) < needProfPct) {
    unmet.push(`${p.profitable_days_pct ?? 0}%/${needProfPct}% profitable days`);
  }
  return { ok: unmet.length === 0, unmet, progress: p };
}

// Realized + floating P&L for the current UTC day. Used by the daily
// profit cap (Infinity: 3%), which blocks NEW orders once hit rather
// than breaching the account — hitting a profit cap is not a failure.
async function todayGain(db: Db, acct: Acct, equity: number): Promise<number> {
  return round2(equity - Number(acct.day_start_equity));
}
type Tr = {
  id: string; account_id: string; user_id: string; symbol: string;
  side: string; volume: number; open_price: number; close_price: number | null;
  sl: number | null; tp: number | null; status: string; pnl: number | null;
};

// deno-lint-ignore no-explicit-any
type Db = any;

// ---------- engine ----------
async function closeTrade(db: Db, acct: Acct, t: Tr, exit: number, reason: string, q?: Quote | null, clientIp?: string | null): Promise<boolean> {
  const pnl = await tradePnl(t, exit);
  if (pnl === null) return false;
  // .eq("status","open") makes this UPDATE atomic and conditional at the
  // database level, but a filtered update that matches zero rows is NOT
  // an error in supabase-js — it silently succeeds with no data. Without
  // checking rows-affected, a trade already closed by a concurrent
  // request (two tabs, a double-click, the state poll racing a manual
  // close) would credit pnl to acct.balance a SECOND time here. .select()
  // is what makes the affected rows visible to check.
  const { data: closedRow, error: e1 } = await db.from("trades").update({
    status: "closed", close_price: exit, pnl: round2(pnl),
    close_reason: reason, closed_at: new Date().toISOString(),
  }).eq("id", t.id).eq("status", "open").select("id");
  if (e1 || !closedRow || closedRow.length === 0) return false; // already closed elsewhere — no-op, not an error
  acct.balance = round2(Number(acct.balance) + pnl);
  await logAudit(db, {
    trade_id: t.id, user_id: acct.user_id, account_id: acct.id, event: "close",
    symbol: t.symbol, side: t.side, requested_volume: Number(t.volume),
    requested_price: exit, fill_price: exit, quote: q ?? null,
    client_ip: reason === "manual" ? (clientIp ?? null) : null, // system-initiated closes (sl/tp/breach) have no human to attribute an IP to
  });
  fireMirror(acct, t, "close"); // mirror the close to the live account (if enabled)
  return true;
}

// Marks positions, applies SL/TP, daily rollover, breach/pass rules.
// Mutates acct in memory; persists account changes at the end.
async function enforce(db: Db, acct: Acct): Promise<{ open: Tr[]; equity: number; floating: number }> {
  const { data: openRows } = await db.from("trades")
    .select("*").eq("account_id", acct.id).eq("status", "open").order("opened_at");
  let open: Tr[] = openRows ?? [];

  // SL/TP auto-close (fills at the exact SL/TP level once the live bid/ask crosses it)
  if (acct.status === "active") {
    const still: Tr[] = [];
    for (const t of open) {
      const q = await fetchQuote(t.symbol);
      if (q === null || quoteStale(q)) { still.push(t); continue; }
      const ex = t.side === "buy" ? q.bid : q.ask; // the price that would actually fill a close
      const sl = t.sl === null ? null : Number(t.sl);
      const tp = t.tp === null ? null : Number(t.tp);
      let done = false;
      if (t.side === "buy") {
        if (sl !== null && ex <= sl) done = await closeTrade(db, acct, t, sl, "sl", q);
        else if (tp !== null && ex >= tp) done = await closeTrade(db, acct, t, tp, "tp", q);
      } else {
        if (sl !== null && ex >= sl) done = await closeTrade(db, acct, t, sl, "sl", q);
        else if (tp !== null && ex <= tp) done = await closeTrade(db, acct, t, tp, "tp", q);
      }
      if (!done) still.push(t);
    }
    open = still;
  }

  // Resting limit/stop orders are checked before marking to market, so a
  // fill this tick is included in the equity the rules are judged on.
  open = await processPendingOrders(db, acct, open, round2(Number(acct.balance)));

  // mark to market
  let floating = 0;
  for (const t of open) {
    const q = await fetchQuote(t.symbol);
    if (q === null || quoteStale(q)) continue;
    const mark = t.side === "buy" ? q.bid : q.ask;
    const pnl = await tradePnl(t, mark);
    if (pnl !== null) {
      floating += pnl;
      // deno-lint-ignore no-explicit-any
      (t as any).live_pnl = round2(pnl);
      // deno-lint-ignore no-explicit-any
      (t as any).mark = mark;
    }
  }
  let equity = round2(Number(acct.balance) + floating);

  const start = Number(acct.starting_balance);
  const todayUtc = new Date().toISOString().slice(0, 10);

  if (acct.status === "active") {
    // daily rollover (UTC). For trailing_eod accounts this is also the
    // ONLY moment the drawdown high-water mark is allowed to move —
    // that is exactly what "your drawdown locks in at end-of-day highs,
    // not intraday peaks" means on the Futures page.
    if (acct.day_start_date !== todayUtc) {
      if ((acct.drawdown_mode ?? "static") === "trailing_eod") {
        const prevPeak = Number(acct.trailing_peak ?? start);
        if (equity > prevPeak) acct.trailing_peak = round2(equity);
        acct.trailing_peak_date = todayUtc;
      }
      acct.day_start_date = todayUtc;
      acct.day_start_equity = equity;
      await db.from("equity_snapshots").insert({
        account_id: acct.id, user_id: acct.user_id, balance: acct.balance, equity,
      });
    }

    // ---- drawdown floor, by mode ----
    // total_paid_out shifts every floor down by whatever has already been
    // withdrawn via payout, so a payout is never itself read as a loss
    // (see add-payout-buffer.sql / admin-console payout_create).
    const mode = acct.drawdown_mode ?? "static";
    const ddAmount = start * Number(acct.max_drawdown_pct) / 100;
    const paidOut = Number(acct.total_paid_out ?? 0);
    let ddFloor: number;

    if (mode === "trailing_intraday") {
      // Peak follows live equity the moment a new high prints.
      const peak = Math.max(Number(acct.trailing_peak ?? start), equity);
      if (peak > Number(acct.trailing_peak ?? start)) acct.trailing_peak = round2(peak);
      ddFloor = round2(peak - ddAmount - paidOut);
    } else if (mode === "trailing_eod") {
      // Peak is frozen until the next daily rollover above, so an
      // intraday spike that gives the profit back never tightens the floor.
      const peak = Number(acct.trailing_peak ?? start);
      ddFloor = round2(peak - ddAmount - paidOut);
    } else {
      ddFloor = round2(start * (1 - Number(acct.max_drawdown_pct) / 100) - paidOut);
    }

    const dailyFloor = round2(Number(acct.day_start_equity) - start * Number(acct.daily_loss_pct) / 100);

    let breach: string | null = null;
    if (equity <= ddFloor) breach = "max_drawdown";
    else if (equity <= dailyFloor) breach = "daily_loss";

    if (breach) {
      for (const t of open) {
        const q = await fetchQuote(t.symbol);
        if (q !== null) {
          const exit = t.side === "buy" ? q.bid : q.ask;
          await closeTrade(db, acct, t, exit, "breach", q);
        }
      }
      const { data: leftover } = await db.from("trades")
        .select("*").eq("account_id", acct.id).eq("status", "open");
      open = leftover ?? [];
      floating = 0;
      equity = round2(Number(acct.balance));
      acct.status = "breached";
      acct.breach_reason = breach;
    } else if (
      acct.phase !== "funded" &&
      Number(acct.profit_target_pct) > 0 &&
      Number(acct.balance) >= round2(start * (1 + Number(acct.profit_target_pct) / 100)) &&
      open.length === 0
    ) {
      // Hitting the profit target is necessary but NOT sufficient. Before
      // this check existed a trader could clear a $25K Traditional in a
      // single trade on day one while the site advertised a 5-day minimum.
      // A funded account never "passes" again — it keeps running (and
      // accruing payout-eligible profit) until it is breached.
      const gate = await passGate(db, acct);
      if (gate.ok) {
        acct.status = "passed";
        await provisionNextStage(db, acct);
      }
      // Not passing yet is not a breach — the trader simply keeps trading
      // until the remaining requirements are met.
    }
  }

  await db.from("trading_accounts").update({
    balance: acct.balance, day_start_equity: acct.day_start_equity,
    day_start_date: acct.day_start_date, status: acct.status,
    breach_reason: acct.breach_reason,
    trailing_peak: acct.trailing_peak ?? null,
    trailing_peak_date: acct.trailing_peak_date ?? null,
    updated_at: new Date().toISOString(),
  }).eq("id", acct.id);

  return { open, equity, floating: round2(floating) };
}

async function usedMarginUsd(open: Tr[]): Promise<number> {
  let total = 0;
  for (const t of open) {
    const inst = INSTRUMENTS[t.symbol];
    const m = await mid(t.symbol);
    const conv = await usdPerQuote(inst.quote);
    if (m === null || conv === null) continue;
    total += (inst.contract * Number(t.volume) * m * conv) / LEVERAGE;
  }
  return total;
}

async function statePayload(db: Db, acct: Acct, open: Tr[], equity: number, floating: number) {
  const [{ data: closed }, { data: pending }] = await Promise.all([
    db.from("trades").select("*").eq("account_id", acct.id).eq("status", "closed")
      .order("closed_at", { ascending: false }).limit(30),
    db.from("pending_orders").select("*").eq("account_id", acct.id).eq("status", "pending")
      .order("created_at", { ascending: false }),
  ]);
  // Order ID per position: order_audit_events.id is this platform's Order
  // ID (see order-position-id-integrity.sql), trades.id is the Position
  // ID. A position can have several order events against it (open, an
  // SL/TP modify, a close) — the most recent one is what a trader means
  // by "the order" for that row, so later events win in this map.
  const allTradeIds = [...open.map((t) => t.id), ...(closed ?? []).map((t: Tr) => t.id)];
  const orderIdByTrade: Record<string, string> = {};
  if (allTradeIds.length) {
    const { data: events } = await db.from("order_audit_events")
      .select("id,trade_id,server_ts").in("trade_id", allTradeIds)
      .order("server_ts", { ascending: true });
    for (const e of events ?? []) {
      if (e.trade_id) orderIdByTrade[e.trade_id] = String(e.id);
    }
  }
  const withOrderId = (t: Tr) => ({ ...t, order_id: orderIdByTrade[t.id] ?? null });

  const start = Number(acct.starting_balance);
  const gate = await passGate(db, acct);

  // The drawdown floor shown must match the mode actually enforced, or
  // the trader is watching the wrong number.
  const mode = acct.drawdown_mode ?? "static";
  const ddAmount = start * Number(acct.max_drawdown_pct) / 100;
  const paidOut = Number(acct.total_paid_out ?? 0);
  const peak = Number(acct.trailing_peak ?? start);
  const ddFloor = mode === "static"
    ? round2(start * (1 - Number(acct.max_drawdown_pct) / 100) - paidOut)
    : round2(Math.max(peak, mode === "trailing_intraday" ? equity : peak) - ddAmount - paidOut);

  return {
    ok: true,
    account: {
      id: acct.id, label: acct.label, status: acct.status, breach_reason: acct.breach_reason,
      starting_balance: start, balance: Number(acct.balance), equity, floating,
      day_start_equity: Number(acct.day_start_equity),
      challenge_type: acct.challenge_type ?? "traditional",
      stage: Number(acct.stage ?? 1),
      phase: acct.phase ?? "evaluation",
      limits: {
        target_balance: Number(acct.profit_target_pct) > 0
          ? round2(start * (1 + Number(acct.profit_target_pct) / 100)) : null,
        max_dd_floor: ddFloor,
        drawdown_mode: mode,
        trailing_peak: mode === "static" ? null : round2(peak),
        daily_floor: round2(Number(acct.day_start_equity) - start * Number(acct.daily_loss_pct) / 100),
        max_risk_per_trade_pct: acct.max_risk_per_trade_pct ?? null,
        max_risk_per_trade_usd: acct.max_risk_per_trade_pct == null ? null
          : round2(start * Number(acct.max_risk_per_trade_pct) / 100),
        daily_profit_cap_usd: acct.daily_profit_cap_pct == null ? null
          : round2(start * Number(acct.daily_profit_cap_pct) / 100),
        require_stop_loss: !!acct.require_stop_loss,
      },
      // Everything still standing between this account and a pass.
      progress: {
        trading_days: gate.progress.trading_days,
        min_trading_days: Number(acct.min_trading_days ?? 0),
        trades_closed: gate.progress.trades_closed,
        min_trades: Number(acct.min_trades ?? 0),
        profitable_days_pct: gate.progress.profitable_days_pct,
        min_profitable_days_pct: acct.min_profitable_days_pct ?? null,
        requirements_met: gate.ok,
        unmet: gate.unmet,
      },
    },
    open_trades: open.map(withOrderId),
    closed_trades: (closed ?? []).map(withOrderId),
    pending_orders: pending ?? [],
  };
}

const err = (msg: string, code = 400) =>
  new Response(JSON.stringify({ ok: false, error: msg }), {
    status: code, headers: { ...CORS, "Content-Type": "application/json" },
  });

// Matches public.fn_sha256(text) exactly (encode(digest(input,'sha256'),'hex')
// — lowercase hex) so a bot token's hash always looks up the same row
// regardless of which side computed it.
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Turns a raw plpgsql RAISE EXCEPTION message (e.g. "too_soon:2.3 days
// since last payout, minimum 7 days") into a client-facing sentence.
// Postgres wraps our message as-is, so this just maps the leading code.
const RPC_ERROR_MESSAGES: Record<string, string> = {
  account_not_found: "Account not found.",
  not_funded: "You don't have a funded account yet.",
  account_not_in_good_standing: "Your account isn't in good standing.",
  investigation_hold: "Your account is under review — payouts are paused until this clears. Contact support.",
  kyc_not_verified: "Identity verification (KYC) must be completed before you can request a payout.",
  nothing_owed: "There's no payable profit yet on this account.",
  consistency_check_failed: "One trade accounts for too much of this period's profit — this needs manual review before payout.",
  payout_not_found: "Payout not found.",
  not_requested: "This payout has already moved past the requested stage.",
  not_approved: "This payout hasn't been approved yet.",
  insufficient_balance: "Account balance is too low to cover this payout.",
  cannot_void_paid: "A paid payout can't be voided.",
  already_void: "This payout is already void.",
};
function cleanRpcError(raw: string): string {
  const code = raw.split(":")[0].trim();
  if (code === "too_soon") return "Too soon since your last payout — " + raw.split(":")[1]?.trim();
  if (code === "below_minimum") return raw.split(":")[1]?.trim() ?? "Amount is below the minimum withdrawal.";
  return RPC_ERROR_MESSAGES[code] ?? raw;
}

// ---------- symbol tradeability (symbol_specs: enabled + max spread) ----------
async function symbolCheck(db: Db, symKey: string): Promise<{ ok: boolean; reason?: string; maxSpread?: number }> {
  const { data: spec } = await db.from("symbol_specs").select("enabled,disabled_reason,max_spread").eq("symbol", symKey).maybeSingle();
  if (spec && spec.enabled === false) return { ok: false, reason: spec.disabled_reason || "Symbol disabled" };
  return { ok: true, maxSpread: spec ? Number(spec.max_spread) : undefined };
}

// ---------- audit trail: every order-type action ----------
// order_audit_events.id (returned here) is this platform's Order ID —
// one row per action (open/modify/partial_close/close/reject/
// place_pending/cancel_pending) — distinct from trade_id, the Position
// ID. Returns the new row's id (the Order ID) on success, null on
// failure — logging must never block trading, so callers that don't
// need the id can and do ignore the return value.
async function logAudit(db: Db, row: {
  trade_id?: string | null; pending_order_id?: string | null; user_id: string; account_id: string;
  event: "open" | "close" | "reject" | "modify" | "partial_close" | "place_pending" | "cancel_pending";
  reject_reason?: string; symbol: string; side?: string | null; requested_volume?: number | null;
  requested_price?: number | null; fill_price?: number | null; quote?: Quote | null; client_ip?: string | null;
}): Promise<string | null> {
  try {
    const { data, error } = await db.from("order_audit_events").insert({
      trade_id: row.trade_id ?? null, pending_order_id: row.pending_order_id ?? null,
      user_id: row.user_id, account_id: row.account_id,
      event: row.event, reject_reason: row.reject_reason ?? null, symbol: row.symbol,
      side: row.side ?? null, requested_volume: row.requested_volume ?? null,
      requested_price: row.requested_price ?? null, fill_price: row.fill_price ?? null,
      bid: row.quote?.bid ?? null, ask: row.quote?.ask ?? null, spread: row.quote?.spread ?? null,
      quote_ts: row.quote?.providerTs ? new Date(row.quote.providerTs).toISOString() : null,
      server_ts: new Date().toISOString(),
      latency_ms: row.quote?.providerTs ? Date.now() - row.quote.providerTs : null,
      source_id: SOURCE_ID, client_ip: row.client_ip ?? null,
    }).select("id").single();
    // Audit logging must never block trading, so a failure here is swallowed
    // rather than surfaced to the caller — but it must not be swallowed
    // SILENTLY. The event-enum check constraint rejected every 'modify' insert
    // for months and nobody noticed, precisely because this path returned null
    // without a trace (see order-position-id-integrity.sql). The Supabase
    // client returns errors rather than throwing, so the catch below never
    // fired for that class of bug; `error` is the branch that actually matters.
    if (error) {
      console.error("[audit] order_audit_events insert failed", {
        event: row.event, symbol: row.symbol, account_id: row.account_id,
        code: (error as { code?: string }).code, message: error.message,
      });
      return null;
    }
    return data ? String(data.id) : null;
  } catch (e) {
    console.error("[audit] order_audit_events insert threw", {
      event: row.event, symbol: row.symbol, account_id: row.account_id,
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
// Best-effort client IP for multi-accounting detection (see
// shared_ip_accounts in prop-firm-hardening.sql). Deno Deploy/Supabase
// edge functions receive this from the platform, not the client
// directly — still spoofable in theory, so this is a lead to
// investigate, never sole grounds to act on.
function clientIpFrom(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? null;
}
async function logFeedEvent(db: Db, event: "stale" | "outage" | "reconnect" | "spike" | "bad_quote", symbol: string | null, detail: string) {
  try { await db.from("feed_health_events").insert({ source_id: SOURCE_ID, event, symbol, detail }); } catch (_) { /* best effort */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return err("POST only", 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return err("Invalid JSON"); }
  const clientIp = clientIpFrom(req);

  // ---- scheduled sweep: server-side breach enforcement independent of
  // whether any trader has a browser tab open. Without this, a position
  // could blow through its drawdown floor while the trader is offline and
  // sit unenforced until they next poll state() — by then price may have
  // moved back, silently erasing a breach that should have happened.
  // Called by pg_cron (see setup-drawdown-sweep-cron.sql), not by users:
  // authenticated by a shared secret header, never a user JWT.
  if (body.action === "sweep") {
    const secret = req.headers.get("x-cron-secret");
    const expected = Deno.env.get("CRON_SECRET");
    if (!expected || secret !== expected) return err("Not authorized", 401);

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: candidates } = await db.from("trading_accounts")
      .select("id")
      .eq("status", "active")
      .in("id", (await db.from("trades").select("account_id").eq("status", "open")).data?.map((r: { account_id: string }) => r.account_id) ?? []);

    const seen = new Set((candidates ?? []).map((c: { id: string }) => c.id));
    let breached = 0;
    for (const id of seen) {
      const { data: acct } = await db.from("trading_accounts").select("*").eq("id", id).maybeSingle();
      if (!acct) continue;
      const before = acct.status;
      await enforce(db, acct as Acct);
      if (before === "active") {
        const { data: after } = await db.from("trading_accounts").select("status").eq("id", id).maybeSingle();
        if (after?.status === "breached") breached++;
      }
    }
    return new Response(JSON.stringify({ ok: true, swept: seen.size, breached }),
      { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // privileged client for writes (bypasses RLS — server is the only writer)
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // authenticate the caller — either a normal signed-in session, or a
  // trader's own bot API token (ipfx_bot_... — see bot-api-token-rollout.sql).
  // A bot token only ever resolves to that same trader's auth_user_id, so
  // every downstream check (account ownership, RLS-equivalent filters by
  // user.id) applies identically regardless of which path authenticated it.
  //
  // The bot token travels in X-IPFX-Bot-Token, NOT Authorization: Supabase's
  // edge gateway rejects any Authorization value that isn't JWT-shaped
  // before a function's own code ever runs, so a bot caller must still send
  // the public anon key as a normal Bearer token in Authorization (exactly
  // like the browser already does) and put its real credential here instead.
  const authHeader = req.headers.get("Authorization") ?? "";
  const botTokenHeader = req.headers.get("X-IPFX-Bot-Token") ?? "";
  // deno-lint-ignore no-explicit-any
  let user: any = null;
  let authMethod: "session" | "bot" = "session";

  if (botTokenHeader.startsWith("ipfx_bot_")) {
    const bearer = botTokenHeader;
    authMethod = "bot";
    const tokenHash = await sha256Hex(bearer);
    const { data: tokenRow } = await db.from("api_token")
      .select("person_id, expires_at, revoked_at")
      .eq("token_hash_sha256", tokenHash)
      .maybeSingle();
    if (!tokenRow || tokenRow.revoked_at || (tokenRow.expires_at && new Date(tokenRow.expires_at) <= new Date())) {
      return err("Invalid or revoked API token", 401);
    }
    const { data: personRow } = await db.from("person")
      .select("auth_user_id").eq("id", tokenRow.person_id).maybeSingle();
    if (!personRow) return err("Invalid or revoked API token", 401);
    // Fetch the full auth user (not just the id) so every downstream code
    // path that reads user.user_metadata/user.email behaves identically
    // whether the caller came in via session or bot token.
    const { data: adminUser, error: adminErr } = await db.auth.admin.getUserById(personRow.auth_user_id);
    if (adminErr || !adminUser?.user) return err("Invalid or revoked API token", 401);
    user = adminUser.user;
  } else {
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user: sessionUser } } = await authClient.auth.getUser();
    user = sessionUser;
  }
  if (!user) return err("Not signed in", 401);

  // A bot token is scoped to trading only (api_token.scope_text:
  // 'trade:own_account') — a leaked key can move positions on that one
  // simulated account but can never touch payouts, KYC, or account
  // settings. Same restriction applies regardless of which action-name
  // format a given branch below checks (body.action vs the `action`
  // local declared further down — both read the same request body).
  const BOT_ALLOWED_ACTIONS = new Set([
    "state", "price", "prices", "open", "close", "close_all", "modify",
    "partial_close", "place_pending", "cancel_pending",
  ]);
  if (authMethod === "bot" && !BOT_ALLOWED_ACTIONS.has(body.action)) {
    return err("This API key is trade-only — it cannot access payouts, KYC, or account settings", 403);
  }

  // Live quote for the order ticket — no trading account needed. Reports
  // feed status honestly (closed/stale/demo) so the client can grey out
  // order buttons instead of pretending the feed is broker-grade.
  if (body.action === "price") {
    const symbol = cleanSymbol(body.symbol);
    if (!symbol) return err("Unknown instrument");
    const inst = INSTRUMENTS[symbol];
    if (!marketOpen()) {
      return new Response(JSON.stringify({ ok: true, symbol, status: "closed", digits: inst.digits }),
        { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const q = await fetchQuote(symbol);
    if (q === null) {
      await logFeedEvent(db, "outage", symbol, "fetchQuote returned null");
      return new Response(JSON.stringify({ ok: true, symbol, status: "no_feed", digits: inst.digits }),
        { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const stale = quoteStale(q);
    if (stale) await logFeedEvent(db, "stale", symbol, `age_ms=${Date.now() - (q.providerTs ?? q.receivedTs)}`);
    return new Response(JSON.stringify({
      ok: true, symbol, status: stale ? "stale" : "demo",
      mid: q.mid, bid: q.bid, ask: q.ask, spread: q.spread,
      quote_ts: q.providerTs, received_ts: q.receivedTs,
      digits: inst.digits, source: SOURCE_ID,
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Bulk quotes for a watchlist -- one round trip instead of the client
  // polling N symbols individually. Reuses fetchQuote(), which already
  // sits behind the 4s in-process cache, so this is cheap whenever
  // another request (this user's own ticket poll, or another user
  // watching the same symbol) has already warmed that symbol recently.
  // Fetched in parallel, capped at 40 symbols/request so one call can't
  // be used to hammer the upstream feed.
  if (body.action === "prices") {
    const raw = Array.isArray(body.symbols) ? body.symbols : [];
    const symbols = [...new Set(raw.map((s: unknown) => cleanSymbol(s)).filter((s): s is string => !!s))].slice(0, 40);
    if (!symbols.length) return err("No valid instruments requested");
    const closed = !marketOpen();
    const quotes = await Promise.all(symbols.map(async (symbol) => {
      const inst = INSTRUMENTS[symbol];
      if (closed) return { symbol, status: "closed" as const, digits: inst.digits };
      const q = await fetchQuote(symbol);
      if (q === null) return { symbol, status: "no_feed" as const, digits: inst.digits };
      const stale = quoteStale(q);
      return {
        symbol, status: (stale ? "stale" : "demo") as const,
        mid: q.mid, bid: q.bid, ask: q.ask, spread: q.spread, digits: inst.digits,
      };
    }));
    return new Response(JSON.stringify({ ok: true, quotes, source: SOURCE_ID }),
      { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // load or provision the active account
  let { data: acct } = await db.from("trading_accounts")
    .select("*").eq("user_id", user.id).eq("status", "active").maybeSingle();
  if (!acct) {
    // no active account: return most recent finished one for display, or provision
    const { data: last } = await db.from("trading_accounts")
      .select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(1).maybeSingle();

    if (last && last.status === "passed" && last.phase !== "funded") {
      // Defensive fallback: the funded account should already have been
      // provisioned by enforce() at the moment this row passed. If it
      // somehow wasn't (a row from before this existed, or a missed
      // race), provision it now rather than leaving the trader stuck.
      await provisionNextStage(db, last as Acct);
      const { data: nowActive } = await db.from("trading_accounts")
        .select("*").eq("user_id", user.id).eq("status", "active").maybeSingle();
      acct = nowActive ?? last;
    } else if (last && body.action === "state") {
      acct = last;
    } else if (!last) {
      // Account creation belongs to verified server-side enrollment, never
      // user-editable signup metadata or a browser state request.
      return err("Your challenge account has not been provisioned. Contact support before making another payment.", 403);
    } else {
      return err("No active account — your challenge is " + last.status, 409);
    }
  }

  const state = await enforce(db, acct as Acct);
  const action = body.action;

  if (action === "state") {
    return new Response(JSON.stringify(await statePayload(db, acct as Acct, state.open, state.equity, state.floating)),
      { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // ---- payouts: KYC status, payout methods, requesting a payout, history ----
  // These don't require the account to be "active" (a trader should be
  // able to check KYC status or manage payout methods between challenges),
  // so they're handled before the status gate below. The actual money
  // gates (funded, good standing, KYC verified, min days, consistency)
  // are enforced transactionally inside fn_request_payout — never trust
  // client-visible state for that, only the DB function's own re-check.
  const jsonOk = (b: Record<string, unknown>) => new Response(JSON.stringify({ ok: true, ...b }), { headers: { ...CORS, "Content-Type": "application/json" } });

  // App-level abuse guard for financially-sensitive actions — separate
  // from the business-rule gates inside fn_request_payout (7-day payout
  // cadence etc.), this is about spam (hammering an endpoint), not
  // eligibility. Always logs the attempt, then reports whether the
  // caller is currently over the limit.
  async function rateLimited(eventType: string, maxPerWindow: number, windowMinutes: number): Promise<boolean> {
    const since = new Date(Date.now() - windowMinutes * 60000).toISOString();
    const { count } = await db.from("security_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id).eq("event_type", eventType).gte("created_at", since);
    await db.from("security_events").insert({ user_id: user.id, event_type: eventType, ip_address: clientIp });
    return (count ?? 0) >= maxPerWindow;
  }

  if (action === "kyc_status") {
    const { data: kyc } = await db.from("trader_kyc").select("status,note,verified_at").eq("user_id", user.id).maybeSingle();
    return jsonOk({ status: kyc?.status ?? "unverified", note: kyc?.note ?? null, verified_at: kyc?.verified_at ?? null });
  }

  if (action === "list_payout_methods") {
    const { data } = await db.from("payout_methods").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    return jsonOk({ methods: data ?? [] });
  }

  if (action === "add_payout_method") {
    if (await rateLimited("add_payout_method", 10, 60)) return err("Too many payout-method changes — try again later.", 429);
    const method_type = String(body.method_type ?? "");
    const label = String(body.label ?? "").trim().slice(0, 80);
    const reference = String(body.reference ?? "").trim().slice(0, 120);
    if (!["bank_transfer", "paypal", "wire"].includes(method_type)) return err("Invalid method type");
    if (!label || !reference) return err("Label and reference are required");
    await db.from("payout_methods").update({ is_default: false }).eq("user_id", user.id);
    const { data, error } = await db.from("payout_methods").insert({
      user_id: user.id, method_type, label, reference, is_default: true,
    }).select("*").single();
    if (error) return err("Could not save payout method", 500);
    return jsonOk({ method: data });
  }

  if (action === "delete_payout_method") {
    const id = String(body.method_id ?? "");
    if (!id) return err("method_id required");
    await db.from("payout_methods").delete().eq("id", id).eq("user_id", user.id);
    return jsonOk({});
  }

  if (action === "list_payouts") {
    const { data } = await db.from("payouts").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(100);
    return jsonOk({ payouts: data ?? [] });
  }

  if (action === "payout_summary") {
    const { data: funded } = await db.from("trading_accounts")
      .select("*").eq("user_id", user.id).eq("phase", "funded").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!funded) return jsonOk({ has_funded_account: false });
    const { data: summary } = await db.from("trader_payout_summary").select("*").eq("account_id", funded.id).maybeSingle();
    const { data: kyc } = await db.from("trader_kyc").select("status").eq("user_id", user.id).maybeSingle();
    return jsonOk({
      has_funded_account: true, account_status: funded.status, total_paid_out: Number(funded.total_paid_out ?? 0),
      available_now: summary ? Number(summary.trader_share_owed) : 0,
      kyc_status: kyc?.status ?? "unverified", investigation_hold: !!funded.investigation_hold,
    });
  }

  if (action === "request_payout") {
    if (await rateLimited("request_payout", 5, 60)) return err("Too many payout requests — try again later.", 429);
    const { data: funded } = await db.from("trading_accounts")
      .select("*").eq("user_id", user.id).eq("phase", "funded").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!funded) return err("No funded account yet", 404);
    const payout_method_id = body.payout_method_id ? String(body.payout_method_id) : null;
    if (!payout_method_id) return err("Select a payout method first");
    const idem = typeof body.idempotency_key === "string" && body.idempotency_key ? body.idempotency_key : `req_${user.id}_${funded.id}_${Date.now()}`;

    const { data: result, error } = await db.rpc("fn_request_payout", {
      p_account_id: funded.id, p_requested_by: user.id, p_is_admin: false,
      p_idempotency_key: idem, p_payout_method_id: payout_method_id,
    });
    if (error) return err(cleanRpcError(error.message), 409);
    return jsonOk({ payout: result });
  }

  // ---- pending orders (limit / stop) ----
  if (action === "place_pending") {
    if ((acct as Acct).status !== "active") return err("Account is " + (acct as Acct).status, 409);
    const { data: platCfg } = await db.from("platform_config").select("trading_halted,halted_reason").eq("id", true).maybeSingle();
    if (platCfg?.trading_halted) return err("Trading is temporarily paused: " + (platCfg.halted_reason || "platform maintenance"), 503);

    const symbol = cleanSymbol(body.symbol);
    if (!symbol) return err("Unknown instrument");
    const side = body.side === "buy" || body.side === "sell" ? body.side : null;
    if (!side) return err("Side must be buy or sell");
    const orderType = body.order_type === "limit" || body.order_type === "stop" ? body.order_type : null;
    if (!orderType) return err("Order type must be limit or stop");
    const volume = Math.round(Number(body.volume) * 100) / 100;
    if (!isFinite(volume) || volume < 0.01 || volume > 100) return err("Volume must be 0.01–100 lots");
    const trigger = Number(body.trigger_price);
    if (!isFinite(trigger) || trigger <= 0) return err("Enter a valid trigger price");

    const { count: openPend } = await db.from("pending_orders")
      .select("id", { count: "exact", head: true })
      .eq("account_id", (acct as Acct).id).eq("status", "pending");
    if ((openPend ?? 0) >= MAX_OPEN_POSITIONS) return err(`Max ${MAX_OPEN_POSITIONS} resting orders`);

    // Reject a trigger that is already through the market — that is a
    // market order wearing a costume, and filling it at a stale trigger
    // would hand the trader a price that never existed.
    const q = await fetchQuote(symbol);
    if (q === null) return err("No live price for " + symbol, 503);
    if (!quoteStale(q)) {
      const px = side === "buy" ? q.ask : q.bid;
      const already = orderType === "limit"
        ? (side === "buy" ? px <= trigger : px >= trigger)
        : (side === "buy" ? px >= trigger : px <= trigger);
      if (already) return err(`That ${orderType} would trigger immediately at the current price (${px}). Use a market order, or move the trigger.`);
    }

    const lvl = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
    const sl = lvl(body.sl), tp = lvl(body.tp);
    if (sl !== null && (!isFinite(sl) || sl <= 0)) return err("Invalid stop loss");
    if (tp !== null && (!isFinite(tp) || tp <= 0)) return err("Invalid take profit");
    // Validate the levels against the TRIGGER, since that is the intended entry.
    if (sl !== null && ((side === "buy" && sl >= trigger) || (side === "sell" && sl <= trigger)))
      return err("Stop loss must be on the loss side of the trigger price");
    if (tp !== null && ((side === "buy" && tp <= trigger) || (side === "sell" && tp >= trigger)))
      return err("Take profit must be on the profit side of the trigger price");
    if ((acct as Acct).require_stop_loss && sl === null)
      return err("This challenge requires a stop-loss on every order.");

    const { data: created, error: pErr } = await db.from("pending_orders").insert({
      account_id: (acct as Acct).id, user_id: user.id, symbol, side,
      order_type: orderType, volume, trigger_price: trigger, sl, tp,
      expires_at: body.expires_at ? String(body.expires_at) : null,
    }).select("*").single();
    if (pErr) return err("Could not place the order", 500);
    const orderId = await logAudit(db, {
      pending_order_id: created.id, user_id: user.id, account_id: (acct as Acct).id, event: "place_pending",
      symbol, side, requested_volume: volume, requested_price: trigger, quote: q, client_ip: clientIp,
    });
    return jsonOk({ pending: created, order_id: orderId });
  }

  if (action === "cancel_pending") {
    const id = String(body.order_id ?? "");
    if (!id) return err("order_id required");
    const { data: upd } = await db.from("pending_orders")
      .update({ status: "cancelled", resolved_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", user.id).eq("status", "pending").select("*");
    if (!upd || !upd.length) return err("That order is no longer pending", 409);
    await logAudit(db, {
      pending_order_id: id, user_id: user.id, account_id: (acct as Acct).id, event: "cancel_pending",
      symbol: upd[0].symbol, side: upd[0].side, requested_volume: Number(upd[0].volume),
      requested_price: Number(upd[0].trigger_price), client_ip: clientIp,
    });
    return jsonOk({});
  }

  if ((acct as Acct).status !== "active") return err("Account is " + (acct as Acct).status, 409);

  if (action === "open") {
    // Platform kill switch: new orders only. Closing/flattening stays
    // allowed during a halt so traders can protect existing positions.
    const { data: platCfg } = await db.from("platform_config").select("trading_halted,halted_reason").eq("id", true).maybeSingle();
    if (platCfg?.trading_halted) return err("Trading is temporarily paused: " + (platCfg.halted_reason || "platform maintenance"), 503);

    const symbol = cleanSymbol(body.symbol);
    if (!symbol) return err("Unknown instrument");
    const side = body.side === "buy" || body.side === "sell" ? body.side : null;
    if (!side) return err("Side must be buy or sell");
    const volume = Math.round(Number(body.volume) * 100) / 100;
    if (!isFinite(volume) || volume < 0.01 || volume > 100) return err("Volume must be 0.01–100 lots");
    if (state.open.length >= MAX_OPEN_POSITIONS) return err("Max " + MAX_OPEN_POSITIONS + " open positions");

    const reject = async (reason: string, q?: Quote | null) => {
      await logAudit(db, {
        user_id: user.id, account_id: (acct as Acct).id, event: "reject", reject_reason: reason,
        symbol, side, requested_volume: volume, quote: q ?? null, client_ip: clientIp,
      });
      return err(reason, 409);
    };

    // fail-closed gates, in order: market session -> symbol enabled -> quote -> stale -> spread
    if (!marketOpen()) return reject("Market is closed for this instrument");
    const spec = await symbolCheck(db, symbol);
    if (!spec.ok) return reject(spec.reason || "Symbol disabled");

    const inst = INSTRUMENTS[symbol];
    const q = await fetchQuote(symbol);
    if (q === null) { await logFeedEvent(db, "outage", symbol, "open rejected: no quote"); return reject("No live price for " + symbol + " — order rejected"); }
    if (quoteStale(q)) { await logFeedEvent(db, "stale", symbol, "open rejected: stale quote"); return reject("Price feed is stale — order rejected"); }
    const maxSpread = spec.maxSpread ?? inst.maxSpread;
    if (q.spread > maxSpread) { await logFeedEvent(db, "spike", symbol, `spread ${q.spread} > max ${maxSpread}`); return reject("Spread too wide — order rejected", q); }

    const fill = side === "buy" ? q.ask : q.bid;

    // SL/TP sanity (must be on the correct side of the fill)
    let sl: number | null = body.sl === undefined || body.sl === null || body.sl === "" ? null : Number(body.sl);
    let tp: number | null = body.tp === undefined || body.tp === null || body.tp === "" ? null : Number(body.tp);
    if (sl !== null && (!isFinite(sl) || sl <= 0)) sl = null;
    if (tp !== null && (!isFinite(tp) || tp <= 0)) tp = null;
    if (sl !== null && ((side === "buy" && sl >= fill) || (side === "sell" && sl <= fill))) return err("SL must be on the loss side of entry");
    if (tp !== null && ((side === "buy" && tp <= fill) || (side === "sell" && tp >= fill))) return err("TP must be on the profit side of entry");

    // margin check
    const conv = await usdPerQuote(inst.quote);
    if (conv === null) return reject("No conversion rate — order rejected", q);

    // ---- challenge rule gates (see challenge-rules-engine.sql) ----
    const A = acct as Acct;
    const startBal = Number(A.starting_balance);

    // Daily profit cap (Infinity: 3%). Hitting it blocks new orders for
    // the rest of the UTC day — it is not a breach. Existing positions
    // can still be managed and closed.
    if (A.daily_profit_cap_pct != null) {
      const gain = await todayGain(db, A, state.equity);
      const cap = round2(startBal * Number(A.daily_profit_cap_pct) / 100);
      if (gain >= cap) {
        return reject(`Daily profit cap reached ($${cap.toFixed(2)}). New orders reopen at 00:00 UTC — you can still manage open positions.`, q);
      }
    }

    // A risk cap is unverifiable without a stop, so the two travel together.
    if (A.require_stop_loss && sl === null) {
      return reject("This challenge requires a stop-loss on every order.", q);
    }

    // Max risk per trade (Infinity: 1% of starting balance).
    if (A.max_risk_per_trade_pct != null && sl !== null) {
      const riskUsd = Math.abs(fill - sl) * inst.contract * volume * conv;
      const maxRisk = round2(startBal * Number(A.max_risk_per_trade_pct) / 100);
      if (riskUsd > maxRisk + 0.01) {
        return reject(
          `Risk on this order is $${riskUsd.toFixed(2)}, above the ${A.max_risk_per_trade_pct}% cap ($${maxRisk.toFixed(2)}). Reduce size or tighten the stop.`, q);
      }
    }
    const needed = (inst.contract * volume * q.mid * conv) / LEVERAGE;
    const used = await usedMarginUsd(state.open);
    if (used + needed > state.equity) return reject("Insufficient margin ($" + Math.round(needed) + " needed)", q);

    const { data: inserted, error } = await db.from("trades").insert({
      account_id: (acct as Acct).id, user_id: user.id, symbol, side, volume,
      open_price: fill, sl, tp,
    }).select("id").single();
    if (error) return reject("Order failed", q);

    await logAudit(db, {
      trade_id: inserted?.id, user_id: user.id, account_id: (acct as Acct).id, event: "open",
      symbol, side, requested_volume: volume, requested_price: fill, fill_price: fill, quote: q, client_ip: clientIp,
    });

    // mirror the open to the live account (fire-and-forget, if enabled)
    if (inserted?.id) {
      fireMirror(acct as Acct, { id: inserted.id, symbol, side, volume } as Tr, "open");
    }

    await db.from("equity_snapshots").insert({
      account_id: (acct as Acct).id, user_id: user.id, balance: (acct as Acct).balance, equity: state.equity,
    });
  } else if (action === "close") {
    const id = typeof body.trade_id === "string" ? body.trade_id : null;
    const target = state.open.find((t) => t.id === id);
    if (!target) return err("Position not found or already closed", 404);
    const q = await fetchQuote(target.symbol);
    if (q === null) return err("No live price — try again", 503);
    if (quoteStale(q)) { await logFeedEvent(db, "stale", target.symbol, "close rejected: stale quote"); return err("Price feed is stale — try again", 503); }
    const exit = target.side === "buy" ? q.bid : q.ask;
    const done = await closeTrade(db, acct as Acct, target, exit, "manual", q, clientIp);
    if (!done) return err("Close failed", 500);
  } else if (action === "close_all") {
    for (const t of state.open) {
      const q = await fetchQuote(t.symbol);
      if (q !== null && !quoteStale(q)) {
        const exit = t.side === "buy" ? q.bid : q.ask;
        await closeTrade(db, acct as Acct, t, exit, "manual", q, clientIp);
      }
    }

  // ---- modify: move the stop-loss / take-profit on a live position ----
  // Every real platform has this; IPFX Markets did not, so a trader who
  // wanted to move a stop had to close and re-enter at a worse price.
  } else if (action === "modify") {
    const id = typeof body.trade_id === "string" ? body.trade_id : null;
    const target = state.open.find((t) => t.id === id);
    if (!target) return err("Position not found or already closed", 404);
    const q = await fetchQuote(target.symbol);
    if (q === null) return err("No live price — try again", 503);
    if (quoteStale(q)) return err("Price feed is stale — try again", 503);

    const mark = target.side === "buy" ? q.bid : q.ask;
    const lvl = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
    const nsl = lvl(body.sl), ntp = lvl(body.tp);
    if (nsl !== null && (!isFinite(nsl) || nsl <= 0)) return err("Invalid stop loss");
    if (ntp !== null && (!isFinite(ntp) || ntp <= 0)) return err("Invalid take profit");
    if (nsl !== null && ((target.side === "buy" && nsl >= mark) || (target.side === "sell" && nsl <= mark)))
      return err("Stop loss must be on the loss side of the current price");
    if (ntp !== null && ((target.side === "buy" && ntp <= mark) || (target.side === "sell" && ntp >= mark)))
      return err("Take profit must be on the profit side of the current price");

    const A2 = acct as Acct;
    if (A2.require_stop_loss && nsl === null) return err("This challenge requires a stop-loss on every position.");
    // A widened stop must still respect the per-trade risk cap, measured
    // from the original entry — otherwise the cap is trivially bypassed
    // by opening tight and moving the stop out afterwards.
    if (A2.max_risk_per_trade_pct != null && nsl !== null) {
      const inst2 = INSTRUMENTS[target.symbol];
      const conv2 = await usdPerQuote(inst2.quote);
      if (conv2 !== null) {
        const riskUsd = Math.abs(Number(target.open_price) - nsl) * inst2.contract * Number(target.volume) * conv2;
        const maxRisk = round2(Number(A2.starting_balance) * Number(A2.max_risk_per_trade_pct) / 100);
        if (riskUsd > maxRisk + 0.01) {
          return err(`That stop implies $${riskUsd.toFixed(2)} of risk, above the ${A2.max_risk_per_trade_pct}% cap ($${maxRisk.toFixed(2)}).`);
        }
      }
    }

    const { error: mErr } = await db.from("trades").update({ sl: nsl, tp: ntp })
      .eq("id", target.id).eq("status", "open");
    if (mErr) return err("Could not modify position", 500);
    await logAudit(db, {
      trade_id: target.id, user_id: user.id, account_id: (acct as Acct).id, event: "modify",
      symbol: target.symbol, side: target.side, requested_volume: Number(target.volume),
      requested_price: mark, quote: q, client_ip: clientIp,
    });

  // ---- partial close: bank part of a winner, keep the rest running ----
  } else if (action === "partial_close") {
    const id = typeof body.trade_id === "string" ? body.trade_id : null;
    const target = state.open.find((t) => t.id === id);
    if (!target) return err("Position not found or already closed", 404);
    const vol = Math.round(Number(body.volume) * 100) / 100;
    const full = Number(target.volume);
    if (!isFinite(vol) || vol < 0.01) return err("Volume must be at least 0.01 lots");
    if (vol >= full) return err("To close the whole position use Close, not partial close");
    if (round2(full - vol) < 0.01) return err("Remaining position would be below the 0.01 lot minimum");

    const q = await fetchQuote(target.symbol);
    if (q === null) return err("No live price — try again", 503);
    if (quoteStale(q)) return err("Price feed is stale — try again", 503);
    const exit = target.side === "buy" ? q.bid : q.ask;

    // Claim the volume FIRST, conditioned on the position still being open
    // AND still at the volume we read it at (optimistic check — nothing
    // else, e.g. a concurrent full close, resized or closed it since).
    // Only once that atomic claim succeeds do we realize P&L and insert
    // the closed-slice trade. Doing this in the other order (as originally
    // written) let a concurrent full close land in the gap between the
    // insert and the shrink-update: the shrink would then silently match
    // zero rows while the phantom partial-close trade had already been
    // inserted and credited, double-counting that volume's P&L.
    const { data: claimed } = await db.from("trades")
      .update({ volume: round2(full - vol) })
      .eq("id", target.id).eq("status", "open").eq("volume", full)
      .select("id");
    if (!claimed || claimed.length === 0) {
      return err("This position changed (closed, modified, or partially closed elsewhere) — try again", 409);
    }

    const slice = { ...target, volume: vol } as Tr;
    const pnl = await tradePnl(slice, exit);
    if (pnl === null) {
      // Roll back the claim — we cannot price the close, so give the
      // volume back rather than leaving the position stuck short.
      await db.from("trades").update({ volume: full }).eq("id", target.id);
      return err("Could not price the close", 503);
    }

    const { data: closedSlice, error: insErr } = await db.from("trades").insert({
      account_id: (acct as Acct).id, user_id: user.id, symbol: target.symbol,
      side: target.side, volume: vol, open_price: target.open_price,
      sl: target.sl, tp: target.tp, status: "closed", close_price: exit,
      pnl: round2(pnl), close_reason: "partial", opened_at: target.opened_at,
      closed_at: new Date().toISOString(),
    }).select("id").single();
    if (insErr || !closedSlice) {
      await db.from("trades").update({ volume: full }).eq("id", target.id);
      return err("Could not record the partial close", 500);
    }

    // Atomic increment (balance = balance + pnl in one SQL statement, via
    // fn_adjust_balance) rather than read-then-write here: this call site
    // sits entirely outside enforce()'s own read-at-request-start/
    // write-at-request-end cycle, so a plain overwrite of acct.balance
    // would silently discard any concurrent balance change (a payout, a
    // different position closing) that happened in the gap.
    const { data: newBal, error: balErr } = await db.rpc("fn_adjust_balance", {
      p_account_id: (acct as Acct).id, p_delta: round2(pnl),
    });
    if (balErr) return err("Partial close filled but balance update failed — contact support", 500);
    (acct as Acct).balance = Number(newBal);
    // trade_id here is the CLOSED SLICE's own id (a distinct Position),
    // not target.id (the original position, which is still open at its
    // reduced volume) — a partial close creates a new closed position,
    // it doesn't mutate the existing open one into a closed one.
    await logAudit(db, {
      trade_id: closedSlice.id, user_id: user.id, account_id: (acct as Acct).id, event: "partial_close",
      symbol: target.symbol, side: target.side, requested_volume: vol,
      requested_price: exit, fill_price: exit, quote: q, client_ip: clientIp,
    });

  } else {
    return err("Unknown action");
  }

  // re-run rules after the mutation, snapshot, respond with fresh state
  const after = await enforce(db, acct as Acct);
  await db.from("equity_snapshots").insert({
    account_id: (acct as Acct).id, user_id: user.id, balance: (acct as Acct).balance, equity: after.equity,
  });
  return new Response(JSON.stringify(await statePayload(db, acct as Acct, after.open, after.equity, after.floating)),
    { headers: { ...CORS, "Content-Type": "application/json" } });
});
