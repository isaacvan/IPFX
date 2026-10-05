// Cost monitor (every minute, pg_cron with a dedicated secret). Compares what trading really costs on the
// owner's E8 funded account ("monitor", read-only) with the TradeLocker demo accounts that receive every
// trader's copies ("shadow") and with IPFX's own feed: spreads sampled at the same moment, and commission /
// overnight fees from each account's filled orders. Uses the read-only TradeLocker client (no order functions).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptSecret, encryptSecret, jwtExpiresAt } from "../_shared/tradelocker-crypto.ts";
import { readClient, type TlEnv } from "../_shared/tradelocker-read.ts";
import { TL_SYMBOLS } from "../_shared/tradelocker-feed.ts";

const SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "NSXUSD", "DJI", "BTCUSD", "GER40"];
const SHADOW_SAMPLED = 2;          // spreads are the same on one server, so two demo accounts are enough

function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
function instrumentFor(map: Array<Record<string, unknown>>, symbol: string) {
  const want = norm(TL_SYMBOLS[symbol] ?? symbol);
  return map.find((m) => norm(String(m.symbol)) === want) ?? map.find((m) => norm(String(m.symbol)).startsWith(want));
}
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

Deno.serve(async (req) => {
  const secret = Deno.env.get("COST_MONITOR_SECRET") ?? "";
  if (req.method !== "POST" || secret.length < 32 || !constantTimeEqual(req.headers.get("x-cost-secret") ?? "", secret)) return json({ error: "unauthorised" }, 401);
  const key = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
  if (!key) return json({ error: "token encryption unavailable" }, 503);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: accts } = await db.from("ladder_accounts").select("*").in("role", ["monitor", "shadow"]).not("access_token_ciphertext", "is", null).order("id");
  const chosen = [...(accts ?? []).filter((a) => a.role === "monitor"), ...(accts ?? []).filter((a) => a.role === "shadow").slice(0, SHADOW_SAMPLED)];
  const historyDue = new Date().getUTCMinutes() % 15 === 0;
  const { data: ipfx } = await db.from("live_quotes").select("symbol,bid,ask").in("symbol", SYMBOLS);
  const ipfxBy = new Map((ipfx ?? []).map((q) => [q.symbol, q]));
  const out: Record<string, unknown>[] = [];

  for (const a of chosen) {
    const tl = readClient((a.api_env ?? "demo") as TlEnv);
    try {
      let token = await decryptSecret(a.access_token_ciphertext, key);
      if (!a.access_expires_at || Date.parse(a.access_expires_at) - Date.now() < 30 * 60_000) {
        const next = await tl.refresh(await decryptSecret(a.refresh_token_ciphertext, key));
        token = next.accessToken;
        await db.from("ladder_accounts").update({ access_token_ciphertext: await encryptSecret(next.accessToken, key),
          refresh_token_ciphertext: await encryptSecret(next.refreshToken, key), access_expires_at: jwtExpiresAt(next.accessToken), updated_at: new Date().toISOString() }).eq("id", a.id);
      }
      const map = (a.instrument_map ?? []) as Array<Record<string, unknown>>;
      const rows: Record<string, unknown>[] = [];
      for (const s of SYMBOLS) {
        const inst = instrumentFor(map, s);
        if (!inst || inst.info_route_id == null) continue;
        const q = await tl.quote(token, String(a.acc_num), Number(inst.info_route_id), String(inst.tradable_instrument_id)).catch(() => null);
        if (!q) continue;
        const ix = ipfxBy.get(s);
        rows.push({ account_id: a.id, role: a.role, symbol: s, bid: q.bid, ask: q.ask, spread: q.ask - q.bid,
          ipfx_bid: ix?.bid ?? null, ipfx_ask: ix?.ask ?? null, ipfx_spread: ix ? Number(ix.ask) - Number(ix.bid) : null });
      }
      if (rows.length) await db.from("cost_samples").insert(rows);
      let fills = 0;
      if (historyDue) {
        const bySym = new Map(map.map((m) => [String(m.tradable_instrument_id), String(m.symbol)]));
        const hist = await tl.history(token, String(a.account_id), String(a.acc_num));
        const filled = hist.filter((h) => /fill/i.test(String(h.status ?? "")) || num(h.filledQty) || num(h.avgPrice));
        const recs = filled.slice(-500).map((h) => ({
          account_id: a.id, role: a.role, ref: String(h.id ?? h.orderId ?? ""), symbol: bySym.get(String(h.tradableInstrumentId)) ?? null,
          side: h.side ?? null, qty: num(h.filledQty ?? h.qty), price: num(h.avgPrice ?? h.price),
          commission: num(h.commission ?? h.fee ?? h.fees), swap: num(h.swap ?? h.swaps ?? h.rollover),
          raw: h, filled_at: num(h.lastModified ?? h.createdDate) ? new Date(Number(h.lastModified ?? h.createdDate)).toISOString() : null,
        })).filter((r) => r.ref);
        if (recs.length) await db.from("cost_fills").upsert(recs, { onConflict: "account_id,ref", ignoreDuplicates: true });
        fills = recs.length;
      }
      out.push({ id: a.id, role: a.role, samples: rows.length, fills });
    } catch (e) { out.push({ id: a.id, role: a.role, error: String((e as Error)?.message ?? e).slice(0, 120) }); }
  }
  await db.from("ab_heartbeats").upsert({ worker: "cost-monitor", ok: out.every((r) => !r.error), at: new Date().toISOString(), detail: { accounts: out } });
  return json({ ok: true, accounts: out });
});
