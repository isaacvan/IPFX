import { createClient } from "https://esm.sh/@supabase/supabase-js@2.115.0";
import Stripe from "npm:stripe@17.7.0";

Deno.serve(async req => {
  if (req.method !== "POST") return new Response("POST required", { status: 405 });
  const key = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!key.startsWith("sk_test_") || !secret) return new Response("Webhook unavailable", { status: 503 });
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Signature required", { status: 400 });
  const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
  let event: Stripe.Event;
  try {
    // Verify the original bytes, never parsed and reserialized JSON.
    const raw = await req.text();
    if (raw.length > 1_000_000) return new Response("Payload too large", { status: 413 });
    event = await stripe.webhooks.constructEventAsync(raw, signature, secret, 300, Stripe.createSubtleCryptoProvider());
  } catch { return new Response("Invalid signature", { status: 400 }); }
  if (event.livemode) return new Response("Live payments disabled", { status: 409 });
  if (event.type !== "payment_intent.succeeded") return new Response("Ignored", { status: 200 });
  const intent = event.data.object as Stripe.PaymentIntent;
  if (intent.livemode || intent.status !== "succeeded" || !intent.metadata.ipfx_order_id) {
    return new Response("Invalid payment", { status: 400 });
  }
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await db.rpc("commerce_record_paid", {
    p_event: event.id, p_order: intent.metadata.ipfx_order_id, p_intent: intent.id,
    p_amount: intent.amount_received, p_currency: intent.currency,
  });
  // Non-2xx keeps provider retries active. No receipt or entitlement is created
  // outside the database transaction, so duplicates cannot provision twice.
  if (error) {
    console.error("payment-event-processing", error.code);
    return new Response("Payment reconciliation required", { status: 503 });
  }
  return new Response("Recorded", { status: 200 });
});
