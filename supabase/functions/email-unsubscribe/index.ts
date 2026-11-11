// email-unsubscribe: public endpoint behind the "Unsubscribe" link and the one-click header (RFC 8058).
//   GET  ?t=<token>  -> checks the token, returns the masked address (changes nothing, so link scanners are harmless)
//   POST ?t=<token>  -> adds the address to email_suppressions. Mail apps POST "List-Unsubscribe=One-Click" here.
// Deployed with --no-verify-jwt. The signed token (address + HMAC with EMAIL_UNSUB_SECRET) is the only credential.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { normEmail, verifyUnsubToken } from "../_shared/email-suppression.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...cors } });
const mask = (e: string) => e.replace(/^(.).*(@.*)$/, (_m, a, b) => `${a}***${b}`);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const secret = Deno.env.get("EMAIL_UNSUB_SECRET");
  if (!secret) return json({ ok: false, error: "not configured" }, 503);
  const url = new URL(req.url);
  let token = url.searchParams.get("t");
  if (!token && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    token = form ? String(form.get("t") ?? "") : null;
  }
  const email = await verifyUnsubToken(token, secret);
  if (!email) return json({ ok: false, error: "This unsubscribe link is not valid." }, 400);
  if (req.method === "GET") return json({ ok: true, email: mask(email) });
  if (req.method !== "POST") return json({ ok: false, error: "GET or POST only" }, 405);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // Never downgrade a harder reason (bounce, complaint) to a plain unsubscribe.
  const { error } = await db.from("email_suppressions").upsert(
    { email: normEmail(email), reason: "unsubscribe", source: url.searchParams.has("t") ? "link" : "form" },
    { onConflict: "email", ignoreDuplicates: true },
  );
  if (error) return json({ ok: false, error: "Could not save this right now. Please try again." }, 503);
  return json({ ok: true, email: mask(email) });
});
