// Self-service account deletion (27 Nov 2026).
//   request  (trader, signed in): type DELETE -> trading stops, email with a cancel link, erase in 7 days
//   cancel   (public, token from the email): restores the accounts that were open
//   process  (hourly cron, x-cron-secret): erases due requests, or marks them blocked and alerts the owner
// Deployed with --no-verify-jwt: each action checks its own credentials.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendEmail } from "../_shared/mail-provider.mjs";
import { render, emailShell } from "../_shared/lifecycle-email.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://ipfxcapital.com",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const MESSAGES: Record<string, string> = {
  CLOSE_OPEN_POSITIONS_FIRST: "Close your open trades first, then delete your account.",
  CANCEL_PENDING_ORDERS_FIRST: "Cancel your pending orders first, then delete your account.",
  PAYOUT_IN_PROGRESS: "You have a payout in progress. Once it is paid you can delete your account.",
  DELETION_REQUEST_NOT_FOUND: "This link is not valid. If your account still exists, sign in and check its status.",
  ALREADY_ERASED: "This account has already been deleted.",
};
const clean = (m: string) => MESSAGES[String(m).split(":")[0].trim()] ?? "Something went wrong. Nothing was changed. Please try again or contact us.";
export const SITE = "https://ipfxcapital.com";

async function mail(db: any, env: Record<string, string>, key: string, to: string, vars: Record<string, unknown>) {
  const { data: t } = await db.from("email_templates").select("*").eq("key", key).eq("is_active", true).maybeSingle();
  if (!t) return { ok: false, error: "template missing" };
  const subject = render(t.subject, vars);
  return await sendEmail({
    from: env.EMAIL_FROM ?? "IPFX Capital <enquiries@ipfxcapital.com>", to, subject,
    html: emailShell(subject, t.preheader, render(t.body_html, vars, true)), text: render(t.body_text, vars),
    replyTo: env.SUPPORT_EMAIL ?? "enquiries@ipfxcapital.com", tags: { template: key },
  }, env);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const env = Deno.env.toObject();
  const db = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request" }, 400); }

  if (body.action === "request") {
    const auth = createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await auth.auth.getUser();
    if (!user) return json({ ok: false, error: "Please sign in again." }, 401);
    if (String(body.confirm ?? "").trim().toUpperCase() !== "DELETE") return json({ ok: false, error: "Type DELETE to confirm." }, 400);
    const { data, error } = await db.rpc("fn_request_account_deletion", { p_user: user.id });
    if (error) return json({ ok: false, error: clean(error.message) }, 409);
    const eraseDate = new Date(data.erase_after).toUTCString().slice(0, 16);
    if (!data.already_requested && user.email) {
      await mail(db, env, "account_deletion_scheduled", user.email, {
        customer_name: String(user.user_metadata?.full_name || user.email.split("@")[0]),
        erase_date: eraseDate, cancel_url: `${SITE}/delete-account.html?cancel=${data.cancel_token}`,
      });
    }
    return json({ ok: true, erase_after: data.erase_after, erase_date: eraseDate, already_requested: !!data.already_requested });
  }

  if (body.action === "cancel") {
    const token = String(body.token ?? "");
    if (!/^[0-9a-f]{64}$/.test(token)) return json({ ok: false, error: clean("DELETION_REQUEST_NOT_FOUND") }, 400);
    const { error } = await db.rpc("fn_cancel_account_deletion", { p_token: token });
    if (error) return json({ ok: false, error: clean(error.message) }, 409);
    return json({ ok: true });
  }

  if (body.action === "process") {
    if (!env.CRON_SECRET || req.headers.get("x-cron-secret") !== env.CRON_SECRET) return json({ ok: false, error: "unauthorized" }, 401);
    const { data: due } = await db.from("account_deletion_requests").select("*").in("status", ["scheduled", "blocked"])
      .lte("erase_after", new Date().toISOString()).order("erase_after").limit(5);
    const done: unknown[] = [];
    for (const r of due ?? []) {
      const { data: blockers } = await db.rpc("fn_account_deletion_blockers", { p_user: r.user_id });
      if ((blockers ?? []).length) {
        await db.from("account_deletion_requests").update({ status: "blocked", blocked_reason: (blockers as string[]).join(",") }).eq("id", r.id);
        await db.from("ab_alerts").upsert({ key: `account_deletion_blocked:${r.id}`, severity: "warning", category: "trader", person_id: r.user_id,
          title: "Account deletion waiting: " + (blockers as string[]).join(", ").toLowerCase().replaceAll("_", " "),
          detail: "A trader asked to delete their account. It will be erased automatically once this clears; the legal deadline is one month from the request.",
          last_seen: new Date().toISOString() }, { onConflict: "key" });
        done.push({ id: r.id, blocked: blockers });
        continue;
      }
      // identity documents first (storage API; direct SQL deletes are not allowed)
      const files: string[] = [];
      for (let page = 0; page < 20; page++) {
        const { data: list } = await db.storage.from("kyc-documents").list(r.user_id, { limit: 100, offset: page * 100 });
        if (!list?.length) break;
        files.push(...list.map((f: { name: string }) => `${r.user_id}/${f.name}`));
        if (list.length < 100) break;
      }
      if (files.length) {
        const { error: rmErr } = await db.storage.from("kyc-documents").remove(files);
        if (rmErr) { done.push({ id: r.id, error: "storage" }); continue; }
      }
      const { data: er, error: eErr } = await db.rpc("fn_gdpr_erase_user", { p_user: r.user_id, p_actor: r.user_id });
      if (eErr) { done.push({ id: r.id, error: "erase" }); continue; }
      if (er?.email && !String(er.email).endsWith("@deleted.invalid")) {
        await mail(db, env, "data_erasure_confirmation", er.email, { customer_name: er.name || String(er.email).split("@")[0] });
      }
      const { error: sErr } = await db.rpc("fn_gdpr_scrub_auth", { p_user: r.user_id, p_actor: r.user_id });
      if (sErr) { done.push({ id: r.id, error: "scrub" }); continue; }
      await db.from("ab_alerts").update({ resolved_at: new Date().toISOString() }).eq("key", `account_deletion_blocked:${r.id}`);
      done.push({ id: r.id, erased: true, files: files.length });
    }
    return json({ ok: true, processed: done });
  }
  return json({ ok: false, error: "Unknown action" }, 400);
});
