// A/B-book executor. Places, partially closes, closes and reconciles book orders on the A-book and B-book
// TradeLocker destinations (team_book_destinations: demo-only by database constraint).
//   A-book live: same direction as the trader; the engine waits for the fill (hedge-first) and fills the
//                trader no better than the broker.
//   B-book live: opposite direction; sent right after the trader's fill.
// Sizing: _shared/ab-allocator.ts (multiplier from evidence) then ab_reserve_risk (hard caps, atomic).
// Callers: trading-engine with the service-role key; pg_cron reconciler with x-book-secret.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptSecret, encryptSecret, jwtExpiresAt } from "../_shared/tradelocker-crypto.ts";
import { closePositionQty, marketOrder, orderFill, ordersByStrategy, placeMarketOrder, refresh, responseIds } from "../_shared/tradelocker.ts";
import { TL_SYMBOLS } from "../_shared/tradelocker-feed.ts";
import { POLICY_V1, type LedgerPoint, type Policy } from "../_shared/ab-classifier.ts";
import { emergencyStop, fundedRiskUsd, legSide, lotsFor, sizeMultiplier, type Progress } from "../_shared/ab-allocator.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
const bookStrategy = (book: string, tradeId: string) => `ipfx${book}_${tradeId.replace(/-/g, "").slice(0, 26)}`;

