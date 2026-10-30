// A/B-book classification worker. Called by pg_cron every 5 minutes (kick_ab_classifier) with a dedicated
// secret. Reads the ledger replay, integrity signals and Stage 2 progress, decides each person's state with
// the pure engine in _shared/ab-classifier.ts, and applies moves through ab_apply_transition (audited,
// optimistic). It never places an order and never changes size: that is the allocator's job.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decide, herdClusters, POLICY_V1, type BookState, type LedgerPoint, type Policy } from "../_shared/ab-classifier.ts";
import { personMetrics, type LedgerRow } from "../_shared/brain.ts";
import { bLiveReview } from "../_shared/b-live-review.ts";
import { runGate, type GateTrade } from "../_shared/copy-gate.ts";
type IntegritySignal = { person_id: string; investigation_hold: boolean | null; critical_flag: boolean | null; stage2_profit_pct: number | null };

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
  // Heartbeat for the owner's Brain page: every run records whether it worked, so a silent stop raises an alert.
  let res: Response;
  try { res = await run(db); } catch (e) { res = json({ error: "run failed: " + String((e as Error)?.message ?? e) }, 500); }
  const body = await res.clone().json().catch(() => ({}));
  await db.from("ab_heartbeats").upsert({ worker: "ab-classifier", ok: res.status === 200 && !body.metricsError, at: new Date().toISOString(),
    detail: res.status === 200 ? { policy: body.policy, people: body.people, moved: body.moved, metrics: body.metrics, error: body.metricsError ?? undefined } : { error: body.error } });
  return res;
});

// deno-lint-ignore no-explicit-any
async function run(db: any): Promise<Response> {
  const started = Date.now();

  const { data: pol, error: polErr } = await db.from("ab_policy_versions").select("version,thresholds").eq("status", "ACTIVE").maybeSingle();
  if (polErr || !pol) return json({ error: "no active policy" }, 503);
  const policy: Policy = { ...POLICY_V1, ...(pol.thresholds as Partial<Policy>), version: pol.version };

  const { data: profiles, error: profErr } = await db.from("ab_trader_profiles").select("person_id,book_state,state_since,last_ab_exit_at,manual_book_state");
  if (profErr) return json({ error: "profiles unavailable" }, 503);

  // Ledger points, paged, oldest first. Only rows with a real quote replay and a stop-loss-based R count as evidence.
  const points = new Map<string, LedgerPoint[]>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("ab_trade_ledger").select("person_id,closed_at,same_r,reverse_r,hold_seconds,trader_r")
      .eq("replay_basis", "REPLAY_QUOTES").not("same_r", "is", null).not("reverse_r", "is", null)
      .order("closed_at", { ascending: true }).order("trade_id", { ascending: true }).range(from, from + 999);
    if (error) return json({ error: "ledger unavailable" }, 503);
    for (const r of data ?? []) {
      const list = points.get(r.person_id) ?? [];
      list.push({ closedAt: Date.parse(r.closed_at), sameR: Number(r.same_r), reverseR: Number(r.reverse_r), holdSeconds: Number(r.hold_seconds), traderR: r.trader_r == null ? null : Number(r.trader_r) });
      points.set(r.person_id, list);
    }
    if (!data || data.length < 1000) break;
  }
  // Integrity signals must be read or the run stops: a silent failure here once meant no suspension could fire.
  const { data: signals, error: sigErr } = await db.from("ab_person_signals").select("person_id,investigation_hold,critical_flag,stage2_profit_pct");
  if (sigErr) return json({ error: "integrity signals unavailable: " + sigErr.message }, 503);
  const sig = new Map<string, IntegritySignal>((signals ?? []).map((s: IntegritySignal): [string, IntegritySignal] => [s.person_id, s]));
  // Herd clusters: people linked by repeated same-trade-within-60s pairs (ab_herd_pairs), joined transitively.
  const { data: pairs, error: herdErr } = await db.rpc("ab_herd_pairs");
  if (herdErr) return json({ error: "herd signals unavailable: " + herdErr.message }, 503);
  const herd = herdClusters((pairs ?? []) as Array<{ person_a: string; person_b: string }>, 3);
  // Policy v5 copy gate: each person's current-run score and identity status. Must load, or the run stops (no silent promotions).
  let gate: Map<string, { score: number; counted: number; startedAt: number }>, kyc: Set<string>;
  try { ({ gate, kyc } = await gateInputs(db, policy)); } catch (e) { return json({ error: "copy gate inputs unavailable: " + String((e as Error)?.message ?? e) }, 503); }

  const now = Date.now();
  const finalState = new Map<string, BookState>();
  let moved = 0, conflicts = 0;
  const moves: Array<Record<string, unknown>> = [];
  for (const p of profiles ?? []) {
    const s = sig.get(p.person_id);
    const suspend = s?.investigation_hold ? "account under investigation" : s?.critical_flag ? "critical trade-safety flag" : null;
    finalState.set(p.person_id, p.book_state as BookState);
    // Owner choices persist; integrity checks still suspend immediately. The database also guards races.
    if (p.manual_book_state && !suspend) continue;
    const decision = decide({
      state: p.book_state as BookState, stateSince: Date.parse(p.state_since),
      lastAbExitAt: p.last_ab_exit_at ? Date.parse(p.last_ab_exit_at) : null, now,
      points: points.get(p.person_id) ?? [], suspend,
      stage2ProfitPct: s?.stage2_profit_pct == null ? null : Number(s.stage2_profit_pct),
      herd: herd.has(p.person_id),
      runGate: gate.get(p.person_id) ?? null, kycVerified: kyc.has(p.person_id),
    }, policy);
    if (!decision) continue;
    const { data: applied, error } = await db.rpc("ab_apply_transition", {
      p_person: p.person_id, p_from: p.book_state, p_to: decision.to, p_reason: decision.reason,
      p_evidence: decision.evidence, p_policy_version: policy.version,
    });
    if (error || !applied) { conflicts++; continue; }
    moved++;
    finalState.set(p.person_id, decision.to);
    moves.push({ from: p.book_state, to: decision.to });
  }
  let metrics = 0, metricsError: string | undefined;
  try { metrics = await writeMetrics(db, profiles ?? [], finalState, points, sig, herd, policy); }
  catch (e) { metricsError = String((e as Error)?.message ?? e); }
  return json({ ok: true, policy: policy.version, people: profiles?.length ?? 0, withEvidence: points.size, herd: herd.size, moved, conflicts, moves, metrics, metricsError, ms: Date.now() - started });
}

