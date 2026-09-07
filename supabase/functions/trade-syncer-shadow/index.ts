// ============================================================
// IPFX Capital — trade-syncer-shadow Edge Function
//
// Phase 4 shadow Trade Syncer (report §12, rollout step §12.12:
// "Shadow mode: no real orders; compare shadow P&L to source").
//
// THIS FUNCTION NEVER SENDS AN ORDER ANYWHERE. There is no provider
// adapter in this file, no broker API client, no network call to
// TradeLocker, HeroFX, or any other third party. Every dest_order row
// it writes has status='shadow_only', which is all the database schema
// allows it to write anyway — internal-control-core.sql's
// fn_block_live_dest_order() trigger independently rejects any
// 'sent'/'filled' status unless broker_account.api_mode='live' AND
// automation_permitted_until is current, and this function never sets
// either of those. Report §12.1: a Trade Syncer may copy only to an
// account owned or controlled by iPFX — the one broker_account this
// operates against (provider_id='ipfx-internal-shadow') is an internal
// placeholder for measuring copyability, not a connection to any real
// destination.
//
// Triggered by trade-syncer-shadow-schema.sql's AFTER INSERT trigger on
// order_audit_events (open/close events only), via pg_net — async,
// so it can never add latency to or block a real trade. A shared
// secret (X-Syncer-Secret) is required so this endpoint can't be driven
// by anyone who merely knows its URL.
//
// Pipeline stages implemented, matching report §12.2/§12.3 (stages this
// shadow scope simplifies are called out explicitly, not silently
// skipped):
//   SourceIngestor -> SchemaValidator -> staleness check -> eligibility
//   (auto-provision governance account if missing) -> pre-trade risk
//   (global kill switch) -> idempotent DurableEventLog insert ->
//   SymbolMapper -> SizeNormalizer -> DestinationRuleCheck ->
//   AuthorizationGate (always shadow-only here) -> ProviderAdapter
//   (no-op) -> shadow ack -> AuditEvent.
//   Reordering (§12.4/§12.9): a close with no prior open on file is
//   rejected as 'reordered_missing_open' rather than a full per-source
//   sequence replay buffer — documented simplification, not silent
//   mis-processing.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Db = ReturnType<typeof createClient>;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-syncer-secret",
};

// Same instrument registry as trading-engine — contract = units per 1.00
// lot (or per index point), which is exactly the "point value" report
// §12.7's sizing formula needs. Kept in sync manually; each edge function
// in this project is self-contained by existing convention (no shared
// module imports between functions).
const INSTRUMENTS: Record<string, { digits: number; contract: number; spread: number }> = {
  EURUSD: { digits: 5, contract: 100000, spread: 0.0002 },
  GBPUSD: { digits: 5, contract: 100000, spread: 0.0003 },
  USDJPY: { digits: 3, contract: 100000, spread: 0.03 },
  AUDUSD: { digits: 5, contract: 100000, spread: 0.0003 },
  USDCAD: { digits: 5, contract: 100000, spread: 0.0003 },
  USDCHF: { digits: 5, contract: 100000, spread: 0.0004 },
  NZDUSD: { digits: 5, contract: 100000, spread: 0.0004 },
  GBPJPY: { digits: 3, contract: 100000, spread: 0.05 },
  EURJPY: { digits: 3, contract: 100000, spread: 0.04 },
  EURGBP: { digits: 5, contract: 100000, spread: 0.0003 },
  EURCAD: { digits: 5, contract: 100000, spread: 0.0005 },
  AUDCAD: { digits: 5, contract: 100000, spread: 0.0006 },
  XAUUSD: { digits: 2, contract: 100, spread: 0.30 },
  XAGUSD: { digits: 3, contract: 5000, spread: 0.05 },
  XPTUSD: { digits: 2, contract: 100, spread: 0.80 },
  XPDUSD: { digits: 2, contract: 100, spread: 1.20 },
  SPXUSD: { digits: 1, contract: 10, spread: 0.5 },
  NSXUSD: { digits: 1, contract: 10, spread: 1.5 },
  DJI: { digits: 0, contract: 10, spread: 2.0 },
  UK100: { digits: 1, contract: 10, spread: 1.0 },
  GER40: { digits: 1, contract: 10, spread: 1.5 },
  FRA40: { digits: 1, contract: 10, spread: 1.5 },
  JPN225: { digits: 0, contract: 10, spread: 8.0 },
  US2000: { digits: 1, contract: 10, spread: 0.8 },
};

