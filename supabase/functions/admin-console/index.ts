// ============================================================
// IPFX Capital — admin-console Edge Function
//
// Powers the admin/verification page. Every action requires the
// caller to be listed in public.admins (fail-closed). Uses the
// service role internally so the browser never holds it.
//
// Actions (POST JSON):
//   { action:"overview" }
//       -> { is_admin, traders:[...] } for every trader/account
//   { action:"set_mirror", user_id, enabled, metaapi_account_id?, region?, volume_multiplier? }
//       -> enable/disable live mirroring for one trader
//   { action:"payout_create", account_id }
//       -> snapshot current owed into a pending payout
//   { action:"payout_mark_paid", payout_id }
//   { action:"set_split", user_id, profit_split_pct }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => json({ ok: false, error: m }, s);

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Trade = any;

const r2 = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const stddev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

// Bucket a UTC hour (0-23) into the FX session it falls in.
function sessionOf(hourUtc: number): "Asia" | "London" | "Overlap" | "New York" | "Off-hours" {
  if (hourUtc >= 0 && hourUtc < 8) return "Asia";
  if (hourUtc >= 8 && hourUtc < 13) return "London";
  if (hourUtc >= 13 && hourUtc < 17) return "Overlap";
  if (hourUtc >= 17 && hourUtc < 22) return "New York";
  return "Off-hours";
}

