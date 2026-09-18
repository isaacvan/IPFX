// Creates a fresh evaluation account carrying a challenge preset's full rule
// set. Shared by the trading engine (free Infinity, promo winners) and the
// admin console (owner grants and resets) so every account is built the same
// way regardless of how it was created.

// deno-lint-ignore no-explicit-any
type Db = any;

// deno-lint-ignore no-explicit-any
export async function insertAccountFromPreset(db: Db, userId: string, preset: any, feeUsd: number | null) {
  const startBal = Number(preset.starting_balance);
  const { data: account, error } = await db.from("trading_accounts").insert({
    user_id: userId,
    label: String(preset.label),
    preset_id: preset.id,
    challenge_type: preset.challenge_type,
    stage: Number(preset.stage ?? 1),
    phase: "evaluation",
    status: "active",
    starting_balance: startBal, balance: startBal, day_start_equity: startBal,
    day_start_date: new Date().toISOString().slice(0, 10),
    profit_target_pct: Number(preset.profit_target_pct),
    max_drawdown_pct: Number(preset.max_drawdown_pct),
    daily_loss_pct: Number(preset.daily_loss_pct),
    drawdown_mode: preset.drawdown_mode,
    trailing_peak: startBal,
    min_trading_days: Number(preset.min_trading_days ?? 0),
    min_trades: Number(preset.min_trades ?? 0),
    max_risk_per_trade_pct: preset.max_risk_per_trade_pct ?? null,
    daily_profit_cap_pct: preset.daily_profit_cap_pct ?? null,
    min_profitable_days_pct: preset.min_profitable_days_pct ?? null,
    require_stop_loss: !!preset.require_stop_loss,
    profit_split_pct: Number(preset.profit_split_pct ?? 85),
    challenge_fee_usd: feeUsd,
    total_paid_out: 0,
  }).select("*").single();
  if (error || !account) return null;
  try { await db.rpc("accept_qualification_v2", { p_account_id: account.id }); }
  catch (_) { /* never block provisioning on this */ }
  return account;
}

// First preset of the challenge line an account belongs to, used to restart it.
export function rootPresetId(presetId: string | null | undefined): string | null {
  if (!presetId) return null;
  if (presetId.startsWith("infinity_")) return "infinity_s1";
  const m = /^(trad|fut)_(\d+k)_p\d+$/.exec(presetId);
  if (m) return `${m[1]}_${m[2]}_p1`;
  if (presetId.startsWith("pac_")) return presetId;
  return null;
}