const STALE_MS = 5 * 60_000; // events older than this by processing time are rejected, not acted on

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface OrderAuditEvent {
  id: number | string;
  trade_id: string | null;
  user_id: string;
  account_id: string;
  event: string;
  symbol: string;
  side: string | null;
  requested_volume: number | null;
  requested_price: number | null;
  fill_price: number | null;
  server_ts: string;
}

interface Trade {
  id: string; account_id: string; symbol: string; side: string; volume: number;
  open_price: number; close_price: number | null; sl: number | null; tp: number | null;
  pnl: number | null; opened_at: string; closed_at: string | null; status: string;
}

// report §12.7 risk-normalized sizing. If a real stop exists, size scales
// with actual planned risk. If not, a documented proxy stands in for a
// real ATR-based stop distance (no price-history service exists yet in
// this codebase to compute a genuine ATR) — flagged stop_proxy:true
// rather than silently treated as a real stop, matching this project's
// "never fabricate precision you don't have" rule used throughout.
function computeShadowSize(trade: Trade, inst: { contract: number; spread: number }, destEquity: number, sourceRiskFraction: number) {
  const destRiskUnits = sourceRiskFraction * destEquity;
  let stopDistance: number;
  let stopProxy = false;
  if (trade.sl !== null) {
    stopDistance = Math.abs(trade.open_price - trade.sl);
  } else {
    // Placeholder proxy: 20x the instrument's configured spread. This is
    // a crude, documented stand-in — NOT a real ATR calculation — used
    // only so an unstopped trade still gets a conservative (larger)
    // shadow size estimate instead of being silently skipped.
    stopDistance = inst.spread * 20;
    stopProxy = true;
  }
  if (stopDistance <= 0) return null;
  const size = destRiskUnits / (stopDistance * inst.contract);
  return { size: Math.max(0, Math.round(size * 100) / 100), stopDistance, stopProxy, destRiskUnits };
}

