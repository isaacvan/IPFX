// ============================================================
// IPFX Capital — create-payment-intent Edge Function
//
// Creates a Stripe PaymentIntent for a challenge-fee checkout and
// returns its client_secret so the browser can confirm payment with
// Stripe's Payment Element (card / Apple Pay / Google Pay / Link).
// The Stripe secret key never leaves this function.
//
// NOT LIVE: requires STRIPE_SECRET_KEY to be set as a Supabase Edge
// Function secret before this can be deployed and called:
//   supabase secrets set STRIPE_SECRET_KEY=sk_test_...
//
// Request:  POST { tier: "10k"|"25k"|"50k"|"100k", amount_usd: number }
// Response: { client_secret: string }
// ============================================================

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => json({ ok: false, error: m }, s);

// Server-side price list — the source of truth. Never trust a client-supplied
// amount; only the tier is trusted, and the price is looked up here.
const TIER_PRICES_USD: Record<string, number> = {
  "10k": 79,
  "25k": 149,
  "50k": 249,
  "100k": 399,
  "200k": 699,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return err("POST only", 405);

  const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
  if (!STRIPE_SECRET_KEY) {
    return err("Payments are not configured yet (missing STRIPE_SECRET_KEY).", 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err("invalid JSON body");
  }

  const tier = String(body.tier ?? "");
  const amountUsd = TIER_PRICES_USD[tier];
  if (!amountUsd) return err("unknown tier");

  try {
    const resp = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        amount: String(Math.round(amountUsd * 100)), // cents
        currency: "usd",
        "automatic_payment_methods[enabled]": "true",
        "metadata[tier]": tier,
        "metadata[product]": "ipfx_challenge_fee",
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return err(data?.error?.message ?? "Stripe rejected the request", 502);
    }

    return json({ ok: true, client_secret: data.client_secret });
  } catch (e) {
    return err(`Could not reach Stripe: ${(e as Error).message}`, 502);
  }
});
