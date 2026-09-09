import { createClient } from "https://esm.sh/@supabase/supabase-js@2.115.0";

// Consumes the 'provision_review' jobs commerce_record_paid() queues in
// commerce_outbox once an order is marked 'paid'. Same lease/claim shape
// as commerce-receipt: service-role-only auth, claim one job with a
// short lock (commerce_claim_provision), do the work, write the result
// back keyed on the lease token so a second worker racing on the same
// row can never both "succeed". See 20260909210000_commerce_provisioning.sql.
//
// Call on a short interval (e.g. every 1-2 minutes via pg_cron + an HTTP
// call, the same pattern already used for ipfx-drawdown-sweep in
// setup-drawdown-sweep-cron.sql) so a paid customer gets their account
// within a minute or two rather than waiting on a manual trigger.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

Deno.serve(async req => {
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey || req.headers.get("Authorization") !== "Bearer " + serviceKey) {
    return json({ error: "Internal service authentication required" }, 401);
  }
  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  const claimed = await db.rpc("commerce_claim_provision");
  if (claimed.error) return json({ error: "Queue unavailable" }, 503);
  const job = claimed.data;
  if (!job?.id) return json({ status: "idle", message: "No pending provisioning job" }, 200);

  async function finish(status: string, last_error: string | null) {
    return await db.from("commerce_outbox").update({ status, last_error })
      .eq("id", job.id).eq("lease_token", job.lease_token).select("id");
  }

  try {
    const { data: accountId, error } = await db.rpc("commerce_provision_account", { p_order_id: job.order_id });
    if (error) {
      console.error("commerce-provision", error.code, error.message);
      const saved = await finish("review", error.message ?? "PROVISION_FAILED");
      return json({ error: saved.error ? "Review write failed" : "Provisioning held for review" },
        saved.error ? 503 : 409);
    }
    const saved = await finish("sent", null);
    if (saved.error || !saved.data?.length) {
      // The account WAS created (commerce_provision_account is idempotent on
      // provisioned_account_id, so re-running this is safe) -- only the
      // outbox bookkeeping is uncertain here, not the provisioning itself.
      return json({ status: "provisioned", account_id: accountId, warning: "Outbox update uncertain, will retry" }, 503);
    }
    return json({ status: "provisioned", account_id: accountId, order_id: job.order_id }, 200);
  } catch (e) {
    console.error("commerce-provision-unexpected", e instanceof Error ? e.message : "unknown");
    const saved = await finish("pending", "PROVISION_UNCERTAIN_RETRY");
    return json({ error: saved.error ? "Queue update failed" : "Provisioning retry pending" }, 503);
  }
});
