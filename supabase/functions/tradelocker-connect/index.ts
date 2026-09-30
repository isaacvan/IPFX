import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { allowRequest, readJsonObject } from "../_shared/request-guards.ts";
import { decryptSecret, encryptSecret, jwtExpiresAt } from "../_shared/tradelocker-crypto.ts";
import { accounts, authenticate, instruments, refresh, tradeRoute } from "../_shared/tradelocker.ts";

const ORIGINS = new Set(["https://ipfxcapital.com", "https://www.ipfxcapital.com", "http://localhost:3000", "http://127.0.0.1:3000"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200, origin = "https://ipfxcapital.com") => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ORIGINS.has(origin) ? origin : "https://ipfxcapital.com", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" } });

function aal(token: string): string {
  try { const raw = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); return String(JSON.parse(atob(raw + "=".repeat((4 - raw.length % 4) % 4))).aal ?? ""); } catch (_) { return ""; }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "https://ipfxcapital.com";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": ORIGINS.has(origin) ? origin : "https://ipfxcapital.com", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" } });
  if (req.method !== "POST" || !ORIGINS.has(origin)) return json({ ok: false, error: "Not allowed" }, 403, origin);
  const authHeader = req.headers.get("authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "");
  const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await auth.auth.getUser();
  if (!user || aal(bearer) !== "aal2") return json({ ok: false, error: "Owner MFA session required" }, 401, origin);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ownerEmail = String(Deno.env.get("IPFX_OWNER_EMAIL") || "paulade491@gmail.com").trim().toLowerCase();
  const { data: admin } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!admin || String(user.email || "").toLowerCase() !== ownerEmail) return json({ ok: false, error: "Owner access only" }, 403, origin);
  if (!await allowRequest(db, "tradelocker-connect", user.id, 12, 60)) return json({ ok: false, error: "Too many connection attempts" }, 429, origin);
  const body = await readJsonObject(req, 16_384).catch(() => null);
  if (!body) return json({ ok: false, error: "Invalid request" }, 400, origin);
  const action = String(body.action || "status");
  const sourceAccountId = String(body.source_account_id || "");
  const sourceUserId = String(body.source_user_id || "");
  if (!UUID.test(sourceAccountId) || !UUID.test(sourceUserId)) return json({ ok: false, error: "Valid trader and account are required" }, 400, origin);
  const { data: source } = await db.from("trading_accounts").select("id,user_id,status,mirror_enabled").eq("id", sourceAccountId).eq("user_id", sourceUserId).maybeSingle();
  if (!source) return json({ ok: false, error: "Source account not found" }, 404, origin);

  const status = async () => {
    const { data: currentSource } = await db.from("trading_accounts").select("mirror_enabled").eq("id", sourceAccountId).maybeSingle();
    const { data: target } = await db.from("mirror_targets").select("enabled,provider,environment,tradelocker_connection_id").eq("source_account_id", sourceAccountId).maybeSingle();
    const { data: connection } = target?.tradelocker_connection_id
      ? await db.from("tradelocker_demo_connections").select("id,environment,server,tradelocker_account_id,acc_num,account_name,status,last_health_at,last_error_code,updated_at").eq("id", target.tradelocker_connection_id).maybeSingle()
      : { data: null };
    const { data: shared } = await db.from("tradelocker_demo_connections").select("id,account_name,status").eq("created_by", user.id).eq("source_user_id", user.id).eq("status", "connected").order("created_at", { ascending: false }).limit(2);
    const { data: delivery } = await db.from("demo_mirror_outbox").select("id,source_trade_id,event,status,attempts,last_error,created_at,updated_at")
      .eq("source_account_id", sourceAccountId).order("id", { ascending: false }).limit(1).maybeSingle();
    const { data: brokerDelivery } = delivery
      ? await db.from("mirror_orders").select("event,status,error,latency_ms,provider_status,created_at")
        .eq("source_trade_id", delivery.source_trade_id).eq("event", delivery.event)
        .eq("provider", "tradelocker").order("created_at", { ascending: false }).limit(1).maybeSingle()
      : { data: null };
    const armed = target?.enabled === true && currentSource?.mirror_enabled === true && target.provider === "tradelocker" && target.environment === "demo" && connection?.status === "connected";
    return json({ ok: true, connection, connected: connection?.status === "connected", armed,
      delivery: delivery ?? null, broker_delivery: brokerDelivery ?? null, provider: target?.provider ?? null,
      shared_demo_ready: (shared ?? []).length === 1, shared_demo_name: (shared ?? []).length === 1 ? shared![0].account_name : null, owner_source: sourceUserId === user.id }, 200, origin);
  };
  if (action === "status") return status();
  if (action === "disconnect") {
    // Disarm only this trader. Other approved traders may share the destination.
    const { error: targetError } = await db.from("mirror_targets").update({ enabled: false, updated_at: new Date().toISOString() }).eq("source_account_id", sourceAccountId);
    const { error: sourceError } = await db.from("trading_accounts").update({ mirror_enabled: false }).eq("id", sourceAccountId);
    if (targetError || sourceError) return json({ ok: false, error: "Could not confirm disconnect; inspect the copier route" }, 503, origin);
    await db.from("admin_audit_log").insert({ actor_id: user.id, action: "tradelocker_demo_disconnect", target_user_id: sourceUserId, target_account_id: sourceAccountId });
    return status();
  }
  if (action === "approve") {
    // Registration adds a candidate, never an armed route. Only owner MFA can arm.
    if (!["active", "demo", "passed"].includes(source.status)) return json({ ok: false, error: "This trading account is not active" }, 409, origin);
    const { data: shared, error: sharedError } = await db.from("tradelocker_demo_connections")
      .select("id,environment,tradelocker_account_id,acc_num,account_name,status,access_token_ciphertext,refresh_token_ciphertext,access_expires_at")
      .eq("created_by", user.id).eq("source_user_id", user.id).eq("status", "connected").order("created_at", { ascending: false }).limit(2);
    if (sharedError || !shared?.length) return json({ ok: false, error: "Connect the owner TradeLocker demo once before approving traders" }, 409, origin);
    if (shared.length !== 1) return json({ ok: false, error: "Multiple owner demo destinations exist; choose one before approving traders" }, 409, origin);
    const connection = shared[0];
    if (connection.environment !== "demo") return json({ ok: false, error: "A demo destination is required" }, 409, origin);
    // A green badge must mean the broker still recognises this account.
    const encryptionKey = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
    if (!encryptionKey) return json({ ok: false, error: "Connector encryption is not configured" }, 503, origin);
    try {
      let accessToken = await decryptSecret(connection.access_token_ciphertext, encryptionKey);
      if (!connection.access_expires_at || new Date(connection.access_expires_at).getTime() - Date.now() < 30 * 60_000) {
        const next = await refresh(await decryptSecret(connection.refresh_token_ciphertext, encryptionKey));
        accessToken = next.accessToken;
        const { error: refreshError } = await db.from("tradelocker_demo_connections").update({
          access_token_ciphertext: await encryptSecret(next.accessToken, encryptionKey),
          refresh_token_ciphertext: await encryptSecret(next.refreshToken, encryptionKey),
          access_expires_at: jwtExpiresAt(next.accessToken), updated_at: new Date().toISOString(),
        }).eq("id", connection.id);
        if (refreshError) throw refreshError;
      }
      const available = await accounts(accessToken);
      if (!available.some((account) => String(account.accNum ?? "") === String(connection.acc_num))) throw new Error("DEMO_ACCOUNT_NOT_RETURNED");
      await db.from("tradelocker_demo_connections").update({ last_health_at: new Date().toISOString(), last_error_code: null }).eq("id", connection.id);
    } catch (error) {
      console.error(JSON.stringify({ event: "shared_demo_health_failed", connection_id: connection.id, code: String(error).slice(0, 100) }));
      return json({ ok: false, error: "Shared demo authentication needs repair; no new trader was connected" }, 409, origin);
    }
    const { data: mapped } = await db.from("tradelocker_instrument_map").select("id").eq("connection_id", connection.id).eq("enabled", true).limit(1);
    if (!mapped?.length) return json({ ok: false, error: "The shared demo has no active instrument mapping" }, 409, origin);
    const { data: existing, error: existingError } = await db.from("mirror_targets").select("id,source_account_id,provider").eq("user_id", sourceUserId).maybeSingle();
    if (existingError) return json({ ok: false, error: "Could not inspect existing copier route" }, 503, origin);
    if (existing && existing.source_account_id !== sourceAccountId) return json({ ok: false, error: "This trader already has another source account linked; review its open copies before changing accounts" }, 409, origin);
    if (existing && existing.provider !== "tradelocker") return json({ ok: false, error: "This trader already has a different copier destination" }, 409, origin);
    const targetValues = { user_id: sourceUserId, source_account_id: sourceAccountId, provider: "tradelocker", environment: "demo", tradelocker_connection_id: connection.id, metaapi_account_id: `tradelocker-demo:${connection.tradelocker_account_id}`, region: "demo", target_type: "prop_firm", firm_name: "TradeLocker Demo", volume_multiplier: 1, enabled: true, updated_at: new Date().toISOString() };
    const { error: targetError } = existing
      ? await db.from("mirror_targets").update(targetValues).eq("id", existing.id)
      : await db.from("mirror_targets").insert(targetValues);
    if (targetError) return json({ ok: false, error: "Could not approve this copier route" }, 503, origin);
    const { error: sourceError } = await db.from("trading_accounts").update({ mirror_enabled: true }).eq("id", sourceAccountId);
    if (sourceError) {
      await db.from("mirror_targets").update({ enabled: false }).eq("source_account_id", sourceAccountId);
      return json({ ok: false, error: "Could not arm source account" }, 503, origin);
    }
    const [{ data: verifiedTarget }, { data: verifiedSource }] = await Promise.all([
      db.from("mirror_targets").select("id,enabled,tradelocker_connection_id").eq("source_account_id", sourceAccountId).maybeSingle(),
      db.from("trading_accounts").select("mirror_enabled").eq("id", sourceAccountId).maybeSingle(),
    ]);
    if (verifiedTarget?.enabled !== true || verifiedTarget.tradelocker_connection_id !== connection.id || verifiedSource?.mirror_enabled !== true)
      return json({ ok: false, error: "Approval could not be verified; copier route may not be armed" }, 503, origin);
    await db.from("admin_audit_log").insert({ actor_id: user.id, action: "tradelocker_demo_approve", target_user_id: sourceUserId, target_account_id: sourceAccountId, detail: { destination_connection_id: connection.id, demo_only: true } });
    return json({ ok: true, connected: true, armed: true, account_name: connection.account_name, message: "Trader approved for the shared TradeLocker demo." }, 200, origin);
  }  if (action !== "connect") return json({ ok: false, error: "Unknown action" }, 400, origin);
  if (sourceUserId !== user.id) return json({ ok: false, error: "Broker credentials may only be set on the owner demo; use Approve for other traders" }, 403, origin);

  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  const server = String(body.server || "").trim();
  const requestedAccountId = String(body.tradelocker_account_id || body.acc_num || "").trim();
  if (!email || !password || !server || (requestedAccountId && !/^[0-9]{1,20}$/.test(requestedAccountId))) return json({ ok: false, error: "TradeLocker login, password and server are required; account ID is optional" }, 400, origin);
  const encryptionKey = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
  if (!encryptionKey) return json({ ok: false, error: "Connector encryption is not configured" }, 503, origin);

  let connectionStage = "authentication";
  let resolvedServer = server;
  try {
    let tokenSet;
    try {
      tokenSet = await authenticate(email, password, resolvedServer);
    } catch (firstError) {
      if (/^herofx$/i.test(server) && server !== "HeroFX") {
        resolvedServer = "HeroFX";
        tokenSet = await authenticate(email, password, resolvedServer);
      } else {
        throw firstError;
      }
    }
    connectionStage = "account_lookup";
    const accountRows = await accounts(tokenSet.accessToken);
    const account = requestedAccountId ? accountRows.find((row) => String(row.id ?? row.accountId) === requestedAccountId) : (accountRows.length === 1 ? accountRows[0] : null);
    const resolvedAccountId = account ? String(account.id ?? account.accountId) : "";
    const resolvedAccNum = account ? String(account.accNum ?? "") : "";
    if (!account) return json({ ok: false, error: requestedAccountId ? "That TradeLocker demo account was not returned for these credentials" : "TradeLocker returned multiple accounts. Enter the account ID shown after # for the HeroFX account." }, 400, origin);
    if (!/^[0-9]{1,10}$/.test(resolvedAccNum)) return json({ ok: false, error: "TradeLocker did not return an account selector for this demo account" }, 400, origin);
    connectionStage = "instrument_lookup";
    const instrumentRows = await instruments(tokenSet.accessToken, resolvedAccountId, resolvedAccNum);
    const usable = instrumentRows.map((row) => ({ row, routeId: tradeRoute(row), instrumentId: Number(row.tradableInstrumentId ?? row.id), symbol: String(row.name ?? row.symbol ?? "").trim().toUpperCase() })).filter((x) => x.symbol && x.routeId != null && Number.isFinite(x.instrumentId));
    if (!usable.length) return json({ ok: false, error: "No tradable instruments were returned by this demo account" }, 400, origin);
    const values = {
      source_user_id: sourceUserId, source_account_id: sourceAccountId, environment: "demo", server: resolvedServer,
      tradelocker_account_id: resolvedAccountId, acc_num: resolvedAccNum, account_name: String(account.name ?? account.accountName ?? "Demo").slice(0, 120),
      access_token_ciphertext: await encryptSecret(tokenSet.accessToken, encryptionKey), refresh_token_ciphertext: await encryptSecret(tokenSet.refreshToken, encryptionKey),
      access_expires_at: jwtExpiresAt(tokenSet.accessToken), status: "connected", last_health_at: new Date().toISOString(), last_error_code: null, created_by: user.id, updated_at: new Date().toISOString(),
    };
    const { data: connection, error } = await db.from("tradelocker_demo_connections").upsert(values, { onConflict: "source_account_id" }).select("id").single();
    if (error || !connection) throw new Error("CONNECTION_SAVE_FAILED");
    await db.from("tradelocker_instrument_map").delete().eq("connection_id", connection.id);
    await db.from("tradelocker_instrument_map").insert(usable.map((x) => ({ connection_id: connection.id, source_symbol: x.symbol, broker_symbol: x.symbol, tradable_instrument_id: x.instrumentId, trade_route_id: x.routeId, min_qty: Number(x.row.minQty ?? x.row.minLot ?? 0.01) || 0.01, lot_step: Number(x.row.qtyStep ?? x.row.lotStep ?? 0.01) || 0.01 })));
    const targetValues = { user_id: sourceUserId, source_account_id: sourceAccountId, provider: "tradelocker", environment: "demo", tradelocker_connection_id: connection.id, metaapi_account_id: `tradelocker-demo:${resolvedAccountId}`, region: "demo", target_type: "prop_firm", firm_name: "TradeLocker Demo", volume_multiplier: 1, enabled: true, updated_at: new Date().toISOString() };
    const { data: existing } = await db.from("mirror_targets").select("id").eq("user_id", sourceUserId).maybeSingle();
    if (existing) await db.from("mirror_targets").update(targetValues).eq("id", existing.id); else await db.from("mirror_targets").insert(targetValues);
    await db.from("trading_accounts").update({ mirror_enabled: true }).eq("id", sourceAccountId);
    await db.from("admin_audit_log").insert({ actor_id: user.id, action: "tradelocker_demo_connect", target_user_id: sourceUserId, target_account_id: sourceAccountId, detail: { server: resolvedServer, account_id: resolvedAccountId, acc_num: resolvedAccNum, instrument_count: usable.length, credentials_persisted: false, armed: false } });
    return json({ ok: true, connected: true, armed: true, instrument_count: usable.length, message: "Demo connected and ready for verified one-for-one demo mirroring." }, 200, origin);
  } catch (error) {
    const code = String(error).split(":")[0].replace(/^Error:\s*/, "");
    const httpStatus = Number(code.match(/TRADELOCKER_HTTP_(\d+)/)?.[1] || 0);
    console.error(JSON.stringify({ event: "tradelocker_connect_failed", account: sourceAccountId, stage: connectionStage, code }));
    await db.from("admin_audit_log").insert({ actor_id: user.id, action: "tradelocker_demo_connect_failed", target_user_id: sourceUserId, target_account_id: sourceAccountId, detail: { stage: connectionStage, code, server: resolvedServer, account_id_suffix: requestedAccountId.slice(-6) } });
    const message = connectionStage === "authentication"
      ? "TradeLocker login was rejected. Use the broker-issued login/email, password and exact server—not a Google, Apple, or TradeLocker Profile password."
      : connectionStage === "instrument_lookup"
      ? `TradeLocker login succeeded, but the account instruments could not be loaded${httpStatus ? ` (HTTP ${httpStatus})` : ""}.`
      : "TradeLocker login succeeded, but that account ID was not returned for these broker credentials.";
    return json({ ok: false, error: message, stage: connectionStage, code }, 400, origin);
  }
});
