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
import { sendLifecycleEmail } from "../_shared/lifecycle-email.ts";
import { insertAccountFromPreset as insertFromPresetShared } from "../_shared/provisioning.ts";
import { feedConfig, feedQuote, loadFeedInstruments, openFeedSession, type FeedInstrument, type FeedSession } from "../_shared/tradelocker-feed.ts";
import { CTraderStream, mapSymbols, PT as CT, signIn, type CTraderCreds } from "../_shared/ctrader-feed.ts";
import { decryptSecret, encryptSecret } from "../_shared/tradelocker-crypto.ts";
import { closedPositions, instrumentNames, readAccount, refresh as tlRefresh, jwtExpiresAt as tlJwtExpiresAt } from "../_shared/venue-tradelocker.ts";
import { closePosition as tlClosePosition } from "../_shared/tradelocker.ts";
import { TL_SYMBOLS } from "../_shared/tradelocker-feed.ts";
import { closeClaimAction, worseFill } from "../_shared/stp-fill.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-ipfx-bot-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "Server-Timing",
  "Timing-Allow-Origin": "*",
};

// The one official quote source. Must match a row in market_data_sources.
const SOURCE_ID = "fxcm-basic";

// ---------- instrument registry (forex, metals, indices — no crypto) ----------
type Inst = {
  code: string;        // provider symbol
  alt?: string;        // fallback provider symbol
  digits: number;
  spread: number;      // synthesized full spread in price units (testing feed has no real bid/ask)
  maxSpread: number;   // reject fills if effective spread exceeds this
  contract: number;    // units per 1.00 lot (per point for indices)
  quote: string;       // quote currency for PnL conversion
  cls: "forex" | "metal" | "index" | "crypto" | "future";
  maxContracts?: number; // futures only: most contracts per order
};

const I = (code: string, digits: number, spread: number, contract: number, cls: Inst["cls"], quote = "USD", alt?: string, maxSpread?: number): Inst =>
  ({ code, digits, spread, maxSpread: maxSpread ?? spread * 4, contract, quote, alt, cls });

// CME futures. `contract` is dollars per 1.00 of price (the contract multiplier),
// so profit = contract x contracts x price change. Spreads are 1-2 ticks
// (indicative: the feed has no real bid/ask). Micro contracts quote the same
// price as the full-size contract. Trade in whole contracts only.
const F = (code: string, digits: number, spread: number, contract: number, maxContracts: number): Inst =>
  ({ code, digits, spread, maxSpread: spread * 4, contract, quote: "USD", cls: "future", maxContracts });

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
  // crypto — 1 coin per lot (CFD convention), trades every day incl.
  // weekends: see marketOpen()'s crypto branch. Spreads are indicative
  // retail-CFD widths, not sourced from a live order book (this feed has
  // no real bid/ask -- see the "testing tier" note on fetchQuote below).
  BTCUSD: I("BTC-USD", 2, 25,   1, "crypto"),
  ETHUSD: I("ETH-USD", 2, 2.5,  1, "crypto"),
  LTCUSD: I("LTC-USD", 2, 0.5,  1, "crypto"),
  ADAUSD: I("ADA-USD", 4, 0.003,1, "crypto"),
  SOLUSD: I("SOL-USD", 2, 0.15, 1, "crypto"),
  DOTUSD: I("DOT-USD", 3, 0.02, 1, "crypto"),
  // CME futures (Futures Challenge accounts only)
  ES:  F("ES=F",  2, 0.25,     50, 20),  MES: F("MES=F", 2, 0.25,      5, 100),
  NQ:  F("NQ=F",  2, 0.50,     20, 20),  MNQ: F("MNQ=F", 2, 0.50,      2, 100),
  YM:  F("YM=F",  0, 2,         5, 20),  MYM: F("MYM=F", 0, 2,       0.5, 100),
  RTY: F("RTY=F", 1, 0.2,      50, 20),  M2K: F("M2K=F", 1, 0.2,       5, 100),
  CL:  F("CL=F",  2, 0.02,   1000, 20),  MCL: F("MCL=F", 2, 0.02,    100, 100),
  GC:  F("GC=F",  1, 0.2,     100, 20),  MGC: F("MGC=F", 1, 0.2,      10, 100),
  NG:  F("NG=F",  3, 0.004, 10000, 20),
  ZB:  F("ZB=F",  3, 0.03125, 1000, 20),
  ZN:  F("ZN=F",  3, 0.015625, 1000, 20),
};

// Futures rules: futures trade only on Futures Challenge accounts (and those
// accounts trade futures only); ZB/ZN are limited to $100K+ accounts, as advertised.
const FUTURES_MIN_BALANCE: Record<string, number> = { ZB: 100_000, ZN: 100_000 };
function instrumentGate(acct: { challenge_type?: string; starting_balance?: number }, symKey: string): string | null {
  const isFuture = INSTRUMENTS[symKey]?.cls === "future";
  const futuresAccount = (acct.challenge_type ?? "") === "futures";
  if (isFuture && !futuresAccount) return "CME futures can only be traded on a Futures Challenge account.";
  if (!isFuture && futuresAccount) return "Futures Challenge accounts trade CME futures only.";
  const min = FUTURES_MIN_BALANCE[symKey];
  if (min && Number(acct.starting_balance) < min) return `${symKey} is available on $100K and larger Futures accounts.`;
  return null;
}
// Futures trade in whole contracts; everything else in 0.01-100 lots.
function volumeError(symKey: string, volume: number): string | null {
  const inst = INSTRUMENTS[symKey];
  if (inst?.cls === "future") {
    const max = inst.maxContracts ?? 20;
    if (!isFinite(volume) || !Number.isInteger(volume) || volume < 1 || volume > max) return `Volume must be a whole number of contracts, 1-${max}`;
    return null;
  }
  if (!isFinite(volume) || volume < 0.01 || volume > 100) return "Volume must be 0.01–100 lots";
  return null;
}

// FXCM's public XML feed uses broker-facing names for the index CFDs.
const FXCM_SYMBOLS: Record<string, string> = {
  EURUSD: "EURUSD", GBPUSD: "GBPUSD", USDJPY: "USDJPY", AUDUSD: "AUDUSD",
  USDCAD: "USDCAD", USDCHF: "USDCHF", NZDUSD: "NZDUSD", GBPJPY: "GBPJPY",
  EURJPY: "EURJPY", EURGBP: "EURGBP", EURCAD: "EURCAD", AUDCAD: "AUDCAD",
  XAUUSD: "XAUUSD", XAGUSD: "XAGUSD",
  SPXUSD: "SPX500", NSXUSD: "NAS100", DJI: "US30", UK100: "UK100",
  GER40: "GER30", FRA40: "FRA40", JPN225: "JPN225", US2000: "US2000",
  BTCUSD: "BTCUSD", ETHUSD: "ETHUSD", LTCUSD: "LTCUSD",
};

const ALIASES: Record<string, string> = {
  US500: "SPXUSD", SPX500: "SPXUSD", NAS100: "NSXUSD", US30: "DJI",
};

const LEVERAGE = 100;
const MAX_OPEN_POSITIONS = 20;
// Terms 8.1: profit from trades closed under MIN_HOLD_SECONDS after opening does
// not count toward the profit target, for accounts opened on or after the
// effective date (14 days' notice per the Terms' amendment clause).
const MIN_HOLD_SECONDS = 60;
// Every rule and cost introduced with the September 2026 Terms update applies
// to accounts opened on or after this moment (Terms 14-day notice clause).
const RULES_V2_EFFECTIVE_MS = Date.parse("2026-10-01T00:00:00Z");
const rulesV2 = (acct: { created_at?: string | null }) =>
  Date.parse(String(acct.created_at ?? "")) >= RULES_V2_EFFECTIVE_MS;
// Execution model (Terms 7.10): market orders and trader-initiated closes fill
// after a short randomised delay at the less favourable of the arrival and
// execution prices, plus per-instrument slippage; commission is charged per
// lot on close. Costs are configured per symbol in symbol_specs.
const EXEC_DELAY_MIN_MS = 300;
const EXEC_DELAY_MAX_MS = 900;
const DEFAULT_COSTS: Record<string, { commissionPerLot: number; slippageBps: number }> = {
  forex: { commissionPerLot: 6, slippageBps: 0.3 },
  metal: { commissionPerLot: 6, slippageBps: 0.5 },
  index: { commissionPerLot: 0, slippageBps: 0.5 },
  crypto: { commissionPerLot: 0, slippageBps: 5 },
  future: { commissionPerLot: 4, slippageBps: 0.5 },
};
// Terms 7.7: total open risk (entry to stop, all positions) may not exceed this
// multiple of the per-trade risk cap.
const MAX_TOTAL_RISK_MULTIPLE = 3;
// Off-market tick filter: a quote that moves further than this fraction from
// the last accepted price within BAD_TICK_WINDOW_MS is dropped.
const BAD_TICK_MAX_MOVE: Record<string, number> = { forex: 0.01, metal: 0.03, index: 0.03, crypto: 0.08, future: 0.03 };
const BAD_TICK_WINDOW_MS = 60_000;
// Terms 8.1: no more than ORDER_BURST_LIMIT new orders per account per window.
const ORDER_BURST_LIMIT = 5;
const ORDER_BURST_WINDOW_MS = 10_000;

// ---------- futures session (CME hours, America/Chicago) ----------
// The futures programme is advertised as flat by 16:00 CT with no weekend
// positions. Enforced for accounts opened from the rules-v2 date.
function chicagoNow(now: Date): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hour12: false, weekday: "short", hour: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { weekday: get("weekday"), hour: Number(get("hour")) % 24 };
}
function futuresSessionOpen(now = new Date()): boolean {
  const { weekday, hour } = chicagoNow(now);
  if (weekday === "Sat") return false;              // closed all Saturday
  if (weekday === "Sun") return hour >= 17;         // reopens 17:00 CT Sunday
  if (weekday === "Fri") return hour < 16;          // closes 16:00 CT Friday
  return !(hour >= 16 && hour < 17);                // daily maintenance break
}
function futuresSessionEnforced(acct: Acct): boolean {
  return (acct.challenge_type ?? "") === "futures" && rulesV2(acct);
}

// ---------- market session (weekend closure) ----------
// Forex/metals/indices: closed Fri 17:00 -> Sun reopen, New York time (see spotMarketOpen).
// symbol is optional so existing callers that don't have one in scope
// keep the old forex-week behaviour unchanged. Crypto genuinely trades
// weekends -- unlike forex, there is no exchange to close -- so a
// crypto symbol skips the weekend closure
// entirely rather than reporting a market that, for that instrument,
// was never actually shut.
// New York wall clock. The spot week runs Sun 17:00 to Fri 17:00 New York time, so it moves by an
// hour in UTC with US daylight saving (21:00 UTC in summer, 22:00 UTC in winter).
const NY_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const NY_DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function nyClock(now = new Date()): { dow: number; mins: number } {
  const p = Object.fromEntries(NY_FMT.formatToParts(now).map((x) => [x.type, x.value]));
  return { dow: NY_DOW[p.weekday] ?? 0, mins: Number(p.hour) * 60 + Number(p.minute) };
}
// Spot FX, metals and index CFDs. Closed Fri 17:00 to Sun reopen (NY), plus the daily 17:00 NY
// rollover break (5 minutes for FX, an hour for metals and indices), when liquidity providers stop
// quoting. Without the break, the pause showed traders "Prices delayed" instead of "Market closed".
function spotMarketOpen(cls: Inst["cls"] | undefined, now = new Date()): boolean {
  const { dow, mins } = nyClock(now);
  const ROLL = 17 * 60, brk = cls === "metal" || cls === "index" ? 60 : 5;
  if (dow === 6) return false;
  if (dow === 5) return mins < ROLL;
  if (dow === 0) return mins >= ROLL + brk;
  return mins < ROLL || mins >= ROLL + brk;
}
function marketOpen(symbol?: string): boolean {
  if (symbol && INSTRUMENTS[symbol]?.cls === "crypto") return true;
  // CME Globex: Sun 17:00 CT to Fri 16:00 CT with a daily 16:00-17:00 CT break.
  if (symbol && INSTRUMENTS[symbol]?.cls === "future") return futuresSessionOpen();
  return spotMarketOpen(symbol ? INSTRUMENTS[symbol]?.cls : "forex");
}

function cleanSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.toUpperCase().replace(/^[A-Z]+:/, "").replace(/[^A-Z0-9]/g, "");
  if (ALIASES[s]) s = ALIASES[s];
  return INSTRUMENTS[s] ? s : null;
}

// ---------- price feed (server-side, cached, fail-closed) ----------
// FXCM basic live feed: genuine broker bid/ask, sampled through the public XML endpoint.
// Provider timestamps drive staleness so a cached-but-dead feed fails closed.
type Quote = { symbol: string; mid: number; bid: number; ask: number; spread: number; providerTs: number | null; receivedTs: number; source: string; feedTs?: number | null };
const quoteCache = new Map<string, Quote>();
const CACHE_TTL_MS = 750;
// Staleness is judged on the provider's own timestamp. Calibrated against the
// FXCM public feed (2026-09-17, London session): FX, metals and indices ran
// 2-4s behind at the median and under 10s at worst; crypto up to ~16s.
// The previous 30s allowance let traders act on prices up to half a minute old.
const STALE_MS = 8_000;
const STALE_MS_CRYPTO = 20_000;
// CME futures come from the free Yahoo feed (no broker bid/ask). Use a tight limit and
// replace this feed with a CME-grade one before paying out real money.
const STALE_MS_FUTURES = 15_000;

function fxcmTimestamp(last: string, receivedTs: number): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(last.trim());
  if (!m) return null;
  const d = new Date(receivedTs);
  d.setUTCHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
  let ts = d.getTime();
  if (ts > receivedTs + 60_000) ts -= 86_400_000;
  return ts;
}

// FXCM's <Last> is when that symbol's price last CHANGED, not when it was last confirmed. A quiet pair can
// go 10-20s without a change while the feed is perfectly alive, so liveness is judged on the newest <Last>
// across the whole feed (the heartbeat), and a single symbol only counts as stale once it has been silent
// for longer than SYMBOL_QUIET_MAX_MS (daily breaks, frozen instruments).
const SYMBOL_QUIET_MAX_MS = 60_000;
function fxcmFeedHeartbeat(xml: string, receivedTs: number): number | null {
  let newest: number | null = null;
  for (const m of xml.matchAll(/<Last>([^<]+)<\/Last>/g)) {
    const ts = fxcmTimestamp(m[1], receivedTs);
    if (ts !== null && (newest === null || ts > newest)) newest = ts;
  }
  return newest;
}

async function fetchFxcmRaw(symKey: string): Promise<{ bid: number; ask: number; ts: number | null; feedTs: number | null } | null> {
  const providerSymbol = FXCM_SYMBOLS[symKey];
  if (!providerSymbol) return null;
  try {
    const r = await fetch("https://rates.fxcm.com/RatesXML?ts=" + Date.now(), {
      headers: { "Accept": "application/xml", "Cache-Control": "no-cache", "User-Agent": "IPFXEngine/2.0" },
    });
    if (!r.ok) return null;
    const xml = await r.text();
    const block = new RegExp('<Rate\\s+Symbol="' + providerSymbol + '">([\\s\\S]*?)<\\/Rate>').exec(xml)?.[1];
    if (!block) return null;
    const read = (tag: string) => {
      const value = new RegExp("<" + tag + ">([^<]+)<\\/" + tag + ">").exec(block)?.[1];
      return value == null ? NaN : Number(value);
    };
    const bid = read("Bid"), ask = read("Ask");
    if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= bid) return null;
    const receivedTs = Date.now();
    const last = /<Last>([^<]+)<\/Last>/.exec(block)?.[1] ?? "";
    return { bid, ask, ts: fxcmTimestamp(last, receivedTs), feedTs: fxcmFeedHeartbeat(xml, receivedTs) };
  } catch (_) { return null; }
}

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
          feedTs: cached.feed_ts ? Date.parse(cached.feed_ts) : null,
          receivedTs: new Date(cached.received_at).getTime(),
          source: cached.source || (FXCM_SYMBOLS[symKey] ? "fxcm-basic" : "yahoo-demo"),
        };
        quoteCache.set(symKey, q);
        return q;
      }
    }
  } catch (_) { /* shared cache is an optimisation, never a hard dependency */ }

  let q: Quote;
  if (FXCM_SYMBOLS[symKey]) {
    const raw = await fetchFxcmRaw(symKey);
    if (raw === null) return null;
    const receivedTs = Date.now();
    q = {
      symbol: symKey, mid: round6((raw.bid + raw.ask) / 2),
      bid: round6(raw.bid), ask: round6(raw.ask),
      spread: round6(raw.ask - raw.bid), providerTs: raw.ts, feedTs: raw.feedTs, receivedTs, source: "fxcm-basic",
    };
  } else {
    let raw = await fetchYahooRaw(inst.code);
    if (raw === null && inst.alt) raw = await fetchYahooRaw(inst.alt);
    if (raw === null) return null;
    q = {
      symbol: symKey, mid: raw.price,
      bid: round6(raw.price - inst.spread / 2), ask: round6(raw.price + inst.spread / 2),
      spread: inst.spread, providerTs: raw.ts, receivedTs: Date.now(), source: "yahoo-demo",
    };
  }
  // Off-market tick filter: a price that jumps implausibly far from the last
  // accepted quote within a minute is dropped (fail closed) rather than
  // filling orders or triggering stops. A genuine move is accepted once the
  // last good quote is older than the window.
  const prev = quoteCache.get(symKey) ?? (await lastKnownQuote(symKey));
  if (prev && prev.mid > 0 && q.receivedTs - prev.receivedTs < BAD_TICK_WINDOW_MS) {
    const move = Math.abs(q.mid - prev.mid) / prev.mid;
    if (move > (BAD_TICK_MAX_MOVE[inst.cls] ?? 0.03)) return null;
  }
  quoteCache.set(symKey, q);
  try {
    const db2 = getCacheClient();
    await db2.from("live_quotes").upsert({
      symbol: symKey, mid: q.mid, bid: q.bid, ask: q.ask, spread: q.spread,
      provider_ts: q.providerTs ? new Date(q.providerTs).toISOString() : null,
      feed_ts: q.feedTs ? new Date(q.feedTs).toISOString() : null,
      received_at: new Date(q.receivedTs).toISOString(),
      source: q.source,
    });
  } catch (_) { /* best-effort write-through — a failed cache write must never block the quote itself */ }
  return q;
}
function round6(n: number) { return Math.round(n * 1e6) / 1e6; }

// ---------- low-latency quote path ----------
// warmQuotes(): ONE query loads every fresh row of the shared quote cache into this isolate's Map,
// so the rest of the request (enforce, marks, conversions, fills) never waits on a per-symbol read.
// The quote pump below keeps that cache no more than ~250ms behind the upstream feed.
const WARM_EVERY_MS = 150;
let lastWarmAt = 0;
async function warmQuotes(force = false): Promise<void> {
  if (!force && Date.now() - lastWarmAt < WARM_EVERY_MS) return;
  lastWarmAt = Date.now();
  try {
    const { data } = await getCacheClient().from("live_quotes").select("*");
    const now = Date.now();
    for (const row of data ?? []) {
      const receivedTs = Date.parse(row.received_at);
      if (!isFinite(receivedTs) || now - receivedTs >= CACHE_TTL_MS) continue;
      const cur = quoteCache.get(row.symbol);
      if (cur && cur.receivedTs >= receivedTs) continue;
      quoteCache.set(row.symbol, {
        symbol: row.symbol, mid: Number(row.mid), bid: Number(row.bid), ask: Number(row.ask), spread: Number(row.spread),
        providerTs: row.provider_ts ? Date.parse(row.provider_ts) : null, receivedTs,
        feedTs: row.feed_ts ? Date.parse(row.feed_ts) : null, 
        source: row.source || (FXCM_SYMBOLS[row.symbol] ? "fxcm-basic" : "yahoo-demo"),
      });
    }
  } catch (_) { /* optimisation only: fetchQuote still falls back per symbol */ }
}

// Quote pump: one FXCM download per tick covers every FXCM symbol. Runs as a background loop started by
// pg_cron every 30s (action "pump"), writes the shared cache in one upsert and pushes changed prices to
// the platform over private Realtime channels ("quotes:<SYMBOL>"). Trader requests never wait on FXCM.
const PUMP_INTERVAL_MS = 250;
const FXCM_REVERSE: Record<string, string[]> = {};
for (const [k, v] of Object.entries(FXCM_SYMBOLS)) (FXCM_REVERSE[v] ??= []).push(k);

async function pumpFxcmOnce(prev: Map<string, Quote>): Promise<{ rows: Record<string, unknown>[]; changed: Quote[] }> {
  const r = await fetch("https://rates.fxcm.com/RatesXML?ts=" + Date.now(), {
    headers: { "Accept": "application/xml", "Cache-Control": "no-cache", "User-Agent": "IPFXEngine/2.0" },
    signal: AbortSignal.timeout(2000),
  });
  if (!r.ok) return { rows: [], changed: [] };
  const xml = await r.text();
  const receivedTs = Date.now();
  const feedTs = fxcmFeedHeartbeat(xml, receivedTs);
  const rows: Record<string, unknown>[] = [];
  const changed: Quote[] = [];
  for (const m of xml.matchAll(/<Rate\s+Symbol="([^"]+)">([\s\S]*?)<\/Rate>/g)) {
    const keys = FXCM_REVERSE[m[1]];
    if (!keys) continue;
    const block = m[2];
    const bid = Number(/<Bid>([^<]+)<\/Bid>/.exec(block)?.[1]);
    const ask = Number(/<Ask>([^<]+)<\/Ask>/.exec(block)?.[1]);
    if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= bid) continue;
    const providerTs = fxcmTimestamp(/<Last>([^<]+)<\/Last>/.exec(block)?.[1] ?? "", receivedTs);
    for (const symKey of keys) {
      const inst = INSTRUMENTS[symKey];
      if (!inst) continue;
      const q: Quote = {
        symbol: symKey, mid: round6((bid + ask) / 2), bid: round6(bid), ask: round6(ask),
        spread: round6(ask - bid), providerTs, feedTs, receivedTs, source: "fxcm-basic",
      };
      // Same off-market tick filter as fetchQuote: an implausible jump is dropped until the last
      // accepted price is older than the window (the stale row then makes requests fail closed).
      const p = prev.get(symKey);
      if (p && p.mid > 0 && receivedTs - p.receivedTs < BAD_TICK_WINDOW_MS &&
        Math.abs(q.mid - p.mid) / p.mid > (BAD_TICK_MAX_MOVE[inst.cls] ?? 0.03)) continue;
      if (!p || p.bid !== q.bid || p.ask !== q.ask || p.providerTs !== q.providerTs) changed.push(q);
      prev.set(symKey, q);
      rows.push({
        symbol: symKey, mid: q.mid, bid: q.bid, ask: q.ask, spread: q.spread,
        provider_ts: providerTs ? new Date(providerTs).toISOString() : null,
        feed_ts: feedTs ? new Date(feedTs).toISOString() : null,
        received_at: new Date(receivedTs).toISOString(),
        source: "fxcm-basic",
      });
    }
  }
  return { rows, changed };
}