function err(msg: string, code = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), { status: code, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const db: Db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Shared secret check — this endpoint is meant to be called only by
  // the order_audit_events trigger (or, for testing, by someone who
  // already has database/dashboard access to read the same secret).
  const expectedSecret = Deno.env.get("SYNCER_SHARED_SECRET");
  const gotSecret = req.headers.get("X-Syncer-Secret");
  if (expectedSecret && gotSecret !== expectedSecret) {
    return err("Invalid syncer secret", 401);
  }

  let body: { order_audit_event_id?: string | number };
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }
  const eventId = body.order_audit_event_id;
  if (!eventId) return err("order_audit_event_id required");

  const receivedAt = Date.now();

  const { data: oae, error: oaeErr } = await db.from("order_audit_events")
    .select("id, trade_id, user_id, account_id, event, symbol, side, requested_volume, requested_price, fill_price, server_ts")
    .eq("id", eventId).maybeSingle();
  if (oaeErr || !oae) return err("order_audit_event not found", 404);
  const auditEvent = oae as unknown as OrderAuditEvent;

  if (!["open", "close"].includes(auditEvent.event)) {
    return new Response(JSON.stringify({ ok: true, skipped: "event_type_not_shadowed" }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }
  if (!auditEvent.trade_id) {
    return new Response(JSON.stringify({ ok: true, skipped: "no_trade_id" }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Staleness (report §12.9): an event processed long after it happened
  // (e.g. this function was down) is rejected rather than acted on late.
  const eventAtMs = new Date(auditEvent.server_ts).getTime();
  if (receivedAt - eventAtMs > STALE_MS) {
    await db.from("replication_event").insert({
      source_event_id: String(auditEvent.id), source_account_id: null,
      source_sequence: Number(auditEvent.id), source_event_type: auditEvent.event,
      payload_jsonb: { reason: "stale", age_ms: receivedAt - eventAtMs }, status: "rejected",
      idempotency_key_hash: await sha256Hex(`${auditEvent.id}:${auditEvent.account_id}:${auditEvent.event}:stale`),
    }).select("id").maybeSingle();
    return new Response(JSON.stringify({ ok: true, rejected: "stale_event", age_ms: receivedAt - eventAtMs }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const { data: trade } = await db.from("trades").select("*").eq("id", auditEvent.trade_id).maybeSingle();
  if (!trade) return err("trade not found for audit event", 404);

  const inst = INSTRUMENTS[trade.symbol];
  if (!inst) {
    return new Response(JSON.stringify({ ok: true, rejected: "unmapped_symbol", symbol: trade.symbol }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Eligibility: resolve (or self-heal) the governance trading_account
  // row this replication_event's FK requires. New signups after tonight
  // won't have one until they're backfilled otherwise, so this creates
  // it on first trade instead of silently dropping their shadow events.
  const { data: person } = await db.from("person").select("id").eq("auth_user_id", auditEvent.user_id).maybeSingle();
  let personId = person?.id as string | undefined;
  if (!personId) {
    const { data: newPerson } = await db.from("person").insert({ auth_user_id: auditEvent.user_id }).select("id").single();
    personId = newPerson?.id;
  }
  if (!personId) return err("could not resolve or create person", 500);

  const { data: gov } = await db.from("trading_account").select("id")
    .eq("person_id", personId).eq("live_trading_account_id", auditEvent.account_id).maybeSingle();
  let govAccountId = gov?.id as string | undefined;
  if (!govAccountId) {
    const { data: newGov } = await db.from("trading_account")
      .insert({ person_id: personId, live_trading_account_id: auditEvent.account_id, account_kind: "simulated" })
      .select("id").single();
    govAccountId = newGov?.id;
  }
  if (!govAccountId) return err("could not resolve or create governance trading_account", 500);

  // Pre-trade risk (report §12.5) — global kill switch only in this
  // shadow scope; per-account/per-symbol/notional caps are meaningful
  // only once a real destination account with real margin exists.
  const { data: kill } = await db.from("kill_switch")
    .select("id, reason, expires_at").eq("scope_type", "global").eq("target", "trade_syncer").eq("enabled", true)
    .maybeSingle();
  if (kill && (!kill.expires_at || new Date(kill.expires_at) > new Date())) {
    await db.from("replication_event").insert({
      source_event_id: String(auditEvent.id), source_account_id: govAccountId,
      source_sequence: Number(auditEvent.id), source_event_type: auditEvent.event,
      payload_jsonb: { reason: "kill_switch", kill_switch_id: kill.id }, status: "rejected",
      idempotency_key_hash: await sha256Hex(`${auditEvent.id}:${govAccountId}:${auditEvent.event}:killswitch`),
    }).select("id").maybeSingle();
    return new Response(JSON.stringify({ ok: true, rejected: "kill_switch_active" }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const { data: brokerAccount } = await db.from("broker_account").select("*").eq("provider_id", "ipfx-internal-shadow").maybeSingle();
  if (!brokerAccount) return err("shadow broker_account not provisioned — run trade-syncer-shadow-schema.sql", 500);

  const idempotencyKey = await sha256Hex(`${auditEvent.id}:${govAccountId}:${auditEvent.event}`);

  if (auditEvent.event === "open") {
    // Report §12.7: source risk fraction = planned risk as a fraction of
    // the SOURCE account's own starting balance, then scaled onto the
    // (placeholder) destination equity — never scaled by raw notional.
    const { data: liveAcct } = await db.from("trading_accounts").select("starting_balance").eq("id", auditEvent.account_id).maybeSingle();
    const sourceStart = liveAcct ? Number(liveAcct.starting_balance) : 100000;
    const sourceRiskDollars = trade.sl !== null
      ? Math.abs(Number(trade.open_price) - Number(trade.sl)) * Number(trade.volume) * inst.contract
      : null;
    const sourceRiskFraction = sourceRiskDollars !== null && sourceStart > 0 ? sourceRiskDollars / sourceStart : 0.01; // 1% conservative default if source itself has no stop

    const sizing = computeShadowSize(trade as Trade, inst, Number(brokerAccount.shadow_equity), sourceRiskFraction);
    if (!sizing) return err("could not compute shadow size (zero stop distance)", 422);

    const payload = {
      symbol: trade.symbol, side: trade.side, source_volume: trade.volume,
      source_open_price: trade.open_price, source_sl: trade.sl, source_tp: trade.tp,
      shadow_size: sizing.size, stop_distance: sizing.stopDistance, stop_proxy: sizing.stopProxy,
      dest_risk_units: sizing.destRiskUnits, dest_equity_assumed: Number(brokerAccount.shadow_equity),
      netting_mode: brokerAccount.netting_mode, decision_latency_ms: receivedAt - eventAtMs,
    };

    const { data: repEvent, error: repErr } = await db.from("replication_event").insert({
      source_event_id: String(auditEvent.id), source_account_id: govAccountId,
      source_sequence: Number(auditEvent.id), source_event_type: "open",
      payload_jsonb: payload, status: "validated", idempotency_key_hash: idempotencyKey,
    }).select("id").single();

    if (repErr) {
      // Unique-violation on idempotency_key_hash = already processed.
      if (String(repErr.message ?? "").includes("duplicate") || (repErr as { code?: string }).code === "23505") {
        return new Response(JSON.stringify({ ok: true, idempotent: true }), { headers: { ...CORS, "Content-Type": "application/json" } });
      }
      return err("could not record replication_event: " + repErr.message, 500);
    }

    // ProviderAdapter stage: intentionally a no-op. Nothing here ever
    // calls out to a broker. dest_order.status is hardcoded 'shadow_only'
    // — the schema's own trigger would reject anything else regardless.
    await db.from("dest_order").insert({
      replication_event_id: repEvent!.id, broker_account_id: brokerAccount.id,
      status: "shadow_only", filled_qty: sizing.size, avg_fill_price: trade.open_price,
    });

    await db.rpc("fn_append_audit_event", {
      p_actor_id: null, p_action: "shadow_replicate_open", p_entity_type: "trade", p_entity_id: trade.id,
      p_before_sha256: null, p_after_sha256: await sha256Hex(JSON.stringify(payload)), p_ip_hash: null,
    }).select().maybeSingle().then(() => {}, () => {}); // best-effort, matches logAudit()'s own never-block posture

    return new Response(JSON.stringify({ ok: true, replication_event_id: repEvent!.id, shadow: payload }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // event === 'close': find the matching open replication_event/dest_order
  // for this trade. Missing => reordered event, reject rather than guess.
  const { data: openRep } = await db.from("replication_event")
    .select("id, payload_jsonb").eq("source_event_type", "open")
    .contains("payload_jsonb", { symbol: trade.symbol }).eq("source_account_id", govAccountId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();

  const { data: openDest } = openRep ? await db.from("dest_order").select("*").eq("replication_event_id", openRep.id).maybeSingle() : { data: null };

  if (!openRep || !openDest) {
    await db.from("replication_event").insert({
      source_event_id: String(auditEvent.id), source_account_id: govAccountId,
      source_sequence: Number(auditEvent.id), source_event_type: "close",
      payload_jsonb: { reason: "reordered_missing_open", symbol: trade.symbol }, status: "rejected",
      idempotency_key_hash: idempotencyKey,
    }).select("id").maybeSingle();
    return new Response(JSON.stringify({ ok: true, rejected: "reordered_missing_open" }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Shadow P&L: same direction/size as the shadow-computed open, applied
  // to the REAL realized price move — this is exactly the report's
  // "compare shadow P&L to source" comparison, computed honestly from
  // real market movement rather than assumed identical to source P&L.
  const shadowSize = Number(openDest.filled_qty);
  const openPrice = Number(openDest.avg_fill_price);
  const closePrice = Number(trade.close_price);
  const direction = trade.side === "buy" ? 1 : -1;
  const shadowPnl = direction * (closePrice - openPrice) * shadowSize * inst.contract;
  const sourcePnl = Number(trade.pnl) || 0;
  const copyRatio = sourcePnl !== 0 ? shadowPnl / sourcePnl : null;

  const closePayload = {
    symbol: trade.symbol, shadow_pnl: Math.round(shadowPnl * 100) / 100, source_pnl: sourcePnl,
    copy_ratio: copyRatio, decision_latency_ms: receivedAt - eventAtMs,
  };

  const { data: closeRep, error: closeRepErr } = await db.from("replication_event").insert({
    source_event_id: String(auditEvent.id), source_account_id: govAccountId,
    source_sequence: Number(auditEvent.id), source_event_type: "close",
    payload_jsonb: closePayload, status: "reconciled", idempotency_key_hash: idempotencyKey,
  }).select("id").single();

  if (closeRepErr) {
    if (String(closeRepErr.message ?? "").includes("duplicate") || (closeRepErr as { code?: string }).code === "23505") {
      return new Response(JSON.stringify({ ok: true, idempotent: true }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    return err("could not record close replication_event: " + closeRepErr.message, 500);
  }

  await db.from("dest_order").update({ status: "shadow_only", avg_fill_price: closePrice }).eq("replication_event_id", openRep.id);
  await db.from("reconciliation_run").insert({
    broker_account_id: brokerAccount.id, source_account_id: govAccountId,
    window_start: trade.opened_at, window_end: trade.closed_at,
    match_status: "matched", mismatch_jsonb: closePayload,
  });

  return new Response(JSON.stringify({ ok: true, replication_event_id: closeRep!.id, shadow: closePayload }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
