// TradeLocker as IPFX Markets' price source: the firm's own connected TradeLocker demo account
// (tradelocker_demo_connections) supplies the broker's live executable bid/ask. Only prices ever leave the
// server — credentials, tokens and account identifiers stay here. Symbols without a broker instrument keep
// their existing source (FXCM / Yahoo).
import { decryptSecret, encryptSecret, jwtExpiresAt } from "./tradelocker-crypto.ts";
import { infoRoute, instruments, quote, refresh, tradeConfig } from "./tradelocker.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

// IPFX instrument key -> broker symbol (HeroFX naming). Non-".PRO" contracts.
export const TL_SYMBOLS: Record<string, string> = {
  EURUSD: "EURUSD", GBPUSD: "GBPUSD", USDJPY: "USDJPY", AUDUSD: "AUDUSD", USDCAD: "USDCAD", USDCHF: "USDCHF",
  NZDUSD: "NZDUSD", GBPJPY: "GBPJPY", EURJPY: "EURJPY", EURGBP: "EURGBP", EURCAD: "EURCAD", AUDCAD: "AUDCAD",
  XAUUSD: "XAUUSD", XAGUSD: "XAGUSD", XPTUSD: "XPTUSD", XPDUSD: "XPDUSD",
  SPXUSD: "SPX500", NSXUSD: "NAS100", DJI: "US30", UK100: "UK100", GER40: "DE40", FRA40: "F40", JPN225: "JP225", US2000: "RUS2000",
  BTCUSD: "BTCUSD", ETHUSD: "ETHUSD", ADAUSD: "ADAUSD",
};

export type FeedSession = { connectionId: string; accessToken: string; accNum: string; accountId: string };
export type FeedInstrument = { symKey: string; brokerSymbol: string; instrumentId: string; routeId: number };

// Loads the configured feed connection, renewing the access token when it is within 30 minutes of expiry.
export async function openFeedSession(db: Db, connectionId: string | null): Promise<FeedSession> {
  const key = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
  if (!key) throw new Error("FEED_ENCRYPTION_KEY_MISSING");
  let q = db.from("tradelocker_demo_connections").select("*").eq("status", "connected").eq("environment", "demo");
  q = connectionId ? q.eq("id", connectionId) : q.order("updated_at", { ascending: false }).limit(1);
  const { data: rows } = await q;
  const c = Array.isArray(rows) ? rows[0] : rows;
  if (!c) throw new Error("FEED_CONNECTION_MISSING");
  let accessToken = await decryptSecret(c.access_token_ciphertext, key);
  if (!c.access_expires_at || Date.parse(c.access_expires_at) - Date.now() < 30 * 60_000) {
    const next = await refresh(await decryptSecret(c.refresh_token_ciphertext, key));
    accessToken = next.accessToken;
    await db.from("tradelocker_demo_connections").update({
      access_token_ciphertext: await encryptSecret(next.accessToken, key),
      refresh_token_ciphertext: await encryptSecret(next.refreshToken, key),
      access_expires_at: jwtExpiresAt(next.accessToken), last_health_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", c.id);
  }
  return { connectionId: c.id, accessToken, accNum: String(c.acc_num), accountId: String(c.tradelocker_account_id) };
}

export async function loadFeedInstruments(s: FeedSession): Promise<FeedInstrument[]> {
  const list = await instruments(s.accessToken, s.accountId, s.accNum);
  const byName = new Map(list.map((r) => [String(r.name ?? r.symbol ?? "").trim().toUpperCase(), r]));
  const out: FeedInstrument[] = [];
  for (const [symKey, brokerSymbol] of Object.entries(TL_SYMBOLS)) {
    const row = byName.get(brokerSymbol);
    if (!row) continue;
    const routeId = infoRoute(row);
    const instrumentId = String(row.tradableInstrumentId ?? row.id ?? "");
    if (routeId === null || !instrumentId) continue;
    out.push({ symKey, brokerSymbol, instrumentId, routeId });
  }
  return out;
}

export async function feedQuote(s: FeedSession, i: FeedInstrument) {
  return await quote(s.accessToken, s.accNum, i.routeId, i.instrumentId);
}

export async function feedConfig(s: FeedSession) {
  return await tradeConfig(s.accessToken, s.accNum);
}
