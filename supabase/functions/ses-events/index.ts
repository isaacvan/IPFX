// ses-events: receives Amazon SES bounce and complaint notifications (through an SNS topic) and puts those addresses
// on the do-not-email list, so a dead or unhappy address is never emailed again.
// Deployed with --no-verify-jwt. The SNS subscription URL carries ?k=<SES_EVENTS_SECRET>; anything without it is refused.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { normEmail } from "../_shared/email-suppression.mjs";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  const secret = Deno.env.get("SES_EVENTS_SECRET");
  if (!secret || new URL(req.url).searchParams.get("k") !== secret) return json({ ok: false }, 401);
  // deno-lint-ignore no-explicit-any
  let msg: any;
  try { msg = JSON.parse(await req.text()); } catch { return json({ ok: false, error: "bad body" }, 400); }

  // SNS asks the endpoint to confirm the subscription once. Only AWS addresses are followed.
  if (msg.Type === "SubscriptionConfirmation") {
    let host = "";
    try { host = new URL(String(msg.SubscribeURL)).hostname; } catch { /* ignore */ }
    if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) return json({ ok: false, error: "unexpected subscribe host" }, 400);
    const r = await fetch(msg.SubscribeURL);
    return json({ ok: r.ok });
  }
  if (msg.Type !== "Notification") return json({ ok: true, ignored: msg.Type ?? null });

  // deno-lint-ignore no-explicit-any
  let evt: any;
  try { evt = JSON.parse(String(msg.Message)); } catch { return json({ ok: true, ignored: "message" }); }
  const kind = String(evt.eventType ?? evt.notificationType ?? "");
  const rows: { email: string; reason: string; source: string; detail: string }[] = [];
  if (kind === "Bounce" && evt.bounce?.bounceType === "Permanent") {
    for (const r of evt.bounce.bouncedRecipients ?? [])
      rows.push({ email: normEmail(r.emailAddress), reason: "bounce", source: "ses", detail: String(r.diagnosticCode ?? evt.bounce.bounceSubType ?? "").slice(0, 300) });
  } else if (kind === "Complaint") {
    for (const r of evt.complaint?.complainedRecipients ?? [])
      rows.push({ email: normEmail(r.emailAddress), reason: "complaint", source: "ses", detail: String(evt.complaint.complaintFeedbackType ?? "").slice(0, 300) });
  }
  if (!rows.length) return json({ ok: true, recorded: 0 });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // A bounce or complaint always wins over an earlier plain unsubscribe, so it replaces it.
  const { error } = await db.from("email_suppressions").upsert(rows, { onConflict: "email" });
  if (error) return json({ ok: false, error: "store failed" }, 503);
  return json({ ok: true, recorded: rows.length });
});
