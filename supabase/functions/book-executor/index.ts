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
import { reserveCapacity } from "../_shared/book-capacity.ts";
import { TL_SYMBOLS } from "../_shared/tradelocker-feed.ts";
import { readClient, type TlEnv } from "../_shared/tradelocker-read.ts";
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

async function destination(db: Db, book: string, exitOnly = false) {
  const key = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
  if (!key) return null;
  const shadow = /^s[0-9]+$/.test(book);
  const ladder = shadow || /^l[0-9]+$/.test(book);
  const { data: d } = shadow
    // Demo copy accounts: no status or execution filter, so a paused account can still close what it holds.
    ? await db.from("ladder_accounts").select("*").eq("id", Number(book.slice(1))).eq("role", "shadow").maybeSingle()
    : ladder
    ? await (exitOnly
      ? db.from("ladder_accounts").select("*").eq("id", Number(book.slice(1))).eq("role", "ladder")
      : db.from("ladder_accounts").select("*").eq("id", Number(book.slice(1))).eq("role", "ladder").eq("execution_enabled", true).in("status", ["evaluation", "funded"])).maybeSingle()
    : await db.from("team_book_destinations").select("*").eq("book", book).eq("status", "connected").eq("environment", "demo").maybeSingle();
  if (!d || !d.access_token_ciphertext || d.role === "monitor" || (d.api_env ?? "demo") !== "demo") return null;
  let token = await decryptSecret(d.access_token_ciphertext, key);
  if (!d.access_expires_at || Date.parse(d.access_expires_at) - Date.now() < 30 * 60_000) {
    const next = await refresh(await decryptSecret(d.refresh_token_ciphertext, key));
    token = next.accessToken;
    const patch = { access_token_ciphertext: await encryptSecret(next.accessToken, key), refresh_token_ciphertext: await encryptSecret(next.refreshToken, key),
      access_expires_at: jwtExpiresAt(next.accessToken), updated_at: new Date().toISOString() };
    if (ladder) await db.from("ladder_accounts").update(patch).eq("id", Number(book.slice(1)));
    else await db.from("team_book_destinations").update({ ...patch, last_health_at: new Date().toISOString() }).eq("book", book);
  }
  return { token, accountId: String(d.account_id), accNum: String(d.acc_num), env: (d.api_env ?? "demo") as TlEnv, map: (d.instrument_map ?? []) as Array<Record<string, unknown>> };
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
    const { data: ladders } = await db.from("ladder_accounts").select("id,size_usd,signal_group").eq("role", "ladder").eq("execution_enabled", true).in("status", ["evaluation", "funded"]);
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
    const capacity = await reserveCapacity(db, leg.book, tradeId, qty, dest);
    if (!capacity?.ok) { await db.rpc("ab_release_risk", { p_book: leg.book, p_trade: tradeId }); return { book: leg.book, skipped: "capacity: " + (capacity?.reason ?? "unavailable") }; }
    const { data: claim, error: claimErr } = await db.from("book_orders").insert({
      book: leg.book, source_trade_id: tradeId, person_id: person, event: "open", idempotency_key: `${leg.book}:${tradeId}:open`, symbol: t.symbol, side, qty,
      multiplier: Number((Number(res.allowed_usd) / traderRisk).toFixed(3)), risk_usd: res.allowed_usd, status: "sent", source_initial_volume: Number(t.volume), lot_step: Number(inst.lot_step ?? 0.01), price_scale_per_lot: scale > 0 ? scale : null,
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
    const { data: planned, error: planError } = await db.rpc("fn_plan_book_exit", { p_open_id: leg.id, p_full: event === "close", p_slice: String(b.slice_id ?? "") });
    if (planError || !planned?.ok) return { book, error: planned?.reason ?? "EXIT_PLAN_UNAVAILABLE" };
    if (planned.skipped) return null;
    const claim = planned.claim, qty = Number(claim.qty);
    if (claim.dispatch_state === "confirmed") return { book, qty, fill_price: claim.fill_price, confirmed: true, duplicate: true };
    if (claim.dispatch_state !== "planned") return { book, error: "EXIT_RECONCILIATION_REQUIRED" };
    // No dispatch before resolving the owned position; a disconnected/paused account keeps a retryable plan.
    const dest = await destination(db, book, true);
    if (!dest) return { book, error: "DESTINATION_UNAVAILABLE", operation_id: claim.id };
    const { data: dispatched, error: dispatchError } = await db.from("book_orders").update({ dispatch_state: "sent", updated_at: new Date().toISOString() })
      .eq("id", claim.id).eq("dispatch_state", "planned").select("id");
    if (dispatchError || !dispatched?.length) return { book, error: "EXIT_ALREADY_IN_FLIGHT" };
    const remaining = Number(planned.remaining ?? qty);
    const started = Date.now();
    try {
      const ids = responseIds(await closePositionQty(dest.token, dest.accNum, String(leg.broker_position_id), qty));
      const fill = await orderFill(dest.token, dest.accountId, dest.accNum, { orderId: ids.orderId, positionId: String(leg.broker_position_id), closing: true, strictOrder: true }).catch(() => null);
      const verified = !!fill && Math.abs(fill.qty - qty) < 1e-8 && !!ids.orderId && fill.orderId === ids.orderId;
      const dir = leg.side === "buy" ? 1 : -1;
      const pnl = fill && leg.fill_price != null && leg.price_scale_per_lot != null
        ? (fill.price - Number(leg.fill_price)) * dir * qty * Number(leg.price_scale_per_lot) : null;
      const { error: receiptError } = await db.from("book_orders").update({ status: verified ? "closed" : "reconciliation_required", dispatch_state: verified ? "confirmed" : "unknown", broker_confirmed_qty: verified ? qty : null, broker_order_id: ids.orderId,
        broker_position_id: leg.broker_position_id, fill_price: fill?.price ?? null, pnl_usd: pnl == null ? null : Math.round(pnl * 100) / 100,
        latency_ms: Date.now() - started, updated_at: new Date().toISOString() }).eq("id", claim.id);
      if (receiptError) return { book, error: "EXIT_RECEIPT_NOT_SAVED", operation_id: claim.id };
      if (verified) await db.rpc("fn_finalize_book_exit", { p_exit_id: claim.id });
      return verified ? { book, qty, fill_price: fill.price, pnl_usd: pnl, confirmed: true } : { book, error: "EXIT_RECONCILIATION_REQUIRED", operation_id: claim.id };
    } catch (e) {
      await db.from("book_orders").update({ status: "reconciliation_required", dispatch_state: "unknown", error: String(e).slice(0, 300), updated_at: new Date().toISOString() }).eq("id", claim.id);
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
  const duplicateA = results.some((r) => String(r.book) !== "b" && !!r.error);
  const fillA = aFills.length ? (traderLong ? Math.min(...aFills) : Math.max(...aFills)) : null;
  return { ok: !results.some(r => !!r.error), results, fill_price: duplicateA ? null : fillA, duplicate_a: duplicateA };
}

// ---------- Shadow copy: every trader's trade at the broker's minimum size on a TradeLocker demo account ----------
// Sent after the trader's own fill, never blocks or alters it, and never touches risk reservations or
// book_orders. The Brain scales the result to funded size (shadow_funded_summary).
async function shadowOpen(db: Db, b: Record<string, unknown>) {
  const tradeId = String(b.source_trade_id), scale = Number(b.price_scale_per_lot);
  const { data: t } = await db.from("trades").select("id,user_id,symbol,side,status").eq("id", tradeId).maybeSingle();
  if (!t || t.status !== "open") return { ok: true, skipped: "source trade not open" };
  if (!(scale > 0)) return { ok: true, skipped: "no price scale" };
  const { data: person } = await db.rpc("ab_person_of", { p_user: t.user_id });
  const who = String(person ?? t.user_id);
  const { data: acctId } = await db.rpc("fn_shadow_account", { p_person: who });
  if (!acctId) return { ok: true, skipped: "no demo account with room" };
  const book = "s" + acctId;
  const dest = await destination(db, book);
  if (!dest) return { ok: true, skipped: "demo account not connected" };
  const inst = instrumentFor(dest.map, t.symbol);
  if (!inst) return { ok: true, skipped: "instrument not available" };
  const { data: profile, error: profileError } = await db.from("ab_trader_profiles").select("book_state").eq("person_id", who).maybeSingle();
  if (profileError || profile?.book_state === "SUSPENDED") return { ok: false, error: "PROFILE_UNAVAILABLE_OR_SUSPENDED" };
  const reverse = !String(profile?.book_state ?? "BB_DEMO").startsWith("AB_");
  const side = reverse ? (t.side === "sell" ? "buy" : "sell") : (t.side === "sell" ? "sell" : "buy");
  const qty = Number(inst.min_qty ?? inst.lot_step ?? 0.01);
  if (!(qty > 0)) return { ok: true, skipped: "no minimum size" };
  const capacity = await reserveCapacity(db, book, tradeId, qty, dest);
  if (!capacity?.ok) return { ok: false, error: "capacity: " + (capacity?.reason ?? "unavailable") };
  const { data: claim, error: claimErr } = await db.from("shadow_orders").insert({
    source_trade_id: tradeId, person_id: who, account_id: acctId, event: "open", idempotency_key: `${book}:${tradeId}:open`,
    symbol: t.symbol, side, qty, status: "sent", price_scale_per_lot: scale,
  }).select("id").single();
  if (claimErr?.code === "23505") return { ok: true, skipped: "duplicate event" };
  if (claimErr || !claim) return { ok: false, error: "claim failed" };
  const started = Date.now();
  try {
    const payload = { ...marketOrder({ qty, routeId: Number(inst.trade_route_id), side, tradableInstrumentId: Number(inst.tradable_instrument_id), sl: null, tp: null, sourceTradeId: tradeId }), strategyId: bookStrategy(book, tradeId) };
    const ids = responseIds(await placeMarketOrder(dest.token, dest.accountId, dest.accNum, payload));
    const fill = await orderFill(dest.token, dest.accountId, dest.accNum, { orderId: ids.orderId }).catch(() => null);
    const positionId = ids.positionId ?? fill?.positionId ?? null;
    await db.from("shadow_orders").update({ status: positionId ? "filled" : "reconciliation_required", broker_order_id: ids.orderId, broker_position_id: positionId,
      fill_price: fill?.price ?? null, latency_ms: Date.now() - started, updated_at: new Date().toISOString() }).eq("id", claim.id);
    // A partial close may have arrived while the demo order was in flight.
    if (positionId) await shadowPriceSlices(db, tradeId).catch(() => 0);
    // The trader may have closed while the demo order was in flight: close the demo position right away.
    const { data: now } = await db.from("trades").select("status").eq("id", tradeId).maybeSingle();
    if (positionId && now?.status === "closed") await shadowClose(db, { source_trade_id: tradeId });
    return { ok: true, book, qty, fill_price: fill?.price ?? null };
  } catch (e) {
    // Never resubmit an ambiguous order: the reconciler finds it by strategy id.
    await db.from("shadow_orders").update({ status: "reconciliation_required", error: String(e).slice(0, 300), latency_ms: Date.now() - started, updated_at: new Date().toISOString() }).eq("id", claim.id);
    return { ok: true, book, error: "broker result requires reconciliation" };
  }
}

// Partial closes: the demo copy is the broker minimum and cannot be split, so a slice is priced from the demo
// account's own bid/ask at that moment (the side a close would use) and no order is sent. Slices older than three
// minutes are never priced late: they stay unpriced and the trade is left out of the funded-size results.
const SLICE_MAX_AGE_MS = 3 * 60_000;
async function shadowPriceSlices(db: Db, tradeId: string) {
  const { data: slices } = await db.from("shadow_slices").select("id,created_at").eq("source_trade_id", tradeId).is("exit_price", null);
  const due = (slices ?? []).filter((x: Record<string, unknown>) => Date.now() - Date.parse(String(x.created_at)) < SLICE_MAX_AGE_MS);
  if (!due.length) return 0;
  const { data: leg } = await db.from("shadow_orders").select("account_id,symbol,side").eq("source_trade_id", tradeId).eq("event", "open").eq("status", "filled").maybeSingle();
  if (!leg) return 0;
  const book = "s" + leg.account_id, dest = await destination(db, book);
  if (!dest) return 0;
  const inst = instrumentFor(dest.map, leg.symbol);
  if (!inst || inst.info_route_id == null) return 0;
  const q = await readClient(dest.env).quote(dest.token, dest.accNum, Number(inst.info_route_id), String(inst.tradable_instrument_id)).catch(() => null);
  if (!q) return 0;
  const exit = leg.side === "buy" ? q.bid : q.ask;
  for (const x of due) await db.from("shadow_slices").update({ exit_price: exit, bid: q.bid, ask: q.ask, priced_at: new Date().toISOString() }).eq("id", x.id).is("exit_price", null);
  return due.length;
}

async function shadowPartial(db: Db, b: Record<string, unknown>) {
  const tradeId = String(b.source_trade_id), sliceId = String(b.slice_trade_id ?? "");
  if (!sliceId) return { ok: false, error: "slice_trade_id required" };
  const { data: leg } = await db.from("shadow_orders").select("account_id,status").eq("source_trade_id", tradeId).eq("event", "open").in("status", ["filled", "sent", "reconciliation_required"]).maybeSingle();
  if (!leg) return { ok: true, skipped: "no demo copy" };
  const { error } = await db.from("shadow_slices").insert({ source_trade_id: tradeId, slice_trade_id: sliceId, account_id: leg.account_id });
  if (error?.code === "23505") return { ok: true, skipped: "duplicate event" };
  if (error) return { ok: false, error: "claim failed" };
  // Demo order still in flight: shadowOpen prices the slice as soon as it fills.
  const priced = leg.status === "filled" ? await shadowPriceSlices(db, tradeId) : 0;
  return { ok: true, priced };
}

async function shadowClose(db: Db, b: Record<string, unknown>) {
  const tradeId = String(b.source_trade_id);
  await shadowPriceSlices(db, tradeId).catch(() => 0);
  const { data: legs } = await db.from("shadow_orders").select("*").eq("source_trade_id", tradeId).eq("event", "open").eq("status", "filled");
  const results: Array<Record<string, unknown>> = [];
  for (const leg of legs ?? []) {
    const book = "s" + leg.account_id;
    let { data: claim, error: claimErr } = await db.from("shadow_orders").insert({
      source_trade_id: tradeId, person_id: leg.person_id, account_id: leg.account_id, event: "close", idempotency_key: `${book}:${tradeId}:close`,
      symbol: leg.symbol, side: leg.side === "buy" ? "sell" : "buy", qty: leg.qty, status: "sent", dispatch_state: "planned", price_scale_per_lot: leg.price_scale_per_lot,
    }).select("id").single();
    if (claimErr?.code === "23505") {
      const { data: old } = await db.from("shadow_orders").select("*").eq("idempotency_key", book + ":" + tradeId + ":close").maybeSingle();
      if (old?.dispatch_state === "planned") Object.assign(claim ?? (claim = {}), old);
      else { results.push({ book, error: old?.dispatch_state === "confirmed" ? null : "EXIT_RECONCILIATION_REQUIRED" }); continue; }
    }
    if ((claimErr && claimErr.code !== "23505") || !claim) { results.push({ book, error: "claim failed" }); continue; }
    const dest = await destination(db, book);
    if (!dest) { await db.from("shadow_orders").update({ status: "reconciliation_required", error: "destination unavailable" }).eq("id", claim.id); results.push({ book, error: "destination unavailable" }); continue; }
    const { data: dispatched, error: dispatchError } = await db.from("shadow_orders").update({ dispatch_state: "sent" }).eq("id", claim.id).eq("dispatch_state", "planned").select("id");
    if (dispatchError || !dispatched?.length) { results.push({ book, error: "EXIT_ALREADY_IN_FLIGHT" }); continue; }
    const started = Date.now();
    try {
      const ids = responseIds(await closePositionQty(dest.token, dest.accNum, String(leg.broker_position_id), 0));
      const fill = await orderFill(dest.token, dest.accountId, dest.accNum, { orderId: ids.orderId, positionId: String(leg.broker_position_id), closing: true, strictOrder: true }).catch(() => null);
      const verified = !!fill && !!ids.orderId && fill.orderId === ids.orderId && Math.abs(fill.qty - Number(leg.qty)) < 1e-8;
      await db.from("shadow_orders").update({ status: verified ? "closed" : "reconciliation_required", dispatch_state: verified ? "confirmed" : "unknown", broker_confirmed_qty: verified ? Number(leg.qty) : null, broker_order_id: ids.orderId, broker_position_id: leg.broker_position_id,
        fill_price: fill?.price ?? null, latency_ms: Date.now() - started, updated_at: new Date().toISOString() }).eq("id", claim.id);
      if (verified) {
        await db.from("shadow_orders").update({ status: "closed", updated_at: new Date().toISOString() }).eq("id", leg.id);
        await db.from("book_position_slots").update({ state: "released" }).eq("book", book).eq("source_trade_id", tradeId);
      }
      results.push({ book, fill_price: fill?.price ?? null });
    } catch (e) {
      await db.from("shadow_orders").update({ status: "reconciliation_required", error: String(e).slice(0, 300), updated_at: new Date().toISOString() }).eq("id", claim.id);
      results.push({ book, error: "broker result requires reconciliation" });
    }
  }
  return { ok: true, results };
}

// Lost responses (found by strategy id) and orphans (the trader's trade closed but the demo copy is still open).
async function shadowReconcile(db: Db) {
  const fixed: unknown[] = [];
  const { data: stuck } = await db.from("shadow_orders").select("*").in("status", ["sent", "reconciliation_required"])
    .lt("created_at", new Date(Date.now() - 45_000).toISOString()).limit(20);
  for (const o of stuck ?? []) {
    const book = "s" + o.account_id, dest = await destination(db, book);
    if (!dest) continue;
    const rows = await ordersByStrategy(dest.token, dest.accountId, dest.accNum, bookStrategy(book, o.source_trade_id)).catch(() => []);
    const filled = rows.filter((r) => String(r.status ?? "").toLowerCase() === "filled" &&
      (o.event === "open" ? (r.isOpen === true || String(r.isOpen) === "true") : (!!o.broker_order_id && String(r.id ?? r.orderId) === String(o.broker_order_id) && Math.abs(Number(r.filledQty) - Number(o.qty)) < 1e-8 && !(r.isOpen === true || String(r.isOpen) === "true"))));
    if (filled.length) {
      const r = filled[0];
      await db.from("shadow_orders").update({ status: o.event === "open" ? "filled" : "closed", ...(o.event === "open" ? {} : { dispatch_state: "confirmed", broker_confirmed_qty: Number(o.qty) }), broker_order_id: String(r.id ?? ""),
        broker_position_id: r.positionId == null ? o.broker_position_id : String(r.positionId), fill_price: Number(r.avgPrice) || null, error: null, updated_at: new Date().toISOString() }).eq("id", o.id);
      if (o.event === "close") await db.from("shadow_orders").update({ status: "closed" }).eq("source_trade_id", o.source_trade_id).eq("event", "open").eq("status", "filled");
      fixed.push({ id: o.id, found: true });
    } else if (Date.now() - Date.parse(o.created_at) > 10 * 60_000) {
      await db.from("shadow_orders").update({ status: "reconciliation_required", error: (o.error ? o.error + " | " : "") + "no broker order found after 10 minutes", updated_at: new Date().toISOString() }).eq("id", o.id);
      fixed.push({ id: o.id, found: false });
    }
  }
  const { data: waiting } = await db.from("shadow_slices").select("source_trade_id").is("exit_price", null).gt("created_at", new Date(Date.now() - SLICE_MAX_AGE_MS).toISOString()).limit(50);
  for (const w of [...new Set((waiting ?? []).map((x: Record<string, unknown>) => String(x.source_trade_id)))]) fixed.push({ priced_slices: w, n: await shadowPriceSlices(db, String(w)).catch(() => 0) });
  const { data: legs } = await db.from("shadow_orders").select("source_trade_id").eq("event", "open").eq("status", "filled").limit(200);
  for (const leg of legs ?? []) {
    const { data: t } = await db.from("trades").select("status").eq("id", leg.source_trade_id).maybeSingle();
    if (t?.status === "closed") fixed.push({ orphan: leg.source_trade_id, ...(await shadowClose(db, { source_trade_id: leg.source_trade_id })) });
  }
  return fixed;
}

async function reconcile(db: Db) {
  const fixed: unknown[] = [];
  // 1) Orders whose broker response was lost: find them by strategy id.
  const { data: stuck } = await db.from("book_orders").select("*").in("status", ["sent", "reconciliation_required", "error"])
    .lt("created_at", new Date(Date.now() - 45_000).toISOString()).limit(20);
  for (const o of stuck ?? []) {
    const dest = await destination(db, o.book, o.event !== "open");
    if (!dest) continue;
    const rows = await ordersByStrategy(dest.token, dest.accountId, dest.accNum, bookStrategy(o.book, o.source_trade_id)).catch(() => []);
    const filled = rows.filter((r) => String(r.status ?? "").toLowerCase() === "filled" &&
      (o.event === "open" ? (r.isOpen === true || String(r.isOpen) === "true") : (!!o.broker_order_id && String(r.id ?? r.orderId) === String(o.broker_order_id) && Math.abs(Number(r.filledQty) - Number(o.qty)) < 1e-8 && !(r.isOpen === true || String(r.isOpen) === "true"))));
    if (filled.length) {
      const r = filled[0];
      await db.from("book_orders").update({ status: o.event === "open" ? "filled" : "closed", ...(o.event === "open" ? {} : { dispatch_state: "confirmed", broker_confirmed_qty: Number(o.qty) }), broker_order_id: String(r.id ?? ""),
        broker_position_id: r.positionId == null ? o.broker_position_id : String(r.positionId), fill_price: Number(r.avgPrice) || null,
        error: null, updated_at: new Date().toISOString() }).eq("id", o.id);
      fixed.push({ id: o.id, found: true });
    } else if (Date.now() - Date.parse(o.created_at) > 10 * 60_000) {
      await db.from("book_orders").update({ status: "reconciliation_required", error: (o.error ? o.error + " | " : "") + "no broker order found after 10 minutes", updated_at: new Date().toISOString() }).eq("id", o.id);
      // Risk remains reserved until affirmative broker reconciliation; absence from history is insufficient.
      fixed.push({ id: o.id, found: false });
    }
  }
  const { data: prepared } = await db.from("book_orders").select("source_trade_id,event,idempotency_key").neq("event", "open").eq("dispatch_state", "planned").limit(50);
  for (const o of prepared ?? []) fixed.push(await closeLeg(db, { source_trade_id: o.source_trade_id, event: o.event, slice_id: String(o.idempotency_key).split("partial:")[1] ?? "" }));
  // 2) Orphans: a filled book leg whose IPFX trade is already closed but whose close never happened.
  const { data: legs } = await db.from("book_orders").select("source_trade_id,book").eq("event", "open").eq("status", "filled").limit(200);
  for (const leg of legs ?? []) {
    const [{ data: t }, { data: c }] = await Promise.all([
      db.from("trades").select("status").eq("id", leg.source_trade_id).maybeSingle(),
      db.from("book_orders").select("id").eq("source_trade_id", leg.source_trade_id).eq("book", leg.book).eq("event", "close").limit(1),
    ]);
    if (t?.status === "closed") fixed.push({ orphan: leg.source_trade_id, ...(await closeLeg(db, { source_trade_id: leg.source_trade_id, event: "close" })) });
  }
  fixed.push(...await shadowReconcile(db).catch(() => []));
  return { ok: true, fixed };
}

// Every copy or reverse that did not happen, with its reason, for the owner's Brain page (best effort:
// a logging failure never changes what was traded).
async function logSkips(db: Db, b: Record<string, unknown>, r: Record<string, unknown>) {
  const reasons: Array<{ book: string; reason: string }> = [];
  if (typeof r.skipped === "string") reasons.push({ book: String(b.book), reason: r.skipped });
  for (const leg of (r.legs as Array<Record<string, unknown>> | undefined) ?? [])
    if (typeof leg.skipped === "string") reasons.push({ book: String(leg.book ?? b.book), reason: leg.skipped });
  if (!reasons.length) return;
  const { data: t } = await db.from("trades").select("user_id").eq("id", String(b.source_trade_id)).maybeSingle();
  const { data: person } = t ? await db.rpc("ab_person_of", { p_user: t.user_id }) : { data: null };
  await db.from("ab_copy_skips").insert(reasons.map((x) => ({ book: x.book, source_trade_id: String(b.source_trade_id), person_id: person ?? null, reason: x.reason.slice(0, 200) })));
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
    const r = await open(db, body);
    await logSkips(db, body, r).catch(() => {});
    return json(r);
  }
  if (body.event === "shadow_open") return json(await shadowOpen(db, body));
  if (body.event === "shadow_close") return json(await shadowClose(db, body));
  if (body.event === "shadow_partial") return json(await shadowPartial(db, body));
  if (body.event === "close" || body.event === "partial_close") return json(await closeLeg(db, body));
  return json({ ok: false, error: "unknown event" }, 400);
});
