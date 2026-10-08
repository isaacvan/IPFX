// Owner-only Brain control room (Team -> Brain page). Read-only view of the A/B-book brain: alerts, books,
// traders, moves and system health. Owner model changes and alert acknowledgements are audited. Requires the owner's
// signed-in MFA (aal2) session, like ladder-admin.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { allowRequest, readJsonObject } from "../_shared/request-guards.ts";

const ORIGINS = new Set(["https://ipfxcapital.com", "https://www.ipfxcapital.com", "http://localhost:3000", "http://localhost:8127"]);
const JOBS = [
  ["ipfx-ab-ledger", "Trade ledger", 300], ["ipfx-ab-classifier", "Classifier trigger", 300], ["ipfx-brain-scan", "Alert scan", 60],
  ["ipfx-treasury", "Payout forecast", 10800], ["ipfx-book-reconcile", "Order reconciler", 300], ["ipfx-drawdown-sweep", "Account rule checks", 120],
  ["ipfx-quote-pump", "Price pump", 120], ["ipfx-demo-mirror-outbox", "Demo mirror", 300], ["ipfx-trader-detector", "Trader detector", 1800],
] as const;
const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, good: 2, info: 3 };
type BrainProfile = { person_id: string; book_state: string; state_since?: string; state_reason?: string;
  last_trade_at?: string; manual_book_state?: string | null; manual_since?: string | null; manual_reason?: string | null };

