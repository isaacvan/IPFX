// ============================================================
// IPFX Capital — trading-engine Edge Function v1
//
// All order flow goes through here. The browser never decides
// a fill price and never writes to the database.
//
// Actions (POST JSON):
//   { action: "state" }                                   -> account + positions + equity
//   { action: "open", symbol, side, volume, sl?, tp? }    -> market order
//   { action: "close", trade_id }                         -> close one position
//   { action: "close_all" }                               -> flatten
//
// Prices: Yahoo Finance (forex/metals/indices) and Binance
// (crypto), fetched server-side with a short cache. If no
// price is available the order is REJECTED — we never fill
// blind (fail closed).
//
// Rules enforced on every call:
//   - profit target  (realized balance >= start * (1 + target%))
//   - max drawdown   (equity <= start * (1 - maxDD%))  -> breach
//   - daily loss     (equity <= dayStart - start*daily%) -> breach
//   - SL/TP          (auto-close when crossed)
// On breach all open positions are closed and the account locks.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------- instrument registry ----------
type Inst = {
  src: "yahoo" | "binance";
  code: string;        // provider symbol
  alt?: string;        // fallback provider symbol (yahoo)
  digits: number;
  spread: number;      // full spread in price units
  contract: number;    // units per 1.00 lot (per point for indices)
  quote: string;       // quote currency for PnL conversion
};

const I = (src: "yahoo" | "binance", code: string, digits: number, spread: number, contract: number, quote = "USD", alt?: string): Inst =>
  ({ src, code, digits, spread, contract, quote, alt });

const INSTRUMENTS: Record<string, Inst> = {
  // forex — 100,000 units per lot
  EURUSD: I("yahoo", "EURUSD=X", 5, 0.0002, 100000),
  GBPUSD: I("yahoo", "GBPUSD=X", 5, 0.0003, 100000),
  USDJPY: I("yahoo", "USDJPY=X", 3, 0.03,   100000, "JPY"),
  AUDUSD: I("yahoo", "AUDUSD=X", 5, 0.0003, 100000),
  USDCAD: I("yahoo", "USDCAD=X", 5, 0.0003, 100000, "CAD"),
  USDCHF: I("yahoo", "USDCHF=X", 5, 0.0004, 100000, "CHF"),
  NZDUSD: I("yahoo", "NZDUSD=X", 5, 0.0004, 100000),
  GBPJPY: I("yahoo", "GBPJPY=X", 3, 0.05,   100000, "JPY"),
  EURJPY: I("yahoo", "EURJPY=X", 3, 0.04,   100000, "JPY"),
  EURGBP: I("yahoo", "EURGBP=X", 5, 0.0003, 100000, "GBP"),
  EURCAD: I("yahoo", "EURCAD=X", 5, 0.0005, 100000, "CAD"),
  AUDCAD: I("yahoo", "AUDCAD=X", 5, 0.0006, 100000, "CAD"),
  // metals — oz per lot
  XAUUSD: I("yahoo", "XAUUSD=X", 2, 0.30, 100,  "USD", "GC=F"),
  XAGUSD: I("yahoo", "XAGUSD=X", 3, 0.05, 5000, "USD", "SI=F"),
  XPTUSD: I("yahoo", "PL=F",     2, 0.80, 100),
  XPDUSD: I("yahoo", "PA=F",     2, 1.20, 100),
  // indices — $10 per index point per lot (CFD convention, uniform)
  SPXUSD: I("yahoo", "^GSPC",  1, 0.5, 10),
  NSXUSD: I("yahoo", "^NDX",   1, 1.5, 10),
  DJI:    I("yahoo", "^DJI",   0, 2.0, 10),
  UK100:  I("yahoo", "^FTSE",  1, 1.0, 10),
  GER40:  I("yahoo", "^GDAXI", 1, 1.5, 10),
  FRA40:  I("yahoo", "^FCHI",  1, 1.5, 10),
  JPN225: I("yahoo", "^N225",  0, 8.0, 10),
  US2000: I("yahoo", "^RUT",   1, 0.8, 10),
  // crypto — 1 coin per lot (USDT treated as USD)
  BTCUSD: I("binance", "BTCUSDT", 1, 50,    1),
  ETHUSD: I("binance", "ETHUSDT", 2, 2,     1),
  XRPUSD: I("binance", "XRPUSDT", 4, 0.001, 1),
  SOLUSD: I("binance", "SOLUSDT", 2, 0.25,  1),
  BNBUSD: I("binance", "BNBUSDT", 2, 0.5,   1),
};

const ALIASES: Record<string, string> = {
  BNBUSDT: "BNBUSD", US500: "SPXUSD", SPX500: "SPXUSD", NAS100: "NSXUSD", US30: "DJI",
};

const LEVERAGE = 100;
const MAX_OPEN_POSITIONS = 20;

function cleanSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.toUpperCase().replace(/^[A-Z]+:/, "").replace(/[^A-Z0-9]/g, "");
  if (ALIASES[s]) s = ALIASES[s];
  return INSTRUMENTS[s] ? s : null;
}

// ---------- price feed (server-side, cached, fail-closed) ----------
const priceCache = new Map<string, { p: number; t: number }>();
const CACHE_TTL_MS = 4000;

async function fetchYahoo(code: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?interval=1m&range=1d`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; IPFXEngine/1.0)" } });
    if (!r.ok) return null;
    const j = await r.json();
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof p === "number" && isFinite(p) && p > 0 ? p : null;
  } catch (_) { return null; }
}

async function fetchBinance(code: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${code}`);
    if (!r.ok) return null;
    const j = await r.json();
    const p = parseFloat(j?.price);
    return isFinite(p) && p > 0 ? p : null;
  } catch (_) { return null; }
}

async function mid(symKey: string): Promise<number | null> {
  const hit = priceCache.get(symKey);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.p;
  const inst = INSTRUMENTS[symKey];
  if (!inst) return null;
  let p = inst.src === "binance" ? await fetchBinance(inst.code) : await fetchYahoo(inst.code);
  if (p === null && inst.alt) p = await fetchYahoo(inst.alt);
  if (p === null) return null;
  priceCache.set(symKey, { p, t: Date.now() });
  return p;
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

// exit price for closing a position right now (crosses the spread)
function exitPrice(t: Tr, midPrice: number): number {
  const inst = INSTRUMENTS[t.symbol];
  return t.side === "buy" ? midPrice - inst.spread / 2 : midPrice + inst.spread / 2;
}

// ---------- types ----------
type Acct = {
  id: string; user_id: string; label: string;
  starting_balance: number; balance: number;
  profit_target_pct: number; max_drawdown_pct: number; daily_loss_pct: number;
  day_start_equity: number; day_start_date: string;
  status: string; breach_reason: string | null;
};
type Tr = {
  id: string; account_id: string; user_id: string; symbol: string;
  side: string; volume: number; open_price: number; close_price: number | null;
  sl: number | null; tp: number | null; status: string; pnl: number | null;
};

// deno-lint-ignore no-explicit-any
type Db = any;

// ---------- engine ----------
async function closeTrade(db: Db, acct: Acct, t: Tr, exit: number, reason: string): Promise<boolean> {
  const pnl = await tradePnl(t, exit);
  if (pnl === null) return false;
  const { error: e1 } = await db.from("trades").update({
    status: "closed", close_price: exit, pnl: round2(pnl),
    close_reason: reason, closed_at: new Date().toISOString(),
  }).eq("id", t.id).eq("status", "open");
  if (e1) return false;
  acct.balance = round2(Number(acct.balance) + pnl);
  return true;
}

// Marks positions, applies SL/TP, daily rollover, breach/pass rules.
// Mutates acct in memory; persists account changes at the end.
async function enforce(db: Db, acct: Acct): Promise<{ open: Tr[]; equity: number; floating: number }> {
  const { data: openRows } = await db.from("trades")
    .select("*").eq("account_id", acct.id).eq("status", "open").order("opened_at");
  let open: Tr[] = openRows ?? [];

  // SL/TP auto-close (idealized fill at the SL/TP level)
  if (acct.status === "active") {
    const still: Tr[] = [];
    for (const t of open) {
      const m = await mid(t.symbol);
      if (m === null) { still.push(t); continue; }
      const ex = exitPrice(t, m);
      const sl = t.sl === null ? null : Number(t.sl);
      const tp = t.tp === null ? null : Number(t.tp);
      let done = false;
      if (t.side === "buy") {
        if (sl !== null && ex <= sl) done = await closeTrade(db, acct, t, sl, "sl");
        else if (tp !== null && ex >= tp) done = await closeTrade(db, acct, t, tp, "tp");
      } else {
        if (sl !== null && ex >= sl) done = await closeTrade(db, acct, t, sl, "sl");
        else if (tp !== null && ex <= tp) done = await closeTrade(db, acct, t, tp, "tp");
      }
      if (!done) still.push(t);
    }
    open = still;
  }

  // mark to market
  let floating = 0;
  for (const t of open) {
    const m = await mid(t.symbol);
    if (m === null) continue;
    const pnl = await tradePnl(t, exitPrice(t, m));
    if (pnl !== null) {
      floating += pnl;
      // deno-lint-ignore no-explicit-any
      (t as any).live_pnl = round2(pnl);
      // deno-lint-ignore no-explicit-any
      (t as any).mark = exitPrice(t, m);
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

    const ddFloor = round2(start * (1 - Number(acct.max_drawdown_pct) / 100));
    const dailyFloor = round2(Number(acct.day_start_equity) - start * Number(acct.daily_loss_pct) / 100);

    let breach: string | null = null;
    if (equity <= ddFloor) breach = "max_drawdown";
    else if (equity <= dailyFloor) breach = "daily_loss";

    if (breach) {
      for (const t of open) {
        const m = await mid(t.symbol);
        if (m !== null) await closeTrade(db, acct, t, exitPrice(t, m), "breach");
      }
      const { data: leftover } = await db.from("trades")
        .select("*").eq("account_id", acct.id).eq("status", "open");
      open = leftover ?? [];
      floating = 0;
      equity = round2(Number(acct.balance));
      acct.status = "breached";
      acct.breach_reason = breach;
    } else if (Number(acct.balance) >= round2(start * (1 + Number(acct.profit_target_pct) / 100)) && open.length === 0) {
      acct.status = "passed";
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return err("POST only", 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return err("Invalid JSON"); }

  // authenticate the caller
  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return err("Not signed in", 401);

  // Live quote for the order ticket — no account needed. Returns real mid,
  // plus bid/ask derived from the instrument spread. Fails closed.
  if (body.action === "price") {
    const symbol = cleanSymbol(body.symbol);
    if (!symbol) return err("Unknown instrument");
    const inst = INSTRUMENTS[symbol];
    const m = await mid(symbol);
    if (m === null) return err("No live price", 503);
    return new Response(JSON.stringify({
      ok: true, symbol, mid: m,
      bid: m - inst.spread / 2, ask: m + inst.spread / 2,
      digits: inst.digits, spread: inst.spread,
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // privileged client for writes (bypasses RLS — server is the only writer)
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // load or provision the active account
  let { data: acct } = await db.from("trading_accounts")
    .select("*").eq("user_id", user.id).eq("status", "active").maybeSingle();
  if (!acct) {
    // no active account: return most recent finished one for display, or provision
    const { data: last } = await db.from("trading_accounts")
      .select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (last && body.action === "state") acct = last;
    else if (!last) {
      const { data: fresh, error } = await db.from("trading_accounts")
        .insert({ user_id: user.id }).select("*").single();
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

  if ((acct as Acct).status !== "active") return err("Account is " + (acct as Acct).status, 409);

  if (action === "open") {
    const symbol = cleanSymbol(body.symbol);
    if (!symbol) return err("Unknown instrument");
    const side = body.side === "buy" || body.side === "sell" ? body.side : null;
    if (!side) return err("Side must be buy or sell");
    const volume = Math.round(Number(body.volume) * 100) / 100;
    if (!isFinite(volume) || volume < 0.01 || volume > 100) return err("Volume must be 0.01–100 lots");
    if (state.open.length >= MAX_OPEN_POSITIONS) return err("Max " + MAX_OPEN_POSITIONS + " open positions");

    const inst = INSTRUMENTS[symbol];
    const m = await mid(symbol);
    if (m === null) return err("No live price for " + symbol + " — order rejected", 503);
    const fill = side === "buy" ? m + inst.spread / 2 : m - inst.spread / 2;

    // SL/TP sanity (must be on the correct side of the fill)
    let sl: number | null = body.sl === undefined || body.sl === null || body.sl === "" ? null : Number(body.sl);
    let tp: number | null = body.tp === undefined || body.tp === null || body.tp === "" ? null : Number(body.tp);
    if (sl !== null && (!isFinite(sl) || sl <= 0)) sl = null;
    if (tp !== null && (!isFinite(tp) || tp <= 0)) tp = null;
    if (sl !== null && ((side === "buy" && sl >= fill) || (side === "sell" && sl <= fill))) return err("SL must be on the loss side of entry");
    if (tp !== null && ((side === "buy" && tp <= fill) || (side === "sell" && tp >= fill))) return err("TP must be on the profit side of entry");

    // margin check
    const conv = await usdPerQuote(inst.quote);
    if (conv === null) return err("No conversion rate — order rejected", 503);
    const needed = (inst.contract * volume * m * conv) / LEVERAGE;
    const used = await usedMarginUsd(state.open);
    if (used + needed > state.equity) return err("Insufficient margin ($" + Math.round(needed) + " needed)");

    const { error } = await db.from("trades").insert({
      account_id: (acct as Acct).id, user_id: user.id, symbol, side, volume,
      open_price: fill, sl, tp,
    });
    if (error) return err("Order failed", 500);

    await db.from("equity_snapshots").insert({
      account_id: (acct as Acct).id, user_id: user.id, balance: (acct as Acct).balance, equity: state.equity,
    });
  } else if (action === "close") {
    const id = typeof body.trade_id === "string" ? body.trade_id : null;
    const target = state.open.find((t) => t.id === id);
    if (!target) return err("Position not found or already closed", 404);
    const m = await mid(target.symbol);
    if (m === null) return err("No live price — try again", 503);
    const done = await closeTrade(db, acct as Acct, target, exitPrice(target, m), "manual");
    if (!done) return err("Close failed", 500);
  } else if (action === "close_all") {
    for (const t of state.open) {
      const m = await mid(t.symbol);
      if (m !== null) await closeTrade(db, acct as Acct, t, exitPrice(t, m), "manual");
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
