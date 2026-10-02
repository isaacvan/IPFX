// Narrow, read-only Team population view. No payout, routing or trading actions.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { allowRequest } from "../_shared/request-guards.ts";

const ORIGINS = new Set(["https://ipfxcapital.com", "https://www.ipfxcapital.com", "http://localhost:3000", "http://127.0.0.1:3000"]);
function response(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS", "Vary": "Origin", "Cache-Control": "no-store" } });
}
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
    "Access-Control-Allow-Methods": "GET, OPTIONS", "Vary": "Origin" } });
  if (req.method !== "GET" || !ORIGINS.has(origin)) return response({ ok: false, error: "Not allowed" }, 403, allowedOrigin);
  const authorization = req.headers.get("authorization") || "";
  const bearer = authorization.replace(/^Bearer\s+/i, "");
  const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await auth.auth.getUser();
  if (authError || !user || aal(bearer) !== "aal2") return response({ ok: false, error: "Owner MFA session required" }, 401, allowedOrigin);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ownerEmail = String(Deno.env.get("IPFX_OWNER_EMAIL") || "paulade491@gmail.com").trim().toLowerCase();
  const { data: admin, error: adminError } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (adminError || !admin || String(user.email || "").toLowerCase() !== ownerEmail)
    return response({ ok: false, error: "Owner access only" }, 403, allowedOrigin);
  try {
    if (!await allowRequest(db, "team-population", user.id, 30, 60))
      return response({ ok: false, error: "Refresh limit reached" }, 429, allowedOrigin);
    const accounts: Array<Record<string, unknown>> = [];
    const profiles: Array<Record<string, unknown>> = [];
    const users: Array<{ id: string; email?: string; created_at?: string; user_metadata?: Record<string, unknown> }> = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.from("trading_accounts")
        .select("id,user_id,phase,label,status,created_at").order("created_at", { ascending: false }).range(offset, offset + 999);
      if (error) throw error;
      accounts.push(...(data || []));
      if ((data || []).length < 1000) break;
    }
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.from("user_profiles").select("user_id,full_name").order("user_id").range(offset, offset + 999);
      if (error) throw error;
      profiles.push(...(data || []));
      if ((data || []).length < 1000) break;
    }
    for (let page = 1; ; page++) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      users.push(...data.users);
      if (data.users.length < 1000) break;
    }
    const profileName = new Map(profiles.map((p) => [String(p.user_id), String(p.full_name || "")]));
    const byId = new Map(users.map((u) => [u.id, u]));
    const hasAccount = new Set(accounts.map((a) => String(a.user_id)));
    const name = (id: string) => profileName.get(id) || String(byId.get(id)?.user_metadata?.full_name || "") || "Registered user";
    const demoAccounts = accounts.filter((a) => a.phase === "demo").map((a) => ({
      id: a.id, user_id: a.user_id, full_name: name(String(a.user_id)),
      email: byId.get(String(a.user_id))?.email || "", label: a.label || "Demo",
      status: a.status, created_at: a.created_at,
    }));
    const withoutAccount = users.filter((u) => !hasAccount.has(u.id)).map((u) => ({
      user_id: u.id, email: u.email || "", full_name: name(u.id), created_at: u.created_at,
    }));
    return response({ ok: true, calculated_at: new Date().toISOString(), registered_users_count: users.length,
      account_counts: { all: accounts.length, demo: demoAccounts.length, challenge: accounts.length - demoAccounts.length },
      demo_accounts: demoAccounts, registered_without_account: withoutAccount }, 200, allowedOrigin);
  } catch (error) {
    console.error(JSON.stringify({ event: "team_population_failed", code: String(error).slice(0, 100) }));
    return response({ ok: false, error: "Could not load current Team population" }, 503, allowedOrigin);
  }
});