async function destination(db: Db, book: string) {
  const { data: d } = await db.from("team_book_destinations").select("*").eq("book", book).eq("status", "connected").eq("environment", "demo").maybeSingle();
  if (!d) return null;
  const key = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
  if (!key) return null;
  let token = await decryptSecret(d.access_token_ciphertext, key);
  if (!d.access_expires_at || Date.parse(d.access_expires_at) - Date.now() < 30 * 60_000) {
    const next = await refresh(await decryptSecret(d.refresh_token_ciphertext, key));
    token = next.accessToken;
    await db.from("team_book_destinations").update({
      access_token_ciphertext: await encryptSecret(next.accessToken, key), refresh_token_ciphertext: await encryptSecret(next.refreshToken, key),
      access_expires_at: jwtExpiresAt(next.accessToken), last_health_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("book", book);
  }
  return { token, accountId: String(d.account_id), accNum: String(d.acc_num), map: (d.instrument_map ?? []) as Array<Record<string, unknown>> };
}
function instrumentFor(map: Array<Record<string, unknown>>, symbol: string) {
  const want = (TL_SYMBOLS[symbol] ?? symbol).toUpperCase();
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return map.find((m) => norm(String(m.symbol)) === norm(want)) ??
    map.find((m) => norm(String(m.symbol)).startsWith(norm(want)));
}

async function ledgerPoints(db: Db, person: string): Promise<LedgerPoint[]> {
  const { data } = await db.from("ab_trade_ledger").select("closed_at,same_r,reverse_r,hold_seconds").eq("person_id", person)
    .eq("replay_basis", "REPLAY_QUOTES").not("same_r", "is", null).not("reverse_r", "is", null).order("closed_at", { ascending: true }).limit(5000);
  return (data ?? []).map((r: Record<string, unknown>) => ({ closedAt: Date.parse(String(r.closed_at)), sameR: Number(r.same_r), reverseR: Number(r.reverse_r), holdSeconds: Number(r.hold_seconds) }));
}

async function open(db: Db, b: Record<string, unknown>) {
  const tradeId = String(b.source_trade_id), book = String(b.book) as "a" | "b";
  const { data: t } = await db.from("trades").select("id,user_id,symbol,side,volume,open_price,sl,status").eq("id", tradeId).maybeSingle();
  if (!t || t.status !== "open") return { ok: true, skipped: "source trade not open" };
  const { data: person } = await db.rpc("ab_person_of", { p_user: t.user_id });
  const { data: route } = await db.rpc("ab_route_for_user", { p_user: t.user_id });
  if (route !== book) return { ok: true, skipped: "route changed" };
  const traderRisk = Number(b.risk_usd), scale = Number(b.price_scale_per_lot);
  if (!(traderRisk > 0) || t.sl == null) return { ok: true, skipped: "no stop loss: risk not measurable" };
  const [{ data: prof }, { data: lim }, { data: settings }, { data: pol }] = await Promise.all([
    db.from("ab_trader_profiles").select("state_since").eq("person_id", person).maybeSingle(),
    db.from("ab_risk_limits").select("*").eq("book", book).maybeSingle(),
    db.from("ab_settings").select("a_scale,b_scale").maybeSingle(),
    db.from("ab_policy_versions").select("thresholds").eq("status", "ACTIVE").maybeSingle(),
  ]);
  const policy: Policy = { ...POLICY_V1, ...(pol?.thresholds ?? {}) };
  const sizing = sizeMultiplier(book, await ledgerPoints(db, person), Date.parse(prof?.state_since ?? new Date().toISOString()), Number(lim?.max_multiplier ?? 1), policy);
  let wanted = traderRisk * sizing.multiplier;
  let sizeReason = sizing.reason, weight = sizing.multiplier;
  if (Number(lim?.account_size_usd) > 0) {
    // Funded-account sizing: a share of the destination's daily risk budget, weighted by confidence.
    const since = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const [{ count: routed }, { count: liveTraders }, { data: progress }, { data: treasury }] = await Promise.all([
      db.from("book_orders").select("id", { count: "exact", head: true }).eq("book", book).eq("event", "open").gte("created_at", since),
      db.from("ab_trader_profiles").select("person_id", { count: "exact", head: true }).eq("book_state", book === "a" ? "AB_LIVE" : "BB_LIVE"),
      db.rpc("ab_person_progress", { p_person: person }),
      db.rpc("treasury_status"),
    ]);
    // Cash for payouts short: no new B-book (reverse) risk at all until it recovers.
    if (book === "b" && treasury === "short") { return { ok: true, skipped: "treasury short: B-book paused" }; }
    const expected = Math.max(Number(routed ?? 0) / 5, Number(liveTraders ?? 0) * 2);
    const f = fundedRiskUsd(book, { accountSizeUsd: Number(lim.account_size_usd), dailyBudgetPct: Number(lim.daily_risk_budget_pct),
      perTradeMinPct: Number(lim.per_trade_min_pct), perTradeMaxPct: Number(lim.per_trade_max_pct) }, expected, (progress ?? "EARLY") as Progress, sizing,
      (treasury ?? "unknown") as "unknown" | "healthy" | "tight" | "short");
    wanted = f.riskUsd; sizeReason = f.reason; weight = f.weight;
  }
  wanted *= Number(book === "a" ? settings?.a_scale ?? 1 : settings?.b_scale ?? 1);
  const side = legSide(book, t.side);
  const signedLots = (side === "buy" ? 1 : -1) * Number(t.volume) * (wanted / traderRisk);
  const { data: res, error: resErr } = await db.rpc("ab_reserve_risk", { p_book: book, p_trade: tradeId, p_person: person, p_symbol: t.symbol, p_signed_lots: signedLots, p_risk_usd: wanted });
  if (resErr || !res?.ok) return { ok: true, skipped: "risk: " + (res?.reason ?? resErr?.message ?? "refused") };
  const dest = await destination(db, book);
  if (!dest) { await db.rpc("ab_release_risk", { p_book: book, p_trade: tradeId }); return { ok: true, skipped: "destination not connected" }; }
  const inst = instrumentFor(dest.map, t.symbol);
  if (!inst) { await db.rpc("ab_release_risk", { p_book: book, p_trade: tradeId }); return { ok: true, skipped: "instrument not available at destination" }; }
  const qty = lotsFor(Number(t.volume), traderRisk, Number(res.allowed_usd), Number(inst.lot_step ?? 0.01), Number(inst.min_qty ?? 0.01));
  if (!(qty > 0)) { await db.rpc("ab_release_risk", { p_book: book, p_trade: tradeId }); return { ok: true, skipped: "below broker minimum" }; }
  const key = `${book}:${tradeId}:open`;
  const { data: claim, error: claimErr } = await db.from("book_orders").insert({
    book, source_trade_id: tradeId, person_id: person, event: "open", idempotency_key: key, symbol: t.symbol, side, qty,
    multiplier: Number((Number(res.allowed_usd) / traderRisk).toFixed(3)), risk_usd: res.allowed_usd, status: "sent", price_scale_per_lot: scale > 0 ? scale : null,
  }).select("id").single();
  if (claimErr?.code === "23505") return { ok: true, skipped: "duplicate event" };
  if (claimErr || !claim) return { ok: false, error: "claim failed" };
  const started = Date.now();
  try {
    const stop = emergencyStop(book, t.side, Number(t.open_price), Number(t.sl));
    const payload = { ...marketOrder({ qty, routeId: Number(inst.trade_route_id), side, tradableInstrumentId: Number(inst.tradable_instrument_id), sl: stop, tp: null, sourceTradeId: tradeId }), strategyId: bookStrategy(book, tradeId) };
    const ids = responseIds(await placeMarketOrder(dest.token, dest.accountId, dest.accNum, payload));
    const fill = await orderFill(dest.token, dest.accountId, dest.accNum, { orderId: ids.orderId }).catch(() => null);
    const positionId = ids.positionId ?? fill?.positionId ?? null;
    await db.from("book_orders").update({
      status: positionId ? "filled" : "reconciliation_required", broker_order_id: ids.orderId, broker_position_id: positionId,
      fill_price: fill?.price ?? null, latency_ms: Date.now() - started, updated_at: new Date().toISOString(),
    }).eq("id", claim.id);
    return { ok: true, book, qty, multiple_of_trader: Number((Number(res.allowed_usd) / traderRisk).toFixed(2)), weight, reason: sizeReason, fill_price: fill?.price ?? null, positionId };
  } catch (e) {
    // Never resubmit an ambiguous order: the reconciler finds it by strategy id.
    await db.from("book_orders").update({ status: "reconciliation_required", error: String(e).slice(0, 300), latency_ms: Date.now() - started, updated_at: new Date().toISOString() }).eq("id", claim.id);
    return { ok: false, error: "broker result requires reconciliation" };
  }
}

async function closeLeg(db: Db, b: Record<string, unknown>) {
  const tradeId = String(b.source_trade_id), event = b.event === "partial_close" ? "partial_close" : "close";
  const { data: legs } = await db.from("book_orders").select("*").eq("source_trade_id", tradeId).eq("event", "open").in("status", ["filled"]);
  const results: unknown[] = [];
  for (const leg of legs ?? []) {
    const book = leg.book as "a" | "b";
    const { data: done } = await db.from("book_orders").select("qty").eq("source_trade_id", tradeId).eq("book", book).in("event", ["partial_close", "close"]).in("status", ["closed", "sent", "reconciliation_required"]);
    const remaining = Number(leg.qty) - (done ?? []).reduce((a: number, r: Record<string, unknown>) => a + Number(r.qty), 0);
    if (!(remaining > 1e-9)) continue;
    const fraction = event === "partial_close" ? Math.min(1, Math.max(0, Number(b.fraction))) : 1;
    let qty = event === "close" ? remaining : Math.floor((Number(leg.qty) * fraction + 1e-9) / 0.01) * 0.01;
    qty = Math.min(Number(qty.toFixed(6)), remaining);
    if (!(qty > 0)) continue;
    const slice = event === "close" ? "close" : `partial:${String(b.slice_id ?? Date.now())}`;
    const { data: claim, error: claimErr } = await db.from("book_orders").insert({
      book, source_trade_id: tradeId, person_id: leg.person_id, event, idempotency_key: `${book}:${tradeId}:${slice}`, symbol: leg.symbol,
      side: leg.side === "buy" ? "sell" : "buy", qty, status: "sent", price_scale_per_lot: leg.price_scale_per_lot,
    }).select("id").single();
    if (claimErr?.code === "23505") { results.push({ book, skipped: "duplicate event" }); continue; }
    if (claimErr || !claim) { results.push({ book, error: "claim failed" }); continue; }
    const dest = await destination(db, book);
    if (!dest) { await db.from("book_orders").update({ status: "reconciliation_required", error: "destination unavailable" }).eq("id", claim.id); results.push({ book, error: "destination unavailable" }); continue; }
    const started = Date.now();
    try {
      const ids = responseIds(await closePositionQty(dest.token, dest.accNum, String(leg.broker_position_id), qty >= remaining - 1e-9 ? 0 : qty));
      const fill = await orderFill(dest.token, dest.accountId, dest.accNum, { orderId: ids.orderId, positionId: String(leg.broker_position_id), closing: true }).catch(() => null);
      const dir = leg.side === "buy" ? 1 : -1;
      const pnl = fill && leg.fill_price != null && leg.price_scale_per_lot != null
        ? (fill.price - Number(leg.fill_price)) * dir * qty * Number(leg.price_scale_per_lot) : null;
      await db.from("book_orders").update({ status: fill ? "closed" : "reconciliation_required", broker_order_id: ids.orderId,
        broker_position_id: leg.broker_position_id, fill_price: fill?.price ?? null, pnl_usd: pnl == null ? null : Math.round(pnl * 100) / 100,
        latency_ms: Date.now() - started, updated_at: new Date().toISOString() }).eq("id", claim.id);
      await db.rpc("ab_release_risk", { p_book: book, p_trade: tradeId, p_fraction: qty >= remaining - 1e-9 ? 1 : qty / remaining });
      results.push({ book, qty, fill_price: fill?.price ?? null, pnl_usd: pnl });
    } catch (e) {
      await db.from("book_orders").update({ status: "reconciliation_required", error: String(e).slice(0, 300), updated_at: new Date().toISOString() }).eq("id", claim.id);
      results.push({ book, error: "broker result requires reconciliation" });
    }
  }
  const first = results.find((r) => (r as Record<string, unknown>).fill_price != null) as Record<string, unknown> | undefined;
  return { ok: true, results, fill_price: first?.fill_price ?? null };
}

async function reconcile(db: Db) {
  const fixed: unknown[] = [];
  // 1) Orders whose broker response was lost: find them by strategy id.
  const { data: stuck } = await db.from("book_orders").select("*").in("status", ["sent", "reconciliation_required"])
    .lt("created_at", new Date(Date.now() - 45_000).toISOString()).limit(20);
  for (const o of stuck ?? []) {
    const dest = await destination(db, o.book);
    if (!dest) continue;
    const rows = await ordersByStrategy(dest.token, dest.accountId, dest.accNum, bookStrategy(o.book, o.source_trade_id)).catch(() => []);
    const filled = rows.filter((r) => String(r.status ?? "").toLowerCase() === "filled" &&
      (o.event === "open" ? (r.isOpen === true || String(r.isOpen) === "true") : !(r.isOpen === true || String(r.isOpen) === "true")));
    if (filled.length) {
      const r = filled[0];
      await db.from("book_orders").update({ status: o.event === "open" ? "filled" : "closed", broker_order_id: String(r.id ?? ""),
        broker_position_id: r.positionId == null ? o.broker_position_id : String(r.positionId), fill_price: Number(r.avgPrice) || null,
        error: null, updated_at: new Date().toISOString() }).eq("id", o.id);
      fixed.push({ id: o.id, found: true });
    } else if (Date.now() - Date.parse(o.created_at) > 10 * 60_000) {
      await db.from("book_orders").update({ status: "error", error: (o.error ? o.error + " | " : "") + "no broker order found after 10 minutes", updated_at: new Date().toISOString() }).eq("id", o.id);
      if (o.event === "open") await db.rpc("ab_release_risk", { p_book: o.book, p_trade: o.source_trade_id });
      fixed.push({ id: o.id, found: false });
    }
  }
  // 2) Orphans: a filled book leg whose IPFX trade is already closed but whose close never happened.
  const { data: legs } = await db.from("book_orders").select("source_trade_id,book").eq("event", "open").eq("status", "filled").limit(200);
  for (const leg of legs ?? []) {
    const [{ data: t }, { data: c }] = await Promise.all([
      db.from("trades").select("status").eq("id", leg.source_trade_id).maybeSingle(),
      db.from("book_orders").select("id").eq("source_trade_id", leg.source_trade_id).eq("book", leg.book).eq("event", "close").limit(1),
    ]);
    if (t?.status === "closed" && !(c ?? []).length) fixed.push({ orphan: leg.source_trade_id, ...(await closeLeg(db, { source_trade_id: leg.source_trade_id, event: "close" })) });
  }
  return { ok: true, fixed };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const secret = Deno.env.get("BOOK_EXECUTOR_SECRET") ?? "";
  const viaService = !!serviceKey && constantTimeEqual(req.headers.get("authorization") ?? "", `Bearer ${serviceKey}`);
  const viaSecret = secret.length >= 32 && constantTimeEqual(req.headers.get("x-book-secret") ?? "", secret);
  if (!viaService && !viaSecret) return json({ error: "unauthorised" }, 401);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (body.action === "reconcile") return json(await reconcile(db));
  if (!viaService) return json({ error: "unauthorised" }, 401);
  if (body.event === "open") {
    if (body.book !== "a" && body.book !== "b") return json({ ok: false, error: "book required" }, 400);
    return json(await open(db, body));
  }
  if (body.event === "close" || body.event === "partial_close") return json(await closeLeg(db, body));
  return json({ ok: false, error: "unknown event" }, 400);
});
