// ============================================================
// IPFX Capital — chart-candles Edge Function (public, read-only)
//
// GET/POST { symbol, tf }  ->  { ok, symbol, tf, source, proxy, bars:[{t,o,h,l,c,v}] }
//
// Historical candles for the IPFX Markets chart. History comes from the same
// Yahoo Finance codes the trading engine falls back to; the page then aligns
// the last candle to the engine's own live price (see assets/js/ipfx-chart.js),
// so what a trader sees on the chart is the price their order fills against.
//
// `proxy: true` marks instruments whose history is a different underlying
// (spot gold/silver are charted from their futures), where the offset to the
// live price is a real basis, not noise.
//
// No account data is read or written. Rate limited per IP.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { allowRequest, safeErrorCode } from "../_shared/request-guards.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200, cacheSeconds = 0) =>
  new Response(JSON.stringify(b), {
    status,
    headers: {
      ...CORS, "Content-Type": "application/json",
      "Cache-Control": cacheSeconds ? `public, max-age=${cacheSeconds}` : "no-store",
    },
  });

// Must match INSTRUMENTS in trading-engine/index.ts. [yahoo code, proxy?]
const CODES: Record<string, [string, boolean]> = {
  EURUSD: ["EURUSD=X", false], GBPUSD: ["GBPUSD=X", false], USDJPY: ["USDJPY=X", false],
  AUDUSD: ["AUDUSD=X", false], USDCAD: ["USDCAD=X", false], USDCHF: ["USDCHF=X", false],
  NZDUSD: ["NZDUSD=X", false], GBPJPY: ["GBPJPY=X", false], EURJPY: ["EURJPY=X", false],
  EURGBP: ["EURGBP=X", false], EURCAD: ["EURCAD=X", false], AUDCAD: ["AUDCAD=X", false],
  XAUUSD: ["GC=F", true], XAGUSD: ["SI=F", true], XPTUSD: ["PL=F", false], XPDUSD: ["PA=F", false],
  SPXUSD: ["^GSPC", false], NSXUSD: ["^NDX", false], DJI: ["^DJI", false], UK100: ["^FTSE", false],
  GER40: ["^GDAXI", false], FRA40: ["^FCHI", false], JPN225: ["^N225", false], US2000: ["^RUT", false],
  BTCUSD: ["BTC-USD", false], ETHUSD: ["ETH-USD", false], LTCUSD: ["LTC-USD", false],
  ADAUSD: ["ADA-USD", false], SOLUSD: ["SOL-USD", false], DOTUSD: ["DOT-USD", false],
  ES: ["ES=F", false], MES: ["MES=F", false], NQ: ["NQ=F", false], MNQ: ["MNQ=F", false],
  YM: ["YM=F", false], MYM: ["MYM=F", false], RTY: ["RTY=F", false], M2K: ["M2K=F", false],
  CL: ["CL=F", false], MCL: ["MCL=F", false], GC: ["GC=F", false], MGC: ["MGC=F", false],
  NG: ["NG=F", false], ZB: ["ZB=F", false], ZN: ["ZN=F", false],
};
const ALIASES: Record<string, string> = { US500: "SPXUSD", SPX500: "SPXUSD", NAS100: "NSXUSD", US30: "DJI" };

// timeframe -> Yahoo interval, range, and how many source bars make one chart bar
const TF: Record<string, { interval: string; range: string; group: number; seconds: number; cache: number }> = {
  "1": { interval: "1m", range: "5d", group: 1, seconds: 60, cache: 20 },
  "3": { interval: "1m", range: "5d", group: 3, seconds: 180, cache: 20 },
  "5": { interval: "5m", range: "1mo", group: 1, seconds: 300, cache: 30 },
  "15": { interval: "15m", range: "1mo", group: 1, seconds: 900, cache: 60 },
  "30": { interval: "30m", range: "1mo", group: 1, seconds: 1800, cache: 60 },
  "60": { interval: "60m", range: "6mo", group: 1, seconds: 3600, cache: 120 },
  "240": { interval: "60m", range: "2y", group: 4, seconds: 14400, cache: 300 },
  "D": { interval: "1d", range: "5y", group: 1, seconds: 86400, cache: 900 },
  "W": { interval: "1wk", range: "10y", group: 1, seconds: 604800, cache: 1800 },
};

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
const memo = new Map<string, { at: number; body: unknown }>();

function cleanSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.toUpperCase().replace(/^[A-Z_]+:/, "").replace(/[^A-Z0-9]/g, "");
  if (ALIASES[s]) s = ALIASES[s];
  return CODES[s] ? s : null;
}

// Group source bars into fixed UTC buckets (e.g. 1m -> 3m, 60m -> 4h).
function aggregate(bars: Bar[], seconds: number): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const bucket = Math.floor(b.t / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v;
    } else {
      out.push({ ...b, t: bucket });
    }
  }
  return out;
}

async function fetchYahoo(code: string, interval: string, range: string): Promise<Bar[] | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?interval=${interval}&range=${range}&includePrePost=false`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; IPFXCharts/1.0)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  const ts: number[] = res?.timestamp ?? [];
  const q = res?.indicators?.quote?.[0];
  if (!ts.length || !q) return null;
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (![o, h, l, c].every((x) => typeof x === "number" && isFinite(x) && x > 0)) continue;
    bars.push({ t: ts[i], o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v: Number(q.volume?.[i]) || 0 });
  }
  return bars;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET" && req.method !== "POST") return json({ ok: false, error: "GET or POST only" }, 405);

  let params: Record<string, unknown> = {};
  if (req.method === "GET") {
    const u = new URL(req.url);
    params = { symbol: u.searchParams.get("symbol"), tf: u.searchParams.get("tf") };
  } else {
    try { params = await req.json(); } catch { return json({ ok: false, error: "Invalid request" }, 400); }
  }
  const symbol = cleanSymbol(params.symbol);
  const tf = String(params.tf ?? "60");
  if (!symbol) return json({ ok: false, error: "Unknown instrument" }, 400);
  if (!TF[tf]) return json({ ok: false, error: "Unknown timeframe" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ip = req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  try {
    if (!await allowRequest(db, "chart-candles:min", ip, 60, 60)) {
      return json({ ok: false, error: "Too many chart requests — wait a moment." }, 429);
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "chart_candles_rate_limit", code: safeErrorCode(e) }));
  }

  const spec = TF[tf];
  const key = `${symbol}|${tf}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < spec.cache * 1000) return json(hit.body, 200, spec.cache);

  const [code, proxy] = CODES[symbol];
  try {
    const raw = await fetchYahoo(code, spec.interval, spec.range);
    if (!raw || !raw.length) return json({ ok: false, error: "No chart history for this instrument right now" }, 502);
    // Intraday: snap every bar (including Yahoo's partial last bar) onto clean
    // UTC boundaries. Daily/weekly bars keep the exchange's own session stamps.
    const bars = spec.seconds < 86400 ? aggregate(raw, spec.seconds) : raw;
    const body = { ok: true, symbol, tf, source: "yahoo", proxy, seconds: spec.seconds, bars: bars.slice(-2000) };
    memo.set(key, { at: Date.now(), body });
    return json(body, 200, spec.cache);
  } catch (e) {
    console.error(JSON.stringify({ event: "chart_candles_fetch", symbol, tf, code: safeErrorCode(e) }));
    if (hit) return json(hit.body, 200, 10); // serve stale rather than blank the chart
    return json({ ok: false, error: "Chart history is temporarily unavailable" }, 502);
  }
});
