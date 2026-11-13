// email-outbox: sends lifecycle emails that were recorded as "queued" while no email provider was configured, and
// retries ones that failed because of the provider's rate limit. It never creates new emails: it only delivers rows
// that the platform itself already wrote to email_events, so calling it early cannot send anything that was not
// already due. Sends through Amazon SES when the AWS keys are set (about $0.10 per 1,000, caps default high), otherwise
// Resend (free plan is 100 a day, shared with sign-up and password-reset emails, so the caps default to 80 a day and
// 10 a run). Marketing emails carry a signed unsubscribe link and the one-click header, and nothing is sent to an
// address on the do-not-email list. Called every 5 minutes by pg_cron.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { emailShell, render } from "../_shared/lifecycle-email.ts";
import { pickProvider, sendEmail } from "../_shared/mail-provider.mjs";
import { blockedBySuppression, isMarketing, normEmail, unsubscribeLinks } from "../_shared/email-suppression.mjs";

const TEMPLATES = ["infinity_v2_launch", "infinity_comeback", "infinity_monthly_restart_v2", "infinity_approved_v2", "infinity_approved", "infinity_monthly_restart", "infinity_breach_notice", "infinity_account_reinstated", "infinity_stop_rule_restart"];
// Emails that only make sense while the trader has an active Infinity account.
const NEEDS_ACTIVE = ["infinity_approved_v2", "infinity_monthly_restart_v2", "infinity_approved", "infinity_monthly_restart", "infinity_account_reinstated"];

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const env = Deno.env.toObject();
  const provider = pickProvider(env);
  if (!provider) return json({ ok: false, error: "No email provider configured" }, 503);
  const DAILY_CAP = Number(env.EMAIL_DAILY_CAP ?? (provider === "ses" ? "5000" : "80"));
  const PER_RUN = Number(env.EMAIL_PER_RUN ?? (provider === "ses" ? "60" : "10"));
  const unsubSecret = env.EMAIL_UNSUB_SECRET;
  const startedAt = Date.now();
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { count: sentToday } = await db.from("email_events").select("id", { count: "exact", head: true })
    .eq("status", "sent").eq("provider", provider).gte("sent_at", dayStart.toISOString());
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
  const rank = (r: any) => (r.payload?.test ? 3 : 0) + (r.template_key === "infinity_breach_notice" || r.template_key === "infinity_monthly_restart" || r.template_key === "infinity_monthly_restart_v2" || r.template_key === "infinity_account_reinstated" || r.template_key === "infinity_stop_rule_restart" ? 2 : 0 - (r.template_key === "infinity_comeback" ? 1 : 0));
  // deno-lint-ignore no-explicit-any
  // Marketing emails wait until the unsubscribe secret is set, so none ever goes out without a working opt-out.
  const list = (rows ?? []).filter((r: any) => live || r.payload?.test === true)
    // deno-lint-ignore no-explicit-any
    .filter((r: any) => unsubSecret || !isMarketing(r.template_key))
    // deno-lint-ignore no-explicit-any
    .sort((a: any, b: any) => rank(b) - rank(a));

  // deno-lint-ignore no-explicit-any
  const templates = new Map<string, any>();
  let sent = 0, failed = 0, skipped = 0;
  for (const row of list) {
    if (budget <= 0 || Date.now() - startedAt > 100_000) break;
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
      const { data: sup } = await db.from("email_suppressions").select("reason").eq("email", normEmail(to)).maybeSingle();
      if (blockedBySuppression(row.template_key, sup?.reason) && !row.payload?.test) {
        await db.from("email_events").update({ status: "skipped", to_email: to, error_message: `On the do-not-email list (${sup?.reason})` }).eq("id", row.id);
        skipped++;
        continue;
      }
      const name = String(au!.user!.user_metadata?.full_name || to.split("@")[0]);
      const vars: Record<string, unknown> = { customer_name: name, ...(row.payload?.vars ?? {}) };
      let extraHeaders: Record<string, string> | undefined;
      if (isMarketing(row.template_key)) {
        const links = await unsubscribeLinks(to, unsubSecret);
        vars.unsubscribe_link = links.page;
        extraHeaders = { "List-Unsubscribe": `<${links.oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
      }
      if (row.template_key === "infinity_v2_launch") {
        vars.first_name = name.trim().split(/\s+/)[0];
        const valid = ["rules_page_url", "terms_url", "unsubscribe_link"].every(k => {
          try { return new URL(String(vars[k] ?? "")).protocol === "https:"; } catch { return false; }
        });
        if (!valid) {
          await db.from("email_events").update({status:"skipped",error_message:"Launch rules, terms and recipient unsubscribe HTTPS links are required"}).eq("id",row.id);
          skipped++;continue;
        }
      }
      if (row.template_key === "infinity_comeback") {
        // Full-page marketing email: needs the recipient's first name and working rules, terms and app links, and is sent without the shell.
        vars.first_name = name.trim().split(/\s+/)[0];
        const valid = ["rules_page_url", "terms_url", "trading_url", "unsubscribe_link"].every(k => {
          try { return new URL(String(vars[k] ?? "")).protocol === "https:"; } catch { return false; }
        });
        if (!valid) {
          await db.from("email_events").update({status:"skipped",error_message:"Come-back email needs https rules, terms, app and unsubscribe links"}).eq("id",row.id);
          skipped++;continue;
        }
      }
      const subject = render(tmpl.subject, vars);
      const html = row.template_key === "infinity_v2_launch" || row.template_key === "infinity_comeback" ? render(tmpl.body_html,vars,true) : emailShell(subject, tmpl.preheader, render(tmpl.body_html, vars, true));
      const text = render(tmpl.body_text, vars);
      const result = await sendEmail({
        from: env.EMAIL_FROM ?? "IPFX Capital <enquiries@ipfxcapital.com>",
        to, subject, html, text,
        replyTo: env.SUPPORT_EMAIL ?? "enquiries@ipfxcapital.com",
        headers: extraHeaders,
        idempotencyKey: `email-event-${row.id}`,
        tags: { template: row.template_key },
      }, env);
      if (result.ok) {
        await db.from("email_events").update({
          status: "sent", to_email: to, subject, provider: result.provider, provider_message_id: result.id ?? null,
          error_message: null, sent_at: new Date().toISOString(),
        }).eq("id", row.id);
        sent++;
        budget--;
      } else {
        await db.from("email_events").update({
          status: "failed", to_email: to, subject, error_message: String(result.error ?? "send failed").slice(0, 500),
        }).eq("id", row.id);
        failed++;
        if (result.retryable) break; // provider limit: stop this run, the next run retries
      }
    } catch (e) {
      await db.from("email_events").update({ status: "queued", error_message: "retry: " + String(e).slice(0, 200) }).eq("id", row.id);
    }
  }
  return json({ ok: true, live, provider, sent, failed, skipped, sent_today: (sentToday ?? 0) + sent });
});
