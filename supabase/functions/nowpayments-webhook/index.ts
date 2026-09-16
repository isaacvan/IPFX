import { createClient } from "https://esm.sh/@supabase/supabase-js@2.115.0";

// NOWPayments IPN handler. Verifies the HMAC-SHA512 signature per NOWPayments'
// spec (hex digest over the JSON-stringified body with keys sorted
// alphabetically, no extra whitespace) before trusting anything in it, then
// hands off to the same commerce_record_paid RPC the Stripe webhook uses —
// see payment-webhook/index.ts. That RPC is what actually marks the order
// paid and queues provisioning; this function only verifies and translates.

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).sort().reduce((acc, key) => {
      acc[key] = sortKeys((value as Record<string, unknown>)[key]);
      return acc;
    }, {} as Record<string, unknown>);
  }
  return value;
}

async function hmacSha512Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async req => {
  if (req.method !== "POST") return new Response("POST required", { status: 405 });
  const secret = Deno.env.get("NOWPAYMENTS_IPN_SECRET");
  if (Deno.env.get("IPFX_CRYPTO_CHECKOUT_ENABLED") !== "true" || !secret) {
    return new Response("Webhook unavailable", { status: 503 });
  }
  const signature = req.headers.get("x-nowpayments-sig");
  if (!signature) return new Response("Signature required", { status: 400 });

  const raw = await req.text();
  if (raw.length > 1_000_000) return new Response("Payload too large", { status: 413 });
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw); } catch { return new Response("Invalid payload", { status: 400 }); }

  const canonical = JSON.stringify(sortKeys(payload));
  const expected = await hmacSha512Hex(secret, canonical);
  if (expected !== signature) return new Response("Invalid signature", { status: 400 });

  // finished / confirmed both indicate NOWPayments has settled the payment.
  // Everything else (waiting, confirming, partially_paid, failed, expired,
  // refunded) is ignored here — the order simply stays pending/created and
  // the customer sees that on the status poll in checkout-flow.js.
  const status = String(payload.payment_status ?? "");
  if (!["finished", "confirmed"].includes(status)) return new Response("Ignored", { status: 200 });

  const orderId = String(payload.order_id ?? "");
  const invoiceId = payload.invoice_id ?? payload.parent_payment_id;
  const paymentId = String(payload.payment_id ?? "");
  if (!orderId || !paymentId) return new Response("Invalid payment", { status: 400 });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: order } = await db.from("commerce_orders")
    .select("id,provider_intent_id,amount_minor,currency").eq("id", orderId).maybeSingle();
  if (!order) return new Response("Order not found", { status: 404 });

  // provider_intent_id was stored as "np_<invoice.id>" at checkout time.
  // NOWPayments' IPN identifies the invoice via invoice_id (or
  // parent_payment_id, depending on flow) rather than echoing that prefixed
  // value, so re-derive it the same way before handing off to the shared RPC,
  // which independently re-checks the match.
  const derivedIntentId = invoiceId ? "np_" + invoiceId : order.provider_intent_id;
  const priceAmountMinor = Math.round(Number(payload.price_amount ?? 0) * 100);

  const { error } = await db.rpc("commerce_record_paid", {
    p_event: "np_" + paymentId,
    p_order: orderId,
    p_intent: derivedIntentId,
    p_amount: priceAmountMinor || order.amount_minor,
    p_currency: String(payload.price_currency ?? order.currency).toLowerCase(),
  });
  if (error) {
    console.error("crypto-payment-event-processing", error.code);
    return new Response("Payment reconciliation required", { status: 503 });
  }
  return new Response("Recorded", { status: 200 });
});
