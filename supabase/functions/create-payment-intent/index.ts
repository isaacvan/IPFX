import { createClient } from "https://esm.sh/@supabase/supabase-js@2.115.0";
import Stripe from "npm:stripe@17.7.0";

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
  // Deliberately no live-key path in this release. Underwriting, tax and
  // fulfillment verification must precede any real challenge-fee collection.
  const key = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (Deno.env.get("IPFX_CHECKOUT_TEST_ENABLED") !== "true" || !key.startsWith("sk_test_")) {
    return json({ error: "Checkout is not available yet. No payment has been taken." }, 503);
  }
  const sku = String(body.sku ?? "");
  if (!/^[a-z0-9_]{1,64}$/.test(sku)) return json({ error: "Invalid product" }, 400);
  if (body.action === "quote") {
    const { data, error } = await db.from("commerce_catalog").select("sku,label,amount_minor,currency,terms_version")
      .eq("sku", sku).eq("enabled", true).maybeSingle();
    const publicKey = Deno.env.get("STRIPE_PUBLISHABLE_KEY") ?? "";
    if (error || !data || !publicKey.startsWith("pk_test_")) return json({ error: "Product unavailable" }, 503);
    return json({ product: data, publishable_key: publicKey, test_mode: true });
  }
  if (!uuid.test(String(body.request_key)) || body.terms_accepted !== true || typeof body.terms_version !== "string") {
    return json({ error: "A request ID and acceptance of the current terms are required." }, 400);
  }
  try {
    const { data: order, error } = await db.rpc("commerce_begin_order", {
      p_user: auth.user.id, p_request: body.request_key, p_sku: sku, p_terms: body.terms_version,
    });
    if (error || !order) {
      console.error("checkout-order", error?.code);
      return json({ error: "Checkout is unavailable for this account or product. Check your verified profile and terms." }, 409);
    }
    if (!["created", "pending"].includes(order.status)) return json({ order_id: order.id, status: order.status }, 409);
    const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 1 });
    let intent;
    if (order.provider_intent_id) intent = await stripe.paymentIntents.retrieve(order.provider_intent_id);
    else {
      // Stripe may prune idempotency keys after 24h. Never recreate an uncertain
      // old intent under the same order after that window.
      if (Date.now() - Date.parse(order.created_at) > 23 * 3600_000) {
        return json({ error: "This checkout expired. Contact support before retrying." }, 409);
      }
      intent = await stripe.paymentIntents.create({
        amount: order.amount_minor, currency: order.currency,
        // Let Stripe offer whatever the account has switched on (cards,
        // Apple/Google Pay, PayPal, Revolut Pay, bank debits — region-
        // dependent) instead of hardcoding "card" and silently hiding
        // everything else. Toggle methods on/off in the Stripe Dashboard
        // under Settings -> Payment methods; nothing here needs to change
        // when you do. The client already uses elements.create('payment'),
        // the unified Element that renders whatever this returns.
        automatic_payment_methods: { enabled: true },
        receipt_email: order.billing_email,
        metadata: { ipfx_order_id: order.id, ipfx_user_id: auth.user.id },
        description: "IPFX Capital test challenge checkout",
      }, { idempotencyKey: "ipfx-commerce-" + order.id });
      const linked = await db.from("commerce_orders").update({
        provider_intent_id: intent.id, status: "pending",
      }).eq("id", order.id).is("provider_intent_id", null).select("id");
      if (linked.error) throw new Error("ORDER_LINK_FAILED");
      if (!linked.data?.length) {
        const check = await db.from("commerce_orders").select("provider_intent_id").eq("id", order.id).single();
        if (check.error || check.data?.provider_intent_id !== intent.id) throw new Error("ORDER_LINK_CONFLICT");
      }
    }
    if (intent.livemode || intent.amount !== order.amount_minor || intent.currency !== order.currency
      || intent.metadata.ipfx_order_id !== order.id) throw new Error("PROVIDER_MISMATCH");
    return json({ order_id: order.id, client_secret: intent.client_secret, status: intent.status,
      amount_minor: order.amount_minor, currency: order.currency, test_mode: true });
  } catch (error) {
    console.error("checkout-provider", error instanceof Error ? error.name : "unknown");
    return json({ error: "Unable to confirm checkout. Retry this same checkout; do not create another payment." }, 503);
  }
});
