// Owner-only control for the treasury, A/B books and evaluation ladder (Team -> Treasury page).
// Requires a signed-in owner with an MFA (aal2) session. Broker passwords are used once to obtain tokens and
// never stored; tokens are stored encrypted and never returned. Every change is written to admin_audit_log.
// Nothing here buys, pays or places a trade: recording a purchase or payout only records what the owner did.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { allowRequest, readJsonObject } from "../_shared/request-guards.ts";
import { encryptSecret, jwtExpiresAt } from "../_shared/tradelocker-crypto.ts";
import { accounts, authenticate, instruments, tradeRoute } from "../_shared/tradelocker.ts";

const ORIGINS = new Set(["https://ipfxcapital.com", "https://www.ipfxcapital.com", "http://localhost:3000", "http://localhost:8127"]);
function aal(token: string): string {
  try { const raw = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); return String(JSON.parse(atob(raw + "=".repeat((4 - raw.length % 4) % 4))).aal ?? ""); }
  catch (_) { return ""; }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "https://ipfxcapital.com";
  const allowed = ORIGINS.has(origin) ? origin : "https://ipfxcapital.com";
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowed, "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin", "Cache-Control": "no-store" };
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST" || !ORIGINS.has(origin)) return json({ ok: false, error: "Not allowed" }, 403);
  const authHeader = req.headers.get("authorization") || "";
  const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await auth.auth.getUser();
  if (!user || aal(authHeader.replace(/^Bearer\s+/i, "")) !== "aal2") return json({ ok: false, error: "Owner MFA session required" }, 401);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const ownerEmail = String(Deno.env.get("IPFX_OWNER_EMAIL") || "paulade491@gmail.com").trim().toLowerCase();
  const { data: admin } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!admin || String(user.email || "").toLowerCase() !== ownerEmail) return json({ ok: false, error: "Owner access only" }, 403);
  if (!await allowRequest(db, "ladder-admin", user.id, 60, 60)) return json({ ok: false, error: "Too many requests" }, 429);
  const body = await readJsonObject(req, 16_384).catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ ok: false, error: "Invalid request" }, 400);
  const audit = (action: string, detail: Record<string, unknown>) => db.from("admin_audit_log").insert({ actor_id: user.id, action, detail });
  const action = String(body.action || "overview");

  if (action === "overview") {
    const { data: snap } = await db.from("treasury_snapshots").select("*").order("as_of", { ascending: false }).limit(1).maybeSingle();
    const [forecasts, states, events, limits, settings, ls, ladders, rec, payouts, spons, reservations, dayPnl] = await Promise.all([
      snap ? db.from("treasury_account_forecasts").select("account_id,person_id,stage,p_graduate,expected_days,payout_if_graduate,expected_payout,mu_mean,trades")
        .eq("snapshot_id", snap.id).order("expected_payout", { ascending: false }).limit(25) : Promise.resolve({ data: [] }),
      db.from("ab_trader_profiles").select("book_state"),
      db.from("ab_lifecycle_events").select("person_id,from_state,to_state,reason,created_at").order("created_at", { ascending: false }).limit(20),
      db.from("ab_risk_limits").select("*"),
      db.from("ab_settings").select("book_halt,starting_reserve_usd,payout_model,sponsor_fee_usd,sl_deadline_seconds").maybeSingle(),
      db.from("ladder_settings").select("*").maybeSingle(),
      db.from("ladder_accounts").select("id,label,size_usd,fee_usd,status,signal_group,platform,environment,server,account_id,execution_enabled,purchased_at"),
      db.from("ladder_recommendations").select("*").order("as_of", { ascending: false }).limit(1).maybeSingle(),
      db.from("ladder_payouts").select("id,ladder_account_id,amount_usd,received_at,note").order("received_at", { ascending: false }).limit(20),
      db.from("graduate_sponsorships").select("id,account_id,user_id,status,fee_usd,note,created_at").order("created_at", { ascending: false }).limit(50),
      db.from("ab_risk_reservations").select("book,risk_usd").eq("status", "active"),
      db.from("book_daily_pnl").select("book,day,pnl_usd").eq("day", new Date().toISOString().slice(0, 10)),
    ]);
    const counts: Record<string, number> = {};
    for (const r of states.data ?? []) counts[r.book_state] = (counts[r.book_state] ?? 0) + 1;
    const names = new Map<string, string>();
    const ids = [...new Set([...(spons.data ?? []).map((s) => s.user_id), ...(forecasts.data ?? []).map((f) => f.person_id)])];
    if (ids.length) { const { data } = await db.from("user_profiles").select("user_id,full_name").in("user_id", ids); for (const p of data ?? []) names.set(p.user_id, p.full_name); }
    const openRisk: Record<string, number> = {};
    for (const r of reservations.data ?? []) openRisk[r.book] = (openRisk[r.book] ?? 0) + Number(r.risk_usd);
    return json({ ok: true, snapshot: snap, forecasts: (forecasts.data ?? []).map((f) => ({ ...f, name: names.get(f.person_id) ?? null })),
      book_states: counts, events: events.data ?? [], limits: limits.data ?? [], settings: settings.data, ladder_settings: ls.data,
      ladder_accounts: ladders.data ?? [], recommendation: rec.data, payouts: payouts.data ?? [],
      sponsorships: (spons.data ?? []).map((s) => ({ ...s, name: names.get(s.user_id) ?? null })), open_risk: openRisk, day_pnl: dayPnl.data ?? [] });
  }
  if (action === "set_reserve") {
    const usd = Number(body.usd);
    if (!(usd >= 0) || usd > 100_000_000) return json({ ok: false, error: "Enter a reserve amount in USD" }, 400);
    await db.from("ab_settings").update({ starting_reserve_usd: usd, updated_at: new Date().toISOString() }).eq("singleton", true);
    await audit("treasury_set_reserve", { usd });
    return json({ ok: true });
  }
  if (action === "halt") {
    const on = body.on === true;
    await db.from("ab_settings").update({ book_halt: on, updated_at: new Date().toISOString() }).eq("singleton", true);
    await audit("ab_book_halt", { on });
    return json({ ok: true, book_halt: on });
  }
  if (action === "ladder_add") {
    const label = String(body.label || "").trim().slice(0, 80), size = Number(body.size_usd), fee = Number(body.fee_usd ?? 0), group = Math.max(0, Math.floor(Number(body.signal_group ?? 0)));
    const email = String(body.email || "").trim(), password = String(body.password || ""), server = String(body.server || "").trim(), wanted = String(body.account_id || "").trim();
    if (!label || !(size > 0) || !(fee >= 0) || !email || !password || !server) return json({ ok: false, error: "Label, size, fee, broker email, password and server are required" }, 400);
    const key = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
    if (!key) return json({ ok: false, error: "Token encryption unavailable" }, 503);
    try {
      const tok = await authenticate(email, password, server);
      const list = await accounts(tok.accessToken);
      const acc = wanted ? list.find((a) => String(a.id ?? a.accountId) === wanted) : (list.length === 1 ? list[0] : null);
      if (!acc) return json({ ok: false, error: "Enter the account number shown after # (several accounts found)" }, 400);
      const accountId = String(acc.id ?? acc.accountId), accNum = String(acc.accNum ?? "");
      const map = (await instruments(tok.accessToken, accountId, accNum)).map((row) => ({
        symbol: String(row.name ?? row.symbol ?? "").trim().toUpperCase(), tradable_instrument_id: String(row.tradableInstrumentId ?? row.id ?? ""),
        trade_route_id: tradeRoute(row), min_qty: Number(row.minQty ?? row.minLot ?? 0.01), lot_step: Number(row.qtyStep ?? row.lotStep ?? 0.01),
      })).filter((r) => r.symbol && r.trade_route_id != null);
      const { data: row, error } = await db.from("ladder_accounts").insert({
        label, size_usd: size, fee_usd: fee, signal_group: group, server, account_id: accountId, acc_num: accNum,
        access_token_ciphertext: await encryptSecret(tok.accessToken, key), refresh_token_ciphertext: await encryptSecret(tok.refreshToken, key),
        access_expires_at: jwtExpiresAt(tok.accessToken), instrument_map: map, execution_enabled: false,
      }).select("id").single();
      if (error || !row) return json({ ok: false, error: "Could not save the account" }, 503);
      await audit("ladder_account_add", { id: row.id, label, size_usd: size, fee_usd: fee, signal_group: group, instruments: map.length });
      return json({ ok: true, id: row.id, instruments: map.length, execution_enabled: false });
    } catch (_) { return json({ ok: false, error: "The broker rejected the login or the account could not be read" }, 400); }
  }
  if (action === "ladder_update") {
    const id = Number(body.id); const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.execution_enabled === "boolean") patch.execution_enabled = body.execution_enabled;
    if (["evaluation", "funded", "breached", "closed"].includes(String(body.status))) patch.status = body.status;
    if (!(id > 0) || Object.keys(patch).length < 2) return json({ ok: false, error: "Nothing to change" }, 400);
    await db.from("ladder_accounts").update(patch).eq("id", id);
    await audit("ladder_account_update", { id, ...patch });
    return json({ ok: true });
  }
  if (action === "payout_add") {
    const amount = Number(body.amount_usd), id = body.ladder_account_id == null ? null : Number(body.ladder_account_id);
    if (!(amount > 0)) return json({ ok: false, error: "Enter the amount received in USD" }, 400);
    await db.from("ladder_payouts").insert({ ladder_account_id: id, amount_usd: amount, note: String(body.note || "").slice(0, 200) || null });
    await audit("ladder_payout_add", { ladder_account_id: id, amount_usd: amount });
    return json({ ok: true });
  }
  if (action === "sponsorship_decide") {
    const id = Number(body.id), status = String(body.status);
    if (!(id > 0) || !["purchased", "declined", "pending"].includes(status)) return json({ ok: false, error: "Choose purchased or declined" }, 400);
    await db.from("graduate_sponsorships").update({ status, fee_usd: body.fee_usd == null ? null : Number(body.fee_usd), note: String(body.note || "").slice(0, 200) || null,
      decided_at: new Date().toISOString() }).eq("id", id);
    await audit("graduate_sponsorship_decide", { id, status });
    return json({ ok: true });
  }
  return json({ ok: false, error: "Unknown action" }, 400);
});