// Realtime push is billed per message (and per recipient). Push only symbols someone has open in IPFX Markets
// (quote_watch, refreshed by their price polls) and at most twice a second per symbol. Nobody watching = no
// messages. Polling still delivers every price, so this only trims duplicate pushes.
const PUSH_MIN_GAP_MS = 500;
const lastPushAt = new Map<string, number>();
let watched = new Set<string>(); let watchedAt = 0;
async function refreshWatched(db: Db): Promise<void> {
  if (Date.now() - watchedAt < 5_000) return;
  watchedAt = Date.now();
  const { data } = await db.from("quote_watch").select("symbol").gte("last_seen", new Date(Date.now() - 60_000).toISOString());
  watched = new Set((data ?? []).map((r: Record<string, unknown>) => String(r.symbol)));
}
const watchWrittenAt = new Map<string, number>();
function noteWatched(db: Db, symbol: string): void {
  const now = Date.now();
  if (now - (watchWrittenAt.get(symbol) ?? 0) < 20_000) return;
  watchWrittenAt.set(symbol, now);
  emailLater(Promise.resolve(db.from("quote_watch").upsert({ symbol, last_seen: new Date(now).toISOString() })).then(() => {}, () => {}));
}

async function broadcastQuotes(qs: Quote[]): Promise<void> {
  const now = Date.now();
  qs = qs.filter((q) => watched.has(q.symbol) && now - (lastPushAt.get(q.symbol) ?? 0) >= PUSH_MIN_GAP_MS);
  if (!qs.length) return;
  for (const q of qs) lastPushAt.set(q.symbol, now);
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  try {
    await fetch(Deno.env.get("SUPABASE_URL") + "/realtime/v1/api/broadcast", {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: qs.map((q) => ({
          topic: "quotes:" + q.symbol, event: "q", private: true,
          payload: { s: q.symbol, b: q.bid, a: q.ask, m: q.mid, sp: q.spread, pt: q.providerTs, rt: q.receivedTs, d: INSTRUMENTS[q.symbol]?.digits },
        })),
      }),
      signal: AbortSignal.timeout(2000),
    });
  } catch (_) { /* push is display-only; polling still delivers prices */ }
}

// ---------- IPFX hub (hub.ipfxcapital.com) ----------
// Each pump tick also sends the changed, watched prices to the hub, which streams them to traders' screens and
// watches open positions tick by tick. Fire-and-forget: never awaited, so the pump is never slowed. While a send
// is in flight, newer prices wait in a per-symbol map (latest wins); on failure they are retried after a pause.
const hubPending = new Map<string, Quote>();
let hubInFlight = false, hubPauseUntil = 0;
function pushToHub(qs: Quote[]): void {
  const url = Deno.env.get("HUB_INGEST_URL"), secret = Deno.env.get("HUB_SECRET");
  if (!url || !secret) return;
  for (const q of qs) if (watched.has(q.symbol)) hubPending.set(q.symbol, q);
  if (hubInFlight || !hubPending.size || Date.now() < hubPauseUntil) return;
  const batch = [...hubPending.values()];
  hubPending.clear();
  hubInFlight = true;
  fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", "x-hub-secret": secret },
    body: JSON.stringify({ q: batch.map((q) => ({ s: q.symbol, b: q.bid, a: q.ask, m: q.mid, sp: q.spread, pt: q.providerTs, rt: q.receivedTs, d: INSTRUMENTS[q.symbol]?.digits, src: q.source })) }),
    signal: AbortSignal.timeout(1500),
  }).then((r) => { if (!r.ok) hubPauseUntil = Date.now() + 2000; return r.body?.cancel(); })
    .catch(() => { hubPauseUntil = Date.now() + 5000; for (const q of batch) if (!hubPending.has(q.symbol)) hubPending.set(q.symbol, q); })
    .finally(() => { hubInFlight = false; });
}
function hubSecretOk(got: string | null): boolean {
  const want = Deno.env.get("HUB_SECRET") ?? "";
  const a = new TextEncoder().encode(got ?? ""), b = new TextEncoder().encode(want);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return want.length >= 32 && diff === 0;
}

// ---------- TradeLocker price source ----------
// Throttled record of which instruments traders are watching (one write per symbol per 5s per isolate).
const demandNotedAt = new Map<string, number>();
function noteDemand(symbol: string) {
  const now = Date.now();
  if (now - (demandNotedAt.get(symbol) ?? 0) < 5000) return;
  demandNotedAt.set(symbol, now);
  getCacheClient().from("quote_demand").upsert({ symbol, last_at: new Date(now).toISOString() }).then(() => {}, () => {});
}

// Most-traded first: when the request budget can't cover everything, these get TradeLocker prices first.
const TL_PRIORITY = ["EURUSD", "XAUUSD", "GBPUSD", "NSXUSD", "DJI", "USDJPY", "BTCUSD", "SPXUSD", "GER40", "ETHUSD",
  "AUDUSD", "USDCAD", "GBPJPY", "EURJPY", "XAGUSD", "USDCHF", "NZDUSD", "EURGBP", "UK100", "US2000", "JPN225",
  "FRA40", "EURCAD", "AUDCAD", "XPTUSD", "XPDUSD", "ADAUSD"];
const TL_FRESH_MS = 8_000;        // a TradeLocker price older than this is not served (FXCM takes over)
const TL_COVER_S = 5;             // every served instrument is re-fetched at least this often
const TL_MIN_RATE = 0.5, TL_START_RATE = 2;
type TlQuote = { bid: number; ask: number; changedAt: number; fetchedAt: number };

class TradeLockerFeed {
  rate = TL_START_RATE; maxRate = 8; tokens = 0; lastRefill = Date.now(); pausedUntil = 0; inFlight = 0; lastRampAt = 0; last429At = 0;
  quotes = new Map<string, TlQuote>(); lastFetch = new Map<string, number>(); pending: Quote[] = [];
  hot = new Set<string>(); hotAt = 0; served: string[] = [];
  stats = { fetches: 0, ok: 0, r429: 0, errors: 0, tlChanges: {} as Record<string, number>, fxChanges: {} as Record<string, number>, maxDiffBps: {} as Record<string, number> };
  constructor(public db: Db, public mode: "shadow" | "tradelocker", public sess: FeedSession, public instruments: FeedInstrument[], public runId: string, public leaseUntil: number) {}

  static async start(db: Db, mode: "shadow" | "tradelocker", connectionId: string | null, runId: string, until: number): Promise<TradeLockerFeed | null> {
    const nowIso = new Date().toISOString();
    const { data: got } = await db.from("price_feed_state").update({ lease_until: new Date(until + 1000).toISOString(), lease_owner: runId, updated_at: nowIso })
      .eq("id", true).or(`lease_until.is.null,lease_until.lt.${nowIso}`).select("*");
    if (!got || !got.length) return null;                          // another pump run holds the TradeLocker lease
    const st = got[0];
    try {
      const sess = await openFeedSession(db, connectionId);
      let instruments: FeedInstrument[] | null = Array.isArray(st.instruments) && st.instruments.length && st.instruments_at &&
        Date.now() - Date.parse(st.instruments_at) < 6 * 3600_000 ? st.instruments : null;
      let maxRate = Number(st.max_rate) || 0;
      if (!instruments) {
        instruments = await loadFeedInstruments(sess);
        try {
          const cfg = await feedConfig(sess) as { rateLimits?: { rateLimitType: string; measure: string; intervalNum: number; limit: number }[] };
          const q = (cfg.rateLimits ?? []).find((r) => r.rateLimitType === "QUOTES");
          if (q && q.measure === "SECONDS" && q.intervalNum > 0) maxRate = (q.limit / q.intervalNum) * 0.8;
        } catch (_) { /* keep the previous ceiling */ }
        await db.from("price_feed_state").update({ instruments, instruments_at: nowIso, max_rate: maxRate || null }).eq("id", true);
      }
      const f = new TradeLockerFeed(db, mode, sess, instruments, runId, until + 1000);
      f.maxRate = maxRate || 8;
      f.rate = Math.min(f.maxRate, Math.max(TL_MIN_RATE, Number(st.rate) || TL_START_RATE));
      f.last429At = st.last_429_at ? Date.parse(st.last_429_at) : 0;
      f.lastRampAt = Date.now();
      // Seed from the cache so a new run continues seamlessly where the previous one stopped.
      const { data: rows } = await db.from("live_quotes").select("symbol,bid,ask,provider_ts,feed_ts,source").eq("source", "tradelocker");
      for (const r of rows ?? []) {
        if (!r.feed_ts) continue;
        f.quotes.set(r.symbol, { bid: Number(r.bid), ask: Number(r.ask), changedAt: r.provider_ts ? Date.parse(r.provider_ts) : Date.parse(r.feed_ts), fetchedAt: Date.parse(r.feed_ts) });
        f.lastFetch.set(r.symbol, Date.parse(r.feed_ts));
      }
      await f.refreshHot();
      f.chooseServed(Array.isArray(st.tl_symbols) ? st.tl_symbols : []);
      return f;
    } catch (e) {
      await db.from("price_feed_state").update({ lease_until: nowIso, stats: { error: String(e).slice(0, 200), at: nowIso } }).eq("id", true);
      await logFeedEvent(db, "outage", null, "tradelocker feed start failed: " + String(e).slice(0, 150));
      throw e;                                                     // caller falls back to FXCM for this run
    }
  }

  // Instruments with open trades, resting orders or recent viewers.
  async refreshHot() {
    this.hotAt = Date.now();
    const since = new Date(Date.now() - 60_000).toISOString();
    const [t, p, d] = await Promise.all([
      this.db.from("trades").select("symbol").eq("status", "open").limit(2000),
      this.db.from("pending_orders").select("symbol").eq("status", "pending").limit(2000),
      this.db.from("quote_demand").select("symbol").gte("last_at", since),
    ]);
    this.hot = new Set([...(t.data ?? []), ...(p.data ?? []), ...(d.data ?? [])].map((r: { symbol: string }) => r.symbol));
  }

  // Which instruments TradeLocker serves this run. Sticky (no source flip-flopping); sized so every served
  // instrument is refreshed at least every TL_COVER_S using half the budget, leaving the rest for hot ones.
  chooseServed(previous: string[]) {
    const mapped = new Set(this.instruments.map((i) => i.symKey));
    if (this.mode === "shadow") { this.served = [...mapped]; return; }
    const cap = Math.max(1, Math.floor(this.rate * 0.5 * TL_COVER_S));
    const order = [...new Set([...previous.filter((s) => this.hot.has(s)), ...previous, ...TL_PRIORITY.filter((s) => this.hot.has(s)), ...TL_PRIORITY])]
      .filter((s) => mapped.has(s));
    this.served = order.slice(0, cap);
  }

