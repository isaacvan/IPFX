// Lifecycle emails sent from server functions (trading-engine, admin-console)
// using the same email_templates and email_events tables as the
// transactional-email function. Never throws: an email problem must never
// block trading or an admin action. Until RESEND_API_KEY is configured every
// email is recorded in email_events with status "queued", so nothing is lost.

import { pickProvider, sendEmail } from "./mail-provider.mjs";
import { blockedBySuppression, normEmail } from "./email-suppression.mjs";

// deno-lint-ignore no-explicit-any
type Db = any;

function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function render(template: string, vars: Record<string, unknown>, html = false): string {
  return String(template ?? "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_m, k) => html ? escapeHtml(vars[k]) : String(vars[k] ?? ""));
}

export function emailShell(subject: string, preheader: string | null, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;background:#f5f7fb;color:#101828;font-family:Inter,Arial,sans-serif"><span style="display:none!important;color:transparent;opacity:0;height:0;width:0;overflow:hidden">${escapeHtml(preheader ?? "")}</span><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fb;padding:32px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb"><tr><td style="padding:28px 30px 18px;border-bottom:1px solid #e5e7eb"><div style="font-size:18px;font-weight:700;letter-spacing:.02em;color:#0b1220">IPFX Capital</div><div style="font-size:13px;color:#667085;margin-top:6px">Simulated trading evaluations</div></td></tr><tr><td style="padding:28px 30px;font-size:15px;line-height:1.65;color:#101828">${body}</td></tr><tr><td style="padding:18px 30px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.55;color:#667085">IPFX Capital provides simulated trading evaluations and performance-based rewards. IPFX Capital does not hold client deposits, provide brokerage services, or offer investment advice.</td></tr></table></td></tr></table></body></html>`;
}

export async function sendLifecycleEmail(
  db: Db, templateKey: string, userId: string, vars: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { data: tmpl } = await db.from("email_templates").select("*")
      .eq("key", templateKey).eq("is_active", true).maybeSingle();
    if (!tmpl) return;
    const { data: au } = await db.auth.admin.getUserById(userId);
    const to = au?.user?.email as string | undefined;
    if (!to) return;
    const name = String(au.user.user_metadata?.full_name || to.split("@")[0]);
    const allVars: Record<string, unknown> = { customer_name: name, ...vars };
    const subject = render(tmpl.subject, allVars);
    const html = emailShell(subject, tmpl.preheader, render(tmpl.body_html, allVars, true));
    const text = render(tmpl.body_text, allVars);

    // Sent through the shared provider: Amazon SES when EMAIL_PROVIDER=ses (or AWS keys are set), otherwise Resend.
    const env = Deno.env.toObject();
    const provider = pickProvider(env);
    let status = "queued";
    let providerId: string | null = null;
    let errorMessage: string | null = "No email provider is configured";
    const { data: sup } = await db.from("email_suppressions").select("reason").eq("email", normEmail(to)).maybeSingle();
    if (sup && blockedBySuppression(templateKey, sup.reason)) {
      status = "skipped"; errorMessage = `On the do-not-email list (${sup.reason})`;
    } else if (provider) {
      const r = await sendEmail({
        from: env.EMAIL_FROM ?? "IPFX Capital <support@ipfxcapital.com>",
        to, subject, html, text,
        replyTo: env.SUPPORT_EMAIL ?? "support@ipfxcapital.com",
        tags: { template: templateKey },
      }, env);
      if (r.ok) { status = "sent"; providerId = r.id ?? null; errorMessage = null; }
      else { status = "failed"; errorMessage = String(r.error ?? "send failed").slice(0, 500); }
    }

    await db.from("email_events").insert({
      user_id: userId, template_key: templateKey, to_email: to, subject, status,
      provider: provider ?? "resend", provider_message_id: providerId, error_message: errorMessage,
      payload: { vars: allVars }, sent_at: status === "sent" ? new Date().toISOString() : null,
    });
  } catch (_) { /* never block the caller */ }
}