function aal(token: string): string {
  try { const raw = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); return String(JSON.parse(atob(raw + "=".repeat((4 - raw.length % 4) % 4))).aal ?? ""); }
  catch (_) { return ""; }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "https://ipfxcapital.com";
  const allowed = ORIGINS.has(origin) ? origin : "https://ipfxcapital.com";
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowed, "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin", "Cache-Control": "no-store" };
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST" || !ORIGINS.has(origin)) return json({ ok: false, error: "Not allowed" }, 403);
  const authHeader = req.headers.get("authorization") || "";
  const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await auth.auth.getUser();
  if (!user || aal(authHeader.replace(/^Bearer\s+/i, "")) !== "aal2") return json({ ok: false, error: "Owner MFA session required" }, 401);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const ownerEmail = String(Deno.env.get("IPFX_OWNER_EMAIL") || "paulade491@gmail.com").trim().toLowerCase();
  const { data: admin } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!admin || String(user.email || "").toLowerCase() !== ownerEmail) return json({ ok: false, error: "Owner access only" }, 403);
  if (!await allowRequest(db, "brain-monitor", user.id, 120, 60)) return json({ ok: false, error: "Too many requests" }, 429);
  const body = await readJsonObject(req, 4_096).catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ ok: false, error: "Invalid request" }, 400);
  const action = String(body.action || "overview");

  // "overview" = everything (about once a minute); "pulse" = the fast-moving parts only, for the 10-second refresh:
  // alerts, tiles, books, health. Traders, moves and replay series come with the next overview.
  if (action === "overview" || action === "pulse") {
    const light = action === "pulse";
    const none = Promise.resolve({ data: null });
    const since90 = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const since24 = new Date(Date.now() - 86_400_000).toISOString();
    const [open, resolved, profiles, metrics, events, limits, settings, pol, reservations, livePnl, paper, orders, skips, snap, beats, prices, mkt, ladders, ...jobs] = await Promise.all([
      db.from("ab_alerts").select("id,key,severity,category,title,detail,person_id,value,first_seen,last_seen,acknowledged_at").is("resolved_at", null).limit(500),
      db.from("ab_alerts").select("id,severity,category,title,person_id,first_seen,resolved_at").gte("resolved_at", since24).order("resolved_at", { ascending: false }).limit(60),
      db.from("ab_trader_profiles").select(light ? "person_id,book_state" : "person_id,book_state,state_since,state_reason,last_trade_at,manual_book_state,manual_since,manual_reason").returns<BrainProfile[]>(),
      light ? db.from("ab_trader_metrics").select("as_of").order("as_of", { ascending: false }).limit(1) : db.from("ab_trader_metrics").select("*"),
      light ? none : db.from("ab_lifecycle_events").select("id,person_id,from_state,to_state,reason,created_at,policy_version").order("created_at", { ascending: false }).limit(100),
      db.from("ab_risk_limits").select("book,daily_loss_stop_usd,daily_profit_cap_usd,open_risk_max_usd,per_trade_max_usd,crowd_max,account_size_usd"),
      db.from("ab_settings").select("book_halt,payout_model").maybeSingle(),
      db.from("ab_policy_versions").select("version,note,created_at").eq("status", "ACTIVE").maybeSingle(),
      db.from("ab_risk_reservations").select("book,risk_usd").eq("status", "active"),
      db.from("book_daily_pnl").select("book,day,pnl_usd").gte("day", since90),
      light ? none : db.rpc("ab_paper_book_daily", { p_days: 90 }),
      db.from("book_orders").select("book,event,status,pnl_usd,latency_ms,created_at").gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString()).limit(20000),
      db.from("ab_copy_skips").select("book,reason").gte("created_at", since24).limit(20000),
      db.from("treasury_snapshots").select("as_of,status,liab_30d,liab_90d,liab_90d_p90,assets_usd,open_accounts").order("as_of", { ascending: false }).limit(1).maybeSingle(),
      db.from("ab_heartbeats").select("worker,ok,at,detail"),
      db.from("live_quotes").select("received_at").order("received_at", { ascending: false }).limit(1).maybeSingle(),
      db.rpc("ab_fx_market_open"),
      db.from("ladder_accounts").select("id,label,status,execution_enabled"),
      ...JOBS.map(([job]) => db.rpc("ab_cron_health", { p_job: job })),
    ]);

    const costs = light ? null : await db.rpc("cost_summary", { p_days: 7 });
    const shadow = light ? null : await db.rpc("shadow_funded_summary", { p_days: 7, p_funded: 50000 });
    const accountContexts: Record<string,unknown[]|null>={};
    const people=(profiles.data??[]).map(p=>p.person_id);
    for(let i=0;i<people.length;i+=500){
      const batch=people.slice(i,i+500);for(const id of batch)accountContexts[id]=null;
      const {data:contexts,error}=await db.rpc("ab_brain_account_context",{p_people:batch});
      if(!error){for(const id of batch)accountContexts[id]=[];for(const row of contexts??[])accountContexts[row.person_id]=row.accounts;}
    }
    const ids = [...new Set([...(light ? [] : (profiles.data ?? []).map((p) => p.person_id)), ...(open.data ?? []).map((a) => a.person_id).filter(Boolean),
      ...(resolved.data ?? []).map((a) => a.person_id).filter(Boolean)])];
    const names = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 500) {
      const { data } = await db.from("user_profiles").select("user_id,full_name").in("user_id", ids.slice(i, i + 500));
      for (const p of data ?? []) if (p.full_name) names.set(p.user_id, p.full_name);
    }
    const label = (id: string | null) => id ? names.get(id) ?? "Trader " + id.slice(0, 6) : null;
    const m = new Map((metrics.data ?? []).map((x) => [x.person_id, x]));
    const traders = (profiles.data ?? []).map((p) => ({ ...p, name: label(p.person_id), metrics: m.get(p.person_id) ?? null, accounts: accountContexts[p.person_id] }));
    const counts: Record<string, number> = {};
    for (const p of profiles.data ?? []) counts[p.book_state] = (counts[p.book_state] ?? 0) + 1;

    const openRisk: Record<string, number> = {};
    for (const r of reservations.data ?? []) { const k = String(r.book).startsWith("l") ? "ladder" : r.book; openRisk[k] = (openRisk[k] ?? 0) + Number(r.risk_usd); }
    const stats: Record<string, { closed: number; wins: number; pnl: number; errors: number; open: number; latency: number[] }> = {};
    for (const o of orders.data ?? []) {
      const k = String(o.book).startsWith("l") ? "ladder" : o.book;
      const s = stats[k] ??= { closed: 0, wins: 0, pnl: 0, errors: 0, open: 0, latency: [] };
      if (o.status === "error" || o.status === "reconciliation_required") s.errors++;
      if (o.event === "open" && o.latency_ms != null) s.latency.push(Number(o.latency_ms));
      if (o.event !== "open" && o.status === "closed" && o.pnl_usd != null) { s.closed++; s.pnl += Number(o.pnl_usd); if (Number(o.pnl_usd) > 0) s.wins++; }
    }
    const execution = Object.fromEntries(Object.entries(stats).map(([k, s]) => {
      const lat = s.latency.sort((a, b) => a - b);
      return [k, { closed: s.closed, wins: s.wins, pnl: Math.round(s.pnl * 100) / 100, errors: s.errors, p50_latency_ms: lat.length ? lat[Math.floor(lat.length / 2)] : null, p95_latency_ms: lat.length ? lat[Math.floor(lat.length * 0.95)] : null }];
    }));
    const skipMap = new Map<string, number>();
    for (const s of skips.data ?? []) { const k = (String(s.book).startsWith("l") ? "ladder" : s.book) + "|" + s.reason; skipMap.set(k, (skipMap.get(k) ?? 0) + 1); }
    const alerts = (open.data ?? []).map((a) => ({ ...a, name: label(a.person_id) }))
      .sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || (Date.parse(b.first_seen) - Date.parse(a.first_seen)));

    return json({
      ok: true, light, generated_at: new Date().toISOString(), metrics_as_of: light ? (metrics.data?.[0]?.as_of ?? null) : (metrics.data ?? []).reduce((a: string | null, x: { as_of: string }) => !a || x.as_of > a ? x.as_of : a, null), policy: pol.data, settings: settings.data, counts,
      alerts, account_contexts: accountContexts, resolved: (resolved.data ?? []).map((a) => ({ ...a, name: label(a.person_id) })),
      health: {
        jobs: JOBS.map(([job, title, maxAge], i) => {
          const h = (jobs[i] as { data: Array<{ age_s: number | null; last_status: string | null }> | null }).data?.[0];
          const age = h?.age_s == null ? null : Number(h.age_s);
          return { job, title, age_s: age, last_status: h?.last_status ?? null, ok: age != null && age <= maxAge && h?.last_status !== "failed" };
        }),
        heartbeats: beats.data ?? [], prices_at: prices.data?.received_at ?? null, market_open: mkt.data === true,
      },
      books: {
        limits: limits.data ?? [], open_risk: openRisk, live_daily: livePnl.data ?? [], ...(light ? {} : { paper_daily: paper.data ?? [] }), execution,
        skips: [...skipMap.entries()].map(([k, n]) => ({ book: k.split("|")[0], reason: k.split("|").slice(1).join("|"), n })).sort((a, b) => b.n - a.n),
        ladder: { accounts: (ladders.data ?? []).length, copying: (ladders.data ?? []).filter((l) => l.execution_enabled).length },
      },
      treasury: snap.data, ...(light ? {} : { costs: costs?.data ?? null, shadow: shadow?.data ?? null, traders, events: (events.data ?? []).map((e) => ({ ...e, name: label(e.person_id) })) }),
    });
  }

  if (action === "trader") {
    const person = String(body.person_id || "");
    if (!/^[0-9a-f-]{36}$/i.test(person)) return json({ ok: false, error: "Choose a trader" }, 400);
    const [{ data, error }, routing, activity, context] = await Promise.all([
      db.rpc("ab_brain_person", { p_person: person }),db.rpc("ab_model_capabilities", { p_person: person }),
      db.rpc("ab_brain_live_activity", { p_person: person }),
      db.rpc("ab_brain_account_context",{p_people:[person]}),
    ]);
    if (error || !data) return json({ ok: false, error: "Trader not found" }, 404);
    if (routing.error || activity.error) return json({ ok: false, error: "Trader routing/activity unavailable" }, 503);
    return json({ ok: true, ...data, accounts: context.error ? null : (context.data?.[0]?.accounts??[]), routing: routing.data, activity: activity.data });
  }

  if (action === "set_model") {
    const person = String(body.person_id || ""), target = String(body.target || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(person) ||
      !["AB_DEMO", "AB_LIVE", "BB_DEMO", "BB_LIVE", "AUTOMATIC"].includes(target) ||
      typeof body.expected_state !== "string" || !(body.expected_manual == null || typeof body.expected_manual === "string") ||
      typeof body.reason !== "string" || body.reason.trim().length < 5 || body.reason.length > 300)
      return json({ ok: false, error: "Choose a trader/model and provide a reason" }, 400);
    const { data, error } = await db.rpc("ab_owner_set_model", {
      p_person: person, p_target: target, p_expected_state: body.expected_state,
      p_expected_manual: body.expected_manual ?? null, p_reason: body.reason.trim(), p_actor: user.id,
    });
    if (error) return json({ ok: false, error: "Model change unconfirmed; refresh the trader before retrying" }, 503);
    if (!data?.ok) return json({ ok: false, error: data?.error || "Model change refused", routing: data?.routing }, 409);
    return json(data);
  }

  if (action === "find_traders") {
    const term = typeof body.query === "string" ? body.query.trim() : "";
    if (term.length < 3 || term.length > 80) return json({ ok: false, error: "Enter at least three characters of the registered name" }, 400);
    const { data, error } = await db.from("user_profiles").select("user_id,full_name")
      .ilike("full_name", "%" + term.replace(/[\\%_]/g, "\\$&") + "%").limit(20);
    if (error) return json({ ok: false, error: "Registered trader search unavailable" }, 503);
    return json({ ok: true, results: data ?? [] });
  }
  if (action === "add_trader") {
    const id = String(body.user_id || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return json({ ok: false, error: "Choose a registered trader" }, 400);
    const { data, error } = await db.rpc("ab_owner_enroll_model", { p_user: id, p_actor: user.id });
    if (error) return json({ ok: false, error: "Adding trader unconfirmed; refresh before retrying" }, 503);
    return json(data ?? { ok: false, error: "Trader not found" }, data?.ok ? 200 : 409);
  }

  if (action === "ack") {
    const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(Number).filter((x) => x > 0).slice(0, 500);
    if (!ids.length) return json({ ok: false, error: "Nothing to acknowledge" }, 400);
    await db.from("ab_alerts").update({ acknowledged_at: new Date().toISOString(), acknowledged_by: user.id }).in("id", ids).is("resolved_at", null);
    await db.from("admin_audit_log").insert({ actor_id: user.id, action: "brain_alert_ack", detail: { ids } });
    return json({ ok: true, acknowledged: ids.length });
  }
  return json({ ok: false, error: "Unknown action" }, 400);
});
