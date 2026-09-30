import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { ...CORS, "Content-Type": "application/json" },
});

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency }).format((minor || 0) / 100);

function escapeHtml(v: unknown) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function render(template: string, vars: Record<string, unknown>, html = false) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k) => html ? escapeHtml(vars[k]) : String(vars[k] ?? ""));
}

function emailShell(subject: string, preheader: string | null, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;background:#f5f7fb;color:#101828;font-family:Inter,Arial,sans-serif"><span style="display:none!important;color:transparent;opacity:0;height:0;width:0;overflow:hidden">${escapeHtml(preheader ?? "")}</span><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fb;padding:32px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb"><tr><td style="padding:28px 30px 18px;border-bottom:1px solid #e5e7eb"><div style="font-size:18px;font-weight:700;letter-spacing:.02em;color:#0b1220">IPFX Capital</div><div style="font-size:13px;color:#667085;margin-top:6px">Simulated trading evaluations</div></td></tr><tr><td style="padding:28px 30px;font-size:15px;line-height:1.65;color:#101828">${body}</td></tr><tr><td style="padding:18px 30px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.55;color:#667085">IPFX Capital provides simulated trading evaluations and performance-based rewards. IPFX Capital does not hold client deposits, provide brokerage services, or offer investment advice.</td></tr></table></td></tr></table></body></html>`;
}

async function sendResend(to: string, subject: string, html: string, text: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return { sent: false, skipped: true, error: "RESEND_API_KEY is not configured" };
  const from = Deno.env.get("EMAIL_FROM") ?? "IPFX Capital <receipts@ipfxcapital.com>";
  const replyTo = Deno.env.get("SUPPORT_EMAIL") ?? "support@ipfxcapital.com";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html, text, reply_to: replyTo }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { sent: false, skipped: false, error: data?.message ?? `Resend ${res.status}`, data };
  return { sent: true, skipped: false, id: data?.id, data };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return json({ ok: false, error: "Not signed in" }, 401);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: adminRow } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  const isAdmin = !!adminRow;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ ok: false, error: "Invalid JSON" }, 400); }

  async function sendTemplate(templateKey: string, toEmail: string, vars: Record<string, unknown>, ids: Record<string, unknown> = {}) {
    const { data: tmpl, error: tmplErr } = await db.from("email_templates").select("*").eq("key", templateKey).eq("is_active", true).maybeSingle();
    if (tmplErr || !tmpl) throw new Error("Email template not found");
    const subject = render(tmpl.subject, vars);
    const htmlBody = render(tmpl.body_html, vars, true);
    const text = render(tmpl.body_text, vars);
    const html = emailShell(subject, tmpl.preheader, htmlBody);
    const result = await sendResend(toEmail, subject, html, text);
    const status = result.sent ? "sent" : result.skipped ? "queued" : "failed";
    const { data: event, error: eventErr } = await db.from("email_events").insert({
      user_id: ids.user_id ?? null,
      receipt_id: ids.receipt_id ?? null,
      checkout_order_id: ids.checkout_order_id ?? null,
      template_key: templateKey,
      to_email: toEmail,
      subject,
      status,
      provider: "resend",
      provider_message_id: result.id ?? null,
      error_message: result.error ?? null,
      payload: { vars, provider_result: result },
      sent_at: result.sent ? new Date().toISOString() : null,
    }).select("*").single();
    if (eventErr) throw new Error("Could not log email event");
    return { event, result };
  }

  if (body.action === "issue_receipt") {
    const checkoutOrderId = typeof body.checkout_order_id === "string" ? body.checkout_order_id : null;
    if (!checkoutOrderId) return json({ ok: false, error: "checkout_order_id required" }, 400);
    const { data: order } = await db.from("checkout_orders").select("*").eq("id", checkoutOrderId).maybeSingle();
    if (!order) return json({ ok: false, error: "Checkout order not found" }, 404);
    if (!isAdmin && order.user_id !== user.id) return json({ ok: false, error: "Forbidden" }, 403);
    if (order.status !== "paid" && !isAdmin) return json({ ok: false, error: "Receipt can only be issued for a paid order" }, 409);

    const { data: authUser } = await db.auth.admin.getUserById(order.user_id);
    const customerEmail = order.billing_email ?? authUser?.user?.email;
    if (!customerEmail) return json({ ok: false, error: "No billing email available" }, 409);

    const { data: existing } = await db.from("receipts")
      .select("*").eq("checkout_order_id", checkoutOrderId).eq("receipt_type", "payment").neq("status", "void").maybeSingle();

    let receipt = existing;
    if (!receipt) {
      const lineItems = Array.isArray(order.metadata?.line_items) ? order.metadata.line_items : [{
        description: order.metadata?.challenge_name ?? "IPFX Capital evaluation fee",
        amount_minor: order.amount_minor,
        currency: order.currency,
      }];
      const { data: created, error: receiptErr } = await db.from("receipts").insert({
        user_id: order.user_id,
        checkout_order_id: order.id,
        enrollment_id: order.enrollment_id,
        receipt_type: "payment",
        amount_minor: order.amount_minor,
        currency: order.currency,
        tax_amount_minor: 0,
        discount_amount_minor: 0,
        total_amount_minor: order.amount_minor,
        payment_method: order.payment_method,
        provider_payment_id: order.provider_payment_id,
        billing_email: customerEmail,
        billing_name: order.cardholder_name ?? authUser?.user?.user_metadata?.full_name ?? null,
        billing_country: order.billing_country,
        line_items: lineItems,
        legal_snapshot: {
          product_type: "simulated_evaluation",
          no_client_deposits: true,
          no_brokerage: true,
          no_investment_advice: true,
          crypto_supported: false,
        },
        metadata: order.metadata ?? {},
      }).select("*").single();
      if (receiptErr) return json({ ok: false, error: receiptErr.message }, 500);
      receipt = created;
    }

    const vars = {
      customer_name: receipt.billing_name ?? authUser?.user?.email?.split("@")[0] ?? "Trader",
      receipt_number: receipt.receipt_number,
      amount: money(receipt.total_amount_minor, receipt.currency),
      currency: receipt.currency,
      challenge_name: order.metadata?.challenge_name ?? "IPFX Capital evaluation",
    };
    const sent = await sendTemplate("payment_receipt", customerEmail, vars, {
      user_id: order.user_id,
      receipt_id: receipt.id,
      checkout_order_id: order.id,
    });
    return json({ ok: true, receipt, email_event: sent.event, delivery: sent.result });
  }

  if (body.action === "send_template") {
    if (!isAdmin) return json({ ok: false, error: "Admin only" }, 403);
    const templateKey = typeof body.template_key === "string" ? body.template_key : null;
    const toEmail = typeof body.to_email === "string" ? body.to_email : null;
    if (!templateKey || !toEmail) return json({ ok: false, error: "template_key and to_email required" }, 400);
    const vars = typeof body.vars === "object" && body.vars ? body.vars as Record<string, unknown> : {};
    const ids = typeof body.ids === "object" && body.ids ? body.ids as Record<string, unknown> : {};
    const sent = await sendTemplate(templateKey, toEmail, vars, ids);
    return json({ ok: true, email_event: sent.event, delivery: sent.result });
  }

  return json({ ok: false, error: "Unknown action" }, 400);
});
