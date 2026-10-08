// Read-only TradeLocker client for the cost monitor (E8 funded account and demo accounts). It can log in,
// list accounts and instruments, read quotes and read history. It has NO order functions by design: a
// monitored funded account can never be traded from IPFX.
import { configuredRows, rows, tokens, unwrap, type TradeLockerTokens } from "./tradelocker.ts";

export const TL_BASES = {
  demo: "https://demo.tradelocker.com/backend-api",
  live: "https://live.tradelocker.com/backend-api",
} as const;
export type TlEnv = keyof typeof TL_BASES;

async function get(base: string, path: string, init: RequestInit, accessToken?: string, accNum?: string, before?: (path: string) => Promise<void>): Promise<unknown> {
  if (init.method && init.method !== "GET" && !path.startsWith("/auth/jwt/")) throw new Error("READ_ONLY_CLIENT");
  await before?.(path);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (accNum != null) headers.accNum = String(accNum);
  const developerKey = Deno.env.get("TRADELOCKER_DEVELOPER_API_KEY");
  if (developerKey) headers["tl-developer-api-key"] = developerKey;
  const r = await fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(8_000) });
  const raw = await r.text();
  const lossless = raw.replace(/("(?:id|accountId|tradableInstrumentId|orderId|positionId)"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g, '$1"$2"').replace(/([\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"');
  const body = (() => { try { return JSON.parse(lossless); } catch (_) { return {}; } })();
  if (!r.ok) throw new Error(`TRADELOCKER_HTTP_${r.status}`);
  return body;
}

export function readClient(env: TlEnv, before?: (path: string) => Promise<void>) {
  const base = TL_BASES[env];
  const read = (path: string, init: RequestInit, token?: string, accNum?: string) => get(base,path,init,token,accNum,before);
  return {
    env,
    authenticate: async (email: string, password: string, server: string): Promise<TradeLockerTokens> =>
      tokens(await read("/auth/jwt/token", { method: "POST", body: JSON.stringify({ email, password, server }) })),
    refresh: async (refreshToken: string): Promise<TradeLockerTokens> =>
      tokens(await read("/auth/jwt/refresh", { method: "POST", body: JSON.stringify({ refreshToken }) })),
    accounts: async (accessToken: string) => rows(await read("/auth/jwt/all-accounts", { method: "GET" }, accessToken), "accounts"),
    instruments: async (accessToken: string, accountId: string, accNum: string) =>
      rows(await read(`/trade/accounts/${accountId}/instruments`, { method: "GET" }, accessToken, accNum), "instruments"),
    config: async (accessToken: string, accNum: string) =>
      unwrap(await read("/trade/config", { method: "GET" }, accessToken, accNum)),
    instrumentDetails: async (accessToken: string, accNum: string, routeId: number, instrumentId: string) =>
      unwrap(await read(`/trade/instruments/${encodeURIComponent(instrumentId)}?routeId=${routeId}&locale=en`, { method: "GET" }, accessToken, accNum)),
    historyWithConfig: async (accessToken: string, accountId: string, accNum: string, config: unknown) =>
      configuredRows(config, await read(`/trade/accounts/${accountId}/ordersHistory`, { method: "GET" }, accessToken, accNum), "ordersHistoryConfig", "ordersHistory"),
    quote: async (accessToken: string, accNum: string, routeId: number, tradableInstrumentId: string | number) => {
      const d = unwrap(await read(`/trade/quotes?routeId=${routeId}&tradableInstrumentId=${tradableInstrumentId}`, { method: "GET" }, accessToken, accNum));
      const bid = Number(d.bp ?? d.bid), ask = Number(d.ap ?? d.ask);
      return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid ? { bid, ask } : null;
    },
    history: async (accessToken: string, accountId: string, accNum: string) => {
      const config = await read("/trade/config", { method: "GET" }, accessToken, accNum);
      const data = await read(`/trade/accounts/${accountId}/ordersHistory`, { method: "GET" }, accessToken, accNum);
      return configuredRows(config, data, "ordersHistoryConfig", "ordersHistory");
    },
  };
}

// Log in on whichever TradeLocker environment accepts the account (prop firms differ).
export async function loginAnyEnv(email: string, password: string, server: string): Promise<{ env: TlEnv; tok: TradeLockerTokens }> {
  let last: unknown = null;
  for (const env of ["demo", "live"] as TlEnv[]) {
    try { return { env, tok: await readClient(env).authenticate(email, password, server) }; } catch (e) { last = e; }
  }
  throw last ?? new Error("TRADELOCKER_LOGIN_FAILED");
}
