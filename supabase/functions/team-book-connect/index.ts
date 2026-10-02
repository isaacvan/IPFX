// Owner/MFA-only TradeLocker credential exchange for the separate Team book
// screens. This function never creates mirror_targets or sends an order.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { allowRequest, readJsonObject } from "../_shared/request-guards.ts";
import { encryptSecret, jwtExpiresAt } from "../_shared/tradelocker-crypto.ts";
import { accounts, authenticate, instruments, tradeRoute } from "../_shared/tradelocker.ts";

const ORIGINS = new Set(["https://ipfxcapital.com", "https://www.ipfxcapital.com", "http://localhost:3000", "http://127.0.0.1:3000"]);
const json = (body: unknown, status: number, origin: string) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" },
});
function aal(token: string): string {
  try {
    const raw = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return String(JSON.parse(atob(raw + "=".repeat((4 - raw.length % 4) % 4))).aal ?? "");
  } catch (_) { return ""; }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "https://ipfxcapital.com";
  const allowedOrigin = ORIGINS.has(origin) ? origin : "https://ipfxcapital.com";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: {
    "Access-Control-Allow-Origin": allowedOrigin, "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin",
  } });
  if (req.method !== "POST" || !ORIGINS.has(origin)) return json({ ok: false, error: "Not allowed" }, 403, allowedOrigin);
  const authHeader = req.headers.get("authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "");
  const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await auth.auth.getUser();
  if (!user || aal(bearer) !== "aal2") return json({ ok: false, error: "Owner MFA session required" }, 401, allowedOrigin);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ownerEmail = String(Deno.env.get("IPFX_OWNER_EMAIL") || "paulade491@gmail.com").trim().toLowerCase();
  const { data: admin } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!admin || String(user.email || "").toLowerCase() !== ownerEmail) return json({ ok: false, error: "Owner access only" }, 403, allowedOrigin);
  if (!await allowRequest(db, "team-book-connect", user.id, 12, 60)) return json({ ok: false, error: "Too many connection attempts" }, 429, allowedOrigin);
  const body = await readJsonObject(req, 16_384).catch(() => null);
  if (!body) return json({ ok: false, error: "Invalid request" }, 400, allowedOrigin);
  const book = String(body.book || "");
  if (book !== "a" && book !== "b") return json({ ok: false, error: "Choose A-book or B-book" }, 400, allowedOrigin);
  const action = String(body.action || "status");

  if (action === "status") {
    const { data, error } = await db.from("team_book_destinations")
      .select("book,environment,server,account_id,acc_num,account_name,status,last_health_at,updated_at")
      .eq("book", book).maybeSingle();
    if (error) return json({ ok: false, error: "Book destination unavailable" }, 503, allowedOrigin);
    return json({ ok: true, destination: data, connected: data?.status === "connected",
      connect_all_enabled: false, execution_enabled: false }, 200, allowedOrigin);
  }
  if (action === "disconnect") {
    const { error } = await db.from("team_book_destinations").update({
      status: "disconnected", access_token_ciphertext: null, refresh_token_ciphertext: null,
      access_expires_at: null, updated_at: new Date().toISOString(),
    }).eq("book", book);
    if (error) return json({ ok: false, error: "Could not disconnect book destination" }, 503, allowedOrigin);
    await db.from("admin_audit_log").insert({ actor_id: user.id, action: "team_book_destination_disconnect", detail: { book } });
    return json({ ok: true, connected: false, execution_enabled: false }, 200, allowedOrigin);
  }
  if (action !== "connect") return json({ ok: false, error: "Unknown action" }, 400, allowedOrigin);
  if (body.environment !== "demo") return json({ ok: false, error: "Only TradeLocker demo-environment logins are available here" }, 400, allowedOrigin);
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  const server = String(body.server || "").trim();
  const requestedAccountId = String(body.account_id || "").trim();
  if (!email || !password || !server || (requestedAccountId && !/^[0-9]{1,20}$/.test(requestedAccountId)))
    return json({ ok: false, error: "Broker email, password and server are required; account ID must be numeric" }, 400, allowedOrigin);
  const encryptionKey = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
  if (!encryptionKey) return json({ ok: false, error: "Token encryption is unavailable" }, 503, allowedOrigin);
  try {
    const tokenSet = await authenticate(email, password, server);
    const accountRows = await accounts(tokenSet.accessToken);
    const account = requestedAccountId
      ? accountRows.find((row) => String(row.id ?? row.accountId) === requestedAccountId)
      : accountRows.length === 1 ? accountRows[0] : null;
    if (!account) return json({ ok: false, error: "Enter the exact account ID after # if TradeLocker returned multiple accounts" }, 400, allowedOrigin);
    const accountId = String(account.id ?? account.accountId ?? "");
    const accNum = String(account.accNum ?? "");
    if (!/^[0-9]{1,20}$/.test(accountId) || !/^[0-9]{1,10}$/.test(accNum))
      return json({ ok: false, error: "TradeLocker did not return a valid account ID and selector" }, 400, allowedOrigin);
    // Never mix reverse B-book orders with the existing same-direction copier.
    // The current demo is eligible after same-direction routes move to another account.
    const { data: shared, error: sharedError } = await db.from("tradelocker_demo_connections")
      .select("id").eq("environment", "demo").eq("status", "connected")
      .eq("tradelocker_account_id", accountId).limit(1);
    if (sharedError) return json({ ok: false, error: "Could not verify destination separation" }, 503, allowedOrigin);
    if (shared?.length) return json({ ok: false,
      error: "This HeroFX demo is still assigned to the same-direction copier. Move those routes to a replacement demo before connecting it for B-book." }, 409, allowedOrigin);
    const instrumentRows = await instruments(tokenSet.accessToken, accountId, accNum);
    const mapped = instrumentRows.map((row) => ({
      symbol: String(row.name ?? row.symbol ?? "").trim().toUpperCase(),
      tradable_instrument_id: String(row.tradableInstrumentId ?? row.id ?? ""),
      trade_route_id: tradeRoute(row),
      min_qty: Number(row.minQty ?? row.minLot ?? 0.01), lot_step: Number(row.qtyStep ?? row.lotStep ?? 0.01),
    })).filter((row) => row.symbol && /^[0-9]{1,20}$/.test(row.tradable_instrument_id) && row.trade_route_id != null);
    if (!mapped.length) return json({ ok: false, error: "TradeLocker returned no tradable instruments" }, 409, allowedOrigin);
    const values = {
      book, environment: "demo", broker: "tradelocker", server, account_id: accountId, acc_num: accNum,
      account_name: String(account.name ?? account.accountName ?? "TradeLocker demo").slice(0, 120),
      access_token_ciphertext: await encryptSecret(tokenSet.accessToken, encryptionKey),
      refresh_token_ciphertext: await encryptSecret(tokenSet.refreshToken, encryptionKey),
      access_expires_at: jwtExpiresAt(tokenSet.accessToken), instrument_map: mapped,
      status: "connected", last_health_at: new Date().toISOString(), created_by: user.id, updated_at: new Date().toISOString(),
    };
    const { error } = await db.from("team_book_destinations").upsert(values, { onConflict: "book" });
    if (error?.code === "23505") return json({ ok: false, error: "A-book and B-book must use separate TradeLocker accounts" }, 409, allowedOrigin);
    if (error) return json({ ok: false, error: "Could not save the protected destination" }, 503, allowedOrigin);
    await db.from("admin_audit_log").insert({ actor_id: user.id, action: "team_book_destination_connect",
      detail: { book, server, account_id_suffix: accountId.slice(-6), instruments: mapped.length, environment: "demo", execution_enabled: false } });
    return json({ ok: true, connected: true, account_name: values.account_name, instrument_count: mapped.length,
      execution_enabled: false, message: "TradeLocker account saved. No trades are armed." }, 200, allowedOrigin);
  } catch (error) {
    const code = String(error).split(":")[0].replace(/^Error:\s*/, "");
    console.error(JSON.stringify({ event: "team_book_connect_failed", book, code }));
    return json({ ok: false, error: "TradeLocker rejected the login or could not load this demo account. Check broker-issued credentials and exact server." }, 400, allowedOrigin);
  }
});
