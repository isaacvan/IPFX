// Treasury worker (hourly via pg_cron, dedicated secret). Forecasts payout liability per open Infinity
// account and in total, compares it with cash that can actually pay it, and stores a snapshot + status.
// Cash counted: the owner-entered starting reserve, payouts actually received from prop-firm accounts
// (ladder_payouts), and realised book P&L on LIVE destinations only (demo P&L is never cash).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { coverageStatus, forecastAccount, liabilityWithin, type AccountState } from "../_shared/treasury.ts";
import { ladderDecision } from "../_shared/ladder.ts";

function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const secret = Deno.env.get("TREASURY_SECRET") ?? "";
  if (req.method !== "POST" || secret.length < 32 || !constantTimeEqual(req.headers.get("x-treasury-secret") ?? "", secret)) return json({ error: "unauthorised" }, 401);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: settings, error: settingsError } = await db.from("ab_settings").select("payout_model,starting_reserve_usd,sponsor_fee_usd").maybeSingle();
  const unavailable = async (source: string) => {
    // Append an explicit invalidation; never refresh a prior healthy cash value on a failed read.
    const { error } = await db.from("treasury_snapshots").insert({ payout_model: "cash_at_stage3", open_accounts: 0,
      liab_7d: 0, liab_30d: 0, liab_60d: 0, liab_90d: 0, liab_30d_p90: 0, liab_90d_p90: 0,
      graduates_30d: 0, graduates_90d: 0, stage4_monthly: 0, assets_usd: null, coverage_90d: null,
      status: "unknown", complete: false, notes: { source_error: source, figures_unavailable: true } });
    return json({ ok: false, error: source, status: "unknown", invalidation_saved: !error }, 503);
  };
  if (settingsError || !settings) return unavailable("SETTINGS_UNAVAILABLE");
  const model = (settings?.payout_model ?? "cash_at_stage3") as "cash_at_stage3" | "sponsored_account";

  const accounts: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("treasury_open_accounts")
      .select("id,person_id,stage,starting_balance,balance,trailing_peak,profit_target_pct,max_drawdown_pct,max_risk_per_trade_pct")
      .order("id").range(from, from + 999);
    if (error) return unavailable("ACCOUNTS_UNAVAILABLE");
    accounts.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  // Trader results per person (R per trade, from the ledger; needs a stop loss, which Infinity requires).
  const rByPerson = new Map<string, number[]>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("ab_trade_ledger").select("person_id,trader_r").not("trader_r", "is", null)
      .order("closed_at", { ascending: true }).order("trade_id", { ascending: true }).range(from, from + 999);
    if (error) return unavailable("LEDGER_UNAVAILABLE");
    for (const r of data ?? []) { const l = rByPerson.get(r.person_id) ?? []; l.push(Math.max(-3, Math.min(5, Number(r.trader_r)))); rByPerson.set(r.person_id, l); }
    if (!data || data.length < 1000) break;
  }
  const forecasts = accounts.map((a) => {
    const person = String(a.person_id);
    const state: AccountState = {
      accountId: String(a.id), personId: person, stage: Number(a.stage), startingBalance: Number(a.starting_balance),
      balance: Number(a.balance), peak: Math.max(Number(a.trailing_peak ?? a.balance), Number(a.balance)),
      targetPct: Number(a.profit_target_pct), maxDdPct: Number(a.max_drawdown_pct), riskPct: Number(a.max_risk_per_trade_pct) / 100,
      traderR: rByPerson.get(person) ?? [],
    };
    return forecastAccount(state, model, Number(settings?.sponsor_fee_usd ?? 350));
  });
  const h7 = liabilityWithin(forecasts, 7), h30 = liabilityWithin(forecasts, 30), h60 = liabilityWithin(forecasts, 60), h90 = liabilityWithin(forecasts, 90);
  const stage4Monthly = forecasts.reduce((a, f) => a + f.s4MonthlyPayout, 0);

  async function total(table: string, column: string) {
    let sum = 0;
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from(table).select("id," + column).order("id").range(from, from + 999);
      if (error) return null;
      for (const row of data ?? []) { const value = Number((row as unknown as Record<string, unknown>)[column]); if (!Number.isFinite(value)) return null; sum += value; }
      if (!data || data.length < 1000) return sum;
    }
  }
  const ladderCash = await total("ladder_payouts", "amount_usd"), feesPaid = await total("ladder_accounts", "fee_usd");
  if (ladderCash == null || feesPaid == null) return unavailable("CASH_INPUTS_UNAVAILABLE");
  const reserve = settings?.starting_reserve_usd == null ? null : Number(settings.starting_reserve_usd);
  const assets = reserve == null ? null : reserve + ladderCash - feesPaid;   // live-destination book P&L: none exist yet (demo only)
  const status = coverageStatus(assets, h90.p90);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const { data: snap, error: snapErr } = await db.from("treasury_snapshots").insert({
    payout_model: model, open_accounts: accounts.length,
    liab_7d: r2(h7.expected), liab_30d: r2(h30.expected), liab_60d: r2(h60.expected), liab_90d: r2(h90.expected),
    liab_30d_p90: r2(h30.p90), liab_90d_p90: r2(h90.p90), graduates_30d: r2(h30.graduates), graduates_90d: r2(h90.graduates),
    stage4_monthly: r2(stage4Monthly), reserve_usd: reserve, ladder_cash_usd: r2(ladderCash - feesPaid), live_book_pnl_30d: 0,
    complete: false,
    assets_usd: assets == null ? null : r2(assets), coverage_90d: assets == null || h90.p90 <= 0 ? null : r2(assets / h90.p90), status: "unknown",
    notes: { method: "posterior x stage table; independent-outcome P90 with 1.5x factor (dependence uncalibrated)", reserve_missing: reserve == null, cash_basis: "owner reserve plus recorded receipts minus fees; bank reconciliation unverified", dependence_stress_usd: r2(forecasts.reduce((s, f) => s + f.payoutIfGraduate, 0)), model_status: "ESTIMATE", details_complete: false },
  }).select("id").single();
  if (snapErr || !snap) return json({ error: "snapshot write failed" }, 503);
  const rows = forecasts.map((f) => ({ snapshot_id: snap.id, account_id: f.accountId, person_id: f.personId, stage: f.stage,
    p_graduate: Number(f.pGraduate.toFixed(5)), expected_days: Number(f.expectedDays.toFixed(1)), payout_if_graduate: r2(f.payoutIfGraduate),
    expected_payout: r2(f.expectedPayout), stage4_monthly: r2(f.s4MonthlyPayout), mu_mean: Number(f.muMean.toFixed(4)), trades: f.trades }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("treasury_account_forecasts").insert(rows.slice(i, i + 500));
    if (error) return unavailable("FORECAST_DETAILS_WRITE_FAILED");
  }
  const { error: completionError } = await db.from("treasury_snapshots").update({ complete: true, status }).eq("id", snap.id);
  if (completionError) return unavailable("SNAPSHOT_COMPLETION_FAILED");

  // Evaluation-ladder recommendation (the owner acts on it; nothing is bought automatically).
  const [{ data: ls }, { data: ev }, { data: activeRows }] = await Promise.all([
    db.from("ladder_settings").select("*").maybeSingle(),
    db.rpc("ladder_gate_evidence", { p_days: 30 }),
    db.from("ladder_accounts").select("id").in("status", ["evaluation", "funded"]),
  ]);
  let recommendation = null;
  if (ls) {
    const d = ladderDecision({ seed: Number(ls.seed_budget_usd), reinvest: Number(ls.reinvest_fraction), fee: Number(ls.default_fee_usd),
      maxActive: Number(ls.max_active_accounts), minTrades: Number(ls.gate_min_trades), breakEvenR: Number(ls.gate_break_even_r) },
      { trades: Number(ev?.trades ?? 0), meanR: ev?.mean_r == null ? null : Number(ev.mean_r), days: Number(ev?.days ?? 0),
        dayMean: ev?.day_mean == null ? null : Number(ev.day_mean), daySd: ev?.day_sd == null ? null : Number(ev.day_sd) },
      (activeRows ?? []).length, ladderCash, feesPaid);
    await db.from("ladder_recommendations").insert({ action: d.action, accounts: d.accounts, budget_usd: r2(d.budget), reason: d.reason, evidence: { ...ev, lower: d.lower, gate: d.gate } });
    recommendation = d;
  }
  return json({ ok: true, snapshot: snap.id, accounts: accounts.length, liab_30d: r2(h30.expected), liab_90d_p90: r2(h90.p90), status, ladder: recommendation });
});
