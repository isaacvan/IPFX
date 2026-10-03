// Supabase Auth "before user created" hook (HTTP). Runs on every new sign-up, before the user exists.
// 1. Verifies the call really comes from Supabase Auth (Standard Webhooks signature).
// 2. Cloudflare Turnstile: when TURNSTILE_SECRET_KEY is set, the sign-up must carry a valid token
//    (signup.html sends it as user_metadata.captcha_token). Not set yet = this step is skipped.
// 3. Per-IP limit: at most SIGNUP_MAX_PER_IP_HOUR / SIGNUP_MAX_PER_IP_DAY new accounts (Terms 3.4).
// Logins, the desktop app and password resets are untouched: this only runs when a user is created.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

const ALLOWED_HOSTS = new Set(["ipfxcapital.com", "www.ipfxcapital.com"]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const reject = (message: string, code = 400) => json({ error: { http_code: code, message } }, 400);

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function turnstileOk(secret: string, token: string, ip: string | null): Promise<{ ok: boolean; why?: string }> {
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    if (!j.success) return { ok: false, why: "captcha_failed:" + String((j["error-codes"] ?? []).join(",")).slice(0, 60) };
    if (j.hostname && !ALLOWED_HOSTS.has(String(j.hostname))) return { ok: false, why: "captcha_wrong_host" };
    return { ok: true };
  } catch (_) {
    // Cloudflare unreachable: do not lock every new trader out. The IP limit still applies.
    return { ok: true, why: "captcha_unverified_network" };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const raw = await req.text();

  let payload: { metadata?: { ip_address?: string }; user?: { email?: string; user_metadata?: Record<string, unknown> } };
  const hookSecret = Deno.env.get("SIGNUP_HOOK_SECRET");
  try {
    payload = hookSecret
      ? new Webhook(hookSecret.replace("v1,whsec_", "")).verify(raw, Object.fromEntries(req.headers)) as typeof payload
      : JSON.parse(raw);
  } catch (_) {
    return json({ error: { http_code: 401, message: "Sign-up check failed. Please try again." } }, 401);
  }

  const ip = String(payload.metadata?.ip_address ?? "").trim() || null;
  const email = String(payload.user?.email ?? "").trim().toLowerCase();
  const meta = payload.user?.user_metadata ?? {};
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const emailHash = email ? await sha256(email) : null;

  // Bot check first, so automated attempts never count against a shared IP's allowance.
  const tsSecret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (tsSecret) {
    const token = typeof meta.captcha_token === "string" ? meta.captcha_token : "";
    const check = token ? await turnstileOk(tsSecret, token, ip) : { ok: false, why: "captcha_missing" };
    if (!check.ok) {
      await db.from("signup_guard_log").insert({ ip, email_hash: emailHash, outcome: "rejected", reason: check.why });
      return reject("Please complete the security check on the sign-up page and try again.");
    }
  }

  const perHour = Number(Deno.env.get("SIGNUP_MAX_PER_IP_HOUR") ?? 5);
  const perDay = Number(Deno.env.get("SIGNUP_MAX_PER_IP_DAY") ?? 15);
  const { data: verdict, error } = await db.rpc("signup_guard_check", { p_ip: ip, p_email_hash: emailHash, p_per_hour: perHour, p_per_day: perDay });
  if (error) {
    // Ledger unavailable: allow rather than block every sign-up, and say so in the logs.
    console.error(JSON.stringify({ event: "signup_guard_db_error", error: error.message }));
    return json({});
  }
  if (verdict) {
    return reject("Too many accounts have been created from this network recently. Each person may hold one IPFX account (Terms 3.4). If this is a mistake, contact enquiries@ipfxcapital.com.", 429);
  }
  return json({});
});