// Inputs for the v5 copy gate. Skipped (empty) while the active policy does not use the gate or the identity rule.
// deno-lint-ignore no-explicit-any
async function gateInputs(db: any, policy: Policy) {
  const gate = new Map<string, { score: number; counted: number; startedAt: number }>(), kyc = new Set<string>();
  if (!Number.isFinite(policy.gateRunScore) && !policy.gateRequireKyc) return { gate, kyc };
  const { data: runs, error } = await db.rpc("ab_copy_gate_inputs");
  if (error) throw new Error(error.message);
  const owner = new Map<string, string>(), started = new Map<string, number>();
  for (const r of runs ?? []) {
    if (r.kyc_verified) kyc.add(r.person_id);
    started.set(r.person_id, Date.parse(r.run_started_at));
    for (const a of r.run_accounts ?? []) owner.set(a, r.person_id);
  }
  if (!Number.isFinite(policy.gateRunScore)) return { gate, kyc };
  const ids = [...owner.keys()], rows = new Map<string, GateTrade[]>(), ledgerRisk = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    for (let from = 0; ; from += 1000) {
      const { data, error: e } = await db.from("trades").select("id,parent_trade_id,account_id,symbol,side,opened_at,closed_at,pnl,initial_risk_usd,status")
        .in("account_id", chunk).order("id", { ascending: true }).range(from, from + 999);
      if (e) throw new Error("trades: " + e.message);
      for (const t of data ?? []) {
        const person = owner.get(t.account_id)!;
        const list = rows.get(person) ?? [];
        list.push({ id: t.id, parentId: t.parent_trade_id, accountId: t.account_id, symbol: t.symbol, side: t.side, openedAt: Date.parse(t.opened_at),
          closedAt: t.status === "closed" && t.closed_at ? Date.parse(t.closed_at) : null, pnlUsd: Number(t.pnl ?? 0),
          riskUsd: t.initial_risk_usd == null ? null : Number(t.initial_risk_usd) });
        rows.set(person, list);
      }
      if (!data || data.length < 1000) break;
    }
    // v1 trades have no stored opening risk: use the ledger's stop-loss risk for the same trade.
    for (let from = 0; ; from += 1000) {
      const { data, error: e } = await db.from("ab_trade_ledger").select("trade_id,risk_usd").in("account_id", chunk).eq("risk_basis", "STOP_LOSS")
        .order("trade_id", { ascending: true }).range(from, from + 999);
      if (e) throw new Error("ledger risk: " + e.message);
      for (const r of data ?? []) if (Number(r.risk_usd) > 0) ledgerRisk.set(r.trade_id, Number(r.risk_usd));
      if (!data || data.length < 1000) break;
    }
  }
  for (const [person, list] of rows) {
    for (const t of list) if (t.riskUsd == null && !t.parentId) t.riskUsd = ledgerRisk.get(t.id) ?? null;
    gate.set(person, { ...runGate(list), startedAt: started.get(person) ?? 0 });
  }
  return { gate, kyc };
}

