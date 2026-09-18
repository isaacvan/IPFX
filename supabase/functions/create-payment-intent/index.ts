import { createClient } from "https://esm.sh/@supabase/supabase-js@2.115.0";
import Stripe from "npm:stripe@17.7.0";
import { allowRequest, readJsonObject, RequestError, requestId, safeErrorCode } from "../_shared/request-guards.ts";

const headers = {
  "Access-Control-Allow-Origin": "https://ipfxcapital.com",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const json = (value: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { ...headers, ...extraHeaders } });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const quoteCache = new Map<string, { product: Record<string, unknown>; publishableKey: string; expiresAt: number }>();

Deno.serve(async req => {
  const traceId = requestId(req);
  const traced = (value: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
    json(value, status, { "X-Request-ID": traceId, ...extraHeaders });
  if (req.method === "OPTIONS") return new Response(null, { headers: { ...headers, "X-Request-ID": traceId } });
  if (req.method !== "POST") return traced({ error: "POST required" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  const { data: auth, error: authError } = await db.auth.getUser(token);
  if (authError || !auth.user) return traced({ error: "Please sign in before checkout." }, 401);
  let body: Record<string, unknown>;
  try { body = await readJsonObject(req); }
  catch (error) {
    const status = error instanceof RequestError ? error.status : 400;
    return traced({ error: status === 413 ? "Request is too large" : "Invalid request" }, status);
  }

  const action = body.action === "status" || body.action === "quote" ? body.action : "create";
  const rate = action === "status" ? [60, 60] : action === "quote" ? [30, 60] : [10, 600];
  try {
    if (!await allowRequest(db, `checkout:${action}`, auth.user.id, rate[0], rate[1])) {
      return traced({ error: "Too many checkout requests. Wait before trying again." }, 429, { "Retry-After": String(rate[1]) });
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "checkout_rate_limit", request_id: traceId, code: safeErrorCode(error) }));
    return traced({ error: "Checkout protection is temporarily unavailable. No payment was taken." }, 503);
  }

  if (body.action === "status") {
    if (!uuid.test(String(body.order_id))) return traced({ error: "Invalid order" }, 400);
    const { data, error } = await db.from("commerce_orders")
      .select("id,status,amount_minor,currency,paid_at,test_mode,provisioned_account_id")
      .eq("id", body.order_id).eq("user_id", auth.user.id).maybeSingle();
    return error ? traced({ error: "Order status unavailable" }, 503)
      : data ? traced({ order: data }) : traced({ error: "Order not found" }, 404);
  }
  // Deliberately no live-key path in this release. Underwriting, tax and
  // fulfillment verification must precede any real challenge-fee collection.
  const key = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (Deno.env.get("IPFX_CHECKOUT_TEST_ENABLED") !== "true" || !key.startsWith("sk_test_")) {
    return traced({ error: "Checkout is not available yet. No payment has been taken." }, 503);
  }
  const sku = String(body.sku ?? "");
  if (!/^[a-z0-9_]{1,64}$/.test(sku)) return traced({ error: "Invalid product" }, 400);
  let sourceAccountId: string | null = null;
  if (sku === "challenge_continue") {
    sourceAccountId = String(body.source_account_id ?? "");
    if (!uuid.test(sourceAccountId)) return traced({ error: "A breached challenge account is required." }, 400);
    const [{ data: source }, { count: activeCount }] = await Promise.all([
      db.from("trading_accounts").select("id,status,phase,challenge_type,preset_id")
        .eq("id", sourceAccountId).eq("user_id", auth.user.id).maybeSingle(),
      db.from("trading_accounts").select("id", { count: "exact", head: true })
        .eq("user_id", auth.user.id).eq("status", "active"),
    ]);
    if (!source || source.status !== "breached" || source.phase !== "evaluation"
      || !["infinity", "traditional", "futures", "pac"].includes(source.challenge_type)) {
      return traced({ error: "This account is not eligible for challenge continuation." }, 409);
    }
    if ((activeCount ?? 0) > 0) return traced({ error: "You already have an active trading account." }, 409);
  }
  if (body.action === "quote") {
    const cached = quoteCache.get(sku);
    if (cached && cached.expiresAt > Date.now()) {
      return traced({ product: cached.product, publishable_key: cached.publishableKey, test_mode: true }, 200, { "Cache-Control": "private, max-age=60" });
    }
    const { data, error } = await db.from("commerce_catalog").select("sku,label,amount_minor,currency,terms_version")
      .eq("sku", sku).eq("enabled", true).maybeSingle();
    const publicKey = Deno.env.get("STRIPE_PUBLISHABLE_KEY") ?? "";
    if (error || !data || !publicKey.startsWith("pk_test_")) return traced({ error: "Product unavailable" }, 503);
    quoteCache.set(sku, { product: data, publishableKey: publicKey, expiresAt: Date.now() + 60_000 });
    return traced({ product: data, publishable_key: publicKey, test_mode: true }, 200, { "Cache-Control": "private, max-age=60" });
  }
  if (!uuid.test(String(body.request_key)) || body.terms_accepted !== true || typeof body.terms_version !== "string") {
    return traced({ error: "A request ID and acceptance of the current terms are required." }, 400);
  }
  try {
    const { data: order, error } = await db.rpc("commerce_begin_order", {
      p_user: auth.user.id, p_request: body.request_key, p_sku: sku, p_terms: body.terms_version,
    });
    if (error || !order) {
      console.error(JSON.stringify({ event: "checkout_order", request_id: traceId, code: error?.code ?? "UNKNOWN" }));
      return traced({ error: "Checkout is unavailable for this account or product. Check your verified profile and terms." }, 409);
    }
    if (sourceAccountId) {
      const linkedSource = await db.from("commerce_orders").update({ source_account_id: sourceAccountId })
        .eq("id", order.id).eq("user_id", auth.user.id).is("source_account_id", null).select("id,source_account_id");
      if (linkedSource.error) {
        console.error(JSON.stringify({ event: "checkout_source_link", request_id: traceId, code: linkedSource.error.code ?? "UNKNOWN" }));
        return traced({ error: "A continuation checkout already exists for this account. Retry the original checkout; do not pay again." }, 409);
      }
      if (!linkedSource.data?.length) {
        const existing = await db.from("commerce_orders").select("source_account_id").eq("id", order.id).single();
        if (existing.error || existing.data?.source_account_id !== sourceAccountId) {
          return traced({ error: "Continuation checkout conflict. No payment was taken." }, 409);
        }
      }
    }
    if (!["created", "pending"].includes(order.status)) return traced({ order_id: order.id, status: order.status }, 409);
    const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 1, timeout: 10_000 });
    let intent;
    if (order.provider_intent_id) intent = await stripe.paymentIntents.retrieve(order.provider_intent_id);
    else {
      // Stripe may prune idempotency keys after 24h. Never recreate an uncertain
      // old intent under the same order after that window.
      if (Date.now() - Date.parse(order.created_at) > 23 * 3600_000) {
        return traced({ error: "This checkout expired. Contact support before retrying." }, 409);
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
        description: sku === "challenge_continue"
          ? "IPFX same-stage challenge continuation"
          : "IPFX Capital test challenge checkout",
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
    return traced({ order_id: order.id, client_secret: intent.client_secret, status: intent.status,
      amount_minor: order.amount_minor, currency: order.currency, test_mode: true });
  } catch (error) {
    console.error(JSON.stringify({ event: "checkout_provider", request_id: traceId, code: safeErrorCode(error) }));
    return traced({ error: "Unable to confirm checkout. Retry this same checkout; do not create another payment." }, 503);
  }
});
