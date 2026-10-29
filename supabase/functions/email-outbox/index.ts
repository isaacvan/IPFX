// email-outbox: sends lifecycle emails that were recorded as "queued" while no email provider was configured, and
// retries ones that failed because of the provider's rate limit. It never creates new emails: it only delivers rows
// that the platform itself already wrote to email_events, so calling it early cannot send anything that was not
// already due. A daily cap keeps total sending inside Resend's free plan (100 a day, shared with sign-up and
// password-reset emails), and a per-run cap spreads the batch across the day. Called hourly by pg_cron.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { emailShell, render } from "../_shared/lifecycle-email.ts";

const DAILY_CAP = Number(Deno.env.get("EMAIL_DAILY_CAP") ?? "80");
const PER_RUN = Number(Deno.env.get("EMAIL_PER_RUN") ?? "10");
const TEMPLATES = ["infinity_v2_launch", "infinity_approved", "infinity_monthly_restart", "infinity_breach_notice", "infinity_account_reinstated"];
// Emails that only make sense while the trader has an active Infinity account.
const NEEDS_ACTIVE = ["infinity_approved", "infinity_monthly_restart", "infinity_account_reinstated"];

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return json({ ok: false, error: "No email provider configured" }, 503);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { count: sentToday } = await db.from("email_events").select("id", { count: "exact", head: true })
    .eq("status", "sent").gte("sent_at", dayStart.toISOString());
  let budget = Math.min(PER_RUN, DAILY_CAP - (sentToday ?? 0));
  if (budget <= 0) return json({ ok: true, sent: 0, reason: "daily cap reached", sent_today: sentToday });

  const { data: rows, error } = await db.from("email_events")
    .select("id,user_id,template_key,status,error_message,payload,created_at")
    .in("template_key", TEMPLATES)
    .or("status.eq.queued,and(status.eq.failed,error_message.ilike.%rate%),and(status.eq.failed,error_message.ilike.%limit%)")
    .order("created_at", { ascending: true }).limit(500);
  if (error) return json({ ok: false, error: "outbox unavailable" }, 503);
  // Owner test messages first, then oldest first. Until the owner switches the outbox live (secret
  // EMAIL_OUTBOX_LIVE=1, set after the test emails were checked), only owner test messages are sent.
  const live = Deno.env.get("EMAIL_OUTBOX_LIVE") === "1";
  // Owner tests first, then time-sensitive notices (breach / restart), then the approval backlog; oldest first within each.
  // deno-lint-ignore no-explicit-any
  const rank = (r: any) => (r.payload?.test ? 3 : 0) + (r.template_key === "infinity_breach_notice" || r.template_key === "infinity_monthly_restart" || r.template_key === "infinity_account_reinstated" ? 2 : 0);
  // deno-lint-ignore no-explicit-any
  const list = (rows ?? []).filter((r: any) => live || r.payload?.test === true)
    // deno-lint-ignore no-explicit-any
    .sort((a: any, b: any) => rank(b) - rank(a));

  // deno-lint-ignore no-explicit-any
  const templates = new Map<string, any>();
  let sent = 0, failed = 0, skipped = 0;
  for (const row of list) {
    if (budget <= 0) break;
    // Claim the row so two overlapping runs can never send the same email twice.
    const { data: claimed } = await db.from("email_events").update({ status: "sending" })
      .eq("id", row.id).eq("status", row.status).select("id").maybeSingle();
    if (!claimed) continue;
    try {
      if (NEEDS_ACTIVE.includes(row.template_key) && !row.payload?.test) {
        const { count: active } = await db.from("trading_accounts").select("id", { count: "exact", head: true })
          .eq("user_id", row.user_id).eq("challenge_type", "infinity").eq("status", "active").is("access_revoked_at", null);
        if (!active) {
          await db.from("email_events").update({ status: "skipped", error_message: "Infinity account no longer active" }).eq("id", row.id);
          skipped++;
          continue;
        }
      }
      if (!templates.has(row.template_key)) {
        const { data: t } = await db.from("email_templates").select("*").eq("key", row.template_key).eq("is_active", true).maybeSingle();
        templates.set(row.template_key, t);
      }
      const tmpl = templates.get(row.template_key);
      const { data: au } = await db.auth.admin.getUserById(row.user_id);
      const to = au?.user?.email as string | undefined;
      if (!tmpl || !to) {
        await db.from("email_events").update({ status: "skipped", error_message: !tmpl ? "template inactive" : "no email address" }).eq("id", row.id);
        skipped++;
        continue;
      }
      const name = String(au!.user!.user_metadata?.full_name || to.split("@")[0]);
      const vars: Record<string, unknown> = { customer_name: name, ...(row.payload?.vars ?? {}) };
      const subject = render(tmpl.subject, vars);
      const html = emailShell(subject, tmpl.preheader, render(tmpl.body_html, vars, true));
      const text = render(tmpl.body_text, vars);
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json",
          "Idempotency-Key": `email-event-${row.id}`,
        },
        body: JSON.stringify({
          from: Deno.env.get("EMAIL_FROM") ?? "IPFX Capital <enquiries@ipfxcapital.com>",
          to, subject, html, text,
          reply_to: Deno.env.get("SUPPORT_EMAIL") ?? "enquiries@ipfxcapital.com",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        await db.from("email_events").update({
          status: "sent", to_email: to, subject, provider: "resend", provider_message_id: data?.id ?? null,
          error_message: null, sent_at: new Date().toISOString(),
        }).eq("id", row.id);
        sent++;
        budget--;
      } else {
        await db.from("email_events").update({
          status: "failed", to_email: to, subject, error_message: String(data?.message ?? `Resend ${res.status}`).slice(0, 500),
        }).eq("id", row.id);
        failed++;
        if (res.status === 429) break; // provider limit: stop this run, the next run retries
      }
    } catch (e) {
      await db.from("email_events").update({ status: "queued", error_message: "retry: " + String(e).slice(0, 200) }).eq("id", row.id);
    }
  }
  return json({ ok: true, live, sent, failed, skipped, sent_today: (sentToday ?? 0) + sent });
});
