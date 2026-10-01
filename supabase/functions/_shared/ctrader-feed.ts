// cTrader Open API (Spotware) as IPFX Markets' price source. Free API; one WebSocket connection streams
// live bid/ask for every subscribed instrument (push, not polling), JSON over wss://<host>:5036.
// Credentials (app client id/secret + an account access/refresh token) stay on the server; only prices leave it.

export const PT = {
  HEARTBEAT: 51, ERROR: 50,
  APP_AUTH_REQ: 2100, APP_AUTH_RES: 2101, ACC_AUTH_REQ: 2102, ACC_AUTH_RES: 2103,
  SYMBOLS_LIST_REQ: 2114, SYMBOLS_LIST_RES: 2115,
  SUBSCRIBE_SPOTS_REQ: 2127, SUBSCRIBE_SPOTS_RES: 2128, SPOT_EVENT: 2131,
  OA_ERROR: 2142, TOKEN_INVALIDATED: 2147, CLIENT_DISCONNECT: 2148,
  ACCOUNTS_BY_TOKEN_REQ: 2149, ACCOUNTS_BY_TOKEN_RES: 2150,
  ACCOUNT_DISCONNECT: 2164, REFRESH_TOKEN_REQ: 2173, REFRESH_TOKEN_RES: 2174,
} as const;

// IPFX instrument key -> broker symbol names to look for (brokers name index CFDs differently).
export const CT_CANDIDATES: Record<string, string[]> = {
  EURUSD: ["EURUSD"], GBPUSD: ["GBPUSD"], USDJPY: ["USDJPY"], AUDUSD: ["AUDUSD"], USDCAD: ["USDCAD"], USDCHF: ["USDCHF"],
  NZDUSD: ["NZDUSD"], GBPJPY: ["GBPJPY"], EURJPY: ["EURJPY"], EURGBP: ["EURGBP"], EURCAD: ["EURCAD"], AUDCAD: ["AUDCAD"],
  XAUUSD: ["XAUUSD", "GOLD"], XAGUSD: ["XAGUSD", "SILVER"], XPTUSD: ["XPTUSD", "PLATINUM"], XPDUSD: ["XPDUSD", "PALLADIUM"],
  SPXUSD: ["US500", "SPX500", "SP500", "USSPX500", "US500CASH"],
  NSXUSD: ["USTEC", "NAS100", "US100", "NDX100", "USTECH100", "US100CASH"],
  DJI: ["US30", "DJ30", "WS30", "USA30", "US30CASH"],
  UK100: ["UK100", "FTSE100", "UK100CASH"],
  GER40: ["DE40", "GER40", "DAX40", "GER30", "DE30", "DE40CASH"],
  FRA40: ["F40", "FRA40", "FR40", "FRANCE40", "FRA40CASH"],
  JPN225: ["JP225", "JPN225", "NIKKEI225", "JAPAN225", "JP225CASH"],
  US2000: ["US2000", "RUSSELL2000", "US2K", "RUT2000", "US2000CASH"],
  BTCUSD: ["BTCUSD"], ETHUSD: ["ETHUSD"], LTCUSD: ["LTCUSD"], ADAUSD: ["ADAUSD"], SOLUSD: ["SOLUSD"], DOTUSD: ["DOTUSD"],
};

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