// Brain control room metrics: every person's performance, evidence and tags (see _shared/brain.ts).
// deno-lint-ignore no-explicit-any
async function writeMetrics(db: any, profiles: Array<{ person_id: string; book_state: string; state_since: string; last_ab_exit_at: string | null; manual_book_state?: string | null }>, state: Map<string, BookState>, points: Map<string, LedgerPoint[]>,
  // deno-lint-ignore no-explicit-any
  sig: Map<string, any>, herd: Set<string>, policy: Policy): Promise<number> {
  const rows = new Map<string, LedgerRow[]>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("ab_trade_ledger").select("person_id,closed_at,trader_pnl_usd,trader_r,hold_seconds,risk_basis")
      .order("closed_at", { ascending: true }).order("trade_id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error("ledger rows: " + error.message);
    for (const r of data ?? []) {
      const list = rows.get(r.person_id) ?? [];
      list.push({ closedAt: Date.parse(r.closed_at), pnlUsd: Number(r.trader_pnl_usd ?? 0), traderR: r.trader_r == null ? null : Number(r.trader_r),
        holdSeconds: Number(r.hold_seconds ?? 0), riskBasis: r.risk_basis });
      rows.set(r.person_id, list);
    }
    if (!data || data.length < 1000) break;
  }
  const { data: snap } = await db.from("treasury_snapshots").select("id").order("as_of", { ascending: false }).limit(1).maybeSingle();
  const payout = new Map<string, { e: number; p: number }>();
  if (snap) {
    const { data: fc, error } = await db.from("treasury_account_forecasts").select("person_id,expected_payout,p_graduate").eq("snapshot_id", snap.id);
    if (error) throw new Error("forecasts: " + error.message);
    for (const f of fc ?? []) {
      const cur = payout.get(f.person_id) ?? { e: 0, p: 0 };
      payout.set(f.person_id, { e: cur.e + Number(f.expected_payout ?? 0), p: Math.max(cur.p, Number(f.p_graduate ?? 0)) });
    }
  }
  const { data: br, error: brErr } = await db.from("ab_person_breaches_7d").select("person_id,breaches");
  if (brErr) throw new Error("breaches: " + brErr.message);
  const breaches = new Map<string, number>((br ?? []).map((b: { person_id: string; breaches: number }): [string, number] => [b.person_id, Number(b.breaches)]));
  const asOf = new Date().toISOString();
  const out = profiles.map((p) => {
    const s = sig.get(p.person_id), pay = payout.get(p.person_id);
    const m = personMetrics(rows.get(p.person_id) ?? [], points.get(p.person_id) ?? [], {
      state: state.get(p.person_id) ?? "BB_DEMO", herd: herd.has(p.person_id), hold: !!s?.investigation_hold, criticalFlag: !!s?.critical_flag,
      breaches7d: breaches.get(p.person_id) ?? 0, expectedPayout: pay?.e ?? null, pGraduate: pay?.p ?? null,
    }, policy);
    const currentState=state.get(p.person_id) ?? 'BB_DEMO';
    const review=bLiveReview({ state:currentState, stateSince:currentState===p.book_state?Date.parse(p.state_since):Date.parse(asOf),
      lastAbExitAt:p.last_ab_exit_at?Date.parse(p.last_ab_exit_at):null, now:Date.parse(asOf), points:points.get(p.person_id)??[],
      suspend:s?.investigation_hold?'investigation':s?.critical_flag?'safety flag':null,
      stage2ProfitPct:s?.stage2_profit_pct==null?null:Number(s.stage2_profit_pct),herd:herd.has(p.person_id),
    },policy,!!p.manual_book_state);
    return { person_id: p.person_id, as_of: asOf, ...m, b_review:review };
  });
  for (let i = 0; i < out.length; i += 500) {
    const { error } = await db.from("ab_trader_metrics").upsert(out.slice(i, i + 500), { onConflict: "person_id" });
    if (error) throw new Error("metrics upsert: " + error.message);
  }
  return out.length;
}
