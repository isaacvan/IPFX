// A/B-book classification worker. Called by pg_cron every 5 minutes (kick_ab_classifier) with a dedicated
// secret. Reads the ledger replay, integrity signals and Stage 2 progress, decides each person's state with
// the pure engine in _shared/ab-classifier.ts, and applies moves through ab_apply_transition (audited,
// optimistic). It never places an order and never changes size: that is the allocator's job.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decide, POLICY_V1, type BookState, type LedgerPoint, type Policy } from "../_shared/ab-classifier.ts";

function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const secret = Deno.env.get("AB_CLASSIFIER_SECRET") ?? "";
  if (req.method !== "POST" || secret.length < 32 || !constantTimeEqual(req.headers.get("x-classifier-secret") ?? "", secret))
    return json({ error: "unauthorised" }, 401);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const started = Date.now();

  const { data: pol, error: polErr } = await db.from("ab_policy_versions").select("version,thresholds").eq("status", "ACTIVE").maybeSingle();
  if (polErr || !pol) return json({ error: "no active policy" }, 503);
  const policy: Policy = { ...POLICY_V1, ...(pol.thresholds as Partial<Policy>), version: pol.version };

  const { data: profiles, error: profErr } = await db.from("ab_trader_profiles").select("person_id,book_state,state_since,last_ab_exit_at");
  if (profErr) return json({ error: "profiles unavailable" }, 503);

  // Ledger points, paged, oldest first. Only rows with a real quote replay and a stop-loss-based R count as evidence.
  const points = new Map<string, LedgerPoint[]>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("ab_trade_ledger").select("person_id,closed_at,same_r,reverse_r,hold_seconds")
      .eq("replay_basis", "REPLAY_QUOTES").not("same_r", "is", null).not("reverse_r", "is", null)
      .order("closed_at", { ascending: true }).order("trade_id", { ascending: true }).range(from, from + 999);
    if (error) return json({ error: "ledger unavailable" }, 503);
    for (const r of data ?? []) {
      const list = points.get(r.person_id) ?? [];
      list.push({ closedAt: Date.parse(r.closed_at), sameR: Number(r.same_r), reverseR: Number(r.reverse_r), holdSeconds: Number(r.hold_seconds) });
      points.set(r.person_id, list);
    }
    if (!data || data.length < 1000) break;
  }
  const { data: signals } = await db.from("ab_person_signals").select("person_id,investigation_hold,critical_flag,stage2_profit_pct");
  const sig = new Map((signals ?? []).map((s) => [s.person_id, s]));

  const now = Date.now();
  let moved = 0, conflicts = 0;
  const moves: Array<Record<string, unknown>> = [];
  for (const p of profiles ?? []) {
    const s = sig.get(p.person_id);
    const suspend = s?.investigation_hold ? "account under investigation" : s?.critical_flag ? "critical trade-safety flag" : null;
    const decision = decide({
      state: p.book_state as BookState, stateSince: Date.parse(p.state_since),
      lastAbExitAt: p.last_ab_exit_at ? Date.parse(p.last_ab_exit_at) : null, now,
      points: points.get(p.person_id) ?? [], suspend,
      stage2ProfitPct: s?.stage2_profit_pct == null ? null : Number(s.stage2_profit_pct),
    }, policy);
    if (!decision) continue;
    const { data: applied, error } = await db.rpc("ab_apply_transition", {
      p_person: p.person_id, p_from: p.book_state, p_to: decision.to, p_reason: decision.reason,
      p_evidence: decision.evidence, p_policy_version: policy.version,
    });
    if (error || !applied) { conflicts++; continue; }
    moved++;
    moves.push({ from: p.book_state, to: decision.to });
  }
  return json({ ok: true, policy: policy.version, people: profiles?.length ?? 0, withEvidence: points.size, moved, conflicts, moves, ms: Date.now() - started });
});
