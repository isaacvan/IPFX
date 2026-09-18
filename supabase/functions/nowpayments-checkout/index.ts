import { createClient } from "https://esm.sh/@supabase/supabase-js@2.115.0";

// Crypto checkout via NOWPayments, alongside (not replacing) the Stripe path
// in create-payment-intent/index.ts. Both write into the same provider-
// agnostic commerce_orders / commerce_begin_order / commerce_record_paid
// pipeline from 20260909190000_commerce_and_mirror_safety.sql, so a paid
// order provisions identically regardless of which provider took the money.
//
// Sandbox-only in this release, same posture as Stripe's "no live-key path
// yet" in create-payment-intent: commerce_orders.test_mode is a hard check
// constraint (must be true) until underwriting/tax/fulfillment review is
// done, so no order created here can be anything but a test order today.

const headers = {
  "Access-Control-Allow-Origin": "https://ipfxcapital.com",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { headers });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  const { data: auth, error: authError } = await db.auth.getUser(token);
  if (authError || !auth.user) return json({ error: "Please sign in before checkout." }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid request" }, 400);

  if (body.action === "status") {
    if (!uuid.test(String(body.order_id))) return json({ error: "Invalid order" }, 400);
    const { data, error } = await db.from("commerce_orders")
      .select("id,status,amount_minor,currency,paid_at,test_mode")
      .eq("id", body.order_id).eq("user_id", auth.user.id).maybeSingle();
    return error ? json({ error: "Order status unavailable" }, 503)
      : data ? json({ order: data }) : json({ error: "Order not found" }, 404);
  }

  // Deliberately sandbox-only in this release, same rationale as the Stripe
  // test-key gate: underwriting/tax/fulfillment review must precede any real
  // challenge-fee collection, and commerce_orders.test_mode is DB-enforced
  // true regardless of what this function does.
  const apiKey = Deno.env.get("NOWPAYMENTS_API_KEY") ?? "";
  if (Deno.env.get("IPFX_CRYPTO_CHECKOUT_ENABLED") !== "true" || !apiKey) {
    return json({ error: "Crypto checkout is not available yet. No payment has been taken." }, 503);
  }
  const apiBase = Deno.env.get("NOWPAYMENTS_API_BASE") || "https://api-sandbox.nowpayments.io/v1";

  const sku = String(body.sku ?? "");
  if (!/^[a-z0-9_]{1,64}$/.test(sku)) return json({ error: "Invalid product" }, 400);
  const { data: identity, error: identityError } = await db.from("trader_identity_private")
    .select("user_id").eq("user_id", auth.user.id).maybeSingle();
  if (identityError || !identity) {
    return json({ error: "Complete your identity and address details before starting a challenge." }, 409);
  }
  // Continuation pricing is account-specific and immutable. Keep it on the
  // Stripe path until this provider accepts the same server-owned offer ID.
  if (sku === "challenge_continue") {
    return json({ error: "Use the secure continuation checkout shown inside IPFX Markets." }, 409);
  }
  if (body.action === "quote") {
    const { data, error } = await db.from("commerce_catalog").select("sku,label,amount_minor,currency,terms_version")
      .eq("sku", sku).eq("enabled", true).maybeSingle();
    if (error || !data) return json({ error: "Product unavailable" }, 503);
    return json({ product: data, test_mode: true });
  }
  if (!uuid.test(String(body.request_key)) || body.terms_accepted !== true || typeof body.terms_version !== "string") {
    return json({ error: "A request ID and acceptance of the current terms are required." }, 400);
  }
  try {
    const { data: order, error } = await db.rpc("commerce_begin_order", {
      p_user: auth.user.id, p_request: body.request_key, p_sku: sku, p_terms: body.terms_version,
    });
    if (error || !order) {
      console.error("crypto-checkout-order", error?.code);
      return json({ error: "Checkout is unavailable for this account or product. Check your verified profile and terms." }, 409);
    }
    if (order.status === "paid") return json({ order_id: order.id, status: order.status });
    if (!["created", "pending"].includes(order.status)) return json({ order_id: order.id, status: order.status }, 409);
    if (Date.now() - Date.parse(order.created_at) > 23 * 3600_000) {
      return json({ error: "This checkout expired. Contact support before retrying." }, 409);
    }

    const fnBase = Deno.env.get("SUPABASE_URL")!.replace(".supabase.co", ".supabase.co/functions/v1");
    const invoiceRes = await fetch(apiBase + "/invoice", {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        price_amount: order.amount_minor / 100,
        price_currency: order.currency,
        order_id: order.id,
        order_description: "IPFX Capital test challenge checkout",
        ipn_callback_url: fnBase + "/nowpayments-webhook",
        success_url: "https://ipfxcapital.com/start-challenge.html#paid",
        cancel_url: "https://ipfxcapital.com/start-challenge.html#step3",
      }),
    });
    const invoice = await invoiceRes.json().catch(() => null);
    if (!invoiceRes.ok || !invoice?.id || !invoice?.invoice_url) {
      console.error("nowpayments-invoice-create", invoiceRes.status, invoice?.message);
      throw new Error("PROVIDER_INVOICE_FAILED");
    }

    const linked = await db.from("commerce_orders").update({
      provider_intent_id: "np_" + invoice.id, status: "pending",
    }).eq("id", order.id).select("id");
    if (linked.error) throw new Error("ORDER_LINK_FAILED");

    return json({
      order_id: order.id, invoice_url: invoice.invoice_url, status: "pending",
      amount_minor: order.amount_minor, currency: order.currency, test_mode: true,
    });
  } catch (error) {
    console.error("crypto-checkout-provider", error instanceof Error ? error.name : "unknown");
    return json({ error: "Unable to start crypto checkout. Retry this same checkout; do not create another payment." }, 503);
  }
});
