// Cloud-only fallback for demo mirror events missed by the fast Edge dispatch.
// Invoked by pg_cron/pg_net, never by the owner's laptop or browser.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  // The pg_cron kicker authenticates with a dedicated secret (Vault: ipfx_mirror_dispatch_secret), so the
  // service-role key never has to be copied into the database.
  const dispatchSecret = Deno.env.get("MIRROR_DISPATCH_SECRET") || "";
  const viaSecret = dispatchSecret.length >= 32 && constantTimeEqual(req.headers.get("x-dispatch-secret") ?? "", dispatchSecret);
  const viaServiceKey = !!serviceKey && constantTimeEqual(req.headers.get("authorization") ?? "", `Bearer ${serviceKey}`);
  if (req.method !== "POST" || !(viaSecret || viaServiceKey))
    return new Response("unauthorised", { status: 401 });
  const url = Deno.env.get("SUPABASE_URL") || "";
  const db = createClient(url, serviceKey);
  const { data: events, error } = await db.rpc("claim_demo_mirror_outbox", { batch_size: 30 });
  if (error) return Response.json({ ok: false, error: "claim failed" }, { status: 503 });
  const results = { acknowledged: 0, skipped: 0, retried: 0, needs_review: 0 };
  for (const event of events || []) {
    const finish = async (status: string, message: string | null = null, delaySeconds = 0) => {
      const patch = { status, last_error: message?.slice(0, 300) ?? null,
        next_attempt_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
        leased_until: null, updated_at: new Date().toISOString() };
      const { error: updateError } = await db.from("demo_mirror_outbox").update(patch)
        .eq("id", event.id).eq("status", "processing");
      if (updateError) console.error(JSON.stringify({ event: "mirror_outbox_update_failed", id: event.id, error: updateError.message }));
    };
    try {
      // The immediate path may already have submitted the order. Never infer
      // safety from HTTP alone: inspect the unique broker claim first.
      const { data: claim } = await db.from("mirror_orders")
        .select("status,error").eq("source_trade_id", event.source_trade_id)
        .eq("event", event.event).eq("provider", "tradelocker")
        .not("idempotency_key", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (claim) {
        if (claim.status === "filled") {
          await finish("acknowledged"); results.acknowledged++;
        } else if (["accepted_pending_position", "reconciliation_required", "sent"].includes(claim.status) &&
            claim.error == null && event.attempts < 5) {
          await finish("pending", `waiting for exact broker reconciliation: ${claim.status}`, 20);
          results.retried++;
        } else {
          await finish("needs_review", `broker claim ${claim.status}: ${claim.error || "inspect"}`);
          results.needs_review++;
        }
        continue;
      }
      const { data: trade } = await db.from("trades")
        .select("id,user_id,symbol,side,volume,sl,tp,open_price,status")
        .eq("id", event.source_trade_id).eq("account_id", event.source_account_id).maybeSingle();
      if (!trade || trade.user_id !== event.user_id || (event.event === "open" && trade.status !== "open")) {
        await finish("skipped", "Source trade no longer open or available"); results.skipped++; continue;
      }
      const response = await fetch(`${url}/functions/v1/live-mirror`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey },
        body: JSON.stringify({ source_trade_id: trade.id, user_id: trade.user_id, event: event.event,
          symbol: trade.symbol, side: trade.side, volume: Number(trade.volume), sl: trade.sl, tp: trade.tp, open_price: trade.open_price }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.ok === true && !body.skipped) {
        // Only a broker-position-mapped open may be acknowledged immediately.
        // A close must be verified absent in the broker position snapshot.
        if (event.event === "open" && body.positionId) {
          await finish("acknowledged"); results.acknowledged++;
        } else {
          await finish("pending", "waiting for exact broker reconciliation", 20); results.retried++;
        }
      } else if (response.ok && body.ok === true && body.skipped === "duplicate event") {
        await finish("pending", "Duplicate dispatch: waiting for broker claim reconciliation", 20); results.retried++;
      } else if (response.ok && body.ok === true && body.skipped) {
        await finish("skipped", String(body.skipped)); results.skipped++;
      } else if (response.ok && body.ok === false) {
        await finish("needs_review", String(body.error || "broker outcome unknown")); results.needs_review++;
      } else if (event.attempts >= 5) {
        await finish("needs_review", `dispatch HTTP ${response.status}`); results.needs_review++;
      } else {
        await finish("pending", `dispatch HTTP ${response.status}`, Math.min(300, 10 * 2 ** event.attempts)); results.retried++;
      }
    } catch (cause) {
      if (event.attempts >= 5) {
        await finish("needs_review", String(cause)); results.needs_review++;
      } else {
        await finish("pending", String(cause), Math.min(300, 10 * 2 ** event.attempts)); results.retried++;
      }
    }
  }
  return Response.json({ ok: true, ...results });
});
