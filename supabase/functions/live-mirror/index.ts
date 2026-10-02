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
//         symbol, side, volume, sl, tp, source_risk_usd, broker_position_id? }
//
// MetaApi REST: POST /users/current/accounts/{id}/trade
//   open  -> { actionType:"ORDER_TYPE_BUY"|"ORDER_TYPE_SELL", symbol, volume }
//   close -> { actionType:"POSITION_CLOSE_ID", positionId }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decideMirrorRisk, matchingMacroEvent } from "../_shared/trader-risk.ts";
import { brokerCopyEvidenceReady } from "../_shared/broker-copy-evidence.ts";
import { decryptSecret, encryptSecret, jwtExpiresAt } from "../_shared/tradelocker-crypto.ts";
import { closePosition, marketOrder, placeMarketOrder, orderHistoryRows, positionAndOrderRows, refresh, responseIds, strategyId } from "../_shared/tradelocker.ts";

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;
// Map our internal symbols to typical MT5 broker symbols. Brokers differ
// (suffixes like .r, .m, m), so this is the adjustable seam.
function brokerSymbol(sym: string): string {
  // default: pass through (EURUSD, XAUUSD, US500, ...). Override per broker here.
  const OVERRIDES: Record<string, string> = {
    // SPXUSD: "US500", NSXUSD: "USTEC", DJI: "US30",  // e.g. if broker uses these
  };
  return OVERRIDES[sym] ?? sym;
}

// deno-lint-ignore no-explicit-any
type Db = any;

function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// Kill switches for NEW mirrored risk. Closes are never blocked so exposure can always be flattened.
//  - IPFX_MIRROR_HALT=true            -> no new mirror opens anywhere.
//  - platform_config.trading_halted   -> the platform-wide halt also stops mirror opens.
//  - IPFX_LIVE_CAPITAL_MIRROR!=true   -> only demo destinations may receive opens (real capital is off by default).
async function mirrorOpenBlocked(db: Db, target: Record<string, unknown>): Promise<string | null> {
  if (String(Deno.env.get("IPFX_MIRROR_HALT") ?? "").toLowerCase() === "true") return "mirror halted (IPFX_MIRROR_HALT)";
  const { data: cfg, error } = await db.from("platform_config").select("trading_halted").limit(1).maybeSingle();
  if (error) return "platform halt state unavailable; fail closed";
  if (cfg?.trading_halted) return "platform trading halted";
  const isDemo = String(target.environment ?? "") === "demo";
  if (!isDemo && String(Deno.env.get("IPFX_LIVE_CAPITAL_MIRROR") ?? "").toLowerCase() !== "true") return "live-capital mirroring disabled (IPFX_LIVE_CAPITAL_MIRROR)";
  return null;
}

