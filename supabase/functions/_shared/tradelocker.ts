export const TRADELOCKER_DEMO_BASE = "https://demo.tradelocker.com/backend-api";

export type TradeLockerTokens = { accessToken: string; refreshToken: string };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function unwrap(value: unknown): Record<string, unknown> {
  const root = object(value);
  return object(root.d ?? root.data ?? root);
}

export function tokens(value: unknown): TradeLockerTokens {
  const d = unwrap(value);
  const accessToken = String(d.accessToken ?? d.access_token ?? "");
  const refreshToken = String(d.refreshToken ?? d.refresh_token ?? "");
  if (!accessToken || !refreshToken) throw new Error("TRADELOCKER_TOKEN_RESPONSE_INVALID");
  return { accessToken, refreshToken };
}

export function rows(value: unknown, key?: string): Record<string, unknown>[] {
  const root = object(value), d = root.d ?? root.data ?? root;
  if (Array.isArray(d)) return d.map(object);
  const o = object(d);
  const candidate = key ? o[key] : (o.accounts ?? o.instruments ?? o.positions ?? o.orders ?? o.results);
  return Array.isArray(candidate) ? candidate.map(object) : [];
}

async function request(path: string, init: RequestInit, accessToken?: string, accNum?: string): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string> ?? {}) };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (accNum != null) headers.accNum = String(accNum);
  const developerKey = Deno.env.get("TRADELOCKER_DEVELOPER_API_KEY");
  if (developerKey) headers["tl-developer-api-key"] = developerKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${TRADELOCKER_DEMO_BASE}${path}`, { ...init, headers, signal: controller.signal });
    const rawBody = await response.text();
    const losslessBody = rawBody.replace(/("(?:id|accountId|tradableInstrumentId|orderId|positionId)"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g, '$1"$2"').replace(/([\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"');
    const body = (() => { try { return JSON.parse(losslessBody); } catch (_) { return {}; } })();
    if (!response.ok) throw new Error(`TRADELOCKER_HTTP_${response.status}:${JSON.stringify(body).slice(0, 180)}`);
    return body;
  } finally { clearTimeout(timer); }
}

export async function authenticate(email: string, password: string, server: string): Promise<TradeLockerTokens> {
  return tokens(await request("/auth/jwt/token", { method: "POST", body: JSON.stringify({ email, password, server }) }));
}

export async function refresh(refreshToken: string): Promise<TradeLockerTokens> {
  return tokens(await request("/auth/jwt/refresh", { method: "POST", body: JSON.stringify({ refreshToken }) }));
}

export async function accounts(accessToken: string): Promise<Record<string, unknown>[]> {
  return rows(await request("/auth/jwt/all-accounts", { method: "GET" }, accessToken), "accounts");
}

export async function instruments(accessToken: string, accountId: string, accNum: string): Promise<Record<string, unknown>[]> {
  return rows(await request(`/trade/accounts/${accountId}/instruments`, { method: "GET" }, accessToken, accNum), "instruments");
}

export function tradeRoute(instrument: Record<string, unknown>): number | null {
  const routes = Array.isArray(instrument.routes) ? instrument.routes.map(object) : [];
  const route = routes.find((r) => String(r.type).toUpperCase() === "TRADE") ?? routes[0];
  const id = Number(route?.id);
  return Number.isFinite(id) ? id : null;
}

export function strategyId(sourceTradeId: string): string {
  return `ipfx_${sourceTradeId.replace(/-/g, "").slice(0, 26)}`;
}

export function marketOrder(input: { qty: number; routeId: number; side: "buy" | "sell"; tradableInstrumentId: number; sl?: number | null; tp?: number | null; sourceTradeId: string }) {
  return {
    qty: input.qty, routeId: input.routeId, side: input.side, validity: "IOC", type: "market", price: 0,
    tradableInstrumentId: input.tradableInstrumentId, strategyId: strategyId(input.sourceTradeId),
    ...(Number.isFinite(input.sl) ? { stopLoss: input.sl } : {}),
    ...(Number.isFinite(input.tp) ? { takeProfit: input.tp } : {}),
  };
}

export async function placeMarketOrder(accessToken: string, accountId: string, accNum: string, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/trade/accounts/${accountId}/orders`, { method: "POST", body: JSON.stringify(payload) }, accessToken, accNum);
}

export async function positions(accessToken: string, accountId: string, accNum: string): Promise<Record<string, unknown>[]> {
  return rows(await request(`/trade/accounts/${accountId}/positions`, { method: "GET" }, accessToken, accNum), "positions");
}

function configuredRows(configValue: unknown, dataValue: unknown, configKey: string, dataKey: string): Record<string, unknown>[] {
  const config = unwrap(configValue);
  const columns = object(config[configKey]).columns;
  const names = Array.isArray(columns) ? columns.map((c) => String(object(c).id ?? "")) : [];
  const raw = unwrap(dataValue)[dataKey];
  if (!Array.isArray(raw)) throw new Error(`TRADELOCKER_${dataKey.toUpperCase()}_INVALID`);
  return raw.map((row) => {
    if (!Array.isArray(row)) return object(row);
    if (!names.length || row.length !== names.length) throw new Error(`TRADELOCKER_${dataKey.toUpperCase()}_CONFIG_MISMATCH`);
    return Object.fromEntries(names.map((name, index) => [name, row[index]]));
  });
}

