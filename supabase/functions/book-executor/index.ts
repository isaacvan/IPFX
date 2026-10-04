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
  const key = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
  if (!key) return null;
  const ladder = /^l[0-9]+$/.test(book);
  const { data: d } = ladder
    ? await db.from("ladder_accounts").select("*").eq("id", Number(book.slice(1))).eq("execution_enabled", true).in("status", ["evaluation", "funded"]).maybeSingle()
    : await db.from("team_book_destinations").select("*").eq("book", book).eq("status", "connected").eq("environment", "demo").maybeSingle();
  if (!d || !d.access_token_ciphertext) return null;
  let token = await decryptSecret(d.access_token_ciphertext, key);
  if (!d.access_expires_at || Date.parse(d.access_expires_at) - Date.now() < 30 * 60_000) {
    const next = await refresh(await decryptSecret(d.refresh_token_ciphertext, key));
    token = next.accessToken;
    const patch = { access_token_ciphertext: await encryptSecret(next.accessToken, key), refresh_token_ciphertext: await encryptSecret(next.refreshToken, key),
      access_expires_at: jwtExpiresAt(next.accessToken), updated_at: new Date().toISOString() };
    if (ladder) await db.from("ladder_accounts").update(patch).eq("id", Number(book.slice(1)));
    else await db.from("team_book_destinations").update({ ...patch, last_health_at: new Date().toISOString() }).eq("book", book);
  }
  return { token, accountId: String(d.account_id), accNum: String(d.acc_num), map: (d.instrument_map ?? []) as Array<Record<string, unknown>> };
}
// Deterministic split of traders across ladder accounts (each account copies one group), so one bad trader or
// one bad day cannot hit every account at once.
function signalGroup(person: string, groups: number): number {
  let h = 2166136261;
  for (const c of person) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return groups > 0 ? h % groups : 0;
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

type Leg = { book: string; sizeUsd: number };

async function open(db: Db, b: Record<string, unknown>) {
  const tradeId = String(b.source_trade_id), book = String(b.book) as "a" | "b";
  const { data: t } = await db.from("trades").select("id,user_id,symbol,side,volume,open_price,sl,status").eq("id", tradeId).maybeSingle();
  if (!t || t.status !== "open") return { ok: true, skipped: "source trade not open" };
  const { data: person } = await db.rpc("ab_person_of", { p_user: t.user_id });
  const { data: route } = await db.rpc("ab_route_for_user", { p_user: t.user_id });
  if (route !== book) return { ok: true, skipped: "route changed" };
  const traderRisk = Number(b.risk_usd), scale = Number(b.price_scale_per_lot);
  if (!(traderRisk > 0) || t.sl == null) return { ok: true, skipped: "no stop loss: risk not measurable" };
  const [{ data: prof }, { data: lim }, { data: settings }, { data: pol }, { data: progress }, { data: treasury }, { data: ls }] = await Promise.all([
    db.from("ab_trader_profiles").select("state_since").eq("person_id", person).maybeSingle(),
    db.from("ab_risk_limits").select("*").eq("book", book).maybeSingle(),
    db.from("ab_settings").select("a_scale,b_scale").maybeSingle(),
    db.from("ab_policy_versions").select("thresholds").eq("status", "ACTIVE").maybeSingle(),
    db.rpc("ab_person_progress", { p_person: person }),
    db.rpc("treasury_status"),
    db.from("ladder_settings").select("signal_groups").maybeSingle(),
  ]);
  // Cash for payouts short: no new B-book (reverse) risk at all until it recovers.
  if (book === "b" && treasury === "short") return { ok: true, skipped: "treasury short: B-book paused" };
  const policy: Policy = { ...POLICY_V1, ...(pol?.thresholds ?? {}) };
  const sizing = sizeMultiplier(book, await ledgerPoints(db, person), Date.parse(prof?.state_since ?? new Date().toISOString()), Number(lim?.max_multiplier ?? 1), policy);

  // Destinations for this signal: the book's review account, plus (A-book only) every enabled ladder account
  // in this trader's signal group.
  const legs: Leg[] = [];
  const { data: reviewDest } = await db.from("team_book_destinations").select("book").eq("book", book).eq("status", "connected").maybeSingle();
  if (reviewDest) legs.push({ book, sizeUsd: Number(lim?.account_size_usd ?? 50000) });
  if (book === "a") {
    const groups = Number(ls?.signal_groups ?? 1);
    const { data: ladders } = await db.from("ladder_accounts").select("id,size_usd,signal_group").eq("execution_enabled", true).in("status", ["evaluation", "funded"]);
    for (const la of ladders ?? []) if (Number(la.signal_group) % groups === signalGroup(String(person), groups)) legs.push({ book: "l" + la.id, sizeUsd: Number(la.size_usd) });
  }
  if (!legs.length) return { ok: true, skipped: "no connected destination" };

  const side = legSide(book, t.side);
  const scaleSetting = Number(book === "a" ? settings?.a_scale ?? 1 : settings?.b_scale ?? 1);
  const since = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const { count: liveTraders } = await db.from("ab_trader_profiles").select("person_id", { count: "exact", head: true }).eq("book_state", book === "a" ? "AB_LIVE" : "BB_LIVE");
  // Legs go out in parallel (each account has its own reservation row and broker token), so 30 ladder
  // accounts take about as long as one and the engine's hedge-first wait is not exceeded.
  const placeLeg = async (leg: Leg): Promise<Record<string, unknown>> => {
    let wanted = traderRisk * sizing.multiplier, reason = sizing.reason, weight = sizing.multiplier;
    if (Number(lim?.account_size_usd) > 0) {
      const { count: routed } = await db.from("book_orders").select("id", { count: "exact", head: true }).eq("book", leg.book).eq("event", "open").gte("created_at", since);
      const groupsShare = leg.book.startsWith("l") ? Math.max(1, Number(ls?.signal_groups ?? 1)) : 1;
      const expected = Math.max(Number(routed ?? 0) / 5, Number(liveTraders ?? 0) * 2 / groupsShare);
      const f = fundedRiskUsd(book, { accountSizeUsd: leg.sizeUsd, dailyBudgetPct: Number(lim.daily_risk_budget_pct),
        perTradeMinPct: Number(lim.per_trade_min_pct), perTradeMaxPct: Number(lim.per_trade_max_pct) }, expected, (progress ?? "EARLY") as Progress, sizing,
        (treasury ?? "unknown") as "unknown" | "healthy" | "tight" | "short");
      wanted = f.riskUsd; reason = f.reason; weight = f.weight;
    }
    wanted *= scaleSetting;
    const signedLots = (side === "buy" ? 1 : -1) * Number(t.volume) * (wanted / traderRisk);
    const { data: res, error: resErr } = await db.rpc("ab_reserve_risk", { p_book: leg.book, p_trade: tradeId, p_person: person, p_symbol: t.symbol, p_signed_lots: signedLots, p_risk_usd: wanted });
    if (resErr || !res?.ok) { return { book: leg.book, skipped: "risk: " + (res?.reason ?? resErr?.message ?? "refused") }; }
    const dest = await destination(db, leg.book);
    if (!dest) { await db.rpc("ab_release_risk", { p_book: leg.book, p_trade: tradeId }); return { book: leg.book, skipped: "destination not connected" }; }
    const inst = instrumentFor(dest.map, t.symbol);
    if (!inst) { await db.rpc("ab_release_risk", { p_book: leg.book, p_trade: tradeId }); return { book: leg.book, skipped: "instrument not available" }; }
    const qty = lotsFor(Number(t.volume), traderRisk, Number(res.allowed_usd), Number(inst.lot_step ?? 0.01), Number(inst.min_qty ?? 0.01));
    if (!(qty > 0)) { await db.rpc("ab_release_risk", { p_book: leg.book, p_trade: tradeId }); return { book: leg.book, skipped: "below broker minimum" }; }
    const { data: claim, error: claimErr } = await db.from("book_orders").insert({
      book: leg.book, source_trade_id: tradeId, person_id: person, event: "open", idempotency_key: `${leg.book}:${tradeId}:open`, symbol: t.symbol, side, qty,
      multiplier: Number((Number(res.allowed_usd) / traderRisk).toFixed(3)), risk_usd: res.allowed_usd, status: "sent", price_scale_per_lot: scale > 0 ? scale : null,
    }).select("id").single();
    if (claimErr?.code === "23505") { return { book: leg.book, skipped: "duplicate event" }; }
    if (claimErr || !claim) { return { book: leg.book, error: "claim failed" }; }
    const started = Date.now();
    try {
      const stop = emergencyStop(book, t.side, Number(t.open_price), Number(t.sl));
      const payload = { ...marketOrder({ qty, routeId: Number(inst.trade_route_id), side, tradableInstrumentId: Number(inst.tradable_instrument_id), sl: stop, tp: null, sourceTradeId: tradeId }), strategyId: bookStrategy(leg.book, tradeId) };
      const ids = responseIds(await placeMarketOrder(dest.token, dest.accountId, dest.accNum, payload));
      const fill = await orderFill(dest.token, dest.accountId, dest.accNum, { orderId: ids.orderId }).catch(() => null);
      const positionId = ids.positionId ?? fill?.positionId ?? null;
      await db.from("book_orders").update({
        status: positionId ? "filled" : "reconciliation_required", broker_order_id: ids.orderId, broker_position_id: positionId,
        fill_price: fill?.price ?? null, latency_ms: Date.now() - started, updated_at: new Date().toISOString(),
      }).eq("id", claim.id);
      return { book: leg.book, qty, multiple_of_trader: Number((Number(res.allowed_usd) / traderRisk).toFixed(2)), weight, reason, fill_price: fill?.price ?? null, positionId };
    } catch (e) {
      // Never resubmit an ambiguous order: the reconciler finds it by strategy id.
      await db.from("book_orders").update({ status: "reconciliation_required", error: String(e).slice(0, 300), latency_ms: Date.now() - started, updated_at: new Date().toISOString() }).eq("id", claim.id);
      return { book: leg.book, error: "broker result requires reconciliation" };
    }
  };
  const results: Array<Record<string, unknown>> = [];
  for (let i = 0; i < legs.length; i += 8) results.push(...await Promise.all(legs.slice(i, i + 8).map(placeLeg)));
  // For hedge-first pricing the trader is filled no better than the WORST same-direction leg.
  const fills = results.map((r) => Number(r.fill_price)).filter((x) => x > 0);
  const worst = fills.length ? (side === "buy" ? Math.max(...fills) : Math.min(...fills)) : null;
  return { ok: true, legs: results, fill_price: book === "a" ? worst : null };
}

async function closeLeg(db: Db, b: Record<string, unknown>) {
  const tradeId = String(b.source_trade_id), event = b.event === "partial_close" ? "partial_close" : "close";
  const { data: legs } = await db.from("book_orders").select("*").eq("source_trade_id", tradeId).eq("event", "open").in("status", ["filled"]);
  // Each leg closes on its own account; run them in parallel so many ladder accounts close together.
  const closeOne = async (leg: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    const book = leg.book as "a" | "b";
    const { data: done } = await db.from("book_orders").select("qty").eq("source_trade_id", tradeId).eq("book", book).in("event", ["partial_close", "close"]).in("status", ["closed", "sent", "reconciliation_required"]);
    const remaining = Number(leg.qty) - (done ?? []).reduce((a: number, r: Record<string, unknown>) => a + Number(r.qty), 0);
    if (!(remaining > 1e-9)) return null;
    const fraction = event === "partial_close" ? Math.min(1, Math.max(0, Number(b.fraction))) : 1;
    let qty = event === "close" ? remaining : Math.floor((Number(leg.qty) * fraction + 1e-9) / 0.01) * 0.01;
    qty = Math.min(Number(qty.toFixed(6)), remaining);
    if (!(qty > 0)) return null;
    const slice = event === "close" ? "close" : `partial:${String(b.slice_id ?? Date.now())}`;
    const { data: claim, error: claimErr } = await db.from("book_orders").insert({
      book, source_trade_id: tradeId, person_id: leg.person_id, event, idempotency_key: `${book}:${tradeId}:${slice}`, symbol: leg.symbol,
      side: leg.side === "buy" ? "sell" : "buy", qty, status: "sent", price_scale_per_lot: leg.price_scale_per_lot,
    }).select("id").single();
    if (claimErr?.code === "23505") { return { book, skipped: "duplicate event" }; }
    if (claimErr || !claim) { return { book, error: "claim failed" }; }
    const dest = await destination(db, book);
    if (!dest) { await db.from("book_orders").update({ status: "reconciliation_required", error: "destination unavailable" }).eq("id", claim.id); return { book, error: "destination unavailable" }; }
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
      return { book, qty, fill_price: fill?.price ?? null, pnl_usd: pnl };
    } catch (e) {
      await db.from("book_orders").update({ status: "reconciliation_required", error: String(e).slice(0, 300), updated_at: new Date().toISOString() }).eq("id", claim.id);
      return { book, error: "broker result requires reconciliation" };
    }
  };
  const results: Array<Record<string, unknown>> = [];
  const all = legs ?? [];
  for (let i = 0; i < all.length; i += 8) for (const x of await Promise.all(all.slice(i, i + 8).map(closeOne))) if (x) results.push(x);
  // Same-direction legs (A-book review + ladder accounts): the trader's close is priced no better than the worst one.
  const aLegs = (legs ?? []).filter((l: Record<string, unknown>) => String(l.book) !== "b");
  const traderLong = aLegs.length ? aLegs[0].side === "buy" : true;
  const aFills = results.filter((r) => String((r as Record<string, unknown>).book) !== "b").map((r) => Number((r as Record<string, unknown>).fill_price)).filter((x) => x > 0);
  const duplicateA = results.some((r) => String((r as Record<string, unknown>).book) !== "b" && (r as Record<string, unknown>).skipped === "duplicate event");
  const fillA = aFills.length ? (traderLong ? Math.min(...aFills) : Math.max(...aFills)) : null;
  return { ok: true, results, fill_price: fillA, duplicate_a: duplicateA };
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
