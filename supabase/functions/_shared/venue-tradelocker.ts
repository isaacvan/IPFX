// Challenge venue: a trader's own broker TradeLocker DEMO account. IPFX reads the account (it never streams or
// redistributes prices) and applies the challenge rules to the results. Read-mostly: the only write is closing the
// trader's positions when a rule is breached.
import { instruments, positions as tlPositions, refresh, unwrap } from "./tradelocker.ts";
import { decryptSecret, encryptSecret, jwtExpiresAt } from "./tradelocker-crypto.ts";

const BASE = "https://demo.tradelocker.com/backend-api";

async function get(path: string, accessToken: string, accNum: string): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, accNum };
  const dev = Deno.env.get("TRADELOCKER_DEVELOPER_API_KEY");
  if (dev) headers["tl-developer-api-key"] = dev;
  const r = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`TRADELOCKER_HTTP_${r.status}`);
  const lossless = text.replace(/("(?:id|accountId|tradableInstrumentId|orderId|positionId)"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g, '$1"$2"')
    .replace(/([\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"');
  return JSON.parse(lossless);
}

function columns(config: Record<string, unknown>, key: string): string[] {
  const c = (config[key] as { columns?: { id: string }[] } | undefined)?.columns ?? [];
  return c.map((x) => String(x.id));
}
function asRows(names: string[], raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => Array.isArray(row) && row.length === names.length
    ? Object.fromEntries(names.map((n, i) => [n, row[i]]))
    : (row as Record<string, unknown>));
}

export type VenueSnapshot = {
  balance: number; equity: number;
  positions: { id: string; instrumentId: string; side: string; qty: number; avgPrice: number; openDate: number; unrealizedPl: number }[];
  fills: { orderId: string; positionId: string; instrumentId: string; side: string; qty: number; price: number; at: number; isOpen: boolean }[];
};

// One sync = 4 TradeLocker requests (config, state, positions, order history).
export async function readAccount(accessToken: string, accountId: string, accNum: string): Promise<VenueSnapshot> {
  const config = unwrap(await get("/trade/config", accessToken, accNum));
  const [stateRaw, posRaw, histRaw] = [
    unwrap(await get(`/trade/accounts/${accountId}/state`, accessToken, accNum)),
    unwrap(await get(`/trade/accounts/${accountId}/positions`, accessToken, accNum)),
    unwrap(await get(`/trade/accounts/${accountId}/ordersHistory`, accessToken, accNum)),
  ];
  const detailNames = columns(config, "accountDetailsConfig");
  const details = Array.isArray(stateRaw.accountDetailsData) ? Object.fromEntries(detailNames.map((n, i) => [n, (stateRaw.accountDetailsData as unknown[])[i]])) : {};
  const balance = Number(details.balance);
  const equity = Number(details.projectedBalance ?? details.balance);
  const pos = asRows(columns(config, "positionsConfig"), posRaw.positions).map((p) => ({
    id: String(p.id), instrumentId: String(p.tradableInstrumentId), side: String(p.side), qty: Number(p.qty),
    avgPrice: Number(p.avgPrice), openDate: Number(p.openDate), unrealizedPl: Number(p.unrealizedPl ?? 0),
  }));
  const fills = asRows(columns(config, "ordersHistoryConfig"), histRaw.ordersHistory)
    .filter((o) => String(o.status).toLowerCase() === "filled" && Number(o.filledQty) > 0 && o.positionId != null)
    .map((o) => ({
      orderId: String(o.id), positionId: String(o.positionId), instrumentId: String(o.tradableInstrumentId),
      side: String(o.side), qty: Number(o.filledQty), price: Number(o.avgPrice),
      at: Number(o.lastModified ?? o.createdDate), isOpen: o.isOpen === true || String(o.isOpen) === "true",
    }));
  if (!Number.isFinite(balance)) throw new Error("TRADELOCKER_STATE_INVALID");
  return { balance, equity: Number.isFinite(equity) ? equity : balance, positions: pos, fills };
}

// Closed positions = opening fills + closing fills grouped by positionId, for positions no longer open.
export function closedPositions(s: VenueSnapshot) {
  const open = new Set(s.positions.map((p) => p.id));
  const by = new Map<string, VenueSnapshot["fills"]>();
  for (const f of s.fills) { if (!open.has(f.positionId)) { const l = by.get(f.positionId) ?? []; l.push(f); by.set(f.positionId, l); } }
  const out: { positionId: string; instrumentId: string; side: string; qty: number; openPrice: number; closePrice: number; openedAt: number; closedAt: number }[] = [];
  for (const [positionId, list] of by) {
    const opens = list.filter((f) => f.isOpen), closes = list.filter((f) => !f.isOpen);
    if (!opens.length || !closes.length) continue;
    const qty = opens.reduce((a, f) => a + f.qty, 0);
    const vw = (fs: typeof list) => fs.reduce((a, f) => a + f.price * f.qty, 0) / fs.reduce((a, f) => a + f.qty, 0);
    out.push({
      positionId, instrumentId: opens[0].instrumentId, side: opens[0].side, qty,
      openPrice: vw(opens), closePrice: vw(closes),
      openedAt: Math.min(...opens.map((f) => f.at)), closedAt: Math.max(...closes.map((f) => f.at)),
    });
  }
  return out;
}

// tradableInstrumentId -> broker symbol name
export async function instrumentNames(accessToken: string, accountId: string, accNum: string): Promise<Record<string, string>> {
  const list = await instruments(accessToken, accountId, accNum);
  return Object.fromEntries(list.map((r) => [String(r.tradableInstrumentId ?? r.id), String(r.name ?? r.symbol ?? "").toUpperCase()]));
}

export { tlPositions, refresh, decryptSecret, encryptSecret, jwtExpiresAt };