export async function orderHistoryRows(accessToken: string, accountId: string, accNum: string): Promise<Record<string, unknown>[]> {
  const [config, orderData] = await Promise.all([
    request("/trade/config", { method: "GET" }, accessToken, accNum),
    request(`/trade/accounts/${accountId}/ordersHistory`, { method: "GET" }, accessToken, accNum),
  ]);
  return configuredRows(config, orderData, "ordersHistoryConfig", "ordersHistory");
}
export async function positionAndOrderRows(accessToken: string, accountId: string, accNum: string): Promise<{ positions: Record<string, unknown>[]; ordersHistory: Record<string, unknown>[] }> {
  const config = await request("/trade/config", { method: "GET" }, accessToken, accNum);
  const [positionData, orderData] = await Promise.all([
    request(`/trade/accounts/${accountId}/positions`, { method: "GET" }, accessToken, accNum),
    request(`/trade/accounts/${accountId}/ordersHistory`, { method: "GET" }, accessToken, accNum),
  ]);
  return {
    positions: configuredRows(config, positionData, "positionsConfig", "positions"),
    ordersHistory: configuredRows(config, orderData, "ordersHistoryConfig", "ordersHistory"),
  };
}
export function responseIds(value: unknown): { orderId: string | null; positionId: string | null } {
  const d = unwrap(value);
  const orderId = d.orderId ?? d.order_id ?? d.id ?? null;
  const positionId = d.positionId ?? d.position_id ?? null;
  return { orderId: orderId == null ? null : String(orderId), positionId: positionId == null ? null : String(positionId) };
}

export async function closePosition(accessToken: string, accNum: string, positionId: string): Promise<unknown> {
  return request(`/trade/positions/${encodeURIComponent(positionId)}`, { method: "DELETE", body: JSON.stringify({ qty: 0 }) }, accessToken, accNum);
}

// ---- market data (price feed) ----
// Quotes use the instrument's INFO route; orders use its TRADE route.
export function infoRoute(instrument: Record<string, unknown>): number | null {
  const routes = Array.isArray(instrument.routes) ? instrument.routes.map(object) : [];
  const route = routes.find((r) => String(r.type).toUpperCase() === "INFO") ?? routes.find((r) => String(r.type).toUpperCase() === "TRADE") ?? routes[0];
  const id = Number(route?.id);
  return Number.isFinite(id) ? id : null;
}

export async function tradeConfig(accessToken: string, accNum: string): Promise<Record<string, unknown>> {
  return unwrap(await request("/trade/config", { method: "GET" }, accessToken, accNum));
}

// Current executable bid/ask for one instrument. Returns null when the broker has no price.
export async function quote(accessToken: string, accNum: string, routeId: number, tradableInstrumentId: number | string): Promise<{ bid: number; ask: number } | null> {
  const d = unwrap(await request(`/trade/quotes?routeId=${routeId}&tradableInstrumentId=${tradableInstrumentId}`, { method: "GET" }, accessToken, accNum));
  const bid = Number(d.bp ?? d.bid), ask = Number(d.ap ?? d.ask);
  return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid ? { bid, ask } : null;
}

// ---- exact broker fill (hedge-first execution) ----
// The column layout in /trade/config is fixed per server, so it is cached: each fill lookup is
// then one request, which matters under TradeLocker's per-account rate limit.
const configCache = new Map<string, { at: number; value: unknown }>();
async function cachedConfig(accessToken: string, accNum: string): Promise<unknown> {
  const hit = configCache.get(accNum);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const value = await request("/trade/config", { method: "GET" }, accessToken, accNum);
  configCache.set(accNum, { at: Date.now(), value });
  return value;
}
export type BrokerFill = { price: number; qty: number; positionId: string | null; orderId: string | null };
// Finds the broker's executed price for one order (by orderId) or, failing that, the newest
// filled closing order of a position. Polls briefly because a fill can take a moment to appear.
export async function orderFill(
  accessToken: string, accountId: string, accNum: string,
  want: { orderId?: string | null; positionId?: string | null; closing?: boolean },
  waitsMs: number[] = [120, 250, 450, 700],
): Promise<BrokerFill | null> {
  const config = await cachedConfig(accessToken, accNum);
  for (const wait of waitsMs) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    const data = await request(`/trade/accounts/${accountId}/ordersHistory`, { method: "GET" }, accessToken, accNum);
    const list = configuredRows(config, data, "ordersHistoryConfig", "ordersHistory")
      .filter((o) => String(o.status ?? "").toLowerCase() === "filled" && Number(o.filledQty) > 0 && Number(o.avgPrice) > 0);
    let hit = want.orderId ? list.find((o) => String(o.id ?? o.orderId ?? "") === String(want.orderId)) : undefined;
    if (!hit && want.positionId && want.closing) {
      hit = list.filter((o) => String(o.positionId ?? "") === String(want.positionId) && !(o.isOpen === true || String(o.isOpen) === "true"))
        .sort((a, b) => Number(b.lastModified ?? b.createdDate ?? 0) - Number(a.lastModified ?? a.createdDate ?? 0))[0];
    }
    if (hit) {
      return { price: Number(hit.avgPrice), qty: Number(hit.filledQty), positionId: hit.positionId == null ? null : String(hit.positionId),
        orderId: hit.id == null ? null : String(hit.id) };
    }
  }
  return null;
}