  private pick(): FeedInstrument | null {
    const now = Date.now();
    let best: FeedInstrument | null = null, bestScore = -1;
    for (const i of this.instruments) {
      if (!this.served.includes(i.symKey)) continue;
      const age = now - (this.lastFetch.get(i.symKey) ?? 0);
      const score = age * (this.hot.has(i.symKey) ? 3 : 1);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  private async fetchOne(i: FeedInstrument, fxMid: number | null) {
    this.stats.fetches++;
    this.lastFetch.set(i.symKey, Date.now());
    try {
      const q = await feedQuote(this.sess, i);
      if (!q) return;
      this.stats.ok++;
      const now = Date.now();
      // Additive increase: +0.25 req/s for every 5s of clean operation (and 10s clear of the last 429).
      if (now - this.lastRampAt >= 5000 && now - this.last429At >= 10_000) { this.rate = Math.min(this.maxRate, this.rate + 0.25); this.lastRampAt = now; }
      const prev = this.quotes.get(i.symKey);
      const mid = (q.bid + q.ask) / 2;
      const inst = INSTRUMENTS[i.symKey];
      if (prev) {
        const pm = (prev.bid + prev.ask) / 2;
        if (pm > 0 && now - prev.fetchedAt < BAD_TICK_WINDOW_MS && Math.abs(mid - pm) / pm > (BAD_TICK_MAX_MOVE[inst?.cls ?? "forex"] ?? 0.03)) return;
      }
      const changed = !prev || prev.bid !== q.bid || prev.ask !== q.ask;
      this.quotes.set(i.symKey, { bid: q.bid, ask: q.ask, changedAt: changed ? now : prev!.changedAt, fetchedAt: now });
      if (changed) {
        this.stats.tlChanges[i.symKey] = (this.stats.tlChanges[i.symKey] ?? 0) + 1;
        this.pending.push({ symbol: i.symKey, mid: round6(mid), bid: round6(q.bid), ask: round6(q.ask), spread: round6(q.ask - q.bid), providerTs: now, feedTs: now, receivedTs: now, source: "tradelocker" });
      }
      if (fxMid && fxMid > 0) {
        const bps = Math.round(Math.abs(mid - fxMid) / fxMid * 1e5) / 10;
        this.stats.maxDiffBps[i.symKey] = Math.max(this.stats.maxDiffBps[i.symKey] ?? 0, bps);
      }
    } catch (e) {
      if (String(e).includes("TRADELOCKER_HTTP_429")) {
        this.stats.r429++; this.tokens = 0; this.last429At = Date.now();
        this.rate = Math.max(TL_MIN_RATE, this.rate * 0.5);
        this.pausedUntil = Date.now() + 1500;
      } else this.stats.errors++;
    }
  }

  // Called every pump tick: spend the request budget (token bucket), then hand back rows/changes to publish.
  async tick(fxRows: Record<string, unknown>[], fxChanged: Quote[]): Promise<{ rows: Record<string, unknown>[]; changed: Quote[] }> {
    const now = Date.now();
    if (now - this.hotAt > 5000) this.refreshHot().catch(() => {});
    this.tokens = Math.min(Math.max(1, this.rate), this.tokens + this.rate * (now - this.lastRefill) / 1000);
    this.lastRefill = now;
    const fxMid = new Map(fxRows.map((r) => [String(r.symbol), Number(r.mid)]));
    for (const c of fxChanged) this.stats.fxChanges[c.symbol] = (this.stats.fxChanges[c.symbol] ?? 0) + 1;
    while (now >= this.pausedUntil && this.tokens >= 1 && this.inFlight < 3) {
      const i = this.pick();
      if (!i) break;
      this.tokens -= 1; this.inFlight++;
      this.fetchOne(i, fxMid.get(i.symKey) ?? null).finally(() => { this.inFlight--; });
      this.lastFetch.set(i.symKey, now);
    }
    if (this.mode === "shadow") { this.pending = []; return { rows: fxRows, changed: fxChanged }; }
    // Serve TradeLocker for its instruments while fresh; FXCM (or Yahoo) remains the automatic fallback.
    const served = new Set(this.served.filter((s) => { const q = this.quotes.get(s); return q && now - q.fetchedAt < TL_FRESH_MS; }));
    const rows = fxRows.filter((r) => !served.has(String(r.symbol)));
    for (const s of served) {
      const q = this.quotes.get(s)!;
      rows.push({
        symbol: s, mid: round6((q.bid + q.ask) / 2), bid: round6(q.bid), ask: round6(q.ask), spread: round6(q.ask - q.bid),
        provider_ts: new Date(q.changedAt).toISOString(), feed_ts: new Date(q.fetchedAt).toISOString(),
        received_at: new Date(now).toISOString(), source: "tradelocker",
      });
    }
    const changed = [...fxChanged.filter((c) => !served.has(c.symbol)), ...this.pending.filter((c) => served.has(c.symbol))];
    this.pending = [];
    return { rows, changed };
  }

  async finish() {
    await this.db.from("price_feed_state").update({
      rate: this.rate, tl_symbols: this.served, lease_until: new Date().toISOString(),
      last_429_at: this.last429At ? new Date(this.last429At).toISOString() : undefined,
      stats: { ...this.stats, mode: this.mode, rate: this.rate, max_rate: this.maxRate, served: this.served, hot: [...this.hot], at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }).eq("id", true).eq("lease_owner", this.runId);
  }
}

// ---------- cTrader Open API price source (free, streaming) ----------
async function ctraderCreds(db: Db): Promise<CTraderCreds | null> {
  const clientId = Deno.env.get("CTRADER_CLIENT_ID"), clientSecret = Deno.env.get("CTRADER_CLIENT_SECRET");
  const envAccess = Deno.env.get("CTRADER_ACCESS_TOKEN") ?? "", envRefresh = Deno.env.get("CTRADER_REFRESH_TOKEN") ?? "";
  if (!clientId || !clientSecret || !envAccess) return null;
  let accessToken = envAccess, refreshToken = envRefresh;
  const key = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
  const { data: st } = await db.from("price_feed_state").select("ctrader_access_ct,ctrader_refresh_ct,ctrader_account_id,ctrader_env_hash").eq("id", true).maybeSingle();
  // Tokens refreshed by the server win, unless the owner has since set new tokens in the secrets.
  if (key && st?.ctrader_access_ct && st?.ctrader_refresh_ct && st.ctrader_env_hash === await sha256Hex(envAccess)) {
    accessToken = await decryptSecret(st.ctrader_access_ct, key);
    refreshToken = await decryptSecret(st.ctrader_refresh_ct, key);
  }
  const envAcc = Number(Deno.env.get("CTRADER_ACCOUNT_ID") || 0) || null;
  return { clientId, clientSecret, accessToken, refreshToken, accountId: envAcc ?? (st?.ctrader_account_id ? Number(st.ctrader_account_id) : null), host: Deno.env.get("CTRADER_HOST") || "demo.ctraderapi.com" };
}

class CTraderFeed {
  stream: CTraderStream; ids: Record<string, number> = {}; byId = new Map<number, string>();
  quotes = new Map<string, { bid: number; ask: number; changedAt: number }>(); pending: Quote[] = []; ready = false;
  constructor(host: string) { this.stream = new CTraderStream(host); }

  static async start(db: Db): Promise<CTraderFeed> {
    const creds = await ctraderCreds(db);
    if (!creds) throw new Error("CTRADER_NOT_CONFIGURED");
    const f = new CTraderFeed(creds.host);
    await f.stream.open();
    const { accountId, refreshed } = await signIn(f.stream, creds);
    const key = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
    const upd: Record<string, unknown> = { ctrader_account_id: accountId };
    if (refreshed && key) {
      upd.ctrader_access_ct = await encryptSecret(refreshed.accessToken, key);
      upd.ctrader_refresh_ct = await encryptSecret(refreshed.refreshToken, key);
      upd.ctrader_env_hash = await sha256Hex(Deno.env.get("CTRADER_ACCESS_TOKEN") ?? "");
    }
    const { data: st } = await db.from("price_feed_state").select("ctrader_symbols,ctrader_symbols_at").eq("id", true).maybeSingle();
    let ids: Record<string, number> | null = st?.ctrader_symbols && st.ctrader_symbols_at && Date.now() - Date.parse(st.ctrader_symbols_at) < 6 * 3600_000 ? st.ctrader_symbols : null;
    if (!ids || !Object.keys(ids).length) {
      const r = await f.stream.request(CT.SYMBOLS_LIST_REQ, { ctidTraderAccountId: accountId });
      ids = mapSymbols((r.symbol as { symbolId: number; symbolName?: string; enabled?: boolean }[]) ?? []);
      upd.ctrader_symbols = ids; upd.ctrader_symbols_at = new Date().toISOString();
    }
    await db.from("price_feed_state").update(upd).eq("id", true);
    f.ids = ids;
    for (const [k, v] of Object.entries(ids)) f.byId.set(Number(v), k);
    f.stream.onSpot = (symbolId, bid, ask) => {
      const k = f.byId.get(symbolId);
      if (!k) return;
      const prev = f.quotes.get(k);
      const b = bid ?? prev?.bid, a = ask ?? prev?.ask;       // spot events may carry only the side that moved
      if (b == null || a == null || !(a >= b) || b <= 0) return;
      const now = Date.now();
      if (prev) {
        const pm = (prev.bid + prev.ask) / 2, m = (b + a) / 2;
        if (pm > 0 && Math.abs(m - pm) / pm > (BAD_TICK_MAX_MOVE[INSTRUMENTS[k]?.cls ?? "forex"] ?? 0.03)) return;
        if (prev.bid === b && prev.ask === a) return;
      }
      f.quotes.set(k, { bid: b, ask: a, changedAt: now });
      f.pending.push({ symbol: k, mid: round6((a + b) / 2), bid: round6(b), ask: round6(a), spread: round6(a - b), providerTs: now, feedTs: now, receivedTs: now, source: "ctrader" });
    };
    await f.stream.request(CT.SUBSCRIBE_SPOTS_REQ, { ctidTraderAccountId: accountId, symbolId: Object.values(ids) });
    f.ready = true;
    return f;
  }

  alive(): boolean {
    return this.ready && this.stream.ws?.readyState === WebSocket.OPEN && Date.now() - this.stream.lastMessageAt < 30_000;
  }

  // Serve every mapped instrument from the stream while it is alive; FXCM/Yahoo otherwise.
  tick(fxRows: Record<string, unknown>[], fxChanged: Quote[], writeAll: boolean): { rows: Record<string, unknown>[]; changed: Quote[] } {
    if (!this.alive()) { this.pending = []; return { rows: fxRows, changed: fxChanged }; }
    const now = Date.now();
    const served = new Set([...this.quotes.keys()]);
    const changedNow = new Set(this.pending.map((q) => q.symbol));
    const rows = fxRows.filter((r) => !served.has(String(r.symbol)));
    for (const [k, q] of this.quotes) {
      if (!writeAll && !changedNow.has(k)) continue;             // unchanged rows are refreshed every 3rd tick
      rows.push({
        symbol: k, mid: round6((q.bid + q.ask) / 2), bid: round6(q.bid), ask: round6(q.ask), spread: round6(q.ask - q.bid),
        provider_ts: new Date(q.changedAt).toISOString(), feed_ts: new Date(now).toISOString(),
        received_at: new Date(now).toISOString(), source: "ctrader",
      });
    }
    const changed = [...fxChanged.filter((c) => !served.has(c.symbol)), ...this.pending];
    this.pending = [];
    return { rows, changed };
  }
}

async function runQuotePump(db: Db, durationMs: number): Promise<{ ticks: number; pushed: number }> {
  const until = Date.now() + durationMs;
  const runId = crypto.randomUUID();
  let feedMode: "fxcm" | "shadow" | "tradelocker" = "fxcm";
  let ctMode = false;
  let feedConn: string | null = null;
  try {
    const { data: cfg } = await db.from("platform_config").select("price_feed,price_feed_connection_id").eq("id", true).maybeSingle();
    if (cfg?.price_feed === "shadow" || cfg?.price_feed === "tradelocker") { feedMode = cfg.price_feed; feedConn = cfg.price_feed_connection_id ?? null; }
    if (cfg?.price_feed === "ctrader") ctMode = true;
  } catch (_) { /* default: FXCM only */ }
  let ct: CTraderFeed | null = null;
  let ctReserved = new Set<string>();
  const ctStartedAt = Date.now();
  if (ctMode) {
    try {
      const { data: st } = await db.from("price_feed_state").select("ctrader_symbols").eq("id", true).maybeSingle();
      ctReserved = new Set(Object.keys(st?.ctrader_symbols ?? {}));
    } catch (_) { /* nothing reserved */ }
    CTraderFeed.start(db).then((f) => { ct = f; }).catch(async (e) => {
      ctReserved = new Set();
      await logFeedEvent(db, "outage", null, "ctrader feed start failed: " + String(e).slice(0, 150));
    });
  }
  let tl: TradeLockerFeed | null = null;
  let nextLeaseTry = 0;
  let tlFailed = false;
  // While another run still holds the TradeLocker lease, don't overwrite its instruments with FXCM prices
  // (that would flip the source back and forth at every hand-over).
  let reserved = new Set<string>();
  if (feedMode === "tradelocker") {
    try {
      const { data: st } = await db.from("price_feed_state").select("tl_symbols").eq("id", true).maybeSingle();
      reserved = new Set(st?.tl_symbols ?? []);
    } catch (_) { /* nothing reserved */ }
  }
  const prev = new Map<string, Quote>();
  try {
    const { data: seed } = await db.from("live_quotes").select("*");
    for (const row of seed ?? []) {
      if (!FXCM_SYMBOLS[row.symbol]) continue;
      prev.set(row.symbol, {
        symbol: row.symbol, mid: Number(row.mid), bid: Number(row.bid), ask: Number(row.ask), spread: Number(row.spread),
        providerTs: row.provider_ts ? Date.parse(row.provider_ts) : null, receivedTs: Date.parse(row.received_at), source: "fxcm-basic",
      });
    }
  } catch (_) { /* no reference yet: the first tick seeds it */ }
  let ticks = 0, pushed = 0;
  while (Date.now() < until) {
    const t0 = Date.now();
    try {
      if (feedMode !== "fxcm" && !tl && !tlFailed && Date.now() >= nextLeaseTry) {
        nextLeaseTry = Date.now() + 1000;               // the previous run releases its lease as it ends
        try { tl = await TradeLockerFeed.start(db, feedMode, feedConn, runId, until); } catch (_) { tlFailed = true; }
      }
      // cTrader mode ticks every 100ms; FXCM (fallback) is still read every 3rd tick.
      const fxDue = !ctMode || ticks % 3 === 0;
      const fx = fxDue ? await pumpFxcmOnce(prev) : { rows: [] as Record<string, unknown>[], changed: [] as Quote[] };
      let out = fx;
      if (ctMode) {
        const ctNow = ct as CTraderFeed | null;
        if (ctNow) out = ctNow.tick(fx.rows, fx.changed, fxDue);
        else if (ctReserved.size && Date.now() - ctStartedAt < 4000) {
          out = { rows: fx.rows.filter((r) => !ctReserved.has(String(r.symbol))), changed: fx.changed.filter((c) => !ctReserved.has(c.symbol)) };
        }
      } else if (tl) out = await tl.tick(fx.rows, fx.changed);
      else if (feedMode === "tradelocker" && !tlFailed && reserved.size) {
        out = { rows: fx.rows.filter((r) => !reserved.has(String(r.symbol))), changed: fx.changed.filter((c) => !reserved.has(c.symbol)) };
      }
      const { rows, changed } = out;
      await refreshWatched(db).catch(() => {});
      if (changed.length) pushToHub(changed);
      if (rows.length) {
        await Promise.all([
          db.from("live_quotes").upsert(rows),
          broadcastQuotes(changed),
          // every price change, for the 1s / 15s / 30s chart candles (kept 6h)
          changed.length ? db.from("quote_ticks").insert(changed.map((q) => ({ symbol: q.symbol, ts: new Date(q.receivedTs).toISOString(), mid: q.mid, bid: q.bid, ask: q.ask }))) : null,
        ]);
        pushed += changed.length;
      }
    } catch (_) { /* one bad tick never stops the pump */ }
    ticks++;
    const wait = (ctMode && ct ? 100 : PUMP_INTERVAL_MS) - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  if (tl) await tl.finish().catch(() => {});
  if (ct) (ct as CTraderFeed).stream.close();
  return { ticks, pushed };
}
function quoteStale(q: Quote): boolean {
  const refTs = q.providerTs ?? q.receivedTs;
  const cls = INSTRUMENTS[q.symbol]?.cls;
  const limit = cls === "crypto" ? STALE_MS_CRYPTO : cls === "future" ? STALE_MS_FUTURES : STALE_MS;
  const now = Date.now();
  if ((q.source === "fxcm-basic" || q.source === "tradelocker" || q.source === "ctrader") && q.feedTs != null) {
    // Feed-level liveness first: if nothing in the whole FXCM feed has moved within the limit, fail closed.
    if (now - q.feedTs > limit) return true;
    // Feed alive: an unchanged price is still the current price, until the symbol has been silent too long.
    return now - refTs > Math.max(limit, SYMBOL_QUIET_MAX_MS);
  }
  return now - refTs > limit;
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
// Lifecycle emails never delay or fail the request that triggered them.
// Keep mirror delivery alive after returning the source close response.
function mirrorLater(p: Promise<unknown>) {
  const guarded = p.catch((error) => console.error(JSON.stringify({ event: "mirror_background_failed", error: String(error).slice(0, 160) })));
  try { EdgeRuntime.waitUntil(guarded); } catch (_) { /* local fallback: guarded promise is already running */ }
}
function emailLater(p: Promise<unknown>) {
  try { EdgeRuntime.waitUntil(p); } catch (_) { p.catch(() => {}); }
}

const BREACH_TEXT: Record<string, string> = {
  max_drawdown: "the maximum drawdown limit was reached",
  daily_loss: "the daily loss limit was reached",
  stop_loss_rule: "three trades were left without a stop loss in this Infinity run (3 stop-loss warnings)",
};
// Infinity stop-loss rule: 3 warnings in one run end it (restart from Stage 1).
const SL_STRIKES_MAX = 3;

// deno-lint-ignore no-explicit-any
type MirrorResult = Record<string, any> | null;
async function fireMirror(
  db: any, acct: Acct, t: Tr, event: "open" | "close", sourceRiskUsd: number | null = null,
  opts: { sync?: boolean; armed?: boolean } = {},
): Promise<MirrorResult> {
  // deno-lint-ignore no-explicit-any
  if (!opts.armed && !(acct as any).mirror_enabled) {
    // Disarming blocks new opens, but a copied position must still be closable.
    let targetQuery = db.from("mirror_targets").select("id").eq("source_account_id", acct.id);
    if (event === "open") targetQuery = targetQuery.eq("enabled", true);
    const { data: approvedTarget } = await targetQuery.limit(1).maybeSingle();
    if (!approvedTarget) return null;
  }
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  try {
    const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/live-mirror`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
        "apikey": serviceKey,
      },
      body: JSON.stringify({
        source_trade_id: t.id, user_id: acct.user_id, event,
        symbol: t.symbol, side: t.side, volume: Number(t.volume),
        sl: t.sl, tp: t.tp, open_price: t.open_price, source_risk_usd: sourceRiskUsd,
        ...(opts.sync ? { sync: true } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
    }
    const result = await response.json().catch(() => null);
    if (result?.ok === false) {
      await db.from("demo_mirror_outbox").update({ status: "needs_review", last_error: String(result.error || "broker outcome unknown").slice(0, 300), updated_at: new Date().toISOString() })
        .eq("source_trade_id", t.id).eq("event", event).eq("status", "pending");
      return result;
    }
    if (result?.ok === true && result.skipped !== "duplicate event") {
      // An accepted close is not proof that the exact position disappeared.
      // Opens without a mapped position likewise need broker reconciliation.
      const brokerConfirmedOpen = event === "open" && Boolean(result.positionId);
      const status = result.skipped ? "skipped" : brokerConfirmedOpen ? "acknowledged" : "pending";
      await db.from("demo_mirror_outbox").update({
        status,
        last_error: result.skipped ? String(result.skipped).slice(0, 300) :
          status === "pending" ? "waiting for exact broker position reconciliation" : null,
        next_attempt_at: status === "pending" ? new Date(Date.now() + 20_000).toISOString() : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
        .eq("source_trade_id", t.id).eq("event", event).eq("status", "pending");
    }
    return result;
  } catch (error) {
    const detail = `dispatch: ${String(error).slice(0, 280)}`;
    console.error(JSON.stringify({ event: "mirror_dispatch_failed", source_trade_id: t.id, detail }));
    await db.from("mirror_orders").insert({
      source_trade_id: t.id, user_id: acct.user_id, event,
      symbol: t.symbol, side: t.side, volume: Number(t.volume),
      status: "error", error: detail,
    });
    return null;
  }
}

// ---------- hedge-first execution (copied / A-book trades) ----------
// A copied trade's hedge is placed at the broker FIRST, inside the execution delay every order
// already has, and the trader is filled at the WORSE of the IPFX price and the broker's real fill
// (see _shared/stp-fill.ts). Per unit, the hedge then earns at least what the trader earns on every
// open and close. Accounts without a copy target are untouched (instant B-book path).
const HEDGE_SYNC_TIMEOUT_MS = 4_000;
// Waits up to timeoutMs for the hedge's broker result, but never aborts the request: a broker order
// that is already in flight must always finish and be recorded (an aborted call could leave a hedge
// open at the broker with no record of it). After the timeout the trader is filled at IPFX prices
// and the hedge completes in the background.
async function hedgeNow(db: Db, acct: Acct, t: Tr, event: "open" | "close", riskUsd: number | null, timeoutMs = HEDGE_SYNC_TIMEOUT_MS): Promise<MirrorResult> {
  const call = fireMirror(db, acct, t, event, riskUsd, { sync: true, armed: true });
  mirrorLater(call);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<MirrorResult>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try { return await Promise.race([call, timeout]); } finally { clearTimeout(timer); }
}
async function hedgeOpenArmed(db: Db, acct: Acct): Promise<boolean> {
  // deno-lint-ignore no-explicit-any
  if ((acct as any).venue && (acct as any).venue !== "ipfx") return false;
  const { data } = await db.from("mirror_targets").select("id").eq("source_account_id", acct.id).eq("enabled", true).limit(1).maybeSingle();
  return !!data;
}
type HedgeClose = { state: "none" } | { state: "busy" } | { state: "unhedged" } | { state: "filled"; price: number };
async function hedgeCloseFirst(db: Db, acct: Acct, t: Tr): Promise<HedgeClose> {
  const { data: openLeg } = await db.from("mirror_orders").select("id").eq("source_trade_id", t.id).eq("event", "open")
    .in("status", ["filled", "accepted_pending_position"]).not("idempotency_key", "is", null).limit(1).maybeSingle();
  if (!openLeg) return { state: "none" };
  const r = await hedgeNow(db, acct, t, "close", null);
  const price = Number(r?.fill_price);
  if (r?.ok === true && !r.skipped && price > 0) return { state: "filled", price };
  if (r?.skipped === "duplicate event") {
    const action = closeClaimAction(r.existing, Date.now());
    if (action === "use_price") return { state: "filled", price: Number(r.existing.fill_price) };
    if (action === "busy") return { state: "busy" };
  }
  console.error(JSON.stringify({ event: "hedge_close_unpriced", trade_id: t.id, result: r ? JSON.stringify(r).slice(0, 200) : null }));
  return { state: "unhedged" };
}

// ---------- A/B-book routing (book-executor) ----------
// A trader in AB_LIVE is copied (same direction, hedge-first) on the A-book destination; a trader in
// BB_LIVE is reversed on the B-book destination. The classifier sets the state; ab_route_for_user also
// requires a connected destination and no halt. Sizing and hard caps live in book-executor / the database.
async function abRoute(db: Db, userId: string): Promise<"a" | "b" | null> {
  const { data, error } = await db.rpc("ab_route_for_user", { p_user: userId });
  if (error) return null;
  return data === "a" || data === "b" ? data : null;
}
async function callBook(body: Record<string, unknown>): Promise<MirrorResult> {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/book-executor`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
      body: JSON.stringify(body),
    });
    return await r.json().catch(() => null);
  } catch (error) {
    console.error(JSON.stringify({ event: "book_executor_call_failed", body: JSON.stringify(body).slice(0, 200), error: String(error).slice(0, 160) }));
    return null;
  }
}
// Same never-abort rule as hedgeNow: an in-flight broker order always finishes and is recorded.
async function bookNow(body: Record<string, unknown>, timeoutMs = HEDGE_SYNC_TIMEOUT_MS): Promise<MirrorResult> {
  const call = callBook(body);
  mirrorLater(call);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<MirrorResult>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try { return await Promise.race([call, timeout]); } finally { clearTimeout(timer); }
}
function bookLater(body: Record<string, unknown>) { mirrorLater(callBook(body)); }
// Shadow copy (demo accounts at minimum size, scaled to funded size in the Brain). Only dispatched while at least
// one enabled demo copy account exists, so nothing is invoked before the owner connects them.
let shadowCache: { at: number; v: boolean } = { at: 0, v: false };
async function shadowOn(db: Db): Promise<boolean> {
  if (Date.now() - shadowCache.at < 30_000) return shadowCache.v;
  const { count } = await db.from("ladder_accounts").select("id", { count: "exact", head: true }).eq("role", "shadow").eq("execution_enabled", true).not("access_token_ciphertext", "is", null);
  shadowCache = { at: Date.now(), v: (count ?? 0) > 0 };
  return shadowCache.v;
}
function shadowLater(db: Db, body: Record<string, unknown>) {
  mirrorLater((async () => ((await shadowOn(db).catch(() => false)) ? await callBook(body) : null))());
}
async function bookLegs(db: Db, tradeId: string): Promise<{ a: boolean; b: boolean }> {
  const { data } = await db.from("book_orders").select("book").eq("source_trade_id", tradeId).eq("event", "open").in("status", ["filled", "reconciliation_required", "sent"]);
  const books = new Set<string>((data ?? []).map((r: Record<string, unknown>) => String(r.book)));
  // Same-direction legs: the A-book review account and every ladder account ('l<id>').
  return { a: [...books].some((x) => x === "a" || /^l[0-9]+$/.test(x)), b: books.has("b") };
}

// Board rule: every trade needs a stop loss within N seconds (ab_settings.sl_deadline_seconds; null = off).
let slDeadlineCache: { at: number; v: number | null } = { at: 0, v: null };
async function slDeadlineSeconds(db: Db): Promise<number | null> {
  if (Date.now() - slDeadlineCache.at < 30_000) return slDeadlineCache.v;
  const { data } = await db.from("ab_settings").select("sl_deadline_seconds").maybeSingle();
  slDeadlineCache = { at: Date.now(), v: data?.sl_deadline_seconds == null ? null : Number(data.sl_deadline_seconds) };
  return slDeadlineCache.v;
}

// ---------- types ----------
type Acct = {
  id: string; user_id: string; label: string;
  venue?: string; venue_equity?: number | null;
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
  created_at?: string;
  require_stop_loss?: boolean;
  breached_at?: string | null; breach_equity?: number | null; breach_floor?: number | null;
  access_revoked_at?: string | null; access_revoked_reason?: string | null;
};

const isDemoAccount = (acct: Acct) => acct.phase === "demo" && acct.status === "demo";
const isTradableAccount = (acct: Acct) => acct.status === "active" || isDemoAccount(acct);

// A fixed percentage cap alone still lets a trader gamble when only a small
// amount of loss room remains. Keep every new trade below the phase cap and
// below a conservative share of the live drawdown/daily buffers.
const DRAWDOWN_BUFFER_RISK_FRACTION = 0.20; // at least five full losses remain
const DAILY_BUFFER_RISK_FRACTION = 0.25;    // at least four full losses remain today
type EffectiveRiskLimit = {
  base: number; effective: number; drawdownRemaining: number; dailyRemaining: number;
};
function effectiveRiskLimit(acct: Acct, equityNow: number): EffectiveRiskLimit | null {
  if (acct.max_risk_per_trade_pct == null || isDemoAccount(acct)) return null;
  const start = Number(acct.starting_balance);
  const equity = Number(equityNow);
  const base = round2(start * Number(acct.max_risk_per_trade_pct) / 100);
  const ddAmount = start * Number(acct.max_drawdown_pct) / 100;
  const paidOut = Number(acct.total_paid_out ?? 0);
  const mode = acct.drawdown_mode ?? "static";
  const peak = mode === "trailing_intraday"
    ? Math.max(Number(acct.trailing_peak ?? start), equity)
    : Number(acct.trailing_peak ?? start);
  const ddFloor = mode === "static"
    ? start * (1 - Number(acct.max_drawdown_pct) / 100) - paidOut
    : peak - ddAmount - paidOut;
  const dayStart = Number(acct.day_start_equity ?? equity);
  const dailyFloor = dayStart - start * Number(acct.daily_loss_pct) / 100;
  const drawdownRemaining = round2(Math.max(0, equity - ddFloor));
  const dailyRemaining = round2(Math.max(0, equity - dailyFloor));
  const effective = round2(Math.max(0, Math.min(
    base,
    drawdownRemaining * DRAWDOWN_BUFFER_RISK_FRACTION,
    dailyRemaining * DAILY_BUFFER_RISK_FRACTION,
  )));
  return { base, effective, drawdownRemaining, dailyRemaining };
}

async function ensureDemoAccount(db: Db, userId: string): Promise<Acct> {
  const ensured = await db.rpc("fn_ensure_demo_account", { p_user_id: userId });
  if (ensured.error || !ensured.data) throw new Error("DEMO_ACCOUNT_UNAVAILABLE");
  const { data, error } = await db.from("trading_accounts").select("*")
    .eq("id", ensured.data).eq("user_id", userId).eq("phase", "demo")
    .eq("status", "demo").is("access_revoked_at", null).single();
  if (error || !data) throw new Error("DEMO_ACCOUNT_UNAVAILABLE");
  return data as Acct;
}

async function breachNotice(db: Db, acct: Acct) {
  const { data: event } = await db.from("account_breach_events")
    .select("reason,trigger_equity,breach_floor,triggered_at")
    .eq("account_id", acct.id).maybeSingle();
  const reason = String(event?.reason ?? acct.breach_reason ?? "rule_breach");
  const remaining = await db.from("trades").select("id", { count: "exact", head: true }).eq("account_id", acct.id).eq("status", "open");
  return {
    source_account_id: acct.id,
    label: acct.label,
    challenge_type: acct.challenge_type ?? "traditional",
    stage: Number(acct.stage ?? 1),
    phase: acct.phase ?? "evaluation",
    reason,
    reason_label: BREACH_TEXT[reason] ?? reason.replaceAll("_", " "),
    trigger_equity: Number(event?.trigger_equity ?? acct.breach_equity ?? acct.balance),
    breach_floor: Number(event?.breach_floor ?? acct.breach_floor ?? 0),
    breached_at: event?.triggered_at ?? acct.breached_at ?? null,
    open_positions_remaining: remaining.error ? null : (remaining.count ?? null),
  };
}

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
    // The funded account keeps the rule set the trader earned it under.
    // Without these it silently reverted to schema defaults: risk caps and
    // the stop-loss requirement disappeared, a trailing drawdown became a
    // static one, and challenge_fee_usd was lost — which is what the fee
    // credit (Terms 10.9) and the referral commission are calculated from.
    challenge_type: evalAcct.challenge_type ?? "traditional",
    stage: Number(evalAcct.stage ?? 1),
    drawdown_mode: evalAcct.drawdown_mode ?? "static",
    trailing_peak: startBal,
    max_risk_per_trade_pct: evalAcct.max_risk_per_trade_pct ?? null,
    daily_profit_cap_pct: evalAcct.daily_profit_cap_pct ?? null,
    require_stop_loss: !!evalAcct.require_stop_loss,
    challenge_fee_usd: evalAcct.challenge_fee_usd ?? null,
    // Minimum days/trades are pass requirements; a funded account never passes.
    min_trading_days: 0, min_trades: 0,
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
  conv: number, equityNow: number, usedMargin: number, openRisk: number | null = null,
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
    const limit = effectiveRiskLimit(acct, equityNow);
    const maxRisk = limit?.effective ?? round2(startBal * Number(acct.max_risk_per_trade_pct) / 100);
    if (riskUsd > maxRisk + 0.01) {
      return `Risk $${riskUsd.toFixed(2)} exceeds the current $${maxRisk.toFixed(2)} limit (base cap ${acct.max_risk_per_trade_pct}%; reduced as loss room is used)`;
    }
    if (openRisk !== null) {
      const cap = round2(maxRisk * MAX_TOTAL_RISK_MULTIPLE);
      if (openRisk + riskUsd > cap + 0.01) {
        return `Total open risk would be $${(openRisk + riskUsd).toFixed(2)}, above the limit ($${cap.toFixed(2)})`;
      }
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
  db: Db, acct: Acct, open: Tr[], equityNow: number, riskReady = true,
): Promise<Tr[]> {
  if (!isTradableAccount(acct)) return open;
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

    // Expiry still runs during a pricing outage, but no new position may
    // fill until the complete Infinity portfolio can be checked reliably.
    if (!riskReady) continue;

    const symbol = String(o.symbol);
    const inst = INSTRUMENTS[symbol];
    if (!inst) continue;
    const q = await fetchQuote(symbol);
    if (q === null || quoteStale(q)) continue;      // never fill on a bad quote
    if (!marketOpen(symbol)) continue;
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

    const takingAsk = o.side === "buy";
    const arrivalPx = takingAsk ? q.ask : q.bid;
    const v2 = rulesV2(acct);
    // A triggered stop order executes as a market order and can slip; a limit
    // order fills at its price or better.
    const fill = v2 && o.order_type === "stop"
      ? roundPrice(symbol, adverse(arrivalPx, takingAsk, spec.slippageBps))
      : arrivalPx;
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
    const openRisk = v2 ? await openRiskUsd(working) : null;
    const gate = ruleGate(acct, inst, Number(o.volume), fill, sl, conv, equityNow, usedMargin, openRisk);
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
      ...(v2 ? {
        decision_price: arrivalPx,
        execution_shortfall: await shortfallUsd(symbol, takingAsk, arrivalPx, fill, Number(o.volume)),
        pnl_basis: "NET_AFTER_COSTS",
      } : {}),
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
    // One-cancels-other: the first leg of an OCO group to fill cancels the rest.
    // (A unique index allows only one 'filled' row per group, so a racing leg can't also fill.)
    if (o.oco_group) {
      await db.from("pending_orders").update({
        status: "cancelled", reject_reason: "OCO: other leg filled", resolved_at: new Date().toISOString(),
      }).eq("oco_group", o.oco_group).eq("status", "pending").neq("id", o.id);
    }

    await logAudit(db, {
      trade_id: inserted.id, user_id: acct.user_id, account_id: acct.id, event: "open",
      symbol, side: String(o.side), requested_volume: Number(o.volume),
      requested_price: Number(o.trigger_price), fill_price: fill, quote: q,
    });
    const sourceRiskUsd = sl === null ? null : Math.abs(fill - sl) * inst.contract * Number(o.volume) * conv;
    const abBook = await abRoute(db, acct.user_id);
    if (abBook === "a" || await hedgeOpenArmed(db, acct)) {
      // Copied account: the hedge fills first; the trader's entry is no better than the broker's.
      const hedge = abBook === "a"
        ? await bookNow({ event: "open", book: "a", source_trade_id: inserted.id, risk_usd: sourceRiskUsd, price_scale_per_lot: inst.contract * conv })
        : await hedgeNow(db, acct, inserted as Tr, "open", sourceRiskUsd);
      const brokerFill = Number(hedge?.fill_price);
      if (brokerFill > 0) {
        const px = roundAdverse(symbol, worseFill(takingAsk, fill, brokerFill) ?? fill, takingAsk);
        if (px !== fill) {
          await db.from("trades").update({
            open_price: px,
            ...(v2 ? { execution_shortfall: await shortfallUsd(symbol, takingAsk, arrivalPx, px, Number(o.volume)) } : {}),
          }).eq("id", inserted.id).eq("status", "open");
          await db.from("pending_orders").update({ fill_price: px }).eq("id", o.id);
          inserted.open_price = px;
        }
      } else {
        console.error(JSON.stringify({ event: "hedge_open_unpriced", trade_id: inserted.id, result: hedge ? JSON.stringify(hedge).slice(0, 200) : null }));
      }
    } else {
      mirrorLater(fireMirror(db, acct, inserted as Tr, "open", sourceRiskUsd));
      if (abBook === "b") bookLater({ event: "open", book: "b", source_trade_id: inserted.id, risk_usd: sourceRiskUsd, price_scale_per_lot: inst.contract * conv });
    }
    shadowLater(db, { event: "shadow_open", source_trade_id: inserted.id, price_scale_per_lot: inst.contract * conv });
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

// Profit from winning trades closed under MIN_HOLD_SECONDS after opening.
// Partial closes keep the original opened_at, so splitting a position cannot
// reset the clock.
async function quickTradeProfit(db: Db, accountId: string): Promise<number> {
  const { data } = await db.from("trades").select("pnl,opened_at,closed_at")
    .eq("account_id", accountId).eq("status", "closed").gt("pnl", 0).limit(10000);
  let sum = 0;
  for (const t of data ?? []) {
    const heldSec = (Date.parse(t.closed_at) - Date.parse(t.opened_at)) / 1000;
    if (Number.isFinite(heldSec) && heldSec < MIN_HOLD_SECONDS) sum += Number(t.pnl);
  }
  return round2(sum);
}

async function orderBurstExceeded(db: Db, accountId: string): Promise<boolean> {
  const since = new Date(Date.now() - ORDER_BURST_WINDOW_MS).toISOString();
  const { count, error } = await db.from("order_audit_events")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId).in("event", ["open", "place_pending"]).gte("created_at", since);
  if (error) return false; // audit trouble must never halt trading
  return (count ?? 0) >= ORDER_BURST_LIMIT;
}

// Last price the feed actually printed for a symbol, however old.
async function lastKnownQuote(symKey: string): Promise<Quote | null> {
  try {
    const { data } = await getCacheClient().from("live_quotes").select("*").eq("symbol", symKey).maybeSingle();
    if (!data) return null;
    return {
      symbol: symKey, mid: Number(data.mid), bid: Number(data.bid), ask: Number(data.ask),
      spread: Number(data.spread),
      providerTs: data.provider_ts ? Date.parse(data.provider_ts) : null,
      feedTs: data.feed_ts ? Date.parse(data.feed_ts) : null,
      receivedTs: Date.parse(data.received_at),
      source: data.source || (FXCM_SYMBOLS[symKey] ? "fxcm-basic" : "yahoo-demo"),
    };
  } catch (_) { return null; }
}

// First account for a verified-email user holding a redeemed promo claim.
// Size and rules come from the claim's preset, never from signup metadata,
// and the fee is recorded as $0 so no fee credit or referral commission is
// ever paid on a free challenge.
type ProvisionResult = { ok: true; account: Acct } | { ok: false; error: string; status: number };

// Creates a fresh evaluation account from a preset (shared module) and sends
// the activation email without delaying the request.
// deno-lint-ignore no-explicit-any
async function insertAccountFromPreset(db: Db, userId: string, preset: any, feeUsd: number): Promise<Acct | null> {
  const account = await insertFromPresetShared(db, userId, preset, feeUsd);
  if (!account) return null;
  emailLater(sendLifecycleEmail(db, "challenge_activated", userId, {
    challenge_name: String(preset.label),
    account_size: "$" + Number(preset.starting_balance).toLocaleString("en-US"),
    trading_platform: "IPFX Markets",
  }));
  return account as Acct;
}

// Eligibility for the free Infinity Challenge (Terms 4.6): verified email,
// permitted jurisdiction, no active challenge, and at most the preset's
// monthly attempt cap of Stage 1 starts (a restart after failing counts).
// deno-lint-ignore no-explicit-any
async function infinityStatus(db: Db, user: any) {
  const { data: accts } = await db.from("trading_accounts")
    .select("id,status,challenge_type,preset_id,created_at,access_revoked_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  const list = accts ?? [];
  const hasActive = list.some((a: { status: string; access_revoked_at?: string | null }) => a.status === "active" && !a.access_revoked_at);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const used = list.filter((a: { preset_id: string | null; created_at: string }) =>
    a.preset_id === "infinity_s1" && a.created_at >= monthStart).length;
  const { data: preset } = await db.from("challenge_presets").select("*").eq("id", "infinity_s1").maybeSingle();
  const cap = Number(preset?.max_attempts_per_month ?? 1);
  const [{ data: profile }, { data: identity }, { data: application }, { data: kyc }, monthly] = await Promise.all([
    db.from("user_profiles").select("restricted_jurisdiction,age_confirmed").eq("user_id", user.id).maybeSingle(),
    db.from("trader_identity_private").select("user_id").eq("user_id", user.id).maybeSingle(),
    db.from("challenge_enrolment_requests").select("id,status,decision_note,trading_account_id")
      .eq("user_id", user.id).eq("preset_id", "infinity_s1").maybeSingle(),
    db.from("trader_kyc").select("status").eq("user_id", user.id).maybeSingle(),
    db.rpc("fn_infinity_breach_lockout", { p_user: user.id }),
  ]);
  if (monthly.error || !monthly.data) throw new Error("INFINITY_ELIGIBILITY_UNAVAILABLE");
  let reason: string | null = null;
  if (monthly.data.locked) reason = monthly.data.blocked_until
    ? "Account has been breached. Infinity restarts on " + new Date(monthly.data.blocked_until).toISOString().slice(0, 10) + " at 00:00 UTC."
    : "Account has been breached. Your restart date needs review.";
  else if (!preset) reason = "The Infinity Challenge is unavailable right now.";
  else if (!user.email_confirmed_at) reason = "Verify your email address first — check your inbox for the confirmation link.";
  else if (profile?.restricted_jurisdiction) reason = "Sorry — we can't offer challenges in your jurisdiction.";
  else if (!identity) reason = "Complete your identity and residential address before starting the challenge.";
  else if (!["pending", "verified"].includes(String(kyc?.status ?? ""))) reason = "Complete the identity-document application before starting the challenge.";
  else if (hasActive) reason = "You already have an active challenge. Finish it before starting another.";
  else if (used >= cap) reason = `You've used all ${cap} Infinity attempts this month. They reset on the 1st.`;
  return {
    eligible: reason === null, reason, preset,
    attempts_used: used, attempts_cap: cap, attempts_left: Math.max(0, cap - used),
    has_active: hasActive,
    identity_complete: !!identity,
    is_restart: list.some((a: { challenge_type: string }) => a.challenge_type === "infinity"),
    needs_age_confirmation: profile?.age_confirmed !== true,
    application_status: application?.status ?? null,
    application_note: application?.decision_note ?? null,
    application_id: application?.id ?? null,
    breach_lockout: monthly.data,
  };
}
// deno-lint-ignore no-explicit-any
async function provisionFromPromoClaim(db: Db, user: any): Promise<ProvisionResult> {
  const notProvisioned: ProvisionResult = {
    ok: false, status: 403,
    error: "You don't have an active challenge yet. Start the free Infinity Challenge from your dashboard, or choose a challenge on the website.",
  };
  if (!user?.email_confirmed_at) return notProvisioned;

  const { data: identity } = await db.from("trader_identity_private").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!identity) return { ok: false, status: 409, error: "Complete your identity and residential address before activating a challenge." };
  const { data: kyc } = await db.from("trader_kyc").select("status").eq("user_id", user.id).maybeSingle();
  if (!["pending", "verified"].includes(String(kyc?.status ?? ""))) {
    return { ok: false, status: 409, error: "Complete the challenge application and identity-document upload before activation." };
  }

  const { data: profile } = await db.from("user_profiles").select("restricted_jurisdiction").eq("user_id", user.id).maybeSingle();
  if (profile?.restricted_jurisdiction) {
    return { ok: false, status: 403, error: "Sorry — we can't offer challenges in your jurisdiction. Contact support@ipfxcapital.com if you believe this is incorrect." };
  }

  const { data: claim } = await db.from("challenge_claims").select("promo_code,challenge_type,account_type")
    .eq("user_id", user.id).not("promo_code", "is", null)
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!claim) return notProvisioned;

  const size = String(claim.challenge_type ?? "").toLowerCase();
  if (!/^\d{2,3}k$/.test(size)) return notProvisioned;
  const presetId = (claim.account_type === "futures" ? "fut_" : "trad_") + size + "_p1";
  const { data: preset } = await db.from("challenge_presets").select("*").eq("id", presetId).maybeSingle();
  if (!preset) {
    return { ok: false, status: 409, error: "Your promo challenge could not be set up automatically. Contact support@ipfxcapital.com." };
  }

  const { data: application } = await db.from("challenge_enrolment_requests")
    .select("id,status,decision_note,trading_account_id")
    .eq("user_id", user.id).eq("preset_id", presetId).maybeSingle();
  if (!application) {
    return { ok: false, status: 403, error: "Choose this challenge on the website and complete the identity-document application before review." };
  }
  if (application.status === "pending") {
    return { ok: false, status: 403, error: "Your challenge request is waiting for review. We aim to decide within 24 hours." };
  }
  if (application.status === "denied") {
    return { ok: false, status: 403, error: application.decision_note || "This challenge request was not approved." };
  }
  if (application.status !== "approved") return notProvisioned;
  if (application.trading_account_id) {
    const { data: existing } = await db.from("trading_accounts").select("*")
      .eq("id", application.trading_account_id).is("access_revoked_at", null).maybeSingle();
    if (existing) return { ok: true, account: existing as Acct };
  }
  const account = await insertAccountFromPreset(db, user.id, preset, 0);
  if (!account) return { ok: false, status: 500, error: "Could not provision account" };
  await db.from("trading_accounts").update({ approval_request_id: application.id }).eq("id", account.id);
  await db.from("challenge_enrolment_requests").update({
    trading_account_id: account.id, updated_at: new Date().toISOString(),
  }).eq("id", application.id);
  return { ok: true, account };
}

// The requirements that must ALL hold, alongside the profit target,
// before an evaluation account is allowed to pass. Returns the unmet
// items so the trader can be shown exactly what is left.
async function passGate(db: Db, acct: Acct): Promise<{ ok: boolean; unmet: string[]; progress: Progress; qualification: Record<string, unknown> | null }> {
  const p = await fetchProgress(db, acct.id);
  const unmet: string[] = [];
  const needDays = Number(acct.min_trading_days ?? 0);
  const needTrades = Number(acct.min_trades ?? 0);
  const needProfPct = acct.min_profitable_days_pct == null ? null : Number(acct.min_profitable_days_pct);

  if (p.trading_days < needDays) unmet.push(`${p.trading_days}/${needDays} trading days`);
  if (p.trades_closed < needTrades) unmet.push(`${p.trades_closed}/${needTrades} trades`);
  // Each Infinity account has a versioned qualification contract; the
  // pre-launch alignment also attaches v4 to existing test accounts.
  const qualification = await db.rpc("qualification_progress_v2", { p_account: acct.id });
  if (qualification.error || !qualification.data) unmet.push("Qualification verification unavailable");
  else if (qualification.data.applies && !qualification.data.eligible) {
    unmet.push(...(qualification.data.unmet ?? ["Extended qualification incomplete"]));
  }
  if (needProfPct !== null && (p.profitable_days_pct ?? 0) < needProfPct) {
    unmet.push(`${p.profitable_days_pct ?? 0}%/${needProfPct}% profitable days`);
  }
  if (rulesV2(acct)) {
    const quick = await quickTradeProfit(db, acct.id);
    const target = round2(Number(acct.starting_balance) * (1 + Number(acct.profit_target_pct) / 100));
    if (quick > 0 && round2(Number(acct.balance) - quick) < target) {
      unmet.push(`$${quick.toFixed(2)} of profit came from trades held under ${MIN_HOLD_SECONDS}s and does not count toward the target`);
    }
  }
  return { ok: unmet.length === 0, unmet, progress: p, qualification: qualification.error ? null : qualification.data as Record<string, unknown> | null };
}

// Realized + floating P&L for the current UTC day. Used by each account's
// accepted daily profit cap, which blocks NEW orders once hit rather
// than breaching the account — hitting a profit cap is not a failure.
async function todayGain(db: Db, acct: Acct, equity: number): Promise<number> {
  return round2(equity - Number(acct.day_start_equity));
}
type Tr = {
  id: string; account_id: string; user_id: string; symbol: string;
  side: string; volume: number; open_price: number; close_price: number | null;
  sl: number | null; tp: number | null; status: string; pnl: number | null; opened_at: string;
  trail_distance?: number | null;
};

// deno-lint-ignore no-explicit-any
type Db = any;

// ---------- engine ----------
async function closeTrade(
  db: Db, acct: Acct, t: Tr, exit: number, reason: string, q?: Quote | null, clientIp?: string | null,
  exec?: { shortfallUsd?: number },
): Promise<boolean> {
  // Copied trade: close the hedge first and fill the trader no better than the broker did.
  const legs = await bookLegs(db, t.id);
  let hedge: HedgeClose;
  if (legs.a) {
    const r = await bookNow({ event: "close", source_trade_id: t.id });
    if (r?.duplicate_a === true) return false; // another request is closing this hedge right now
    const px = Number(r?.fill_price);
    hedge = px > 0 ? { state: "filled", price: px } : { state: "unhedged" };
  } else {
    hedge = await hedgeCloseFirst(db, acct, t);
  }
  if (hedge.state === "busy") return false; // another request is closing this hedge right now
  if (hedge.state === "filled") {
    const takingAsk = t.side === "sell"; // closing a sell buys at the ask
    const worse = worseFill(takingAsk, exit, hedge.price) ?? exit;
    if (worse !== exit && exec) {
      const extra = await shortfallUsd(t.symbol, takingAsk, exit, worse, Number(t.volume));
      exec = { ...exec, shortfallUsd: (exec.shortfallUsd ?? 0) + extra };
    }
    exit = roundAdverse(t.symbol, worse, takingAsk);
  }
  const gross = await tradePnl(t, exit);
  if (gross === null) return false;
  const v2 = rulesV2(acct);
  const commission = v2 ? round2((await symbolCheck(db, t.symbol)).commissionPerLot * Number(t.volume)) : 0;
  const rawPnl = gross - commission;
  // Infinity stop-loss rule: a trade closed for having no stop loss keeps its loss, never its profit.
  const strip = reason === "no_stop_loss" && acct.challenge_type === "infinity" && rawPnl > 0;
  const pnl = strip ? 0 : rawPnl;
  // deno-lint-ignore no-explicit-any
  if (strip) (t as any).stripped_profit = round2(rawPnl);
  // The source close and balance credit commit together. Recheck the
  // volume and entry price: a concurrent partial must not let this close
  // credit the old, larger position. Broker hedging above remains first.
  const { data: committed, error: e1 } = await db.rpc("fn_commit_ipfx_close", {
    p_trade_id: t.id, p_account_id: acct.id, p_user_id: acct.user_id,
    p_expected_volume: Number(t.volume), p_expected_open_price: Number(t.open_price),
    p_exit: exit, p_pnl: round2(pnl), p_reason: reason, p_costs_enabled: v2,
    p_commission: commission, p_shortfall: round2(exec?.shortfallUsd ?? 0),
    p_stripped_profit: strip ? round2(rawPnl) : null,
  });
  if (e1 || !committed?.ok) return false; // closed or resized elsewhere; no duplicate credit
  acct.balance = Number(committed.balance);
  // The source close is committed. Broker copying must not hold up the UI;
  // EdgeRuntime.waitUntil keeps the exact-ID mirror dispatch alive. A hedge already closed
  // above is skipped; after an unpriced attempt it is re-sent (the idempotency key drops a
  // duplicate) so a hedge can never be left open behind a closed trade.
  if (hedge.state !== "filled") mirrorLater(fireMirror(db, acct, t, "close"));
  // B-book reverse legs (and any A-book leg left unpriced) close right after the trader's close.
  if (legs.b || (legs.a && hedge.state !== "filled")) bookLater({ event: "close", source_trade_id: t.id });
  shadowLater(db, { event: "shadow_close", source_trade_id: t.id });
  await logAudit(db, {
    trade_id: t.id, user_id: acct.user_id, account_id: acct.id, event: "close",
    symbol: t.symbol, side: t.side, requested_volume: Number(t.volume),
    requested_price: exit, fill_price: exit, quote: q ?? null,
    client_ip: reason === "manual" ? (clientIp ?? null) : null, // system-initiated closes (sl/tp/breach) have no human to attribute an IP to
  });
  return true;
}

// Third stop-loss warning in an Infinity run: the run ends like a breach (frozen, switched to demo, resting orders
// cancelled, open positions closed). The trader restarts from Stage 1 with claim_infinity.
async function strikeOutRun(db: Db, acct: Acct, open: Tr[]): Promise<Tr[]> {
  const bal = round2(Number(acct.balance));
  const claim = await db.rpc("fn_claim_account_breach", { p_account_id: acct.id, p_reason: "stop_loss_rule", p_trigger_equity: bal, p_breach_floor: bal });
  if (claim.error) { console.error("[sl-strikes] breach claim failed", { account_id: acct.id, message: claim.error.message }); return open; }
  acct.status = "breached";
  acct.breach_reason = "stop_loss_rule";
  if (claim.data === true) {
    for (const t of open) {
      let q = await fetchQuote(t.symbol);
      if (q === null) q = await lastKnownQuote(t.symbol);
      if (q !== null) await closeTrade(db, acct, t, t.side === "buy" ? q.bid : q.ask, "breach", q);
    }
    emailLater(sendLifecycleEmail(db, "account_breached", acct.user_id, {
      challenge_name: acct.label,
      breach_reason: BREACH_TEXT.stop_loss_rule,
      next_step: "This Infinity run has ended and IPFX Markets has switched you to demo. Restart the Infinity Challenge from Stage 1 when you are ready; your new run starts with 0 warnings. Always set a stop loss within 30 seconds of opening a trade.",
    }));
  }
  const { data: left } = await db.from("trades").select("*").eq("account_id", acct.id).eq("status", "open");
  return left ?? [];
}

// Marks positions, applies SL/TP, daily rollover, breach/pass rules.
// Mutates acct in memory; persists account changes at the end.
// ---------- price alerts ----------
// Evaluated against the mid price (what the chart draws). userId=null evaluates every active alert (sweep).
async function evaluateAlerts(db: Db, userId: string | null): Promise<number> {
  let qy = db.from("price_alerts").select("id,symbol,condition,price").eq("status", "active").limit(5000);
  if (userId) qy = qy.eq("user_id", userId);
  const { data } = await qy;
  if (!data || !data.length) return 0;
  const bySym = new Map<string, { id: string; condition: string; price: number }[]>();
  for (const a of data) {
    const list = bySym.get(a.symbol) ?? [];
    list.push(a);
    bySym.set(a.symbol, list);
  }
  let fired = 0;
  for (const [sym, rows] of bySym) {
    if (!INSTRUMENTS[sym]) continue;
    const q = await fetchQuote(sym);
    if (q === null || quoteStale(q)) continue;
    const m = round6((q.bid + q.ask) / 2);
    for (const a of rows) {
      const hit = a.condition === "above" ? m >= Number(a.price) : m <= Number(a.price);
      if (!hit) continue;
      const { data: upd } = await db.from("price_alerts").update({
        status: "triggered", triggered_at: new Date().toISOString(), triggered_price: m,
      }).eq("id", a.id).eq("status", "active").select("id");
      if (upd && upd.length) fired++;
    }
  }
  return fired;
}

// ---------- broker-demo challenge venue ----------
const VENUE_SYMBOL: Record<string, string> = Object.fromEntries(Object.entries(TL_SYMBOLS).map(([k, v]) => [v, k]));
function venueSymbol(brokerName: string | undefined): string | null {
  const n = String(brokerName ?? "").toUpperCase().replace(/\.(PRO|RAW|ECN|STD)$/, "");
  return VENUE_SYMBOL[n] ?? cleanSymbol(n);
}
type VenueConn = Record<string, any>; // deno-lint-ignore no-explicit-any
async function venueToken(db: Db, c: VenueConn): Promise<string> {
  const key = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
  if (!key) throw new Error("VENUE_ENCRYPTION_KEY_MISSING");
  let token = await decryptSecret(c.access_token_ciphertext, key);
  if (!c.access_expires_at || Date.parse(c.access_expires_at) - Date.now() < 30 * 60_000) {
    const next = await tlRefresh(await decryptSecret(c.refresh_token_ciphertext, key));
    token = next.accessToken;
    await db.from("venue_connections").update({
      access_token_ciphertext: await encryptSecret(next.accessToken, key),
      refresh_token_ciphertext: await encryptSecret(next.refreshToken, key),
      access_expires_at: tlJwtExpiresAt(next.accessToken), updated_at: new Date().toISOString(),
    }).eq("id", c.id);
  }
  return token;
}
// Close every open position on the trader's broker demo (rule breach).
async function flattenVenue(db: Db, acct: Acct): Promise<number> {
  const { data: c } = await db.from("venue_connections").select("*").eq("trading_account_id", acct.id).maybeSingle();
  if (!c) return 0;
  const token = await venueToken(db, c);
  const snap = await readAccount(token, String(c.tradelocker_account_id), String(c.acc_num));
  let closed = 0;
  for (const p of snap.positions) {
    try { await tlClosePosition(token, String(c.acc_num), p.id); closed++; } catch (e) { console.error("[venue] close failed", p.id, String(e).slice(0, 120)); }
  }
  return closed;
}
// One account: read the broker demo, import trades, update balance/equity, then apply the normal challenge rules.
async function syncVenueConnection(db: Db, c: VenueConn): Promise<void> {
  const { data: acctRow } = await db.from("trading_accounts").select("*").eq("id", c.trading_account_id).maybeSingle();
  if (!acctRow) return;
  const token = await venueToken(db, c);
  const snap = await readAccount(token, String(c.tradelocker_account_id), String(c.acc_num));
  let names: Record<string, string> = c.instrument_names ?? {};
  const unknownIds = [...snap.positions.map((p) => p.instrumentId), ...snap.fills.map((f) => f.instrumentId)].filter((id) => !names[id]);
  if (unknownIds.length) {
    names = await instrumentNames(token, String(c.tradelocker_account_id), String(c.acc_num));
    await db.from("venue_connections").update({ instrument_names: names }).eq("id", c.id);
  }
  const since = Date.parse(c.connected_at);
  const base = { account_id: acctRow.id, user_id: acctRow.user_id, external_source: "tradelocker" };
  // closed positions
  for (const cp of closedPositions(snap).filter((x) => x.openedAt >= since)) {
    const sym = venueSymbol(names[cp.instrumentId]);
    const inst = sym ? INSTRUMENTS[sym] : null;
    let pnl = 0, reason = "external";
    if (inst) {
      const conv = await usdPerQuote(inst.quote);
      if (conv !== null) pnl = round2((cp.closePrice - cp.openPrice) * (cp.side === "buy" ? 1 : -1) * cp.qty * inst.contract * conv);
      else reason = "external_unpriced";
    } else reason = "external_unknown_instrument";
    const { error: closedErr } = await db.from("trades").upsert({
      ...base, external_position_id: cp.positionId, symbol: sym ?? String(names[cp.instrumentId] ?? cp.instrumentId),
      side: cp.side === "sell" ? "sell" : "buy", volume: cp.qty, open_price: cp.openPrice, close_price: cp.closePrice,
      status: "closed", close_reason: reason, pnl, pnl_basis: "GROSS_BEFORE_COSTS",
      opened_at: new Date(cp.openedAt).toISOString(), closed_at: new Date(cp.closedAt).toISOString(),
    }, { onConflict: "account_id,external_source,external_position_id" });
    if (closedErr) throw new Error("VENUE_IMPORT_CLOSED:" + closedErr.message);
  }
  // open positions
  for (const p of snap.positions.filter((x) => x.openDate >= since - 5000)) {
    const sym = venueSymbol(names[p.instrumentId]);
    const { error: openErr } = await db.from("trades").upsert({
      ...base, external_position_id: p.id, symbol: sym ?? String(names[p.instrumentId] ?? p.instrumentId),
      side: p.side === "sell" ? "sell" : "buy", volume: p.qty, open_price: p.avgPrice, status: "open",
      opened_at: new Date(p.openDate).toISOString(),
    }, { onConflict: "account_id,external_source,external_position_id" });
    if (openErr) throw new Error("VENUE_IMPORT_OPEN:" + openErr.message);
  }
  // challenge balance = starting balance + broker P&L since connection - payouts already taken
  const start = Number(acctRow.starting_balance);
  const paid = Number(acctRow.total_paid_out ?? 0);
  const chBal = round2(start + (snap.balance - Number(c.baseline_balance)) - paid);
  const chEq = round2(start + (snap.equity - Number(c.baseline_balance)) - paid);
  if (acctRow.status === "active") {
    await db.from("trading_accounts").update({ balance: chBal, venue_equity: chEq, venue_synced_at: new Date().toISOString() })
      .eq("id", acctRow.id).eq("status", "active");
    await enforce(db, { ...acctRow, balance: chBal, venue_equity: chEq } as Acct);
  } else if (acctRow.status === "breached" && snap.positions.length) {
    await flattenVenue(db, acctRow as Acct);
  }
  await db.from("venue_connections").update({
    status: "connected", last_error: null, last_sync_at: new Date().toISOString(),
    broker_balance: snap.balance, broker_equity: snap.equity, updated_at: new Date().toISOString(),
  }).eq("id", c.id);
}

async function enforce(db: Db, acct: Acct): Promise<{ open: Tr[]; equity: number; floating: number; unpriced: number }> {
  let quoteRiskUnavailable = false;
  let infinityMonthlyBlocked = false;
  // The database checks persisted portfolio quotes before SL/TP can change
  // the portfolio. A crossed floor stays latched even if the price recovers.
  if (acct.challenge_type === "infinity" && acct.status === "active" && (acct.venue ?? "ipfx") === "ipfx") {
    const [{ data: guard, error }, monthly] = await Promise.all([
      db.rpc("fn_enforce_infinity_from_quotes", { p_account: acct.id }),
      db.rpc("fn_infinity_breach_lockout", { p_user: acct.user_id }),
    ]);
    if (error || !guard) throw new Error("CHALLENGE_RISK_CHECK_UNAVAILABLE");
    if (monthly.error || !monthly.data) throw new Error("INFINITY_ELIGIBILITY_UNAVAILABLE");
    infinityMonthlyBlocked = monthly.data.locked === true;
    if (guard.status === "active" && guard.access_revoked_at) throw new Error("CHALLENGE_ACCESS_REVOKED");
    quoteRiskUnavailable = guard.checked === false && ["MARK_UNAVAILABLE", "RULES_UNAVAILABLE"].includes(guard.reason);
    for (const key of ["status", "balance", "breach_reason", "day_start_equity", "day_start_date", "trailing_peak", "trailing_peak_date",
      "breached_at", "breach_equity", "breach_floor", "access_revoked_at"]) {
      // deno-lint-ignore no-explicit-any
      if (Object.prototype.hasOwnProperty.call(guard, key)) (acct as any)[key] = guard[key];
    }
  }
  const [{ data: openRows }] = await Promise.all([
    db.from("trades").select("*").eq("account_id", acct.id).eq("status", "open").order("opened_at"),
    warmQuotes(),
  ]);
  let open: Tr[] = openRows ?? [];
  // Broker-demo challenges: positions live at the broker. Equity comes from the broker (synced by venue_sync), no
  // IPFX price is used, and a breach closes the positions at the broker instead of filling them here.
  const venueMode = (acct.venue ?? "ipfx") !== "ipfx";

  // Recovery path: if a worker stopped after the DB freeze but before every
  // close completed, the next state call/offline sweep finishes flattening.
  // The account is already immutable and the per-account lease keeps this
  // single-writer.
  if (!venueMode && acct.status === "breached" && open.length && await claimOrderLock(db, acct.id)) {
    try {
      for (const t of open) {
        let q = await fetchQuote(t.symbol);
        if (q === null) q = await lastKnownQuote(t.symbol);
        if (q !== null) {
          const exit = t.side === "buy" ? q.bid : q.ask;
          await closeTrade(db, acct, t, exit, "breach", q);
        }
      }
      const { data: remaining } = await db.from("trades")
        .select("*").eq("account_id", acct.id).eq("status", "open").order("opened_at");
      open = remaining ?? [];
    } finally {
      await releaseOrderLock(db, acct.id);
    }
  }

  // SL/TP auto-close. A stop fills at the worse of its level and the live price, so a gap
  // through the stop costs what the market cost; a take-profit fills at its level.
  if (isTradableAccount(acct) && !venueMode) {
    const still: Tr[] = [];
    let strikeOut = false;
    for (const t of open) {
      if (strikeOut) { still.push(t); continue; }
      const q = await fetchQuote(t.symbol);
      if (q === null || quoteStale(q)) { still.push(t); continue; }
      const ex = t.side === "buy" ? q.bid : q.ask; // the price that would actually fill a close
      // Trailing stop: pull the stop toward the market by trail_distance. It only ever TIGHTENS
      // (the conditional update refuses to loosen it, even if two passes race).
      const trail = t.trail_distance == null ? null : Number(t.trail_distance);
      if (trail !== null && trail > 0) {
        const cand = roundPrice(t.symbol, t.side === "buy" ? ex - trail : ex + trail);
        const cur = t.sl === null ? null : Number(t.sl);
        if (cur === null || (t.side === "buy" ? cand > cur : cand < cur)) {
          let upd = db.from("trades").update({ sl: cand }).eq("id", t.id).eq("status", "open");
          upd = cur === null ? upd.is("sl", null) : (t.side === "buy" ? upd.lt("sl", cand) : upd.gt("sl", cand));
          const { data: moved } = await upd.select("id");
          if (moved && moved.length) t.sl = cand;
        }
      }
      const sl = t.sl === null ? null : Number(t.sl);
      const tp = t.tp === null ? null : Number(t.tp);
      let done = false;
      // Infinity only: a trade still without a stop loss after the deadline is closed, its profit removed
      // (closeTrade) and it counts as a stop-loss warning.
      const slDeadline = sl === null && acct.challenge_type === "infinity" ? await slDeadlineSeconds(db) : null;
      // deno-lint-ignore no-explicit-any
      const openedAtMs = Date.parse(String((t as any).opened_at ?? ""));
      if (slDeadline != null && Number.isFinite(openedAtMs) && Date.now() - openedAtMs > slDeadline * 1000) {
        done = await closeTrade(db, acct, t, ex, "no_stop_loss", q);
        if (!done) { still.push(t); continue; }
        // deno-lint-ignore no-explicit-any
        const { data: strikes } = await db.rpc("fn_record_sl_strike", { p_account: acct.id, p_trade: t.id, p_stripped: Number((t as any).stripped_profit ?? 0) });
        // deno-lint-ignore no-explicit-any
        (acct as any).sl_strikes = Number(strikes ?? 0);
        if (Number(strikes) >= SL_STRIKES_MAX && acct.status === "active") strikeOut = true;
        continue;
      }
      if (t.side === "buy") {
        if (sl !== null && ex <= sl) done = await closeTrade(db, acct, t, await stopFill(db, acct, t.symbol, Math.min(sl, ex), false), "sl", q);
        else if (tp !== null && ex >= tp) done = await closeTrade(db, acct, t, tp, "tp", q);
      } else {
        if (sl !== null && ex >= sl) done = await closeTrade(db, acct, t, await stopFill(db, acct, t.symbol, Math.max(sl, ex), true), "sl", q);
        else if (tp !== null && ex <= tp) done = await closeTrade(db, acct, t, tp, "tp", q);
      }
      if (!done) still.push(t);
    }
    open = still;
    if (strikeOut) open = await strikeOutRun(db, acct, open);
  }

  // Futures positions must be flat outside the CME session. Closing here
  // rather than breaching the account: an open position at the bell is a
  // session rule, not a drawdown failure.
  if (!venueMode && isTradableAccount(acct) && open.length && futuresSessionEnforced(acct) && !futuresSessionOpen()) {
    const remaining: Tr[] = [];
    for (const t of open) {
      const q = await fetchQuote(t.symbol);
      if (q === null || quoteStale(q)) { remaining.push(t); continue; }
      const takingAsk = t.side === "sell";
      const spec = await symbolCheck(db, t.symbol);
      const exit = roundPrice(t.symbol, adverse(takingAsk ? q.ask : q.bid, takingAsk, spec.slippageBps));
      const closed = await closeTrade(db, acct, t, exit, "session_close", q);
      if (!closed) remaining.push(t);
    }
    open = remaining;
  }

  // Resting limit/stop orders are checked before marking to market, so a
  // fill this tick is included in the equity the rules are judged on.
  if (!venueMode) open = await processPendingOrders(db, acct, open, round2(Number(acct.balance)), !quoteRiskUnavailable && !infinityMonthlyBlocked);

  // mark to market
  let floating = 0;
  let unpriced = quoteRiskUnavailable ? 1 : 0;
  for (const t of (venueMode ? [] : open)) {
    let q = await fetchQuote(t.symbol);
    if (q === null || quoteStale(q)) {
      // Never value a position at zero because its price is missing or old:
      // that hid its loss from the drawdown checks. Mark it at the last price
      // the feed printed, and pause new orders while its market is open.
      if (marketOpen(t.symbol)) unpriced++;
      q = (await lastKnownQuote(t.symbol)) ?? q;
      if (q === null) continue;
    }
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
  if (venueMode) {
    equity = round2(Number(acct.venue_equity ?? acct.balance));
    floating = round2(equity - Number(acct.balance));
  }

  const start = Number(acct.starting_balance);
  const todayUtc = new Date().toISOString().slice(0, 10);

  if (acct.status === "active" && !isDemoAccount(acct) && !quoteRiskUnavailable) {
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
      // Terms 7.2 (rules v2): the day starts from the higher of balance and
      // equity, so a floating loss carried over midnight still counts.
      acct.day_start_equity = rulesV2(acct) ? round2(Math.max(Number(acct.balance), equity)) : equity;
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
      const breachFloor = breach === "max_drawdown" ? ddFloor : dailyFloor;
      const claim = await db.rpc("fn_claim_account_breach", {
        p_account_id: acct.id,
        p_reason: breach,
        p_trigger_equity: equity,
        p_breach_floor: breachFloor,
      });
      if (claim.error) {
        // Fail safe, not open: if the atomic claim function is broken (e.g. a missing table, which
        // happened in production until 2026-09-30), still freeze the account with a conditional
        // update so exactly one request wins, then flatten below. Only if that also fails do we throw.
        console.error("[breach] freeze claim failed; using fallback", { account_id: acct.id, code: claim.error.code, message: claim.error.message });
        const { data: frozen, error: fbErr } = await db.from("trading_accounts").update({
          status: "breached", breach_reason: breach, access_revoked_at: new Date().toISOString(),
          access_revoked_reason: "challenge_rule_breach:" + breach, mirror_enabled: false,
        }).eq("id", acct.id).eq("status", "active").select("id");
        if (fbErr) {
          console.error("[breach] fallback freeze failed", { account_id: acct.id, code: fbErr.code });
          throw new Error("BREACH_FREEZE_FAILED");
        }
        await db.from("pending_orders").update({ status: "cancelled", resolved_at: new Date().toISOString() })
          .eq("account_id", acct.id).eq("status", "pending");
        (claim as { data: unknown }).data = Array.isArray(frozen) && frozen.length > 0;
        await logFeedEvent(db, "outage", null, `breach_claim_fallback account=${acct.id} code=${claim.error.code ?? "?"}`);
      }

      // Only the request that won the active -> breached transition performs
      // the flatten. The DB insert guards make the freeze immediate, so no new
      // trade or pending order can race in after this point.
      if (claim.data === true) {
        if (venueMode) await flattenVenue(db, acct).catch((e) => console.error("[venue] flatten failed", acct.id, String(e).slice(0, 120)));
        else for (const t of open) {
          let q = await fetchQuote(t.symbol);
          if (q === null) q = await lastKnownQuote(t.symbol);
          if (q !== null) {
            const exit = t.side === "buy" ? q.bid : q.ask;
            await closeTrade(db, acct, t, exit, "breach", q);
          }
        }
        emailLater(sendLifecycleEmail(db, "account_breached", acct.user_id, {
          challenge_name: acct.label,
          breach_reason: BREACH_TEXT[breach] ?? breach,
          next_step: acct.phase === "evaluation"
            ? "Your challenge account is frozen and IPFX Markets has switched you to demo. You can view the current continuation price, restart, or apply for a new challenge."
            : "Your funded account is frozen and IPFX Markets has switched you to demo. Review your dashboard or contact support for the next available action.",
        }));
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
        const { data: nextAcct } = await db.from("trading_accounts")
          .select("label,phase").eq("funded_from_account_id", acct.id).maybeSingle();
        if (nextAcct?.phase === "funded") {
          emailLater(sendLifecycleEmail(db, "account_funded", acct.user_id, { challenge_name: acct.label }));
        } else if (nextAcct) {
          emailLater(sendLifecycleEmail(db, "stage_passed", acct.user_id, { challenge_name: acct.label, next_name: nextAcct.label }));
        }
      }
      // Not passing yet is not a breach — the trader simply keeps trading
      // until the remaining requirements are met.
    }
  }

  const expectedStatus = acct.status;
  const saved = await db.from("trading_accounts").update({
    ...(venueMode ? { balance: acct.balance } : {}), day_start_equity: acct.day_start_equity,
    day_start_date: acct.day_start_date, status: acct.status,
    breach_reason: acct.breach_reason,
    trailing_peak: acct.trailing_peak ?? null,
    trailing_peak_date: acct.trailing_peak_date ?? null,
    updated_at: new Date().toISOString(),
  }).eq("id", acct.id).eq("status", expectedStatus).select("status,breach_reason,balance");
  if (saved.data?.length && !venueMode) {
    const beforeRefresh = Number(acct.balance);
    acct.balance = Number(saved.data[0].balance);
    equity = round2(equity + Number(acct.balance) - beforeRefresh);
  }
  if (!saved.data?.length) {
    const { data: fresh } = await db.from("trading_accounts")
      .select("status,breach_reason,balance").eq("id", acct.id).maybeSingle();
    if (fresh) {
      acct.status = fresh.status;
      acct.breach_reason = fresh.breach_reason;
      acct.balance = Number(fresh.balance);
      if (fresh.status === "breached") {
        floating = 0;
        equity = round2(Number(acct.balance));
      }
    }
  }

  return { open, equity, floating: round2(floating), unpriced };
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
  const [{ data: closed }, { data: pending }, monthly, controls] = await Promise.all([
    db.from("trades").select("*").eq("account_id", acct.id).eq("status", "closed")
      .order("closed_at", { ascending: false }).limit(30),
    db.from("pending_orders").select("*").eq("account_id", acct.id).eq("status", "pending")
      .order("created_at", { ascending: false }),
    db.rpc("fn_infinity_breach_lockout", { p_user: acct.user_id }),
    db.rpc("brain_trader_controls", { p_user: acct.user_id }),
  ]);
  if (monthly.error || !monthly.data) throw new Error("INFINITY_ELIGIBILITY_UNAVAILABLE");
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
  const liveRiskLimit = effectiveRiskLimit(acct, equity);

  return {
    ok: true,
    infinity_lockout: monthly.data,
    service_controls: controls.error ? { unavailable: true, notices: [] } : controls.data,
    account: {
      id: acct.id, label: acct.label, status: acct.status, breach_reason: acct.breach_reason,
      // deno-lint-ignore no-explicit-any
      sl_strikes: Number((acct as any).sl_strikes ?? 0), sl_strikes_max: SL_STRIKES_MAX,
      is_demo: isDemoAccount(acct),
      venue: acct.venue ?? "ipfx",
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
        max_risk_per_trade_usd: liveRiskLimit?.effective ?? null,
        base_risk_per_trade_usd: liveRiskLimit?.base ?? null,
        drawdown_room_usd: liveRiskLimit?.drawdownRemaining ?? null,
        daily_loss_room_usd: liveRiskLimit?.dailyRemaining ?? null,
        daily_profit_cap_usd: acct.daily_profit_cap_pct == null ? null
          : round2(start * Number(acct.daily_profit_cap_pct) / 100),
        require_stop_loss: !!acct.require_stop_loss,
        // Infinity Challenge: profit from winning trades held under this many seconds is not payout-eligible
        // (enforced in the payout functions; the platform warns before an early close).
        payout_min_hold_seconds: (acct.challenge_type ?? "") === "infinity" ? 60 : null,
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
        qualification: gate.qualification,
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
  payout_pending: "You already have a payout request under review — wait for it to be processed before requesting another.",
  period_already_paid: "This period has already been paid out.",
  payout_not_found: "Payout not found.",
  not_requested: "This payout has already moved past the requested stage.",
  not_approved: "This payout hasn't been approved yet.",
  insufficient_balance: "Account balance is too low to cover this payout.",
  cannot_void_paid: "A paid payout can't be voided.",
  already_void: "This payout is already void.",
};
function cleanRpcError(raw: string): string {
  const code = raw.split(":")[0].trim();
  if (code === "BELOW_MINIMUM") return "Minimum withdrawal is $500. Your earnings remain held until the minimum is reached.";
  if (code === "too_soon") return "Too soon since your last payout — " + raw.split(":")[1]?.trim();
  if (code === "below_minimum") return raw.split(":")[1]?.trim() ?? "Amount is below the minimum withdrawal.";
  return RPC_ERROR_MESSAGES[code] ?? raw;
}

// ---------- symbol tradeability (symbol_specs: enabled + max spread) ----------
type SymbolCheck = { ok: boolean; reason?: string; maxSpread?: number; commissionPerLot: number; slippageBps: number };
async function symbolCheck(db: Db, symKey: string): Promise<SymbolCheck> {
  const { data: spec } = await db.from("symbol_specs")
    .select("enabled,disabled_reason,max_spread,commission_per_lot_usd,slippage_bps").eq("symbol", symKey).maybeSingle();
  const fallback = DEFAULT_COSTS[INSTRUMENTS[symKey]?.cls ?? "forex"] ?? DEFAULT_COSTS.forex;
  const costs = {
    commissionPerLot: spec?.commission_per_lot_usd != null ? Number(spec.commission_per_lot_usd) : fallback.commissionPerLot,
    slippageBps: spec?.slippage_bps != null ? Number(spec.slippage_bps) : fallback.slippageBps,
  };
  if (spec && spec.enabled === false) return { ok: false, reason: spec.disabled_reason || "Symbol disabled", ...costs };
  return { ok: true, maxSpread: spec ? Number(spec.max_spread) : undefined, ...costs };
}

function roundPrice(symKey: string, px: number): number {
  return Number(px.toFixed(INSTRUMENTS[symKey]?.digits ?? 5));
}
// Rounds against the trader (up when buying, down when selling), so rounding can never make a
// copied trade's fill better than the hedge's.
function roundAdverse(symKey: string, px: number, takingAsk: boolean): number {
  const f = Math.pow(10, INSTRUMENTS[symKey]?.digits ?? 5);
  const v = takingAsk ? Math.ceil(px * f - 1e-7) : Math.floor(px * f + 1e-7);
  return Number((v / f).toFixed(INSTRUMENTS[symKey]?.digits ?? 5));
}

// Moves a price against the trader by `bps` basis points.
function adverse(px: number, takingAsk: boolean, bps: number): number {
  const slip = px * bps / 10000;
  return takingAsk ? px + slip : px - slip;
}

type Execution = { price: number; decision: number; latencyMs: number; quote: Quote };

// Market execution. takingAsk = buying (opening a buy or closing a sell).
// Fills at the less favourable of the arrival price and the price after the
// delay, then applies slippage: a move in the trader's favour during the
// delay is never passed on, which removes any edge from the feed's lag.
// Returns null only when failClosed and no usable quote exists afterwards.
async function executeAtMarket(
  symKey: string, takingAsk: boolean, arrival: Quote, slippageBps: number, failClosed: boolean, skipDelay = false,
): Promise<Execution | null> {
  const decision = takingAsk ? arrival.ask : arrival.bid;
  const started = Date.now();
  if (!skipDelay) {
    const delay = EXEC_DELAY_MIN_MS + Math.floor(Math.random() * (EXEC_DELAY_MAX_MS - EXEC_DELAY_MIN_MS + 1));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  await warmQuotes(true);
  let later = await fetchQuote(symKey);
  if (later === null || quoteStale(later)) {
    if (failClosed) return null;
    later = arrival;
  }
  const atExecution = takingAsk ? later.ask : later.bid;
  const worse = takingAsk ? Math.max(decision, atExecution) : Math.min(decision, atExecution);
  return {
    price: roundPrice(symKey, adverse(worse, takingAsk, slippageBps)),
    decision, latencyMs: Date.now() - started, quote: later,
  };
}

// USD cost of filling at `price` rather than `decision`.
async function shortfallUsd(symKey: string, takingAsk: boolean, decision: number, price: number, volume: number): Promise<number> {
  const inst = INSTRUMENTS[symKey];
  const conv = inst ? await usdPerQuote(inst.quote) : null;
  if (!inst || conv === null) return 0;
  const diff = takingAsk ? price - decision : decision - price;
  return round2(Math.max(0, diff) * inst.contract * volume * conv);
}

// Stop-loss fill for rules-v2 accounts: slippage on top of the gap-true price.
async function stopFill(db: Db, acct: Acct, symKey: string, px: number, takingAsk: boolean): Promise<number> {
  if (!rulesV2(acct)) return px;
  const spec = await symbolCheck(db, symKey);
  return roundPrice(symKey, adverse(px, takingAsk, spec.slippageBps));
}

// Money at risk if every open stop is hit (positions without a stop, or with
// a stop already in profit, contribute nothing).
async function openRiskUsd(open: Tr[]): Promise<number> {
  let total = 0;
  for (const t of open) {
    if (t.sl === null || t.sl === undefined) continue;
    const inst = INSTRUMENTS[t.symbol];
    const conv = inst ? await usdPerQuote(inst.quote) : null;
    if (!inst || conv === null) continue;
    const perUnit = t.side === "buy" ? Number(t.open_price) - Number(t.sl) : Number(t.sl) - Number(t.open_price);
    total += Math.max(0, perUnit) * inst.contract * Number(t.volume) * conv;
  }
  return round2(total);
}

async function claimOrderLock(db: Db, accountId: string): Promise<boolean> {
  const { data, error } = await db.rpc("claim_account_order_lock", { p_account: accountId, p_seconds: 5 });
  return error ? true : data !== false; // lock trouble must never halt trading
}
async function releaseOrderLock(db: Db, accountId: string): Promise<void> {
  try { await db.rpc("release_account_order_lock", { p_account: accountId }); } catch (_) { /* expires on its own */ }
}

// Terms 8.2: flag (never block, shared IPs are common) an opposite position on
// the same instrument held by a different trader who traded from this IP.
async function flagCrossAccountHedge(db: Db, userId: string, symbol: string, side: string, clientIp: string | null): Promise<void> {
  if (!clientIp) return;
  try {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { data: peers } = await db.from("order_audit_events").select("user_id")
      .eq("client_ip", clientIp).neq("user_id", userId).gte("created_at", since).limit(50);
    const others = [...new Set((peers ?? []).map((p: { user_id: string }) => p.user_id))];
    if (!others.length) return;
    const { data: opposite } = await db.from("trades").select("id").in("user_id", others)
      .eq("symbol", symbol).eq("status", "open").eq("side", side === "buy" ? "sell" : "buy").limit(1);
    if (opposite && opposite.length) {
      await db.from("security_events").insert({ user_id: userId, event_type: "possible_cross_account_hedge", ip_address: clientIp });
    }
  } catch (_) { /* flagging must never block an order */ }
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
      source_id: row.quote?.source ?? SOURCE_ID, client_ip: row.client_ip ?? null,
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

// deno-lint-ignore no-explicit-any
const authCache = new Map<string, { user: any; until: number }>();
const AUTH_CACHE_MS = 30_000;

const handleRequest = async (req: Request): Promise<Response> => {
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
  // Read-only diagnostics for the TradeLocker price feed (cron secret). mode "config": renew the token and read
  // the account's rate limits + instrument mapping. mode "quotes": time real quote requests, paced by "pace_ms".
  if (body.action === "feed_probe") {
    const secret = req.headers.get("x-cron-secret");
    const expected = Deno.env.get("CRON_SECRET");
    if (!expected || secret !== expected) return err("Not authorized", 401);
    const pdb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const out: Record<string, unknown> = { mode: body.mode ?? "config" };
    try {
      let t = Date.now();
      const sess = await openFeedSession(pdb, null);
      out.session_ms = Date.now() - t;
      t = Date.now();
      const inst = await loadFeedInstruments(sess);
      out.instruments_ms = Date.now() - t;
      out.mapped = inst.map((i) => i.symKey);
      if (body.mode === "venue_read") {
        // Read-only check of the challenge-venue reader against the firm's own demo connection.
        const t1 = Date.now();
        const snap = await readAccount(sess.accessToken, sess.accountId, sess.accNum);
        out.read_ms = Date.now() - t1;
        const names = await instrumentNames(sess.accessToken, sess.accountId, sess.accNum);
        const closed = closedPositions(snap);
        out.balance = snap.balance; out.equity = snap.equity;
        out.open_positions = snap.positions.length; out.fills = snap.fills.length; out.closed_positions = closed.length;
        out.sample_open = snap.positions.slice(0, 2).map((p) => ({ ...p, symbol: names[p.instrumentId] }));
        out.sample_closed = closed.slice(-3).map((c) => ({ ...c, symbol: names[c.instrumentId] }));
      } else if (body.mode === "ctrader") {
        // Live check of the cTrader stream. Without credentials it still proves connectivity + protocol by
        // sending deliberately invalid app credentials (expects a polite auth error back).
        const creds = await ctraderCreds(pdb);
        const s2 = new CTraderStream(creds?.host ?? "demo.ctraderapi.com");
        const t0 = Date.now();
        await s2.open();
        out.connect_ms = Date.now() - t0;
        if (!creds) {
          try { await s2.request(CT.APP_AUTH_REQ, { clientId: "ipfx-connectivity-check", clientSecret: "invalid" }); out.app_auth = "unexpectedly accepted"; }
          catch (e) { out.app_auth = String(e).slice(0, 200); }
          out.configured = false;
        } else {
          const { accountId, refreshed } = await signIn(s2, creds);
          out.account_id = accountId; out.token_refreshed = !!refreshed;
          const r = await s2.request(CT.SYMBOLS_LIST_REQ, { ctidTraderAccountId: accountId });
          const ids = mapSymbols((r.symbol as { symbolId: number; symbolName?: string; enabled?: boolean }[]) ?? []);
          out.mapped = Object.keys(ids);
          out.missing = Object.keys(INSTRUMENTS).filter((k) => INSTRUMENTS[k].cls !== "future" && !ids[k]);
          const counts: Record<string, number> = {};
          const byId = new Map(Object.entries(ids).map(([k, v]) => [Number(v), k]));
          s2.onSpot = (id) => { const k = byId.get(id); if (k) counts[k] = (counts[k] ?? 0) + 1; };
          await s2.request(CT.SUBSCRIBE_SPOTS_REQ, { ctidTraderAccountId: accountId, symbolId: Object.values(ids) });
          await new Promise((x) => setTimeout(x, Math.min(20_000, Number(body.listen_ms) || 10_000)));
          out.spot_events = counts;
          out.total_events = Object.values(counts).reduce((a, b) => a + b, 0);
        }
        s2.close();
      } else if (body.mode === "limits") {
        // Raw requests so the 429 response itself (headers + body) can be inspected per endpoint type.
        const base = "https://demo.tradelocker.com/backend-api";
        const dev = Deno.env.get("TRADELOCKER_DEVELOPER_API_KEY");
        const raw = async (path: string) => {
          const h: Record<string, string> = { Authorization: `Bearer ${sess.accessToken}`, accNum: sess.accNum };
          if (dev) h["tl-developer-api-key"] = dev;
          const t1 = Date.now();
          const r = await fetch(base + path, { headers: h });
          const text = await r.text();
          const hdr: Record<string, string> = {};
          r.headers.forEach((v, k) => { if (/rate|limit|retry|x-|cf-|server|via/i.test(k)) hdr[k] = v; });
          return { status: r.status, ms: Date.now() - t1, hdr, body: r.status === 200 ? text.slice(0, 160) : text.slice(0, 300) };
        };
        const eur = inst.find((i) => i.symKey === "EURUSD")!;
        const gbp = inst.find((i) => i.symKey === "GBPUSD")!;
        const run = async (label: string, paths: string[], perSec: number, n: number) => {
          const res: { status: number }[] = []; let first429: unknown = null; let sample200: unknown = null;
          for (let k = 0; k < n; k++) {
            const t1 = Date.now();
            const r = await raw(paths[k % paths.length]);
            res.push(r);
            if (r.status === 429 && !first429) first429 = { at: k, ...r };
            if (r.status === 200 && !sample200) sample200 = r;
            const wait = 1000 / perSec - (Date.now() - t1);
            if (wait > 0) await new Promise((x) => setTimeout(x, wait));
          }
          const counts: Record<string, number> = {};
          for (const r of res) counts[r.status] = (counts[r.status] ?? 0) + 1;
          return { label, perSec, n, counts, first429, sample200 };
        };
        const q = (i: { routeId: number; instrumentId: string }) => `/trade/quotes?routeId=${i.routeId}&tradableInstrumentId=${i.instrumentId}`;
        const d = (i: { routeId: number; instrumentId: string }) => `/trade/depth?routeId=${i.routeId}&tradableInstrumentId=${i.instrumentId}`;
        const b = (i: { routeId: number; instrumentId: string }) => `/trade/dailyBar?routeId=${i.routeId}&barType=BID&tradableInstrumentId=${i.instrumentId}`;
        out.dev_key = !!dev;
        out.tests = [];
        for (const [label, paths, rate] of [["quotes_1sym_2ps", [q(eur)], 2], ["depth_1sym_2ps", [d(eur)], 2], ["dailybar_1sym_2ps", [b(eur)], 2], ["quotes_2sym_2ps", [q(eur), q(gbp)], 2], ["quotes_1sym_5ps", [q(eur)], 5]] as [string, string[], number][]) {
          (out.tests as unknown[]).push(await run(label, paths, rate, 12));
          await new Promise((x) => setTimeout(x, 3000));
        }
      } else if ((body.mode ?? "config") === "config") {
        const cfg = await feedConfig(sess);
        out.config = JSON.stringify(cfg).slice(0, 6000);
      } else {
        const pace = Math.max(100, Number(body.pace_ms) || 500);
        const sym = String(body.symbol || "EURUSD");
        const target = inst.find((i) => i.symKey === sym);
        if (!target) throw new Error("SYMBOL_NOT_MAPPED");
        const samples: { ms: number; bid?: number; ask?: number; err?: string }[] = [];
        const n = Math.min(60, Number(body.count) || 20);
        for (let k = 0; k < n; k++) {
          const t1 = Date.now();
          try { const q = await feedQuote(sess, target); samples.push({ ms: Date.now() - t1, bid: q?.bid, ask: q?.ask }); }
          catch (e) { samples.push({ ms: Date.now() - t1, err: String(e).slice(0, 100) }); }
          const wait = pace - (Date.now() - t1);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
        let changes = 0;
        for (let k = 1; k < samples.length; k++) if (samples[k].bid !== samples[k - 1].bid || samples[k].ask !== samples[k - 1].ask) changes++;
        out.symbol = sym; out.pace_ms = pace; out.count = n; out.changes = changes;
        out.errors = samples.filter((x) => x.err).length;
        out.first_error = samples.find((x) => x.err)?.err ?? null;
        out.latency_ms = samples.map((x) => x.ms);
        out.last = samples[samples.length - 1];
      }
    } catch (e) { out.error = String(e).slice(0, 300); }
    return new Response(JSON.stringify(out), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  if (body.action === "venue_sync") {
    const secret = req.headers.get("x-cron-secret");
    const expected = Deno.env.get("CRON_SECRET");
    if (!expected || secret !== expected) return err("Not authorized", 401);
    const vdb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const nowIso = new Date().toISOString();
    const { data: got } = await vdb.from("venue_sync_lease").update({ lease_until: new Date(Date.now() + 9_500).toISOString(), owner: crypto.randomUUID() })
      .eq("id", true).or(`lease_until.is.null,lease_until.lt.${nowIso}`).select("id");
    if (!got?.length) return new Response(JSON.stringify({ ok: true, skipped: "previous sync running" }), { headers: { ...CORS, "Content-Type": "application/json" } });
    // Least-recently-synced first, so every account is reached even when one run can't cover all of them.
    const { data: conns } = await vdb.from("venue_connections").select("*").in("status", ["connected", "error"])
      .order("last_sync_at", { ascending: true, nullsFirst: true }).limit(500);
    const queue = [...(conns ?? [])];
    const deadline = Date.now() + 8_000;
    let synced = 0, failed = 0;
    const worker = async () => {
      while (queue.length && Date.now() < deadline) {
        const c = queue.shift()!;
        try { await syncVenueConnection(vdb, c); synced++; }
        catch (e) {
          failed++;
          await vdb.from("venue_connections").update({ status: "error", last_error: String(e).slice(0, 200), last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", c.id);
        }
      }
    };
    await Promise.all(Array.from({ length: 10 }, worker));
    await vdb.from("venue_sync_lease").update({ lease_until: new Date().toISOString() }).eq("id", true);
    return new Response(JSON.stringify({ ok: true, synced, failed, remaining: queue.length }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  if (body.action === "pump") {
    const secret = req.headers.get("x-cron-secret");
    const expected = Deno.env.get("CRON_SECRET");
    if (!expected || secret !== expected) return err("Not authorized", 401);
    const pumpDb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const durationMs = Math.min(58_000, Math.max(5_000, Number(body.duration_ms) || 29_000));
    const job = runQuotePump(pumpDb, durationMs);
    // Respond immediately and keep pumping in the background so pg_net never holds a connection open.
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt && typeof rt.waitUntil === "function") {
      rt.waitUntil(job);
      return new Response(JSON.stringify({ ok: true, pumping_ms: durationMs }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const res = await job;
    return new Response(JSON.stringify({ ok: true, ...res }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // The hub's two calls (dedicated secret, no user session): instrument specs for its P&L estimates, and
  // "check these accounts now" when a stop, take-profit, pending order or loss limit is crossed. The decision
  // is always made here by enforce(), exactly as for the sweep and the traders' own price polls.
  if (body.action === "hub_specs" || body.action === "hub_enforce") {
    if (!hubSecretOk(req.headers.get("x-hub-secret"))) return err("Not authorized", 401);
    const out = (b: unknown) => new Response(JSON.stringify(b), { headers: { ...CORS, "Content-Type": "application/json" } });
    if (body.action === "hub_specs") {
      return out({ ok: true, instruments: Object.fromEntries(Object.entries(INSTRUMENTS).map(([s, i]) => [s, { contract: i.contract, quote: i.quote, digits: i.digits, cls: i.cls }])) });
    }
    const hubDb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const ids = (Array.isArray(body.account_ids) ? body.account_ids : []).map(String)
      .filter((x: string) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 25);
    const results: Record<string, unknown>[] = [];
    for (const id of ids) {
      const { data: acct } = await hubDb.from("trading_accounts").select("*").eq("id", id).maybeSingle();
      // Demo accounts too: their stops, take-profits and pending orders must fire even when the trader is offline.
      if (!acct || (acct.access_revoked_at && acct.status !== "breached") || !(isTradableAccount(acct as Acct) || acct.status === "breached")) { results.push({ id, skipped: true }); continue; }
      try {
        const r = await enforce(hubDb, acct as Acct);
        results.push({ id, open: r.open.length, equity: r.equity, status: (acct as Acct).status });
      } catch (e) { results.push({ id, error: String(e).slice(0, 120) }); }
    }
    return out({ ok: true, results });
  }

  if (body.action === "sweep") {
    const secret = req.headers.get("x-cron-secret");
    const expected = Deno.env.get("CRON_SECRET");
    if (!expected || secret !== expected) return err("Not authorized", 401);

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // The sweep runs every few seconds; a lease stops a slow run and the next
    // one enforcing the same account at once. Missing lease function = run.
    const lease = await db.rpc("claim_engine_sweep", { p_seconds: 55 });
    if (!lease.error && lease.data === false) {
      return new Response(JSON.stringify({ ok: true, skipped: "previous sweep still running" }),
        { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    // Page through open trades instead of packing every account id into one
    // URL filter (which fails past a few hundred accounts), and visit accounts
    // in random order under a time budget so a slow run never leaves the same
    // accounts unchecked every time.
    const ids = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data: page, error: pageErr } = await db.from("trades").select("account_id")
        .eq("status", "open").order("id").range(from, from + 999);
      if (pageErr || !page || !page.length) break;
      for (const r of page) ids.add(r.account_id);
      if (page.length < 1000) break;
    }
    let alertsFired = 0;
    try { alertsFired = await evaluateAlerts(db, null); } catch (_) { /* alerts never block enforcement */ }
    const queue = [...ids].sort(() => Math.random() - 0.5);
    const deadline = Date.now() + 40_000;
    let visited = 0;
    let breached = 0;
    for (const id of queue) {
      if (Date.now() > deadline) break;
      visited++;
      const { data: acct } = await db.from("trading_accounts").select("*").eq("id", id).maybeSingle();
      // Demo accounts included: enforce() closes their stops/targets and fills their orders (no loss limits apply).
      if (!acct || (acct.access_revoked_at && acct.status !== "breached") || !(isTradableAccount(acct as Acct) || acct.status === "breached")) continue;
      const before = acct.status;
      await enforce(db, acct as Acct);
      if (before === "active") {
        const { data: after } = await db.from("trading_accounts").select("status").eq("id", id).maybeSingle();
        if (after?.status === "breached") breached++;
      }
    }
    if (!lease.error) await db.rpc("release_engine_sweep");
    return new Response(JSON.stringify({ ok: true, swept: visited, unvisited: queue.length - visited, breached, alerts_fired: alertsFired }),
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
    // The platform polls every 750ms with the same session token. Verify it with Supabase Auth once, then
    // reuse the verified user for up to AUTH_CACHE_MS (never past the token's own expiry) in this isolate.
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const cacheKey = token.split(".").length === 3 ? await sha256Hex(token) : "";
    const cached = cacheKey ? authCache.get(cacheKey) : undefined;
    if (cached && cached.until > Date.now()) {
      user = cached.user;
    } else {
      const authClient = createClient(
        Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: { user: sessionUser } } = await authClient.auth.getUser();
      user = sessionUser;
      if (sessionUser && cacheKey) {
        let until = Date.now() + AUTH_CACHE_MS;
        try {
          const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
          const claims = JSON.parse(atob(part + "=".repeat((4 - part.length % 4) % 4)));
          if (typeof claims.exp === "number") until = Math.min(until, claims.exp * 1000);
        } catch (_) { /* keep the short default */ }
        if (authCache.size > 5000) authCache.clear();
        authCache.set(cacheKey, { user: sessionUser, until });
      }
    }
  }
  if (!user) return err("Not signed in", 401);

  const challengePublicLaunchAt = Date.parse("2026-10-08T23:00:00Z"); // 9 Oct 2026 00:00 UK
  // Prelaunch tests belong on demo accounts. Even the owner must not accrue
  // qualification progress before the published launch date.
  const challengePreviewAllowed = Date.now() >= challengePublicLaunchAt;

  // A bot token is scoped to trading only (api_token.scope_text:
  // 'trade:own_account') — a leaked key can move positions on that one
  // simulated account but can never touch payouts, KYC, or account
  // settings. Same restriction applies regardless of which action-name
  // format a given branch below checks (body.action vs the `action`
  // local declared further down — both read the same request body).
  const BOT_ALLOWED_ACTIONS = new Set([
    "state", "price", "prices", "open", "close", "close_all", "modify",
    "partial_close", "place_pending", "cancel_pending", "set_trailing",
  ]);
  if (authMethod === "bot" && (typeof body.action !== "string" || !BOT_ALLOWED_ACTIONS.has(body.action))) {
    return err("This API key is trade-only — it cannot access payouts, KYC, or account settings", 403);
  }

  // Free Infinity Challenge: status for the dashboard, and the claim itself
  // (first start or restart after failing). Bot tokens cannot reach these.
  if (body.action === "infinity_status") {
    const st = await infinityStatus(db, user);
    const { preset: _p, ...pub } = st;
    return new Response(JSON.stringify({ ok: true, infinity: pub }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }
  if (body.action === "claim_infinity") {
    if (!challengePreviewAllowed) return err("Challenges launch 9 October 2026.", 403);
    if (!(await claimOrderLock(db, user.id))) return err("Already processing — try again in a moment.", 429);
    try {
      const st = await infinityStatus(db, user);
      if (!st.eligible) return new Response(JSON.stringify({ ok: false, error: st.reason ?? "Not eligible", infinity_lockout: st.breach_lockout }),
        { status: 409, headers: { ...CORS, "Content-Type": "application/json" } });
      if (st.needs_age_confirmation) {
        if (body.confirm_age !== true) return err("Please confirm you are 18 or older.", 400);
        await db.from("user_profiles").update({ age_confirmed: true }).eq("user_id", user.id);
      }
      const { data: application } = await db.from("challenge_enrolment_requests")
        .select("id,status,decision_note,trading_account_id")
        .eq("user_id", user.id).eq("preset_id", "infinity_s1").maybeSingle();
      if (!application) {
        return err("Complete the challenge application, declarations and identity-document upload on the website first. Once submitted, it will be reviewed within the next 24 hours.", 409);
      }
      if (application.status === "pending") {
        return new Response(JSON.stringify({
          ok: true, pending_review: true, application,
          message: "Your challenge request is waiting for review. We aim to decide within 24 hours.",
        }), { headers: { ...CORS, "Content-Type": "application/json" } });
      }
      if (application.status === "denied") {
        return err(application.decision_note || "This Infinity Challenge request was not approved.", 403);
      }
      if (application.status !== "approved") return err("This challenge is not approved yet.", 403);
      if (application.trading_account_id) {
        // Idempotent replay only while that account is still running. Once it has ended
        // (breached/closed) the trader is entitled to a fresh Stage 1 within their monthly attempts.
        const { data: existing } = await db.from("trading_accounts").select("id,label,starting_balance,status")
          .eq("id", application.trading_account_id).is("access_revoked_at", null).maybeSingle();
        if (existing && existing.status === "active") return new Response(JSON.stringify({ ok: true, account: existing }),
          { headers: { ...CORS, "Content-Type": "application/json" } });
      }
      const account = await insertAccountFromPreset(db, user.id, st.preset, 0);
      if (!account) return err("Could not start your challenge — please try again.", 500);
      await db.from("trading_accounts").update({ approval_request_id: application.id }).eq("id", account.id);
      await db.from("challenge_enrolment_requests").update({
        trading_account_id: account.id, updated_at: new Date().toISOString(),
      }).eq("id", application.id);
      return new Response(JSON.stringify({
        ok: true,
        account: { id: account.id, label: account.label, starting_balance: Number(account.starting_balance) },
        attempts_left: Math.max(0, st.attempts_left - 1),
      }), { headers: { ...CORS, "Content-Type": "application/json" } });
    } finally {
      await releaseOrderLock(db, user.id);
    }
  }

  // Live quote for the order ticket — no trading account needed. Reports
  // feed status honestly (closed/stale/demo) so the client can grey out
  // order buttons instead of pretending the feed is broker-grade.
  if (body.action === "price") {
    const symbol = cleanSymbol(body.symbol);
    if (symbol) noteWatched(db, symbol);
    if (!symbol) return err("Unknown instrument");
    noteDemand(symbol);
    await warmQuotes();
    const inst = INSTRUMENTS[symbol];
    let risk_status: { status: string; breach_reason: string | null } | null = null;
    // The connected terminal asks for a quote every 750ms. Use that same
    // request to mark every open position and enforce drawdown, instead of
    // waiting for the slower state poll (or 10s offline sweep). This runs even
    // if the chart's selected symbol is closed: another open symbol may not be.
    if (body.enforce_risk === true) {
      const { data: riskAcct } = await db.from("trading_accounts")
        .select("*").eq("user_id", user.id).eq("status", "active")
        .is("access_revoked_at", null).maybeSingle();
      if (riskAcct) {
        const { count } = await db.from("trades").select("id", { count: "exact", head: true })
          .eq("account_id", riskAcct.id).eq("status", "open");
        if ((count ?? 0) > 0) {
          await enforce(db, riskAcct as Acct);
          risk_status = { status: riskAcct.status, breach_reason: riskAcct.breach_reason };
        }
      }
    }
    if (!marketOpen(symbol)) {
      return new Response(JSON.stringify({ ok: true, symbol, status: "closed", digits: inst.digits, risk_status }),
        { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const q = await fetchQuote(symbol);
    if (q === null) {
      await logFeedEvent(db, "outage", symbol, "fetchQuote returned null");
      return new Response(JSON.stringify({ ok: true, symbol, status: "no_feed", digits: inst.digits, risk_status }),
        { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const stale = quoteStale(q);
    if (stale) await logFeedEvent(db, "stale", symbol, `age_ms=${Date.now() - (q.providerTs ?? q.receivedTs)}`);
    return new Response(JSON.stringify({
      ok: true, symbol, status: stale ? "stale" : (q.source === "fxcm-basic" || q.source === "tradelocker" || q.source === "ctrader" ? "live" : "demo"),
      mid: q.mid, bid: q.bid, ask: q.ask, spread: q.spread,
      quote_ts: q.providerTs, received_ts: q.receivedTs,
      digits: inst.digits, source: q.source, risk_status,
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
    await warmQuotes();
    const raw = Array.isArray(body.symbols) ? body.symbols : [];
    const symbols = [...new Set(raw.map((s: unknown) => cleanSymbol(s)).filter((s): s is string => !!s))].slice(0, 40);
    if (!symbols.length) return err("No valid instruments requested");
    const quotes = await Promise.all(symbols.map(async (symbol) => {
      const inst = INSTRUMENTS[symbol];
      // Per-symbol, not shared across the batch: a crypto symbol in the
      // same request as a forex pair over a weekend must not inherit the
      // forex closure just because it was fetched in the same call.
      if (!marketOpen(symbol)) return { symbol, status: "closed" as const, digits: inst.digits };
      const q = await fetchQuote(symbol);
      if (q === null) return { symbol, status: "no_feed" as const, digits: inst.digits };
      const stale = quoteStale(q);
      return {
        symbol, status: stale ? "stale" as const : "demo" as const,
        mid: q.mid, bid: q.bid, ask: q.ask, spread: q.spread, digits: inst.digits,
      };
    }));
    return new Response(JSON.stringify({ ok: true, quotes, source: SOURCE_ID }),
      { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Account mode is a server-resolved choice, never a client-supplied account
  // id. That prevents a trader from selecting another user's row. Challenge
  // mode only considers approved evaluation/funded rows; demo mode resolves to
  // the one permanent practice account created by fn_ensure_demo_account.
  const requestedDemo = body.account_mode === "demo";
  let breachSource: Acct | null = null;
  let acct: Acct | null = null;

  if (requestedDemo) {
    acct = await ensureDemoAccount(db, user.id);
  } else {
    const activeResult = await db.from("trading_accounts")
      .select("*").eq("user_id", user.id).eq("status", "active")
      .neq("phase", "demo").is("access_revoked_at", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    acct = (activeResult.data as Acct | null) ?? null;
  }

  if (!acct) {
    // Revoked breached rows remain server-visible for an immutable reason and
    // continuation source, but never become the selected trading account.
    const { data: last } = await db.from("trading_accounts")
      .select("*").eq("user_id", user.id).neq("phase", "demo")
      .or("access_revoked_at.is.null,status.eq.breached")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();

    if (last && last.status === "passed" && last.phase !== "funded") {
      await provisionNextStage(db, last as Acct);
      const { data: nowActive } = await db.from("trading_accounts")
        .select("*").eq("user_id", user.id).eq("status", "active")
        .neq("phase", "demo").is("access_revoked_at", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      acct = (nowActive as Acct | null) ?? null;
    } else if (last && last.status === "breached") {
      breachSource = last as Acct;
      acct = await ensureDemoAccount(db, user.id);
    } else if (!last && challengePreviewAllowed) {
      // A redeemed code can provision only after launch and approval.
      // Everyone else receives a practice account.
      const provisioned = await provisionFromPromoClaim(db, user);
      acct = provisioned.ok ? provisioned.account as Acct : await ensureDemoAccount(db, user.id);
    } else {
      acct = await ensureDemoAccount(db, user.id);
    }
  }

  if (["open", "place_pending"].includes(String(body.action))) {
    const controls=await db.rpc("brain_trader_controls",{p_user:user.id});
    if(controls.error||!controls.data)return err("Trading review status could not be confirmed. No order was placed.",503);
    if(controls.data.paused)return err("New trades are paused for review: "+String(controls.data.reason||"Contact support. Existing positions can still close."),409);
  }
  if (!requestedDemo && ((acct as Acct).challenge_type === "infinity" || isDemoAccount(acct as Acct)) &&
    ["open", "place_pending"].includes(String(body.action))) {
    const monthly = await db.rpc("fn_infinity_breach_lockout", { p_user: user.id });
    if (monthly.error || !monthly.data) return err("Infinity eligibility could not be confirmed. No order was placed.", 503);
    if (monthly.data.locked) return new Response(JSON.stringify({ ok: false, order_blocked: true,
      error: monthly.data.message, infinity_lockout: monthly.data }),
      { status: 409, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  const state = await enforce(db, acct as Acct);
  const action = body.action;

  // A challenge order submitted after the account was already failed must
  // not silently become a practice order. An explicit demo choice is allowed.
  if (breachSource && !requestedDemo && isDemoAccount(acct as Acct) &&
    ["open", "place_pending", "cancel_pending", "modify", "set_trailing", "partial_close", "close", "close_all"].includes(String(action))) {
    return new Response(JSON.stringify({ ...(await statePayload(db, acct as Acct, state.open, state.equity, state.floating)),
      breach_notice: await breachNotice(db, breachSource), switched_to_demo: true, order_blocked: true,
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // A live tick can breach the selected challenge during this very request.
  // Switch before any requested mutation is processed, so an order submitted
  // on the failed account is blocked rather than silently replayed on demo.
  if (!isDemoAccount(acct as Acct) && (acct as Acct).status === "breached") {
    breachSource = acct as Acct;
    const demo = await ensureDemoAccount(db, user.id);
    const demoState = await enforce(db, demo);
    const payload = await statePayload(db, demo, demoState.open, demoState.equity, demoState.floating);
    return new Response(JSON.stringify({
      ...payload,
      breach_notice: await breachNotice(db, breachSource),
      switched_to_demo: true,
      order_blocked: action !== "state",
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  if (action === "state") {
    const payload = await statePayload(db, acct as Acct, state.open, state.equity, state.floating);
    let alerts: unknown[] = [];
    try {
      await evaluateAlerts(db, user.id);
      const { data: al } = await db.from("price_alerts").select("*").eq("user_id", user.id)
        .or("status.eq.active,and(status.eq.triggered,seen_at.is.null)").order("created_at", { ascending: false }).limit(100);
      alerts = al ?? [];
    } catch (_) { /* alerts are best-effort; never block state */ }
    return new Response(JSON.stringify({
      ...payload,
      alerts,
      ...(breachSource ? { breach_notice: await breachNotice(db, breachSource), switched_to_demo: true } : {}),
    }),
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
    const { data: infinityPreview, error: infinityPreviewError } = await db.rpc("fn_infinity_payout_preview", { p_user_id: user.id });
    if (infinityPreviewError) return err(cleanRpcError(infinityPreviewError.message), 503);
    if (infinityPreview?.has_infinity && !infinityPreview?.completion_requested) {
      const { data: kyc } = await db.from("trader_kyc").select("status").eq("user_id", user.id).maybeSingle();
      return jsonOk({
        has_funded_account: false, payout_kind: "infinity_stage3",
        stage3_status: infinityPreview.stage3_status,
        stage2_held: Number(infinityPreview.stage2_held ?? 0),
        available_now: Number(infinityPreview.available_now ?? 0),
        minimum_withdrawal: 500, kyc_status: kyc?.status ?? "unverified",
      });
    }
    const { data: funded } = await db.from("trading_accounts")
      .select("*").eq("user_id", user.id).eq("phase", "funded")
      .or("challenge_type.neq.infinity,stage.gte.4")
      .is("access_revoked_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!funded) return jsonOk({ has_funded_account: false, minimum_withdrawal: 500, payout_kind: infinityPreview?.has_infinity ? "infinity_completed" : null });
    const { data: summary } = await db.from("trader_payout_summary").select("*").eq("account_id", funded.id).maybeSingle();
    const { data: kyc } = await db.from("trader_kyc").select("status").eq("user_id", user.id).maybeSingle();
    return jsonOk({
      has_funded_account: true, account_status: funded.status, total_paid_out: Number(funded.total_paid_out ?? 0), minimum_withdrawal: 500,
      available_now: summary ? Number(summary.trader_share_owed) : 0,
      kyc_status: kyc?.status ?? "unverified", investigation_hold: !!funded.investigation_hold,
    });
  }

  if (action === "request_payout") {
    if (await rateLimited("request_payout", 5, 60)) return err("Too many payout requests — try again later.", 429);
    const payout_method_id = body.payout_method_id ? String(body.payout_method_id) : null;
    if (!payout_method_id) return err("Select a payout method first");
    const { data: infinityStage3 } = await db.from("trading_accounts")
      .select("*").eq("user_id", user.id).eq("challenge_type", "infinity").eq("stage", 3)
      .in("status", ["active", "passed"]).is("access_revoked_at", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (infinityStage3?.status === "active") return err("Stage 2 earnings are held. Complete Stage 3 before requesting a payout; the minimum withdrawal is $500.", 409);
    const stage3Complete = infinityStage3?.status === "passed" && Number(infinityStage3.balance) >= Number(infinityStage3.starting_balance) * (1 + Number(infinityStage3.profit_target_pct ?? 6) / 100);
    const { data: stage3Payout } = stage3Complete ? await db.from("payouts").select("id")
      .eq("account_id", infinityStage3!.id).eq("programme_event", "INFINITY_STAGE3_COMPLETION_PAYOUT")
      .neq("status", "void").limit(1).maybeSingle() : { data: null };
    if (stage3Complete && !stage3Payout) {
      const idem = typeof body.idempotency_key === "string" && body.idempotency_key ? body.idempotency_key : `infinity_s3_${user.id}_${infinityStage3.id}_${Date.now()}`;
      const { data: result, error } = await db.rpc("fn_request_infinity_stage3_payout", {
        p_account_id: infinityStage3.id, p_requested_by: user.id,
        p_idempotency_key: idem, p_payout_method_id: payout_method_id,
      });
      if (error) return err(cleanRpcError(error.message), 409);
      return jsonOk({ payout: result, programme_event: result?.programme_event ?? "INFINITY_STAGE3_PAYOUT" });
    }
    if (infinityStage3 && !stage3Complete) return err("Complete Stage 3 before requesting a payout; the minimum withdrawal is $500.", 409);
    const { data: funded } = await db.from("trading_accounts")
      .select("*").eq("user_id", user.id).eq("phase", "funded")
      .or("challenge_type.neq.infinity,stage.gte.4")
      .is("access_revoked_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!funded) return err(stage3Payout ? "The Stage 3 payout has already been requested." : "No completed Stage 3 or funded account is eligible for a payout yet", 404);
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
    if (!(await claimOrderLock(db, (acct as Acct).id))) {
      return err("Another order on this account is still being processed — try again in a moment.", 429);
    }
    try {
      if (!isTradableAccount(acct as Acct)) return err("Account is " + (acct as Acct).status, 409);
      if (((acct as Acct).venue ?? "ipfx") !== "ipfx") return err("This challenge is traded in your broker TradeLocker demo account, not on IPFX Markets.", 409);
      if (await orderBurstExceeded(db, (acct as Acct).id)) {
        return err(`Too many orders — at most ${ORDER_BURST_LIMIT} new orders every ${ORDER_BURST_WINDOW_MS / 1000} seconds.`, 429);
      }
      if (state.unpriced > 0) {
        return err("Pricing is unavailable for one of your open positions — new orders are paused until it returns.", 503);
      }
      const { data: platCfg } = await db.from("platform_config").select("trading_halted,halted_reason").eq("id", true).maybeSingle();
      if (platCfg?.trading_halted) return err("Trading is temporarily paused: " + (platCfg.halted_reason || "platform maintenance"), 503);

      const symbol = cleanSymbol(body.symbol);
      if (!symbol) return err("Unknown instrument");
      const gate = instrumentGate(acct as Acct, symbol);
      if (gate) return err(gate, 409);
      const side = body.side === "buy" || body.side === "sell" ? body.side : null;
      if (!side) return err("Side must be buy or sell");
      const orderType = body.order_type === "limit" || body.order_type === "stop" ? body.order_type : null;
      if (!orderType) return err("Order type must be limit or stop");
      const volume = Math.round(Number(body.volume) * 100) / 100;
      const volumeProblem = volumeError(symbol, volume);
      if (volumeProblem) return err(volumeProblem);
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

      let expiresAt: string | null = null;
      if (body.expires_at) {
        const t = Date.parse(String(body.expires_at));
        if (!isFinite(t) || t <= Date.now() + 60_000) return err("Expiry must be at least a minute in the future");
        if (t > Date.now() + 90 * 86400_000) return err("Expiry can be at most 90 days ahead");
        expiresAt = new Date(t).toISOString();
      }

      // OCO: link this order to an existing resting order; whichever fills first cancels the other.
      let ocoGroup: string | null = null;
      let ocoLinkId: string | null = null;
      if (body.oco_with) {
        const { data: link } = await db.from("pending_orders").select("id,oco_group,status,symbol")
          .eq("id", String(body.oco_with)).eq("account_id", (acct as Acct).id).maybeSingle();
        if (!link || link.status !== "pending") return err("The order you linked is no longer pending", 409);
        if (link.symbol !== symbol) return err("Both OCO orders must be on the same instrument");
        ocoGroup = link.oco_group ?? link.id;
        ocoLinkId = link.oco_group ? null : link.id;
      }

      const { data: created, error: pErr } = await db.from("pending_orders").insert({
        account_id: (acct as Acct).id, user_id: user.id, symbol, side,
        order_type: orderType, volume, trigger_price: trigger, sl, tp,
        expires_at: expiresAt, oco_group: ocoGroup,
      }).select("*").single();
      if (pErr) return err("Could not place the order", 500);
      if (ocoLinkId) {
        const { data: linked } = await db.from("pending_orders").update({ oco_group: ocoGroup })
          .eq("id", ocoLinkId).eq("status", "pending").select("id");
        if (!linked || !linked.length) {
          await db.from("pending_orders").update({ status: "cancelled", reject_reason: "OCO: linked order filled first", resolved_at: new Date().toISOString() }).eq("id", created.id);
          return err("The order you linked filled or was cancelled first — the new order was not placed", 409);
        }
      }
      const orderId = await logAudit(db, {
        pending_order_id: created.id, user_id: user.id, account_id: (acct as Acct).id, event: "place_pending",
        symbol, side, requested_volume: volume, requested_price: trigger, quote: q, client_ip: clientIp,
      });
      return jsonOk({ ...await statePayload(db, acct as Acct, state.open, state.equity, state.floating), pending: created, order_id: orderId });
    } finally {
      await releaseOrderLock(db, (acct as Acct).id);
    }
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
    return jsonOk(await statePayload(db, acct as Acct, state.open, state.equity, state.floating));
  }

  // ---- price alerts ----
  if (action === "list_alerts") {
    const { data } = await db.from("price_alerts").select("*").eq("user_id", user.id)
      .order("created_at", { ascending: false }).limit(200);
    return jsonOk({ alerts: data ?? [] });
  }
  if (action === "create_alert") {
    const symbol = cleanSymbol(body.symbol);
    if (!symbol) return err("Unknown instrument");
    const condition = body.condition === "above" || body.condition === "below" ? body.condition : null;
    if (!condition) return err("Condition must be above or below");
    const price = Number(body.price);
    if (!isFinite(price) || price <= 0) return err("Enter a valid alert price");
    const note = body.note ? String(body.note).slice(0, 140) : null;
    const { count } = await db.from("price_alerts").select("id", { count: "exact", head: true })
      .eq("user_id", user.id).eq("status", "active");
    if ((count ?? 0) >= 50) return err("You can have at most 50 active alerts");
    const q = await fetchQuote(symbol);
    if (q !== null && !quoteStale(q)) {
      const m = (q.bid + q.ask) / 2;
      if (condition === "above" ? m >= price : m <= price) return err(`Price is already ${condition} ${price}`);
    }
    const { data, error } = await db.from("price_alerts").insert({ user_id: user.id, symbol, condition, price, note }).select("*").single();
    if (error) return err("Could not save the alert", 500);
    return jsonOk({ alert: data });
  }
  if (action === "cancel_alert") {
    const id = String(body.alert_id ?? "");
    const { data } = await db.from("price_alerts").update({ status: "cancelled" })
      .eq("id", id).eq("user_id", user.id).eq("status", "active").select("id");
    if (!data || !data.length) return err("That alert is no longer active", 409);
    return jsonOk({});
  }
  if (action === "alerts_seen") {
    const ids = Array.isArray(body.alert_ids) ? body.alert_ids.map(String).slice(0, 200) : [];
    if (ids.length) {
      await db.from("price_alerts").update({ seen_at: new Date().toISOString() })
        .eq("user_id", user.id).eq("status", "triggered").is("seen_at", null).in("id", ids);
    }
    return jsonOk({});
  }

  // ---- account statement (works for breached/closed accounts too) ----
  if (action === "statement") {
    const A = acct as Acct;
    const to = body.to ? new Date(String(body.to)) : new Date();
    const from = body.from ? new Date(String(body.from)) : new Date(to.getTime() - 30 * 86400_000);
    if (!isFinite(from.getTime()) || !isFinite(to.getTime()) || from >= to) return err("Invalid statement period");
    if (to.getTime() - from.getTime() > 366 * 86400_000) return err("A statement can cover at most one year");
    const fromIso = from.toISOString(), toIso = to.toISOString();
    const [{ data: trades }, { data: after }, { data: payouts }] = await Promise.all([
      db.from("trades").select("id,symbol,side,volume,open_price,close_price,sl,tp,opened_at,closed_at,pnl,close_reason")
        .eq("account_id", A.id).eq("status", "closed").gte("closed_at", fromIso).lt("closed_at", toIso)
        .order("closed_at", { ascending: true }).limit(5000),
      db.from("trades").select("pnl").eq("account_id", A.id).eq("status", "closed").gte("closed_at", toIso).limit(20000),
      db.from("payouts").select("id,trader_share,status,approved_at,paid_at,period_start,period_end")
        .eq("account_id", A.id).in("status", ["approved", "paid"]).order("approved_at", { ascending: true }),
    ]);
    type PnlRow = { pnl: number | null };
    type PayRow = { trader_share: number; approved_at: string | null };
    const sum = (rows: PnlRow[] | null) => round2((rows ?? []).reduce((a, r) => a + Number(r.pnl ?? 0), 0));
    const paidSum = (rows: PayRow[]) => round2(rows.reduce((a, r) => a + Number(r.trader_share ?? 0), 0));
    const pays = (payouts ?? []) as PayRow[];
    const payoutsIn = pays.filter((p) => !!p.approved_at && p.approved_at >= fromIso && p.approved_at < toIso);
    const payoutsAfter = pays.filter((p) => !!p.approved_at && p.approved_at >= toIso);
    const tr = (trades ?? []) as PnlRow[];
    const net = sum(tr);
    // Balance only moves on closed-trade P&L and approved payouts, so walk back from today's balance.
    const closingBalance = round2(Number(A.balance) - sum(after as PnlRow[]) + paidSum(payoutsAfter));
    const openingBalance = round2(closingBalance - net + paidSum(payoutsIn));
    const wins = tr.filter((t) => Number(t.pnl) > 0);
    const losses = tr.filter((t) => Number(t.pnl) < 0);
    return jsonOk({
      statement: {
        generated_at: new Date().toISOString(), from: fromIso, to: toIso,
        account: { id: A.id, label: A.label, status: A.status, phase: A.phase ?? "evaluation", starting_balance: Number(A.starting_balance), is_demo: isDemoAccount(A) },
        summary: {
          opening_balance: openingBalance, closing_balance: closingBalance, net_pnl: net,
          payouts: paidSum(payoutsIn), trades: tr.length, wins: wins.length, losses: losses.length,
          gross_profit: sum(wins), gross_loss: sum(losses),
          win_rate_pct: tr.length ? round2(wins.length / tr.length * 100) : null,
        },
        trades: trades ?? [], payouts: payoutsIn,
      },
    });
  }

  if (!isTradableAccount(acct as Acct)) return err("Account is " + (acct as Acct).status, 409);
  if (((acct as Acct).venue ?? "ipfx") !== "ipfx") return err("This challenge is traded in your broker TradeLocker demo account, not on IPFX Markets.", 409);

  if (action === "open") {
    if (!(await claimOrderLock(db, (acct as Acct).id))) {
      return err("Another order on this account is still being processed — try again in a moment.", 429);
    }
    try {
      if (await orderBurstExceeded(db, (acct as Acct).id)) {
        return err(`Too many orders — at most ${ORDER_BURST_LIMIT} new orders every ${ORDER_BURST_WINDOW_MS / 1000} seconds.`, 429);
      }
      // Idempotent opens: a retried or double-submitted request with the same client_order_id
      // returns the current state instead of opening a second position.
      const clientOrderId = typeof body.client_order_id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.client_order_id) ? body.client_order_id : null;
      const duplicateState = async () => {
        const now = await enforce(db, acct as Acct);
        return new Response(JSON.stringify({ ...(await statePayload(db, acct as Acct, now.open, now.equity, now.floating)), duplicate_order: true }),
          { headers: { ...CORS, "Content-Type": "application/json" } });
      };
      if (clientOrderId) {
        const { data: dup } = await db.from("trades").select("id").eq("account_id", (acct as Acct).id).eq("client_order_id", clientOrderId).maybeSingle();
        if (dup) return await duplicateState();
      }
      if (state.unpriced > 0) {
        return err("Pricing is unavailable for one of your open positions — new orders are paused until it returns.", 503);
      }
      // Platform kill switch: new orders only. Closing/flattening stays
      // allowed during a halt so traders can protect existing positions.
      const { data: platCfg } = await db.from("platform_config").select("trading_halted,halted_reason").eq("id", true).maybeSingle();
      if (platCfg?.trading_halted) return err("Trading is temporarily paused: " + (platCfg.halted_reason || "platform maintenance"), 503);

      const symbol = cleanSymbol(body.symbol);
      if (!symbol) return err("Unknown instrument");
      const gate = instrumentGate(acct as Acct, symbol);
      if (gate) return err(gate, 409);
      const side = body.side === "buy" || body.side === "sell" ? body.side : null;
      if (!side) return err("Side must be buy or sell");
      const volume = Math.round(Number(body.volume) * 100) / 100;
      const volumeProblem = volumeError(symbol, volume);
      if (volumeProblem) return err(volumeProblem);
      if (state.open.length >= MAX_OPEN_POSITIONS) return err("Max " + MAX_OPEN_POSITIONS + " open positions");

      const reject = async (reason: string, q?: Quote | null) => {
        await logAudit(db, {
          user_id: user.id, account_id: (acct as Acct).id, event: "reject", reject_reason: reason,
          symbol, side, requested_volume: volume, quote: q ?? null, client_ip: clientIp,
        });
        return err(reason, 409);
      };

      // fail-closed gates, in order: market session -> symbol enabled -> quote -> stale -> spread
      if (!marketOpen(symbol)) return reject("Market is closed for this instrument");
      if (futuresSessionEnforced(acct as Acct) && !futuresSessionOpen()) {
        return reject("The futures session is closed — positions must be flat by 16:00 CT and cannot be held over the weekend.");
      }
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

      // Phase-specific max risk per trade, tightened further as the trader
      // approaches either live loss boundary.
      if (A.max_risk_per_trade_pct != null && sl !== null) {
        const riskUsd = Math.abs(fill - sl) * inst.contract * volume * conv;
        const limit = effectiveRiskLimit(A, state.equity);
        const maxRisk = limit?.effective ?? round2(startBal * Number(A.max_risk_per_trade_pct) / 100);
        if (riskUsd > maxRisk + 0.01) {
          return reject(
            `Risk on this order is $${riskUsd.toFixed(2)}, above your current $${maxRisk.toFixed(2)} limit (base cap ${A.max_risk_per_trade_pct}%). Reduce size or tighten the stop.`, q);
        }
      }
      const needed = (inst.contract * volume * q.mid * conv) / LEVERAGE;
      const used = await usedMarginUsd(state.open);
      if (used + needed > state.equity) return reject("Insufficient margin ($" + Math.round(needed) + " needed)", q);

      const v2 = rulesV2(A);
      if (v2 && A.max_risk_per_trade_pct != null && sl !== null) {
        const riskUsd = Math.abs(fill - sl) * inst.contract * volume * conv;
        const openRisk = await openRiskUsd(state.open);
        const limit = effectiveRiskLimit(A, state.equity);
        const perTrade = limit?.effective ?? round2(startBal * Number(A.max_risk_per_trade_pct) / 100);
        const cap = round2(perTrade * MAX_TOTAL_RISK_MULTIPLE);
        if (openRisk + riskUsd > cap + 0.01) {
          return reject(`Total open risk would be $${(openRisk + riskUsd).toFixed(2)}, above the current $${cap.toFixed(2)} aggregate limit. Close or tighten another position first.`, q);
        }
      }

      await flagCrossAccountHedge(db, user.id, symbol, side, clientIp);

      // Copied (A-book) account: hedge first, then fill the trader no better than the broker.
      const abBook = await abRoute(db, user.id);
      if (abBook === "a" || await hedgeOpenArmed(db, A)) {
        const takingAsk = side === "buy";
        const started = Date.now();
        const minDelay = v2 ? EXEC_DELAY_MIN_MS + Math.floor(Math.random() * (EXEC_DELAY_MAX_MS - EXEC_DELAY_MIN_MS + 1)) : 0;
        // The source row must exist before the hedge (live-mirror verifies it); it is re-priced below.
        const { data: provisional, error: insErr } = await db.from("trades").insert({
          account_id: A.id, user_id: user.id, symbol, side, volume, open_price: fill, sl, tp,
          ...(v2 ? { decision_price: fill, pnl_basis: "NET_AFTER_COSTS" } : {}),
          ...(clientOrderId ? { client_order_id: clientOrderId } : {}),
        }).select("id").single();
        if (insErr && insErr.code === "23505" && clientOrderId) return await duplicateState();
        if (insErr || !provisional) return reject("Order failed", q);
        const riskUsd = sl === null ? null : Math.abs(fill - sl) * inst.contract * volume * conv;
        const srcTrade = { id: provisional.id, account_id: A.id, user_id: user.id, symbol, side, volume, open_price: fill, close_price: null, sl, tp, status: "open", pnl: null } as Tr;
        const hedge = abBook === "a"
          ? await bookNow({ event: "open", book: "a", source_trade_id: provisional.id, risk_usd: riskUsd, price_scale_per_lot: inst.contract * conv })
          : await hedgeNow(db, A, srcTrade, "open", riskUsd);
        // The broker round trip is the execution delay; top it up so timing never differs from other orders.
        const rest = minDelay - (Date.now() - started);
        if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
        let later: Quote | null = null;
        if (v2) { await warmQuotes(true); later = await fetchQuote(symbol); if (later && quoteStale(later)) later = null; }
        const brokerFill = Number(hedge?.fill_price) > 0 ? Number(hedge!.fill_price) : null;
        let px = worseFill(takingAsk, fill, later ? (takingAsk ? later.ask : later.bid) : null, brokerFill) ?? fill;
        if (v2) px = adverse(px, takingAsk, spec.slippageBps);
        const openPx = roundAdverse(symbol, px, takingAsk);
        await db.from("trades").update({
          open_price: openPx,
          ...(v2 ? {
            execution_shortfall: await shortfallUsd(symbol, takingAsk, fill, openPx, volume),
            execution_latency_ms: Date.now() - started,
          } : {}),
        }).eq("id", provisional.id).eq("status", "open");
        if (!brokerFill) console.error(JSON.stringify({ event: "hedge_open_unpriced", trade_id: provisional.id, result: hedge ? JSON.stringify(hedge).slice(0, 200) : null }));
        await logAudit(db, {
          trade_id: provisional.id, user_id: user.id, account_id: A.id, event: "open",
          symbol, side, requested_volume: volume, requested_price: fill, fill_price: openPx, quote: q, client_ip: clientIp,
        });
        await db.from("equity_snapshots").insert({ account_id: A.id, user_id: user.id, balance: A.balance, equity: state.equity });
      } else {
      let openPrice = fill;
      let execInfo: Record<string, unknown> = {};
      if (v2) {
        const ex = await executeAtMarket(symbol, side === "buy", q, spec.slippageBps, true);
        if (ex === null) return reject("Price feed dropped during execution — order not filled", q);
        if (sl !== null && ((side === "buy" && sl >= ex.price) || (side === "sell" && sl <= ex.price))) {
          return reject("Price moved through your stop-loss during execution — order not filled", ex.quote);
        }
        if (tp !== null && ((side === "buy" && tp <= ex.price) || (side === "sell" && tp >= ex.price))) {
          return reject("Price moved through your take-profit during execution — order not filled", ex.quote);
        }
        if (A.max_risk_per_trade_pct != null && sl !== null) {
          const riskAtFill = Math.abs(ex.price - sl) * inst.contract * volume * conv;
          const limit = effectiveRiskLimit(A, state.equity);
          const maxRisk = limit?.effective ?? round2(startBal * Number(A.max_risk_per_trade_pct) / 100);
          if (riskAtFill > maxRisk + 0.01) {
            return reject(`Slippage took this order's risk to $${riskAtFill.toFixed(2)}, above the current $${maxRisk.toFixed(2)} limit — order not filled`, ex.quote);
          }
        }
        openPrice = ex.price;
        execInfo = {
          decision_price: ex.decision,
          execution_shortfall: await shortfallUsd(symbol, side === "buy", ex.decision, ex.price, volume),
          execution_latency_ms: ex.latencyMs,
          pnl_basis: "NET_AFTER_COSTS",
        };
      }

      const { data: inserted, error } = await db.from("trades").insert({
        account_id: (acct as Acct).id, user_id: user.id, symbol, side, volume,
        open_price: openPrice, sl, tp, ...execInfo, ...(clientOrderId ? { client_order_id: clientOrderId } : {}),
      }).select("id").single();
      if (error && error.code === "23505" && clientOrderId) return await duplicateState();
      if (error) return reject("Order failed", q);

      // The source trade is committed. Start audit and copy dispatch together.
      const mirrorRiskUsd = sl === null ? null : Math.abs(openPrice - sl) * inst.contract * volume * conv;
      mirrorLater(fireMirror(db, acct as Acct, { id: inserted.id, account_id: A.id, user_id: user.id, symbol, side, volume, open_price: openPrice, close_price: null, sl, tp, status: "open", pnl: null } as Tr, "open", mirrorRiskUsd));
      // B-book live trader: reverse right after the trader's fill.
      if (abBook === "b") bookLater({ event: "open", book: "b", source_trade_id: inserted.id, risk_usd: mirrorRiskUsd, price_scale_per_lot: inst.contract * conv });
      shadowLater(db, { event: "shadow_open", source_trade_id: inserted.id, price_scale_per_lot: inst.contract * conv });
      await logAudit(db, {
          trade_id: inserted?.id, user_id: user.id, account_id: (acct as Acct).id, event: "open",
          symbol, side, requested_volume: volume, requested_price: fill, fill_price: openPrice, quote: q, client_ip: clientIp,
        });

      await db.from("equity_snapshots").insert({
        account_id: (acct as Acct).id, user_id: user.id, balance: (acct as Acct).balance, equity: state.equity,
      });
      }
    } finally {
      await releaseOrderLock(db, (acct as Acct).id);
    }
  } else if (action === "close") {
    const id = typeof body.trade_id === "string" ? body.trade_id : null;
    const target = state.open.find((t) => t.id === id);
    if (!target) return err("Position not found or already closed", 404);
    const q = await fetchQuote(target.symbol);
    if (q === null) return err("No live price — try again", 503);
    if (quoteStale(q)) { await logFeedEvent(db, "stale", target.symbol, "close rejected: stale quote"); return err("Price feed is stale — try again", 503); }
    let exit = target.side === "buy" ? q.bid : q.ask;
    let execInfo: { shortfallUsd?: number } | undefined;
    if (rulesV2(acct as Acct)) {
      const spec = await symbolCheck(db, target.symbol);
      const takingAsk = target.side === "sell";
      // A copied trade's broker close (in closeTrade) is its execution delay.
      const { data: hedged } = await db.from("mirror_orders").select("id").eq("source_trade_id", target.id).eq("event", "open")
        .in("status", ["filled", "accepted_pending_position"]).not("idempotency_key", "is", null).limit(1).maybeSingle();
      const ex = await executeAtMarket(target.symbol, takingAsk, q, spec.slippageBps, false, !!hedged);
      if (ex) {
        exit = ex.price;
        execInfo = { shortfallUsd: await shortfallUsd(target.symbol, takingAsk, ex.decision, ex.price, Number(target.volume)) };
      }
    }
    const done = await closeTrade(db, acct as Acct, target, exit, "manual", q, clientIp, execInfo);
    if (!done) return err("This position was already closed (for example by its stop or take-profit)", 409);
  } else if (action === "close_all") {
    const v2c = rulesV2(acct as Acct);
    const arrivals = new Map<string, Quote>();
    for (const t of state.open) {
      const q = await fetchQuote(t.symbol);
      if (q !== null && !quoteStale(q)) arrivals.set(t.id, q);
    }
    // One shared execution delay for the whole batch rather than one per position.
    if (v2c && arrivals.size) {
      await new Promise((resolve) => setTimeout(resolve,
        EXEC_DELAY_MIN_MS + Math.floor(Math.random() * (EXEC_DELAY_MAX_MS - EXEC_DELAY_MIN_MS + 1))));
    }
    for (const t of state.open) {
      const q = arrivals.get(t.id);
      if (!q) continue;
      let exit = t.side === "buy" ? q.bid : q.ask;
      let execInfo: { shortfallUsd?: number } | undefined;
      if (v2c) {
        const spec = await symbolCheck(db, t.symbol);
        const takingAsk = t.side === "sell";
        const ex = await executeAtMarket(t.symbol, takingAsk, q, spec.slippageBps, false, true);
        if (ex) {
          exit = ex.price;
          execInfo = { shortfallUsd: await shortfallUsd(t.symbol, takingAsk, ex.decision, ex.price, Number(t.volume)) };
        }
      }
      await closeTrade(db, acct as Acct, t, exit, "manual", q, clientIp, execInfo);
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
      if (conv2 === null) return err("Could not check this stop against your risk limit — try again", 503);
      {
        const riskUsd = Math.abs(Number(target.open_price) - nsl) * inst2.contract * Number(target.volume) * conv2;
        const limit = effectiveRiskLimit(A2, state.equity);
        const maxRisk = limit?.effective ?? round2(Number(A2.starting_balance) * Number(A2.max_risk_per_trade_pct) / 100);
        if (riskUsd > maxRisk + 0.01) {
          return err(`That stop implies $${riskUsd.toFixed(2)} of risk, above your current $${maxRisk.toFixed(2)} limit (base cap ${A2.max_risk_per_trade_pct}%).`);
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

  // ---- trailing stop: set/clear the trail distance; enforce() moves the stop ----
  } else if (action === "set_trailing") {
    const id = typeof body.trade_id === "string" ? body.trade_id : null;
    const target = state.open.find((t) => t.id === id);
    if (!target) return err("Position not found or already closed", 404);
    const raw = body.distance;
    let dist: number | null = null;
    if (!(raw === null || raw === undefined || raw === "" || Number(raw) === 0)) {
      dist = Number(raw);
      const q = await fetchQuote(target.symbol);
      if (q === null || quoteStale(q)) return err("Price feed is stale — try again", 503);
      const ex = target.side === "buy" ? q.bid : q.ask;
      if (!isFinite(dist) || dist <= 0 || dist > ex * 0.2) return err("Trailing distance must be positive and under 20% of price");
      if (dist <= q.spread) return err("Trailing distance must be wider than the spread");
      // With no stop yet, the first trailed stop must respect the per-trade risk cap (measured from entry).
      const A3 = acct as Acct;
      if (target.sl === null && A3.max_risk_per_trade_pct != null) {
        const inst3 = INSTRUMENTS[target.symbol];
        const conv3 = await usdPerQuote(inst3.quote);
        if (conv3 === null) return err("Could not check this stop against your risk limit — try again", 503);
        const first = target.side === "buy" ? ex - dist : ex + dist;
        const riskUsd = Math.abs(Number(target.open_price) - first) * inst3.contract * Number(target.volume) * conv3;
        const limit = effectiveRiskLimit(A3, state.equity);
        const maxRisk = limit?.effective ?? round2(Number(A3.starting_balance) * Number(A3.max_risk_per_trade_pct) / 100);
        if (riskUsd > maxRisk + 0.01) return err(`That trailing stop would start $${riskUsd.toFixed(2)} from entry, above your $${maxRisk.toFixed(2)} risk limit.`);
      }
      await logAudit(db, {
        trade_id: target.id, user_id: user.id, account_id: (acct as Acct).id, event: "modify",
        symbol: target.symbol, side: target.side, requested_volume: Number(target.volume),
        requested_price: ex, quote: q, client_ip: clientIp,
      });
    }
    const { error: tErr } = await db.from("trades").update({ trail_distance: dist }).eq("id", target.id).eq("status", "open");
    if (tErr) return err("Could not update the trailing stop", 500);

  // ---- partial close: bank part of a winner, keep the rest running ----
  } else if (action === "partial_close") {
    const id = typeof body.trade_id === "string" ? body.trade_id : null;
    const target = state.open.find((t) => t.id === id);
    if (!target) return err("Position not found or already closed", 404);
    const vol = Math.round(Number(body.volume) * 100) / 100;
    const full = Number(target.volume);
    if (!isFinite(vol) || vol < 0.01) return err("Volume must be at least 0.01 lots");
    if (INSTRUMENTS[target.symbol]?.cls === "future" && !Number.isInteger(vol)) return err("Futures positions close in whole contracts");
    if (vol >= full) return err("To close the whole position use Close, not partial close");
    if (round2(full - vol) < 0.01) return err("Remaining position would be below the 0.01 lot minimum");

    const q = await fetchQuote(target.symbol);
    if (q === null) return err("No live price — try again", 503);
    if (quoteStale(q)) return err("Price feed is stale — try again", 503);
    let exit = target.side === "buy" ? q.bid : q.ask;
    const v2p = rulesV2(acct as Acct);
    const specP = v2p ? await symbolCheck(db, target.symbol) : null;
    let sliceShortfall = 0;
    if (specP) {
      const takingAsk = target.side === "sell";
      const ex = await executeAtMarket(target.symbol, takingAsk, q, specP.slippageBps, false);
      if (ex) {
        exit = ex.price;
        sliceShortfall = await shortfallUsd(target.symbol, takingAsk, ex.decision, ex.price, vol);
      }
    }

    // Price first; the RPC rechecks ownership, volume and entry price under a
    // row lock and commits the resize, slice and balance credit together.
    const slice = { ...target, volume: vol } as Tr;
    const grossPnl = await tradePnl(slice, exit);
    if (grossPnl === null) return err("Could not price the close", 503);
    const sliceCommission = specP ? round2(specP.commissionPerLot * vol) : 0;
    const pnl = grossPnl - sliceCommission;
    const { data: committed, error: commitErr } = await db.rpc("fn_commit_ipfx_partial", {
      p_trade_id: target.id, p_account_id: (acct as Acct).id, p_user_id: user.id,
      p_expected_volume: full, p_expected_open_price: Number(target.open_price),
      p_volume: vol, p_exit: exit, p_pnl: round2(pnl), p_costs_enabled: v2p,
      p_commission: sliceCommission, p_shortfall: sliceShortfall, p_slice_id: crypto.randomUUID(),
    });
    if (commitErr) return err("Could not record the partial close", 500);
    if (!committed?.ok) return err("This position changed — refresh it before retrying", 409);
    const closedSlice = { id: String(committed.slice_id) };
    (acct as Acct).balance = Number(committed.balance);
    // trade_id here is the CLOSED SLICE's own id (a distinct Position),
    // not target.id (the original position, which is still open at its
    // reduced volume) — a partial close creates a new closed position,
    // it doesn't mutate the existing open one into a closed one.
    // Book legs shrink by the same fraction (gap fixed: partial closes used to leave the copy full size).
    const pLegs = await bookLegs(db, target.id);
    if (pLegs.a || pLegs.b) bookLater({ event: "partial_close", source_trade_id: target.id, fraction: vol / full, slice_id: closedSlice.id });
    shadowLater(db, { event: "shadow_partial", source_trade_id: target.id, slice_trade_id: closedSlice.id });
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
  if (!isDemoAccount(acct as Acct) && (acct as Acct).status === "breached") {
    const failed = acct as Acct;
    const demo = await ensureDemoAccount(db, user.id);
    const demoState = await enforce(db, demo);
    const payload = await statePayload(db, demo, demoState.open, demoState.equity, demoState.floating);
    return new Response(JSON.stringify({
      ...payload,
      breach_notice: await breachNotice(db, failed),
      switched_to_demo: true,
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify(await statePayload(db, acct as Acct, after.open, after.equity, after.floating)),
    { headers: { ...CORS, "Content-Type": "application/json" } });
};

Deno.serve(async (req) => {
  const t0 = performance.now();
  const res = await handleRequest(req);
  try { res.headers.set("Server-Timing", `engine;dur=${(performance.now() - t0).toFixed(1)}`); } catch (_) { /* immutable headers */ }
  return res;
});