// Map IPFX keys to the broker's symbolIds: exact name first, then a broker suffix variant (e.g. "EURUSD.r").
export function mapSymbols(symbols: { symbolId: number | string; symbolName?: string; enabled?: boolean }[]): Record<string, number> {
  const byName = new Map<string, number>();
  for (const s of symbols) if (s.symbolName && s.enabled !== false) byName.set(norm(s.symbolName), Number(s.symbolId));
  const out: Record<string, number> = {};
  for (const [key, cands] of Object.entries(CT_CANDIDATES)) {
    let id: number | undefined;
    for (const c of cands) { id = byName.get(c); if (id !== undefined) break; }
    if (id === undefined) {
      for (const c of cands) {
        for (const [n, sid] of byName) if (n.startsWith(c) && n.length - c.length <= 3) { id = sid; break; }
        if (id !== undefined) break;
      }
    }
    if (id !== undefined) out[key] = id;
  }
  return out;
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class CTraderStream {
  ws: WebSocket | null = null;
  lastMessageAt = 0;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private hb: ReturnType<typeof setInterval> | undefined;
  onSpot: (symbolId: number, bid: number | null, ask: number | null, ts: number | null) => void = () => {};
  onClosed: (why: string) => void = () => {};

  constructor(public host: string) {}

  open(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://${this.host}:5036`);
      this.ws = ws;
      const t = setTimeout(() => { try { ws.close(); } catch (_) { /* */ } reject(new Error("CTRADER_CONNECT_TIMEOUT")); }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(t);
        this.lastMessageAt = Date.now();
        this.hb = setInterval(() => this.raw({ payloadType: PT.HEARTBEAT, payload: {} }), 10_000);
        resolve();
      };
      ws.onerror = () => { clearTimeout(t); reject(new Error("CTRADER_SOCKET_ERROR")); };
      ws.onclose = () => { if (this.hb) clearInterval(this.hb); this.onClosed("closed"); for (const p of this.pending.values()) p.reject(new Error("CTRADER_CLOSED")); this.pending.clear(); };
      ws.onmessage = (ev) => this.handle(String(ev.data));
    });
  }

  private raw(msg: Record<string, unknown>) {
    try { this.ws?.send(JSON.stringify(msg)); } catch (_) { /* socket gone */ }
  }

  private handle(text: string) {
    this.lastMessageAt = Date.now();
    let m: { clientMsgId?: string; payloadType?: number; payload?: Record<string, unknown> };
    try { m = JSON.parse(text); } catch (_) { return; }
    const p = m.payload ?? {};
    if (m.payloadType === PT.SPOT_EVENT) {
      const bid = p.bid == null ? null : Number(p.bid) / 100000;
      const ask = p.ask == null ? null : Number(p.ask) / 100000;
      this.onSpot(Number(p.symbolId), bid, ask, p.timestamp == null ? null : Number(p.timestamp));
      return;
    }
    if (m.payloadType === PT.TOKEN_INVALIDATED || m.payloadType === PT.ACCOUNT_DISCONNECT || m.payloadType === PT.CLIENT_DISCONNECT) {
      this.onClosed("server:" + m.payloadType);
      return;
    }
    if (m.clientMsgId && this.pending.has(m.clientMsgId)) {
      const w = this.pending.get(m.clientMsgId)!;
      this.pending.delete(m.clientMsgId);
      clearTimeout(w.timer);
      if (m.payloadType === PT.OA_ERROR || m.payloadType === PT.ERROR) {
        w.reject(new Error(`CTRADER_${String(p.errorCode ?? "ERROR")}:${String(p.description ?? "").slice(0, 120)}`));
      } else w.resolve(p);
    }
  }

  request(payloadType: number, payload: Record<string, unknown>, timeoutMs = 8000): Promise<Record<string, unknown>> {
    const clientMsgId = `ipfx-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(clientMsgId); reject(new Error(`CTRADER_TIMEOUT_${payloadType}`)); }, timeoutMs);
      this.pending.set(clientMsgId, { resolve, reject, timer });
      this.raw({ clientMsgId, payloadType, payload });
    });
  }

  close() {
    if (this.hb) clearInterval(this.hb);
    try { this.ws?.close(); } catch (_) { /* */ }
  }
}

export type CTraderCreds = { clientId: string; clientSecret: string; accessToken: string; refreshToken: string; accountId: number | null; host: string };

// Full sign-in: app auth -> (find the demo account if none given) -> account auth, refreshing the access token once
// if it has expired. Returns the account id and any refreshed tokens (caller persists them).
export async function signIn(s: CTraderStream, c: CTraderCreds): Promise<{ accountId: number; refreshed: { accessToken: string; refreshToken: string; expiresIn: number } | null }> {
  await s.request(PT.APP_AUTH_REQ, { clientId: c.clientId, clientSecret: c.clientSecret });
  let accessToken = c.accessToken;
  let refreshed: { accessToken: string; refreshToken: string; expiresIn: number } | null = null;
  let accountId = c.accountId;
  const pickAccount = async () => {
    const r = await s.request(PT.ACCOUNTS_BY_TOKEN_REQ, { accessToken });
    const list = (r.ctidTraderAccount as { ctidTraderAccountId: number; isLive?: boolean }[] | undefined) ?? [];
    const demo = list.find((a) => a.isLive === false) ?? list[0];
    if (!demo) throw new Error("CTRADER_NO_ACCOUNT_FOR_TOKEN");
    return Number(demo.ctidTraderAccountId);
  };
  try {
    if (!accountId) accountId = await pickAccount();
    await s.request(PT.ACC_AUTH_REQ, { ctidTraderAccountId: accountId, accessToken });
  } catch (e) {
    if (!/ACCESS_TOKEN|TOKEN_INVALID|INVALID_TOKEN|UNAUTHORIZED/i.test(String(e))) throw e;
    const r = await s.request(PT.REFRESH_TOKEN_REQ, { refreshToken: c.refreshToken });
    accessToken = String(r.accessToken);
    refreshed = { accessToken, refreshToken: String(r.refreshToken), expiresIn: Number(r.expiresIn) };
    if (!accountId) accountId = await pickAccount();
    await s.request(PT.ACC_AUTH_REQ, { ctidTraderAccountId: accountId, accessToken });
  }
  return { accountId: accountId!, refreshed };
}