// ============================================================
// buildStrategyProfile — reconstructs a trader's playbook purely from
// their own trade records: which instruments, which side, how they use
// SL/TP, how long they hold, when they trade, how they size positions,
// and whether their behaviour shows martingale sizing or revenge
// trading after a loss. Everything here is derived, not self-reported.
// ============================================================
function buildStrategyProfile(allTrades: Trade[]) {
  const trades = [...allTrades].sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime());
  const closed = trades.filter((t) => t.status === "closed" && t.closed_at && t.pnl !== null);
  const n = closed.length;

  if (n === 0) {
    return {
      trades_total: trades.length, trades_closed: 0,
      summary_text: trades.length
        ? "No closed trades yet — not enough history to infer a strategy."
        : "This account has not placed any trades.",
    };
  }

  // --- symbol breakdown ---
  const bySymbol = new Map<string, Trade[]>();
  for (const t of closed) { const k = t.symbol; if (!bySymbol.has(k)) bySymbol.set(k, []); bySymbol.get(k)!.push(t); }
  const symbolBreakdown = [...bySymbol.entries()].map(([symbol, ts]) => {
    const wins = ts.filter((t) => Number(t.pnl) > 0).length;
    const pnl = ts.reduce((s, t) => s + Number(t.pnl), 0);
    return { symbol, trades: ts.length, pct: r2((ts.length / n) * 100), win_rate: r2((wins / ts.length) * 100), total_pnl: r2(pnl) };
  }).sort((a, b) => b.trades - a.trades);
  const topSymbolPct = symbolBreakdown[0]?.pct ?? 0;

  // --- side bias ---
  const buys = closed.filter((t) => t.side === "buy").length;
  const sideBias = { buy_pct: r2((buys / n) * 100), sell_pct: r2(((n - buys) / n) * 100) };

  // --- SL/TP usage & planned R:R (distance as % of entry price, scale-free across instruments) ---
  const withSl = trades.filter((t) => t.sl !== null);
  const withTp = trades.filter((t) => t.tp !== null);
  const slDist: number[] = [], tpDist: number[] = [], rr: number[] = [];
  for (const t of trades) {
    const entry = Number(t.open_price);
    if (!entry) continue;
    const sD = t.sl !== null ? Math.abs(entry - Number(t.sl)) / entry * 100 : null;
    const tD = t.tp !== null ? Math.abs(Number(t.tp) - entry) / entry * 100 : null;
    if (sD !== null) slDist.push(sD);
    if (tD !== null) tpDist.push(tD);
    if (sD !== null && tD !== null && sD > 0) rr.push(tD / sD);
  }

  // --- hold time ---
  const holdMins = closed.map((t) => (new Date(t.closed_at).getTime() - new Date(t.opened_at).getTime()) / 60000);
  const avgHold = mean(holdMins), medHold = median(holdMins);
  const style = avgHold < 15 ? "scalper" : avgHold < 240 ? "intraday trader" : avgHold < 2880 ? "swing trader" : "position trader";

  // --- session activity ---
  const sessionCounts: Record<string, number> = { Asia: 0, London: 0, Overlap: 0, "New York": 0, "Off-hours": 0 };
  for (const t of closed) sessionCounts[sessionOf(new Date(t.opened_at).getUTCHours())]++;
  const sessionPct = Object.fromEntries(Object.entries(sessionCounts).map(([k, v]) => [k, r2((v / n) * 100)]));
  const dominantSession = Object.entries(sessionCounts).sort((a, b) => b[1] - a[1])[0][0];

  // --- position sizing & martingale detection ---
  const vols = closed.map((t) => Number(t.volume));
  const avgVol = mean(vols), volStd = stddev(vols);
  let martingaleOpportunities = 0, martingaleHits = 0;
  for (let i = 0; i < closed.length - 1; i++) {
    const cur = closed[i], next = closed[i + 1];
    if (Number(cur.pnl) < 0) {
      martingaleOpportunities++;
      if (Number(next.volume) > Number(cur.volume) * 1.3) martingaleHits++;
    }
  }
  const martingaleScore = martingaleOpportunities ? r2((martingaleHits / martingaleOpportunities) * 100) : 0;

  // --- cadence & revenge-trading detection ---
  let revengeCount = 0, gapOpportunities = 0;
  const gapMins: number[] = [];
  for (let i = 0; i < closed.length - 1; i++) {
    const cur = closed[i], next = closed[i + 1];
    const gap = (new Date(next.opened_at).getTime() - new Date(cur.closed_at).getTime()) / 60000;
    if (gap >= 0) { gapMins.push(gap); gapOpportunities++; }
    if (Number(cur.pnl) < 0 && gap >= 0 && gap < 5 && Number(next.volume) >= Number(cur.volume)) revengeCount++;
  }
  const revengePct = gapOpportunities ? r2((revengeCount / gapOpportunities) * 100) : 0;
  const avgGapMins = mean(gapMins);

  // --- discipline: how trades actually closed ---
  const reasonCounts: Record<string, number> = { sl: 0, tp: 0, manual: 0, breach: 0 };
  for (const t of closed) { const r = t.close_reason || "manual"; reasonCounts[r] = (reasonCounts[r] ?? 0) + 1; }
  const ruleBasedPct = r2(((reasonCounts.sl + reasonCounts.tp) / n) * 100);

  // --- overall performance ---
  const wins = closed.filter((t) => Number(t.pnl) > 0);
  const losses = closed.filter((t) => Number(t.pnl) < 0);
  const grossWin = wins.reduce((s, t) => s + Number(t.pnl), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.pnl), 0));
  const winRate = r2((wins.length / n) * 100);
  const profitFactor = grossLoss > 0 ? r2(grossWin / grossLoss) : null;
  const bestWin = wins.length ? Math.max(...wins.map((t) => Number(t.pnl))) : 0;
  const consistencyPct = grossWin > 0 ? r2((bestWin / grossWin) * 100) : 0; // % of all profit from one trade

  // --- plain-English summary ---
  const parts: string[] = [];
  parts.push(`Primarily a ${style} (avg hold ${avgHold < 60 ? Math.round(avgHold) + "m" : (avgHold / 60).toFixed(1) + "h"})`);
  if (symbolBreakdown.length) parts.push(`trading mostly ${symbolBreakdown[0].symbol} (${symbolBreakdown[0].pct}% of trades)`);
  parts.push(`most active in the ${dominantSession} session (${sessionPct[dominantSession]}%)`);
  parts.push(`${sideBias.buy_pct > 60 ? "long-biased" : sideBias.sell_pct > 60 ? "short-biased" : "balanced long/short"}`);
  if (withSl.length / trades.length > 0.8) parts.push(`consistently uses stop-losses (${r2((withSl.length / trades.length) * 100)}% of orders)`);
  else if (withSl.length / trades.length < 0.3) parts.push(`rarely sets a stop-loss (only ${r2((withSl.length / trades.length) * 100)}% of orders) — a real risk flag`);
  if (rr.length) parts.push(`planned R:R averages 1:${mean(rr).toFixed(2)}`);
  if (martingaleScore > 40) parts.push(`⚠ shows martingale-like sizing — volume increases after a loss ${martingaleScore}% of the time`);
  if (revengePct > 20) parts.push(`⚠ shows revenge-trading signs — re-entered within 5 minutes of a loss, at equal/larger size, ${revengePct}% of the time`);
  if (consistencyPct > 50) parts.push(`⚠ ${consistencyPct}% of total profit came from a single trade — win rate may not be repeatable`);

  return {
    trades_total: trades.length, trades_closed: n,
    win_rate: winRate, profit_factor: profitFactor,
    symbol_breakdown: symbolBreakdown, top_symbol_concentration_pct: topSymbolPct,
    side_bias: sideBias,
    sl_usage_pct: r2((withSl.length / trades.length) * 100),
    tp_usage_pct: r2((withTp.length / trades.length) * 100),
    avg_sl_distance_pct: slDist.length ? r2(mean(slDist)) : null,
    avg_tp_distance_pct: tpDist.length ? r2(mean(tpDist)) : null,
    avg_planned_rr: rr.length ? r2(mean(rr)) : null,
    hold_time: { avg_minutes: r2(avgHold), median_minutes: r2(medHold), style },
    session_activity: sessionPct, dominant_session: dominantSession,
    sizing: { avg_volume: r2(avgVol), volume_stddev: r2(volStd), martingale_score_pct: martingaleScore, martingale_flag: martingaleScore > 40 },
    cadence: { avg_gap_minutes: r2(avgGapMins), revenge_trade_pct: revengePct, revenge_flag: revengePct > 20 },
    discipline: { close_reasons: reasonCounts, rule_based_close_pct: ruleBasedPct },
    consistency_pct: consistencyPct,
    summary_text: parts.join("; ") + ".",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return err("POST only", 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return err("bad json"); }

  // authenticate
  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return err("Not signed in", 401);

  const db: Db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // admin gate (fail-closed)
  const { data: adminRow } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  const isAdmin = !!adminRow;
  if (!isAdmin) return json({ ok: true, is_admin: false, traders: [] });

  const action = body.action;

  if (action === "overview") {
    const [{ data: accounts }, { data: profiles }, { data: targets }, { data: summary }, { data: payouts }, { data: stats }, { data: risk }, { data: claims }] =
      await Promise.all([
        db.from("trading_accounts").select("*").order("created_at", { ascending: false }),
        db.from("user_profiles").select("user_id,full_name,referral_code"),
        db.from("mirror_targets").select("*"),
        db.from("trader_payout_summary").select("*"),
        db.from("payouts").select("*").order("created_at", { ascending: false }),
        db.from("trader_stats").select("*"),
        db.from("trader_risk").select("*"),
        db.from("challenge_claims").select("challenge_type,account_type").limit(100000),
      ]);
    const statByAcct = new Map<string, Record<string, unknown>>();
    for (const s of stats ?? []) statByAcct.set(s.account_id, s);
    const riskByAcct = new Map<string, Record<string, unknown>>();
    for (const r of risk ?? []) riskByAcct.set(r.account_id, r);

    // emails via admin API (one page covers a small firm)
    const emailById = new Map<string, string>();
    try {
      const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      for (const u of list?.users ?? []) emailById.set(u.id, u.email ?? "");
    } catch (_) { /* emails optional */ }

    const nameById = new Map<string, string>();
    for (const p of profiles ?? []) nameById.set(p.user_id, p.full_name ?? "");
    const targetByUser = new Map<string, Record<string, unknown>>();
    for (const t of targets ?? []) targetByUser.set(t.user_id, t);
    const sumByAcct = new Map<string, Record<string, unknown>>();
    for (const s of summary ?? []) sumByAcct.set(s.account_id, s);

    const traders = (accounts ?? []).map((a: Record<string, unknown>) => {
      const s = sumByAcct.get(a.id as string);
      const tg = targetByUser.get(a.user_id as string);
      const st = statByAcct.get(a.id as string);
      const start = Number(a.starting_balance);
      const bal = Number(a.balance);
      return {
        user_id: a.user_id,
        account_id: a.id,
        full_name: nameById.get(a.user_id as string) || "—",
        email: emailById.get(a.user_id as string) || "",
        status: a.status,
        starting_balance: start,
        balance: bal,
        realized_pnl: Math.round((bal - start) * 100) / 100,
        profit_split_pct: Number(a.profit_split_pct ?? 85),
        realized_profit_unpaid: s ? Number(s.realized_profit_unpaid) : 0,
        trader_share_owed: s ? Number(s.trader_share_owed) : 0,
        mirror_enabled: !!a.mirror_enabled,
        mirror_target: tg ? { metaapi_account_id: tg.metaapi_account_id, region: tg.region, enabled: tg.enabled, volume_multiplier: tg.volume_multiplier, target_type: tg.target_type ?? "own_broker", firm_name: tg.firm_name ?? null } : null,
        stats: (() => {
          const rk = riskByAcct.get(a.id as string);
          const gw = st ? Number(st.gross_win) : 0;
          const bt = st ? Number(st.best_trade) : 0;
          // consistency: biggest single win as a share of all wins. Lower = steadier.
          const consistency = gw > 0 ? Math.round((bt / gw) * 100) : null;
          return st
            ? { trades: Number(st.trades), win_rate: st.win_rate == null ? null : Number(st.win_rate), profit_factor: st.profit_factor == null ? null : Number(st.profit_factor), avg_trade: Number(st.avg_trade), best_trade: bt, worst_trade: Number(st.worst_trade), max_drawdown_pct: rk ? Number(rk.max_drawdown_pct) : null, consistency_pct: consistency }
            : { trades: 0, win_rate: null, profit_factor: null, avg_trade: 0, best_trade: 0, worst_trade: 0, max_drawdown_pct: null, consistency_pct: null };
        })(),
      };
    });

    // ---- firm back-office rollup (money in/out, liability, exposure) ----
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const accts = accounts ?? [];
    const passed = accts.filter((a: Record<string, unknown>) => a.status === "passed").length;
    const breached = accts.filter((a: Record<string, unknown>) => a.status === "breached").length;
    const active = accts.filter((a: Record<string, unknown>) => a.status === "active").length;
    const mirrored = accts.filter((a: Record<string, unknown>) => a.mirror_enabled).length;
    const payoutLiability = r2((summary ?? []).reduce((s: number, x: Record<string, unknown>) => s + Number(x.trader_share_owed || 0), 0));
    const paidRows = (payouts ?? []).filter((p: Record<string, unknown>) => p.status === "paid");
    const pendingRows = (payouts ?? []).filter((p: Record<string, unknown>) => p.status === "pending" || p.status === "approved");
    const totalPaid = r2(paidRows.reduce((s: number, p: Record<string, unknown>) => s + Number(p.trader_share || 0), 0));
    const pendingPayouts = r2(pendingRows.reduce((s: number, p: Record<string, unknown>) => s + Number(p.trader_share || 0), 0));
    const netTraderPnl = r2(accts.reduce((s: number, a: Record<string, unknown>) => s + (Number(a.balance) - Number(a.starting_balance)), 0));
    const firm = {
      accounts_total: accts.length,
      active, passed, breached, mirrored,
      pass_rate: (passed + breached) > 0 ? Math.round((passed / (passed + breached)) * 1000) / 10 : null,
      challenge_claims: (claims ?? []).length,
      payout_liability: payoutLiability,   // owed to traders right now
      pending_payouts: pendingPayouts,     // recorded but not yet paid
      total_paid: totalPaid,               // money out to date
      net_trader_pnl: netTraderPnl,        // firm's net simulated position (neg = traders up)
    };

    return json({ ok: true, is_admin: true, firm, traders, payouts: payouts ?? [] });
  }

  if (action === "set_mirror") {
    const target_user = String(body.user_id ?? "");
    if (!target_user) return err("user_id required");
    const enabled = body.enabled === true;

    if (enabled) {
      const acctId = body.metaapi_account_id ? String(body.metaapi_account_id).trim() : "";
      if (!acctId) return err("metaapi_account_id required to enable");
      const region = body.region ? String(body.region) : "new-york";
      const mult = Number(body.volume_multiplier ?? 1) || 1;
      const targetType = body.target_type === "prop_firm" ? "prop_firm" : "own_broker";
      const firmName = body.firm_name ? String(body.firm_name).trim().slice(0, 80) : null;

      // one target per user: update if present, else insert
      const { data: existing } = await db.from("mirror_targets").select("id").eq("user_id", target_user).maybeSingle();
      const fields = {
        metaapi_account_id: acctId, region, volume_multiplier: mult,
        target_type: targetType, firm_name: firmName, enabled: true,
      };
      if (existing) {
        await db.from("mirror_targets").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", existing.id);
      } else {
        await db.from("mirror_targets").insert({ user_id: target_user, ...fields });
      }
    } else {
      await db.from("mirror_targets").update({ enabled: false, updated_at: new Date().toISOString() }).eq("user_id", target_user);
    }

    // the engine reads trading_accounts.mirror_enabled on the active account
    await db.from("trading_accounts").update({ mirror_enabled: enabled }).eq("user_id", target_user).eq("status", "active");
    return json({ ok: true });
  }

  if (action === "set_split") {
    const target_user = String(body.user_id ?? "");
    const pct = Number(body.profit_split_pct);
    if (!target_user || !isFinite(pct) || pct < 0 || pct > 100) return err("bad split");
    await db.from("trading_accounts").update({ profit_split_pct: pct }).eq("user_id", target_user).eq("status", "active");
    return json({ ok: true });
  }

  if (action === "payout_create") {
    const account_id = String(body.account_id ?? "");
    if (!account_id) return err("account_id required");
    const { data: s } = await db.from("trader_payout_summary").select("*").eq("account_id", account_id).maybeSingle();
    if (!s) return err("nothing to pay out", 404);
    const gross = Number(s.realized_profit_unpaid);
    const split = Number(s.profit_split_pct);
    const share = Math.round(Math.max(gross, 0) * split / 100 * 100) / 100;
    const { error } = await db.from("payouts").insert({
      user_id: s.user_id, account_id, period_end: new Date().toISOString(),
      gross_profit: Math.round(gross * 100) / 100, split_pct: split, trader_share: share, status: "pending",
    });
    if (error) return err("could not create payout", 500);
    return json({ ok: true, trader_share: share });
  }

  if (action === "payout_mark_paid") {
    const payout_id = String(body.payout_id ?? "");
    if (!payout_id) return err("payout_id required");
    await db.from("payouts").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", payout_id);
    return json({ ok: true });
  }

  // ---- private trader intelligence: every trade a trader has taken,
  // full execution audit, and an auto-inferred strategy profile.
  // Admin-only (gated above); nothing here is visible to the trader.
  if (action === "trader_detail") {
    const target_user = String(body.user_id ?? "");
    if (!target_user) return err("user_id required");

    const [{ data: accountsFor }, { data: profile }] = await Promise.all([
      db.from("trading_accounts").select("*").eq("user_id", target_user).order("created_at", { ascending: false }),
      db.from("user_profiles").select("full_name,referral_code").eq("user_id", target_user).maybeSingle(),
    ]);
    if (!accountsFor || !accountsFor.length) return err("No accounts for this trader", 404);

    let email = "";
    try {
      const { data: u } = await db.auth.admin.getUserById(target_user);
      email = u?.user?.email ?? "";
    } catch (_) { /* optional */ }

    const accountIds = accountsFor.map((a: Record<string, unknown>) => a.id);
    const [{ data: allTrades }, { data: auditEvents }] = await Promise.all([
      db.from("trades").select("*").in("account_id", accountIds).order("opened_at", { ascending: false }).limit(2000),
      db.from("order_audit_events").select("*").eq("user_id", target_user).order("server_ts", { ascending: false }).limit(2000),
    ]);

    const auditByTrade = new Map<string, Record<string, unknown>[]>();
    for (const ev of auditEvents ?? []) {
      const tid = ev.trade_id as string | null;
      if (!tid) continue;
      if (!auditByTrade.has(tid)) auditByTrade.set(tid, []);
      auditByTrade.get(tid)!.push(ev);
    }
    const tradesWithAudit = (allTrades ?? []).map((t: Record<string, unknown>) => ({
      ...t, audit: auditByTrade.get(t.id as string) ?? [],
    }));

    // one profile per account (a trader may have multiple challenge accounts
    // over time) plus a combined profile across everything.
    const perAccount = accountsFor.map((a: Record<string, unknown>) => {
      const ts = (allTrades ?? []).filter((t: Record<string, unknown>) => t.account_id === a.id);
      return { account_id: a.id, label: a.label, status: a.status, created_at: a.created_at, profile: buildStrategyProfile(ts) };
    });
    const combinedProfile = buildStrategyProfile(allTrades ?? []);
    const rejects = (auditEvents ?? []).filter((e: Record<string, unknown>) => e.event === "reject");

    return json({
      ok: true,
      user_id: target_user,
      full_name: profile?.full_name || "—",
      email,
      accounts: accountsFor,
      trades: tradesWithAudit,
      reject_events: rejects,
      per_account_profile: perAccount,
      combined_profile: combinedProfile,
    });
  }

  return err("unknown action");
});
