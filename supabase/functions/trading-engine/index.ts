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
//   - profit target  (realized balance >= start * (1 + target%))
//   - max drawdown   (equity <= start * (1 - maxDD%))  -> breach
//   - daily loss     (equity <= dayStart - start*daily%) -> breach
//   - SL/TP          (auto-close when crossed)
// On breach all open positions are closed and the account locks.
//
// Every open/close/reject writes a row to order_audit_events with
// requested price, fill price, bid, ask, spread, quote timestamp,
// server timestamp, and latency — see logAudit().
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
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

async function fetchQuote(symKey: string): Promise<Quote | null> {
  const hit = quoteCache.get(symKey);
  if (hit && Date.now() - hit.receivedTs < CACHE_TTL_MS) return hit;
  const inst = INSTRUMENTS[symKey];
  if (!inst) return null;
  let raw = await fetchYahooRaw(inst.code);
  if (raw === null && inst.alt) raw = await fetchYahooRaw(inst.alt);
  if (raw === null) return null;
  const q: Quote = {
    symbol: symKey, mid: raw.price,
    bid: round6(raw.price - inst.spread / 2), ask: round6(raw.price + inst.spread / 2),
    spread: inst.spread, providerTs: raw.ts, receivedTs: Date.now(),
  };
  quoteCache.set(symKey, q);
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
};

// Challenge tier -> starting balance / fee, matching start-challenge.html.
// user_metadata.challenge_tier is set at signup; provisioning must honor
// whatever tier the trader actually paid for instead of the schema
// defaults (which are a flat $100K regardless of tier).
const TIER_BALANCE: Record<string, number> = { "10k": 10000, "25k": 25000, "50k": 50000, "100k": 100000, "200k": 200000 };
const TIER_FEE: Record<string, number> = { "10k": 79, "25k": 149, "50k": 249, "100k": 399, "200k": 699 };

// Called the moment an evaluation account passes. Idempotent: if a
// funded account already descends from this one, returns it instead of
// creating a second (protects against enforce() running twice in a race).
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
  const { error: e1 } = await db.from("trades").update({
    status: "closed", close_price: exit, pnl: round2(pnl),
    close_reason: reason, closed_at: new Date().toISOString(),
  }).eq("id", t.id).eq("status", "open");
  if (e1) return false;
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
    // daily rollover (UTC)
    if (acct.day_start_date !== todayUtc) {
      acct.day_start_date = todayUtc;
      acct.day_start_equity = equity;
      await db.from("equity_snapshots").insert({
        account_id: acct.id, user_id: acct.user_id, balance: acct.balance, equity,
      });
    }

    // total_paid_out shifts the max-drawdown floor down by whatever has
    // already been withdrawn via payout, so a payout is never itself
    // read as a loss (see add-payout-buffer.sql / admin-console payout_create).
    const ddFloor = round2(start * (1 - Number(acct.max_drawdown_pct) / 100) - Number(acct.total_paid_out ?? 0));
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
      Number(acct.balance) >= round2(start * (1 + Number(acct.profit_target_pct) / 100)) &&
      open.length === 0
    ) {
      // A funded account never "passes" again — it just keeps running
      // (and accruing payout-eligible profit) until it's breached.
      acct.status = "passed";
      await provisionFundedAccount(db, acct);
    }
  }

  await db.from("trading_accounts").update({
    balance: acct.balance, day_start_equity: acct.day_start_equity,
    day_start_date: acct.day_start_date, status: acct.status,
    breach_reason: acct.breach_reason, updated_at: new Date().toISOString(),
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
  const { data: closed } = await db.from("trades")
    .select("*").eq("account_id", acct.id).eq("status", "closed")
    .order("closed_at", { ascending: false }).limit(30);
  const start = Number(acct.starting_balance);
  return {
    ok: true,
    account: {
      id: acct.id, label: acct.label, status: acct.status, breach_reason: acct.breach_reason,
      starting_balance: start, balance: Number(acct.balance), equity, floating,
      day_start_equity: Number(acct.day_start_equity),
      limits: {
        target_balance: round2(start * (1 + Number(acct.profit_target_pct) / 100)),
        max_dd_floor: round2(start * (1 - Number(acct.max_drawdown_pct) / 100)),
        daily_floor: round2(Number(acct.day_start_equity) - start * Number(acct.daily_loss_pct) / 100),
      },
    },
    open_trades: open,
    closed_trades: closed ?? [],
  };
}

const err = (msg: string, code = 400) =>
  new Response(JSON.stringify({ ok: false, error: msg }), {
    status: code, headers: { ...CORS, "Content-Type": "application/json" },
  });

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

// ---------- audit trail: every open/close/reject ----------
async function logAudit(db: Db, row: {
  trade_id?: string | null; user_id: string; account_id: string; event: "open" | "close" | "reject";
  reject_reason?: string; symbol: string; side?: string | null; requested_volume?: number | null;
  requested_price?: number | null; fill_price?: number | null; quote?: Quote | null; client_ip?: string | null;
}) {
  try {
    await db.from("order_audit_events").insert({
      trade_id: row.trade_id ?? null, user_id: row.user_id, account_id: row.account_id,
      event: row.event, reject_reason: row.reject_reason ?? null, symbol: row.symbol,
      side: row.side ?? null, requested_volume: row.requested_volume ?? null,
      requested_price: row.requested_price ?? null, fill_price: row.fill_price ?? null,
      bid: row.quote?.bid ?? null, ask: row.quote?.ask ?? null, spread: row.quote?.spread ?? null,
      quote_ts: row.quote?.providerTs ? new Date(row.quote.providerTs).toISOString() : null,
      server_ts: new Date().toISOString(),
      latency_ms: row.quote?.providerTs ? Date.now() - row.quote.providerTs : null,
      source_id: SOURCE_ID, client_ip: row.client_ip ?? null,
    });
  } catch (_) { /* audit logging must never block trading */ }
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

  // authenticate the caller
  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return err("Not signed in", 401);

  // privileged client for writes (bypasses RLS — server is the only writer)
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

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
      await provisionFundedAccount(db, last as Acct);
      const { data: nowActive } = await db.from("trading_accounts")
        .select("*").eq("user_id", user.id).eq("status", "active").maybeSingle();
      acct = nowActive ?? last;
    } else if (last && body.action === "state") {
      acct = last;
    } else if (!last) {
      // Jurisdiction gate — Terms §5 excludes several jurisdictions.
      // Enforced here (not by aborting the signup trigger) so a failure
      // mode is a clean, expected rejection rather than a broken auth
      // flow. See prop-firm-hardening.sql.
      const { data: profile } = await db.from("user_profiles").select("restricted_jurisdiction").eq("user_id", user.id).maybeSingle();
      if (profile?.restricted_jurisdiction) {
        return err("Sorry — we can't offer challenges in your jurisdiction. Contact support@ipfxcapital.com if you believe this is incorrect.", 403);
      }

      const tier = String((user.user_metadata as Record<string, unknown> | undefined)?.challenge_tier ?? "100k").toLowerCase();
      const startBal = TIER_BALANCE[tier] ?? 100000;
      const fee = TIER_FEE[tier] ?? null;
      const { data: fresh, error } = await db.from("trading_accounts")
        .insert({
          user_id: user.id, label: tier.toUpperCase() + " Challenge",
          starting_balance: startBal, balance: startBal, day_start_equity: startBal,
          challenge_fee_usd: fee,
        }).select("*").single();
      if (error) return err("Could not provision account", 500);
      acct = fresh;
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
