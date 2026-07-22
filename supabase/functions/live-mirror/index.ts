// ============================================================
// IPFX Capital — live-mirror Edge Function
//
// Forwards a verified trader's fill to their live MT5 account via
// MetaApi. Invoked fire-and-forget by trading-engine right after a
// fill, so it NEVER slows the trader's own order.
//
// SAFETY / STATE:
//   - Does nothing unless the trader has an ENABLED mirror_target
//     AND the METAAPI_TOKEN secret is set. Absent either, it logs a
//     "skipped" row and returns — no live order is placed.
//   - Called with the service-role key (internal, server-to-server).
//     It is NOT meant to be called by browsers.
//
// Body: { source_trade_id, user_id, event:"open"|"close",
//         symbol, side, volume, broker_position_id? }
//
// MetaApi REST: POST /users/current/accounts/{id}/trade
//   open  -> { actionType:"ORDER_TYPE_BUY"|"ORDER_TYPE_SELL", symbol, volume }
//   close -> { actionType:"POSITION_CLOSE_ID", positionId }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Map our internal symbols to typical MT5 broker symbols. Brokers differ
// (suffixes like .r, .m, m), so this is the adjustable seam.
function brokerSymbol(sym: string): string {
  // default: pass through (EURUSD, XAUUSD, BTCUSD, US500, ...). Override per broker here.
  const OVERRIDES: Record<string, string> = {
    // SPXUSD: "US500", NSXUSD: "USTEC", DJI: "US30",  // e.g. if broker uses these
  };
  return OVERRIDES[sym] ?? sym;
}

// deno-lint-ignore no-explicit-any
type Db = any;

async function log(db: Db, row: Record<string, unknown>) {
  try { await db.from("mirror_orders").insert(row); } catch (_) { /* best effort */ }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return new Response("bad json", { status: 400 }); }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const user_id = String(body.user_id ?? "");
  const source_trade_id = String(body.source_trade_id ?? "");
  const event = body.event === "close" ? "close" : "open";
  const symbol = String(body.symbol ?? "");
  const side = body.side === "sell" ? "sell" : body.side === "buy" ? "buy" : null;
  const volumeIn = Number(body.volume);

  const base = { source_trade_id, user_id, event, symbol, side, volume: isFinite(volumeIn) ? volumeIn : null };

  // 1. Is this trader configured + enabled for mirroring?
  const { data: target } = await db.from("mirror_targets")
    .select("*").eq("user_id", user_id).eq("enabled", true).maybeSingle();
  if (!target) {
    await log(db, { ...base, status: "skipped", error: "no enabled mirror target" });
    return new Response(JSON.stringify({ ok: true, skipped: "no target" }), { status: 200 });
  }

  // 2. Do we have MetaApi credentials?
  const token = Deno.env.get("METAAPI_TOKEN");
  if (!token) {
    await log(db, { ...base, target_id: target.id, status: "skipped", error: "METAAPI_TOKEN not set" });
    return new Response(JSON.stringify({ ok: true, skipped: "no credentials" }), { status: 200 });
  }

  const region = String(target.region || "new-york");
  const acctId = String(target.metaapi_account_id);
  const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${acctId}/trade`;

  // 3. Build the MetaApi trade payload.
  let payload: Record<string, unknown>;
  if (event === "open") {
    if (!side) { await log(db, { ...base, target_id: target.id, status: "error", error: "missing side" }); return new Response("bad side", { status: 400 }); }
    const vol = Math.max(0.01, Math.round(volumeIn * Number(target.volume_multiplier || 1) * 100) / 100);
    payload = { actionType: side === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL", symbol: brokerSymbol(symbol), volume: vol };
  } else {
    // Find the broker position id from this trade's own OPEN mirror row.
    let pid = body.broker_position_id ? String(body.broker_position_id) : null;
    if (!pid) {
      const { data: openRow } = await db.from("mirror_orders")
        .select("broker_position_id")
        .eq("source_trade_id", source_trade_id).eq("event", "open").eq("status", "filled")
        .not("broker_position_id", "is", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      pid = openRow?.broker_position_id ?? null;
    }
    payload = pid
      ? { actionType: "POSITION_CLOSE_ID", positionId: pid }
      : { actionType: "POSITIONS_CLOSE_SYMBOL", symbol: brokerSymbol(symbol) }; // fallback: close by symbol
  }

  // 4. Fire the live order and record the result.
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "auth-token": token, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const latency = Date.now() - t0;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      await log(db, { ...base, target_id: target.id, status: "error", latency_ms: latency, error: `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}` });
      return new Response(JSON.stringify({ ok: false, error: j }), { status: 200 });
    }
    // MetaApi returns positionId / orderId on success
    const brokerPosId = j.positionId ?? j.orderId ?? null;
    await log(db, { ...base, target_id: target.id, status: "filled", latency_ms: latency, broker_position_id: brokerPosId ? String(brokerPosId) : null });
    return new Response(JSON.stringify({ ok: true, positionId: brokerPosId, latency_ms: latency }), { status: 200 });
  } catch (e) {
    await log(db, { ...base, target_id: target.id, status: "error", latency_ms: Date.now() - t0, error: String(e).slice(0, 300) });
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 200 });
  }
});
