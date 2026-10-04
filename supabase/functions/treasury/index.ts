// Treasury worker (hourly via pg_cron, dedicated secret). Forecasts payout liability per open Infinity
// account and in total, compares it with cash that can actually pay it, and stores a snapshot + status.
// Cash counted: the owner-entered starting reserve, payouts actually received from prop-firm accounts
// (ladder_payouts), and realised book P&L on LIVE destinations only (demo P&L is never cash).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { coverageStatus, forecastAccount, liabilityWithin, type AccountState } from "../_shared/treasury.ts";

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
  const { data: settings } = await db.from("ab_settings").select("payout_model,starting_reserve_usd,sponsor_fee_usd").maybeSingle();
  const model = (settings?.payout_model ?? "cash_at_stage3") as "cash_at_stage3" | "sponsored_account";

  const accounts: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("treasury_open_accounts")
      .select("id,person_id,stage,starting_balance,balance,trailing_peak,profit_target_pct,max_drawdown_pct,max_risk_per_trade_pct")
      .order("id").range(from, from + 999);
    if (error) return json({ error: "accounts unavailable" }, 503);
    accounts.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  // Trader results per person (R per trade, from the ledger; needs a stop loss, which Infinity requires).
  const rByPerson = new Map<string, number[]>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("ab_trade_ledger").select("person_id,trader_r").not("trader_r", "is", null)
      .order("closed_at", { ascending: true }).order("trade_id", { ascending: true }).range(from, from + 999);
    if (error) return json({ error: "ledger unavailable" }, 503);
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

  const ladder = await db.from("ladder_payouts").select("amount_usd").gte("received_at", "2000-01-01");
  const ladderCash = ladder.error ? 0 : (ladder.data ?? []).reduce((a: number, r: Record<string, unknown>) => a + Number(r.amount_usd), 0);
  const ladderFees = await db.from("ladder_accounts").select("fee_usd");
  const feesPaid = ladderFees.error ? 0 : (ladderFees.data ?? []).reduce((a: number, r: Record<string, unknown>) => a + Number(r.fee_usd ?? 0), 0);
  const reserve = settings?.starting_reserve_usd == null ? null : Number(settings.starting_reserve_usd);
  const assets = reserve == null ? null : reserve + ladderCash - feesPaid;   // live-destination book P&L: none exist yet (demo only)
  const status = coverageStatus(assets, h90.p90);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const { data: snap, error: snapErr } = await db.from("treasury_snapshots").insert({
    payout_model: model, open_accounts: accounts.length,
    liab_7d: r2(h7.expected), liab_30d: r2(h30.expected), liab_60d: r2(h60.expected), liab_90d: r2(h90.expected),
    liab_30d_p90: r2(h30.p90), liab_90d_p90: r2(h90.p90), graduates_30d: r2(h30.graduates), graduates_90d: r2(h90.graduates),
    stage4_monthly: r2(stage4Monthly), reserve_usd: reserve, ladder_cash_usd: r2(ladderCash - feesPaid), live_book_pnl_30d: 0,
    assets_usd: assets == null ? null : r2(assets), coverage_90d: assets == null || h90.p90 <= 0 ? null : r2(assets / h90.p90), status,
    notes: { method: "posterior x calibrated stage table; P90 with 1.5x regime factor", reserve_missing: reserve == null },
  }).select("id").single();
  if (snapErr || !snap) return json({ error: "snapshot write failed" }, 503);
  const rows = forecasts.map((f) => ({ snapshot_id: snap.id, account_id: f.accountId, person_id: f.personId, stage: f.stage,
    p_graduate: Number(f.pGraduate.toFixed(5)), expected_days: Number(f.expectedDays.toFixed(1)), payout_if_graduate: r2(f.payoutIfGraduate),
    expected_payout: r2(f.expectedPayout), stage4_monthly: r2(f.s4MonthlyPayout), mu_mean: Number(f.muMean.toFixed(4)), trades: f.trades }));
  for (let i = 0; i < rows.length; i += 500) await db.from("treasury_account_forecasts").insert(rows.slice(i, i + 500));
  return json({ ok: true, snapshot: snap.id, accounts: accounts.length, liab_30d: r2(h30.expected), liab_90d_p90: r2(h90.p90), status });
});
