import { createClient } from "https://esm.sh/@supabase/supabase-js@2.115.0";
const escape = (value: unknown) => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;")
  .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
Deno.serve(async req => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (req.method !== "POST") return new Response("POST required",{status:405});
  if (!serviceKey || req.headers.get("Authorization") !== "Bearer " + serviceKey) return new Response("Unauthorized",{status:401});
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM");
  const testRecipient = Deno.env.get("IPFX_RECEIPT_TEST_EMAIL");
  if (Deno.env.get("IPFX_RECEIPT_TEST_ENABLED") !== "true" || !resendKey || !from || !testRecipient) {
    return new Response("Receipt test delivery not configured",{status:503});
  }
  const db = createClient(Deno.env.get("SUPABASE_URL")!,serviceKey);
  const claimed = await db.rpc("commerce_claim_receipt");
  if (claimed.error) return new Response("Queue unavailable",{status:503});
  const job = claimed.data;
  if (!job?.id) return new Response("No pending receipt",{status:200});
  async function finish(status: string, last_error: string | null, messageId: string | null = null) {
    return await db.from("commerce_outbox").update({status,last_error,provider_message_id:messageId})
      .eq("id",job.id).eq("lease_token",job.lease_token).select("id");
  }
  const {data:order,error} = await db.from("commerce_orders").select("*").eq("id",job.order_id).single();
  if (error || !order || order.status !== "paid" || !order.test_mode || order.billing_email.toLowerCase() !== testRecipient.toLowerCase()) {
    const saved = await finish("review","VERIFIED_PAID_TEST_ORDER_AND_TEST_RECIPIENT_REQUIRED");
    return new Response(saved.error ? "Review write failed" : "Receipt held for review",{status:saved.error?503:409});
  }
  const total = new Intl.NumberFormat("en-GB",{style:"currency",currency:order.currency}).format(order.amount_minor/100);
  const label = order.product_snapshot.label ?? order.sku;
  const subject = "IPFX Capital | Test payment receipt";
  const text = "IPFX Capital\nTEST PAYMENT RECEIPT - no real money collected\nOrder: " + order.id +
    "\nProduct: " + label + "\nTest amount: " + total + "\nRecorded: " + order.paid_at +
    "\nThis is not a tax invoice and does not activate a trading account.";
  const html = '<!doctype html><html><body style="margin:0;background:#f4f5f7;color:#15171b;font-family:Arial,sans-serif">' +
    '<table role="presentation" width="100%" cellpadding="24"><tr><td align="center"><table role="presentation" width="100%" style="max-width:600px;background:white;border-top:4px solid #2563eb" cellpadding="24"><tr><td>' +
    '<h1 style="font-size:22px;margin:0 0 24px">IPFX Capital</h1><h2 style="font-size:18px">Test Payment Receipt</h2>' +
    '<p>No real money collected.</p><p>Order: '+escape(order.id)+'</p><p>'+escape(label)+'</p><p style="font-size:24px;font-weight:bold">'+escape(total)+'</p>' +
    '<p>Recorded: '+escape(order.paid_at)+'</p><p style="color:#555;font-size:13px">This is not a tax invoice and does not activate a trading account.</p></td></tr></table></td></tr></table></body></html>';
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method:"POST",headers:{"Authorization":"Bearer "+resendKey,"Content-Type":"application/json","Idempotency-Key":"ipfx-test-receipt-"+order.id},
      body:JSON.stringify({from,to:[order.billing_email],subject,text,html}),signal:AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(()=>({}));
    if (!response.ok || typeof result.id !== "string") throw new Error("EMAIL_PROVIDER_NOT_CONFIRMED");
    const saved = await finish("sent",null,result.id);
    if (saved.error || !saved.data?.length) return new Response("Delivery state uncertain; reconciliation required",{status:503});
    return new Response("Test receipt accepted by email provider",{status:200});
  } catch {
    const saved = await finish("pending","EMAIL_DELIVERY_UNCERTAIN_RETRY_SAME_KEY");
    return new Response(saved.error ? "Queue update failed" : "Receipt retry pending",{status:503});
  }
});