async function log(db: Db, row: Record<string, unknown>) {
  try { await db.from("mirror_orders").insert(row); } catch (_) { /* best effort */ }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supplied = req.headers.get("authorization");
  if (!serviceKey || !constantTimeEqual(supplied ?? "", `Bearer ${serviceKey}`)) return new Response("unauthorised", { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return new Response("bad json", { status: 400 }); }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  const user_id = String(body.user_id ?? "");
  const source_trade_id = String(body.source_trade_id ?? "");
  if (body.event === "verify") {
    const { data: trade } = await db.from("trades").select("id,user_id,account_id").eq("id", source_trade_id).eq("user_id", user_id).maybeSingle();
    if (!trade) return new Response(JSON.stringify({ ok: false, error: "source trade not found" }), { status: 404 });
    const { data: target } = await db.from("mirror_targets").select("id,tradelocker_connection_id,provider,environment").eq("user_id", user_id).eq("source_account_id", trade.account_id).eq("provider", "tradelocker").eq("environment", "demo").maybeSingle();
    if (!target?.tradelocker_connection_id) return new Response(JSON.stringify({ ok: false, error: "demo target not found" }), { status: 404 });
    const { data: connection } = await db.from("tradelocker_demo_connections").select("access_token_ciphertext,tradelocker_account_id,acc_num,status,environment").eq("id", target.tradelocker_connection_id).eq("environment", "demo").maybeSingle();
    if (!connection || connection.status !== "connected") return new Response(JSON.stringify({ ok: false, error: "demo connection unavailable" }), { status: 409 });
    const { data: openRow } = await db.from("mirror_orders").select("broker_order_id,broker_position_id").eq("source_trade_id", source_trade_id).eq("target_id", target.id).eq("event", "open").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!openRow?.broker_order_id) return new Response(JSON.stringify({ ok: false, error: "broker open order missing" }), { status: 409 });
    const encryptionKey = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
    if (!encryptionKey) return new Response(JSON.stringify({ ok: false, error: "connector encryption unavailable" }), { status: 503 });
    const accessToken = await decryptSecret(connection.access_token_ciphertext, encryptionKey);
    const snapshot = await positionAndOrderRows(accessToken, String(connection.tradelocker_account_id), String(connection.acc_num));
    const order = snapshot.ordersHistory.find((row) => String(row.orderId ?? row.id ?? "") === String(openRow.broker_order_id));
    const positionId = order?.positionId == null ? String(openRow.broker_position_id ?? "") : String(order.positionId);
    const openPosition = positionId ? snapshot.positions.find((row) => String(row.id ?? row.positionId ?? "") === positionId) : null;
    return new Response(JSON.stringify({ ok: true, order_found: Boolean(order), position_id: positionId || null, broker_position_open: Boolean(openPosition) }), { status: 200 });
  }  if (body.event !== "open" && body.event !== "close") return new Response("invalid event", { status: 400 });
  const event: "open" | "close" = body.event;
  const symbol = String(body.symbol ?? "");
  const side = body.side === "sell" ? "sell" : body.side === "buy" ? "buy" : null;
  const volumeIn = Number(body.volume);
  const stopLoss = body.sl == null ? null : Number(body.sl);
  const takeProfit = body.tp == null ? null : Number(body.tp);
  const sourceRiskUsd = Number(body.source_risk_usd);

  const base = { source_trade_id, user_id, event, symbol, side, volume: isFinite(volumeIn) ? volumeIn : null };

  // 1. Opens require an enabled target. Closes must still reach an existing
  // target after a halt/revocation so disabling new risk cannot trap exposure.
  const { data: sourceTrade, error: tradeError } = await db.from("trades")
    .select("id,account_id,user_id,symbol,side,volume,open_price,sl,tp,opened_at,closed_at,pnl,status")
    .eq("id", source_trade_id).eq("user_id", user_id).maybeSingle();
  if (tradeError || !sourceTrade) return new Response(JSON.stringify({ ok: false, error: "source trade not found" }), { status: 404 });
  if (event === "open") {
    const { data: sourceAccount } = await db.from("trading_accounts")
      .select("status,access_revoked_at").eq("id", sourceTrade.account_id).maybeSingle();
    if (!sourceAccount || sourceAccount.access_revoked_at || !["active", "passed", "demo"].includes(sourceAccount.status)) {
      await log(db, { ...base, status: "skipped", error: "source challenge inactive or archived" });
      return new Response(JSON.stringify({ ok: true, skipped: "source challenge inactive or archived" }), { status: 200 });
    }
  }
  let targetQuery = db.from("mirror_targets").select("*").eq("user_id", user_id).eq("source_account_id", sourceTrade.account_id);
  if (event === "open") targetQuery = targetQuery.eq("enabled", true);
  const { data: target } = await targetQuery.maybeSingle();
  if (!target) {
    await log(db, { ...base, status: "skipped", error: event === "open" ? "no enabled mirror target" : "no mirror target for close" });
    return new Response(JSON.stringify({ ok: true, skipped: "no target" }), { status: 200 });
  }
  if (event === "open") {
    const blocked = await mirrorOpenBlocked(db, target);
    if (blocked) {
      await log(db, { ...base, target_id: target.id, status: "skipped", error: blocked });
      return new Response(JSON.stringify({ ok: true, skipped: "kill_switch", reason: blocked }), { status: 200 });
    }
  }

  // A partially deployed policy, stale snapshot, or accidental target toggle
  // must never activate capital copying. This is independent of the evidence
  // gates below; closes continue to reach their exact mapped position.
  if (event === "open" && target.environment !== "demo" &&
      Deno.env.get("IPFX_REAL_COPY_ENABLED") !== "true") {
    await log(db, { ...base, target_id: target.id, status: "skipped", error: "real-capital copy switch disabled" });
    return new Response(JSON.stringify({ ok: true, skipped: "real-capital copy disabled" }), { status: 200 });
  }

  // Copy control: decide how much of an OPEN IPFX should copy to its own account. This
  // never changes the trader's challenge trade. CLOSE events bypass every
  // exposure filter so live risk cannot be trapped.
  const isDemoOpen = target.provider === "tradelocker" && target.environment === "demo" && event === "open";
  let riskDecision = { action: "skip" as "allow" | "reduce" | "skip", multiplier: 0, reasons: ["risk-control evidence unavailable; fail closed"], unusual_size_multiple: null as number | null };
  let tierVolumeMultiplier = 0;
  let sourceAccountId: string | null = null;
  let category = "unclassified";
  let policyMode: "observe" | "adaptive" | "blocked" = "observe";
  try {

    if (event === "open") {
      const sameVolume = Number.isFinite(volumeIn) && Math.abs(Number(sourceTrade.volume) - volumeIn) <= 1e-9;
      const sameStop = (sourceTrade.sl == null && stopLoss == null) || (sourceTrade.sl != null && stopLoss != null && Math.abs(Number(sourceTrade.sl) - stopLoss) <= 1e-9);
      const sameTakeProfit = (sourceTrade.tp == null && takeProfit == null) || (sourceTrade.tp != null && takeProfit != null && Math.abs(Number(sourceTrade.tp) - takeProfit) <= 1e-9);
      if (String(sourceTrade.symbol) !== symbol || sourceTrade.side !== side || !sameVolume || !sameStop || !sameTakeProfit || sourceTrade.status !== "open") {
        throw new Error("SOURCE_TRADE_PAYLOAD_MISMATCH");
      }
    }
    sourceAccountId = sourceTrade.account_id;
    if (isDemoOpen) {
      riskDecision = { action: "allow", multiplier: 1, reasons: ["verified one-for-one demo mirror"], unusual_size_multiple: null };
      tierVolumeMultiplier = 1;
    } else {
    const openedAt = sourceTrade.opened_at || new Date().toISOString();
    const from = new Date(new Date(openedAt).getTime() - 31 * 60_000).toISOString();
    const to = new Date(new Date(openedAt).getTime() + 31 * 60_000).toISOString();
    const [{ data: policy }, { data: profile }, { data: recent }, { data: flags }, { data: macroEvents }] = await Promise.all([
      db.from("mirror_risk_policies").select("*").eq("user_id", user_id).maybeSingle(),
      sourceAccountId ? db.from("trader_style_profiles").select("category").eq("account_id", sourceAccountId).maybeSingle() : Promise.resolve({ data: null }),
      sourceAccountId ? db.from("trades").select("id,symbol,volume,opened_at,closed_at,pnl,status").eq("account_id", sourceAccountId).neq("id", source_trade_id).order("opened_at", { ascending: false }).limit(50) : Promise.resolve({ data: [] }),
      db.from("trade_safety_flags").select("reason").eq("trade_id", source_trade_id).eq("status", "open"),
      db.from("macro_calendar_events").select("provider_event_id,event_at,country,currency,importance,event_name").gte("event_at", from).lte("event_at", to),
    ]);
    policyMode = ["observe", "adaptive", "blocked"].includes(policy?.mode) ? policy.mode : "observe";
    category = profile?.category || "unclassified";
    const currentTrade = sourceTrade || { id: source_trade_id, symbol, volume: volumeIn, opened_at: openedAt };
    const nearHighImpactNews = !!matchingMacroEvent(currentTrade, (macroEvents ?? []).filter((e: Record<string, unknown>) => Number(e.importance) >= 3), 30);
    riskDecision = decideMirrorRisk({
      event, mode: policyMode, trade: currentTrade, recentTrades: recent ?? [],
      openFlagReasons: (flags ?? []).map((f: Record<string, unknown>) => String(f.reason)),
      category, nearHighImpactNews,
      minMultiplier: Number(policy?.min_multiplier ?? 0.1),
      unusualSizeMultiple: Number(policy?.unusual_size_multiple ?? 3),
      newsMultiplier: Number(policy?.news_multiplier ?? 0.25),
    });
    if (event === "open") {
      const [{ data: copyState }, { data: riskSnapshot }, { data: consent }, { data: copyEvidence }, { data: reserve }, { data: sourceAccount }, { data: detectorAssessment }, { data: validatedPolicy }] = await Promise.all([
        db.from("infinity_copy_states").select("decision_id,effective_tier,status,risk_per_idea_gbp,max_concurrent_ideas,max_open_risk_gbp,last_evidence_at").eq("trading_account_id", sourceAccountId).maybeSingle(),
        db.from("mirror_account_risk_snapshots").select("account_currency,usd_per_account_currency,daily_pnl,drawdown_from_copy_start,gross_open_risk,open_ideas,api_healthy,provider_daily_loss_remaining_gbp,provider_total_drawdown_remaining_gbp,observed_at").eq("target_id", target.id).order("observed_at", { ascending: false }).limit(1).maybeSingle(),
        db.from("trader_copy_consents").select("consented_at,revoked_at").eq("trading_account_id", sourceAccountId).eq("user_id", user_id).is("revoked_at", null).maybeSingle(),
        db.from("trader_detector_copyability_snapshots").select("id,provider_authorised,copyability_lower80,downside_capture,matched_ideas,provenance,as_of_at").eq("trading_account_id", sourceAccountId).order("as_of_at", { ascending: false }).limit(1).maybeSingle(),
        db.from("infinity_payout_reserve_status").select("coverage,fx_observed_at").maybeSingle(),
        db.from("trading_accounts").select("status,access_revoked_at,investigation_hold").eq("id", sourceAccountId).maybeSingle(),
        db.from("trader_detector_assessments").select("id,copy_review_id,as_of_at,state,probability_status").eq("trading_account_id", sourceAccountId).order("as_of_at", { ascending: false }).limit(1).maybeSingle(),
        db.from("infinity_copy_policy_versions").select("id").eq("status", "VALIDATED").order("version", { ascending: false }).limit(1).maybeSingle(),
      ]);
      const { data: tierDecision } = copyState?.decision_id
        ? await db.from("infinity_copy_tier_decisions").select("policy_id,assessment_id").eq("id", copyState.decision_id).maybeSingle()
        : { data: null };
      const freshEvidence = copyState?.last_evidence_at && Date.now() - new Date(copyState.last_evidence_at).getTime() <= 15 * 60_000;
      const freshRisk = riskSnapshot?.observed_at && Date.now() - new Date(riskSnapshot.observed_at).getTime() <= 90_000;
      const brokerCopyEvidence = brokerCopyEvidenceReady(copyEvidence, detectorAssessment, String(copyState?.effective_tier ?? ""), target.id, Date.now());
      const freshReserve = reserve?.fx_observed_at && Date.now() - new Date(reserve.fx_observed_at).getTime() <= 24 * 60 * 60_000;
      const tierActive = copyState?.status === "ACTIVE" && ["MICRO", "PARTIAL", "FULL"].includes(copyState?.effective_tier);
      const budgetGbp = Number(copyState?.risk_per_idea_gbp || 0);
      const plannedOpenRisk = Number(riskSnapshot?.gross_open_risk || 0) + budgetGbp;
      const riskRoom = plannedOpenRisk <= Number(copyState?.max_open_risk_gbp || 0);
      const countRoom = Number(riskSnapshot?.open_ideas || 0) < Number(copyState?.max_concurrent_ideas || 0);
      const brokerHealthy = riskSnapshot?.api_healthy === true && riskSnapshot?.account_currency === "GBP";
      const lossRoom = Number(riskSnapshot?.daily_pnl || 0) > -600 && Number(riskSnapshot?.drawdown_from_copy_start || 0) > -1000;
      const providerRoom = Number(riskSnapshot?.provider_daily_loss_remaining_gbp) > 0 && Number(riskSnapshot?.provider_total_drawdown_remaining_gbp) > 0 &&
        2.75 * plannedOpenRisk <= 0.80 * Number(riskSnapshot.provider_daily_loss_remaining_gbp) &&
        2.75 * plannedOpenRisk <= 0.50 * Number(riskSnapshot.provider_total_drawdown_remaining_gbp);
      const currentAuthority = Boolean(consent) && tierDecision?.policy_id === validatedPolicy?.id &&
        tierDecision?.assessment_id === detectorAssessment?.id && brokerCopyEvidence && Number(reserve?.coverage || 0) >= 1.25 &&
        sourceAccount && ["active", "passed"].includes(sourceAccount.status) && !sourceAccount.access_revoked_at && sourceAccount.investigation_hold !== true;
      if (!tierActive || !freshEvidence || !freshRisk || !freshReserve || !currentAuthority ||
          !brokerHealthy || !riskRoom || !countRoom || !lossRoom || !providerRoom || !Number.isFinite(sourceRiskUsd) || sourceRiskUsd <= 0) {
        riskDecision = { ...riskDecision, action: "skip", multiplier: 0, reasons: [...riskDecision.reasons, "fresh tier, consent, provider, reserve, destination-risk or source-risk gate failed"] };
      } else if (riskDecision.action !== "skip") {
        tierVolumeMultiplier = (budgetGbp * Number(riskSnapshot.usd_per_account_currency)) / sourceRiskUsd;
      }
    }
    }
    const requested = event === "open" ? volumeIn * tierVolumeMultiplier : volumeIn;
    const approved = event === "open" ? requested * riskDecision.multiplier : requested;
    const decisionWrite = db.from("mirror_risk_decisions").insert({
      source_trade_id, user_id, account_id: sourceAccountId, target_id: target.id, event,
      policy_mode: policyMode, category, action: riskDecision.action,
      requested_volume: Number.isFinite(requested) ? requested : null,
      approved_volume: Number.isFinite(approved) ? Math.round(approved * 100) / 100 : null,
      risk_multiplier: riskDecision.multiplier, reasons: riskDecision.reasons,
      evidence: { unusual_size_multiple: riskDecision.unusual_size_multiple, classifier_version: "simple-v1" },
    });
    // Demo audit still runs, but its database round trip does not precede the
    // broker order. Live-capital risk decisions retain their awaited path.
    if (isDemoOpen) {
      const audit = Promise.resolve(decisionWrite).then(({ error }) => {
        if (error) console.error(JSON.stringify({ event: "mirror_demo_decision_audit_failed", source_trade_id, error: error.message }));
      });
      try { EdgeRuntime.waitUntil(audit); } catch (_) { await audit; }
    } else {
      const { error: decisionError } = await decisionWrite;
      if (decisionError) throw new Error(`MIRROR_RISK_AUDIT_FAILED: ${decisionError.message}`);
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "mirror_risk_fallback", source_trade_id, error: String(error).slice(0, 160) }));
    // A partial allow/reduce decision must never survive a failed risk check.
    // Closes deliberately bypass open-risk filters so they can reduce exposure.
    if (event === "open") {
      riskDecision = { action: "skip", multiplier: 0, reasons: ["risk control unavailable; fail closed"], unusual_size_multiple: null };
      tierVolumeMultiplier = 0;
    }
  }

  if (event === "open" && riskDecision.action === "skip") {
    await log(db, { ...base, target_id: target.id, status: "skipped", error: `risk control: ${riskDecision.reasons.join("; ")}`.slice(0, 300) });
    return new Response(JSON.stringify({ ok: true, skipped: "risk control", decision: riskDecision }), { status: 200 });
  }

  // TradeLocker uses a separately authenticated demo-only adapter. Passwords are
  // never retained; only encrypted short-lived tokens are stored.
  if (target.provider === "tradelocker") {
    if (target.environment !== "demo" || !target.tradelocker_connection_id) {
      await log(db, { ...base, target_id: target.id, provider: "tradelocker", status: "error", error: "TradeLocker destination is not a bound demo connection" });
      return new Response(JSON.stringify({ ok: false, error: "demo connection required" }), { status: 409 });
    }
    const encryptionKey = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
    if (!encryptionKey) return new Response(JSON.stringify({ ok: false, error: "connector encryption unavailable" }), { status: 503 });
    const { data: connection } = await db.from("tradelocker_demo_connections").select("*").eq("id", target.tradelocker_connection_id).eq("environment", "demo").eq("status", "connected").maybeSingle();
    if (!connection) return new Response(JSON.stringify({ ok: false, error: "TradeLocker demo connection unavailable" }), { status: 409 });
    let accessToken = await decryptSecret(connection.access_token_ciphertext, encryptionKey);
    const refreshToken = await decryptSecret(connection.refresh_token_ciphertext, encryptionKey);
    if (!connection.access_expires_at || new Date(connection.access_expires_at).getTime() - Date.now() < 30 * 60_000) {
      const next = await refresh(refreshToken);
      accessToken = next.accessToken;
      await db.from("tradelocker_demo_connections").update({
        access_token_ciphertext: await encryptSecret(next.accessToken, encryptionKey),
        refresh_token_ciphertext: await encryptSecret(next.refreshToken, encryptionKey),
        access_expires_at: jwtExpiresAt(next.accessToken), last_health_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", connection.id);
    }
    const idempotencyKey = `${source_trade_id}:${target.id}:${event}`;
    const dispatchStarted = Date.now();
    let brokerPayload: Record<string, unknown> | null = null;
    let mappedPositionId: string | null = null;
    if (event === "open") {
      if (!side) return new Response("bad side", { status: 400 });
      const { data: map } = await db.from("tradelocker_instrument_map").select("*").eq("connection_id", connection.id).eq("source_symbol", symbol.toUpperCase()).eq("enabled", true).maybeSingle();
      if (!map) {
        await log(db, { ...base, target_id: target.id, provider: "tradelocker", status: "skipped", error: "instrument mapping missing" });
        return new Response(JSON.stringify({ ok: true, skipped: "instrument mapping missing" }), { status: 200 });
      }
      const raw = volumeIn * tierVolumeMultiplier * riskDecision.multiplier;
      const step = Number(map.lot_step || 0.01), minQty = Number(map.min_qty || step);
      const qty = Math.floor((raw + 1e-12) / step) * step;
      if (!Number.isFinite(qty) || qty < minQty) return new Response(JSON.stringify({ ok: true, skipped: "below minimum" }), { status: 200 });
      brokerPayload = marketOrder({ qty, routeId: Number(map.trade_route_id), side, tradableInstrumentId: Number(map.tradable_instrument_id), sl: stopLoss, tp: takeProfit, sourceTradeId: source_trade_id });
    } else {
      const { data: openRow } = await db.from("mirror_orders").select("id,broker_order_id,broker_position_id,status").eq("source_trade_id", source_trade_id).eq("target_id", target.id).eq("event", "open").in("status", ["filled", "accepted_pending_position"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!openRow?.broker_order_id && !openRow?.broker_position_id) {
        await log(db, { ...base, target_id: target.id, provider: "tradelocker", status: "error", error: "source open has no broker order or position ID" });
        return new Response(JSON.stringify({ ok: false, error: "position mapping missing" }), { status: 409 });
      }
      mappedPositionId = openRow.broker_position_id ? String(openRow.broker_position_id) : null;
      if (!mappedPositionId) {
        const history = await orderHistoryRows(accessToken, String(connection.tradelocker_account_id), String(connection.acc_num));
        const matched = history.filter((order) => String(order.orderId ?? order.id ?? "") === String(openRow.broker_order_id));
        if (matched.length !== 1) return new Response(JSON.stringify({ ok: false, error: "exact broker order history unavailable" }), { status: 409 });
        const brokerStrategy = String(matched[0].strategyId ?? "");
        if (brokerStrategy && brokerStrategy !== strategyId(source_trade_id)) return new Response(JSON.stringify({ ok: false, error: "broker strategy ID conflict" }), { status: 409 });
        mappedPositionId = matched[0].positionId == null ? null : String(matched[0].positionId);
      }
      if (!mappedPositionId) {
        await log(db, { ...base, target_id: target.id, provider: "tradelocker", status: "error", error: "exact TradeLocker order-to-position mapping missing; close-by-symbol prohibited" });
        return new Response(JSON.stringify({ ok: false, error: "position mapping missing" }), { status: 409 });
      }
    }
    const { data: claim, error: claimError } = await db.from("mirror_orders").insert({ ...base, target_id: target.id, provider: "tradelocker", volume: Number(brokerPayload?.qty ?? volumeIn), status: "sent", idempotency_key: idempotencyKey, dispatch_latency_ms: Date.now() - dispatchStarted }).select("id").single();
    if (claimError?.code === "23505") return new Response(JSON.stringify({ ok: true, skipped: "duplicate event" }), { status: 200 });
    if (claimError || !claim) return new Response(JSON.stringify({ ok: false, error: "idempotency claim failed" }), { status: 503 });
    const apiStarted = Date.now();
    try {
      const result = event === "open"
        ? await placeMarketOrder(accessToken, String(connection.tradelocker_account_id), String(connection.acc_num), brokerPayload!)
        : await closePosition(accessToken, String(connection.acc_num), mappedPositionId!);
      const brokerLatencyMs = Date.now() - apiStarted;
      const ids = responseIds(result);
      const positionId = event === "close" ? mappedPositionId : ids.positionId;
      await db.from("mirror_orders").update({
        status: event === "open" ? (positionId ? "filled" : "accepted_pending_position") : "reconciliation_required",
        latency_ms: brokerLatencyMs, broker_order_id: ids.orderId,
        broker_position_id: positionId, provider_status: "accepted",
      }).eq("id", claim.id);
      if (event === "open" && !positionId && ids.orderId) {
        try {
          EdgeRuntime.waitUntil((async () => {
            await new Promise((resolve) => setTimeout(resolve, 350));
            const history = await orderHistoryRows(accessToken, String(connection.tradelocker_account_id), String(connection.acc_num));
            const exact = history.filter((order) => String(order.orderId ?? order.id ?? "") === ids.orderId);
            const brokerStrategy = exact.length === 1 ? String(exact[0].strategyId ?? "") : "";
            const resolvedId = exact.length === 1 && (!brokerStrategy || brokerStrategy === strategyId(source_trade_id)) ? String(exact[0].positionId ?? "") : "";
            if (resolvedId) await db.from("mirror_orders").update({ broker_position_id: resolvedId, status: "filled" }).eq("id", claim.id).eq("status", "accepted_pending_position");
          })().catch((error) => console.error(JSON.stringify({ event: "mirror_open_reconcile_failed", source_trade_id, error: String(error).slice(0, 160) }))));
        } catch (_) { /* close falls back to exact order history */ }
      }
      if (event === "close" && mappedPositionId) {
        try {
          EdgeRuntime.waitUntil((async () => {
            for (const delay of [350, 1000, 2000]) {
              await new Promise((resolve) => setTimeout(resolve, delay));
              const snapshot = await positionAndOrderRows(accessToken, String(connection.tradelocker_account_id), String(connection.acc_num));
              if (!snapshot.positions.some((pos) => String(pos.id ?? pos.positionId ?? "") === mappedPositionId)) {
                await db.from("mirror_orders").update({ status: "filled", provider_status: "closed" }).eq("id", claim.id).eq("status", "reconciliation_required");
                return;
              }
            }
          })().catch((error) => console.error(JSON.stringify({ event: "mirror_close_verify_failed", source_trade_id, error: String(error).slice(0, 160) }))));
        } catch (_) { /* remains reconciliation_required for manual review */ }
      }
      return new Response(JSON.stringify({ ok: true, orderId: ids.orderId, positionId, api_latency_ms: brokerLatencyMs }), { status: 200 });
    } catch (error) {
      // Never resubmit after an ambiguous network result. Reconcile exactly.
      await db.from("mirror_orders").update({ status: "reconciliation_required", latency_ms: Date.now() - apiStarted, provider_status: "ambiguous", error: String(error).slice(0, 300) }).eq("id", claim.id);
      return new Response(JSON.stringify({ ok: false, error: "TradeLocker result requires reconciliation" }), { status: 200 });
    }
  }
  // Do we have MetaApi credentials?
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
    const rawVol = volumeIn * tierVolumeMultiplier * riskDecision.multiplier;
    if (!Number.isFinite(rawVol) || rawVol < 0.01) {
      await log(db, { ...base, target_id: target.id, status: "skipped", error: "risk-adjusted volume below broker minimum" });
      return new Response(JSON.stringify({ ok: true, skipped: "below minimum", decision: riskDecision }), { status: 200 });
    }
    const vol = Math.floor((rawVol + 1e-9) * 100) / 100;
    payload = { actionType: side === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL", symbol: brokerSymbol(symbol), volume: vol, ...(Number.isFinite(stopLoss) ? { stopLoss } : {}), ...(Number.isFinite(takeProfit) ? { takeProfit } : {}) };
  } else {
    // Find the broker position id from this trade's own OPEN mirror row.
    let pid: string | null = null;
    if (!pid) {
      const { data: openRow } = await db.from("mirror_orders")
        .select("broker_position_id")
        .eq("source_trade_id", source_trade_id).eq("target_id", target.id)
        .eq("event", "open").eq("status", "filled")
        .not("broker_position_id", "is", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      pid = openRow?.broker_position_id ?? null;
    }
    if (!pid) {
      await log(db, { ...base, target_id: target.id, status: "error", error: "broker position mapping missing; close-by-symbol is prohibited" });
      return new Response(JSON.stringify({ ok: false, error: "position mapping missing" }), { status: 409 });
    }
    payload = { actionType: "POSITION_CLOSE_ID", positionId: pid };
  }

  // Claim before broker submission. A retry sees the unique key and cannot
  // create a second live order. Ambiguous broker failures require reconciliation,
  // never an automatic resubmission.
  const idempotencyKey = `${source_trade_id}:${target.id}:${event}`;
  const claimedVolume = Number((payload as Record<string, unknown>).volume ?? volumeIn);
  const { data: claim, error: claimError } = await db.from("mirror_orders").insert({
    ...base, target_id: target.id, volume: Number.isFinite(claimedVolume) ? claimedVolume : null,
    status: "sent", idempotency_key: idempotencyKey,
  }).select("id").single();
  if (claimError?.code === "23505") return new Response(JSON.stringify({ ok: true, skipped: "duplicate event" }), { status: 200 });
  if (claimError || !claim) return new Response(JSON.stringify({ ok: false, error: "idempotency claim failed" }), { status: 503 });

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
      await db.from("mirror_orders").update({ status: "error", latency_ms: latency, error: `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}` }).eq("id", claim.id);
      return new Response(JSON.stringify({ ok: false, error: j }), { status: 200 });
    }
    // An order ID is not a position ID. If the position ID is absent, keep
    // the claim for exact reconciliation instead of pretending it can close.
    const brokerPosId = j.positionId ?? null;
    await db.from("mirror_orders").update({
      status: brokerPosId ? "filled" : "reconciliation_required",
      latency_ms: latency,
      broker_order_id: j.orderId == null ? null : String(j.orderId),
      broker_position_id: brokerPosId == null ? null : String(brokerPosId),
    }).eq("id", claim.id);
    return new Response(JSON.stringify({ ok: true, positionId: brokerPosId, reconciliation_required: !brokerPosId, latency_ms: latency }), { status: 200 });
  } catch (e) {
    // A network failure after submission is ambiguous. Never auto-resubmit.
    await db.from("mirror_orders").update({ status: "reconciliation_required", latency_ms: Date.now() - t0, error: String(e).slice(0, 300) }).eq("id", claim.id);
    return new Response(JSON.stringify({ ok: false, error: "broker result requires reconciliation" }), { status: 200 });
  }
});
