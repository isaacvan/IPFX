// Traders connect their own broker TradeLocker DEMO account to a broker-demo challenge (option 3 venue).
// actions: status | connect | disconnect. Broker passwords are used once to obtain tokens and never stored;
// tokens are stored encrypted and never returned to the browser.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { allowRequest, readJsonObject } from "../_shared/request-guards.ts";
import { encryptSecret, jwtExpiresAt } from "../_shared/tradelocker-crypto.ts";
import { accounts, authenticate } from "../_shared/tradelocker.ts";
import { instrumentNames, readAccount } from "../_shared/venue-tradelocker.ts";

const ORIGINS = new Set(["https://ipfxcapital.com", "https://www.ipfxcapital.com", "http://localhost:8127", "http://localhost:3000"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "https://ipfxcapital.com";
  const cors = {
    "Access-Control-Allow-Origin": ORIGINS.has(origin) ? origin : "https://ipfxcapital.com",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin",
  };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST" || !ORIGINS.has(origin)) return json({ ok: false, error: "Not allowed" }, 403);

  const authHeader = req.headers.get("authorization") || "";
  const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return json({ ok: false, error: "Sign in first" }, 401);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (!await allowRequest(db, "venue-connect", user.id, 20, 60)) return json({ ok: false, error: "Too many attempts — please wait a few minutes." }, 429);
  const body = await readJsonObject(req, 16_384).catch(() => null);
  if (!body) return json({ ok: false, error: "Invalid request" }, 400);
  const action = String(body.action || "status");

  const { data: cfg } = await db.from("platform_config").select("challenge_venue,venue_broker_server").eq("id", true).maybeSingle();

  if (action === "status") {
    const { data: accts } = await db.from("trading_accounts").select("id,label,starting_balance,status,venue")
      .eq("user_id", user.id).eq("venue", "tradelocker_demo").is("access_revoked_at", null)
      .order("created_at", { ascending: false }).limit(20);
    const ids = (accts ?? []).map((a) => a.id);
    const { data: conns } = ids.length
      ? await db.from("venue_connections").select("trading_account_id,server,tradelocker_account_id,account_name,status,last_sync_at,last_error,broker_balance,broker_equity,connected_at").in("trading_account_id", ids)
      : { data: [] };
    return json({ ok: true, enabled: cfg?.challenge_venue === "tradelocker_demo", broker_server: cfg?.venue_broker_server ?? null, accounts: accts ?? [], connections: conns ?? [] });
  }

  const accountId = String(body.trading_account_id || "");
  if (!UUID.test(accountId)) return json({ ok: false, error: "Choose the challenge to connect" }, 400);
  const { data: acct } = await db.from("trading_accounts").select("id,user_id,status,venue,starting_balance,access_revoked_at").eq("id", accountId).eq("user_id", user.id).maybeSingle();
  if (!acct) return json({ ok: false, error: "Challenge not found" }, 404);
  if (acct.venue !== "tradelocker_demo") return json({ ok: false, error: "This challenge is traded on IPFX Markets" }, 409);

  if (action === "disconnect") {
    await db.from("venue_connections").update({ status: "disconnected", updated_at: new Date().toISOString() }).eq("trading_account_id", acct.id);
    return json({ ok: true, disconnected: true });
  }
  if (action !== "connect") return json({ ok: false, error: "Unknown action" }, 400);
  if (acct.access_revoked_at) return json({ ok: false, error: "This prelaunch account is archived; wait for a fresh challenge account" }, 409);
  if (cfg?.challenge_venue !== "tradelocker_demo") return json({ ok: false, error: "Broker-demo challenges are not open yet" }, 409);
  if (acct.status !== "active") return json({ ok: false, error: "This challenge is not active" }, 409);
  const { data: existing } = await db.from("venue_connections").select("id,status").eq("trading_account_id", acct.id).maybeSingle();
  if (existing && existing.status === "connected") return json({ ok: false, error: "This challenge is already connected" }, 409);

  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  const server = String(body.server || cfg?.venue_broker_server || "").trim();
  const wantedId = String(body.tradelocker_account_id || "").trim();
  if (!email || !password || !server) return json({ ok: false, error: "Enter your broker demo login email, password and server" }, 400);
  const key = Deno.env.get("TRADELOCKER_TOKEN_ENCRYPTION_KEY");
  if (!key) return json({ ok: false, error: "Connections are temporarily unavailable" }, 503);

  let stage = "login";
  try {
    const tok = await authenticate(email, password, server);
    stage = "account";
    const list = await accounts(tok.accessToken);
    const account = wantedId ? list.find((a) => String(a.id ?? a.accountId) === wantedId) : (list.length === 1 ? list[0] : null);
    if (!account) return json({ ok: false, error: wantedId ? "That account number was not found for this login" : "Several accounts found — enter the account number (shown after #)" }, 400);
    const accId = String(account.id ?? account.accountId), accNum = String(account.accNum ?? "");
    stage = "read";
    const snap = await readAccount(tok.accessToken, accId, accNum);
    const start = Number(acct.starting_balance);
    if (snap.positions.length) return json({ ok: false, error: "Close all open positions on the demo account before connecting" }, 409);
    if (Math.abs(snap.balance - start) > start * 0.01) {
      return json({ ok: false, error: `The demo balance must be $${start.toLocaleString("en-US")} (it is $${snap.balance.toLocaleString("en-US")}). Open a new demo with that balance.` }, 409);
    }
    // One broker demo account can back only one IPFX challenge.
    const { data: dupe } = await db.from("venue_connections").select("id").eq("tradelocker_account_id", Number(accId)).eq("status", "connected").neq("trading_account_id", acct.id).maybeSingle();
    if (dupe) return json({ ok: false, error: "That demo account is already connected to another challenge" }, 409);
    const names = await instrumentNames(tok.accessToken, accId, accNum);
    const row = {
      user_id: user.id, trading_account_id: acct.id, server, tradelocker_account_id: Number(accId), acc_num: Number(accNum),
      account_name: String(account.name ?? account.accountName ?? "Demo").slice(0, 120),
      access_token_ciphertext: await encryptSecret(tok.accessToken, key), refresh_token_ciphertext: await encryptSecret(tok.refreshToken, key),
      access_expires_at: jwtExpiresAt(tok.accessToken), baseline_balance: snap.balance, connected_at: new Date().toISOString(),
      status: "connected", last_error: null, broker_balance: snap.balance, broker_equity: snap.equity, instrument_names: names,
      updated_at: new Date().toISOString(),
    };
    const { error } = await db.from("venue_connections").upsert(row, { onConflict: "trading_account_id" });
    if (error) throw new Error("SAVE_FAILED");
    return json({ ok: true, connected: true, account_name: row.account_name, balance: snap.balance });
  } catch (e) {
    const msg = stage === "login"
      ? "The broker rejected that login. Use your broker demo email, password and the exact server name."
      : "Connected to the broker, but the demo account could not be read. Please try again.";
    console.error(JSON.stringify({ event: "venue_connect_failed", stage, code: String(e).slice(0, 100) }));
    return json({ ok: false, error: msg, stage }, 400);
  }
});
