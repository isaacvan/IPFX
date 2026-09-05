// ============================================================
// IPFX Capital — deterministic performance metrics (Phase 2)
//
// Implements report §6 exactly: every function that can be undefined
// or insufficiently supported returns `null` with a reason rather than
// fabricating a number (report §6.10: "Never fabricate a probability").
// Pure functions only — no I/O, no framework dependency, so this file
// can be unit tested directly and reused by both the metric-computation
// job and (later) a dashboard server action.
//
// NOT EXECUTED IN THIS ENVIRONMENT: no Node.js is installed on the
// machine this was authored on, so this has been reviewed by hand for
// correctness but not run through tsc or a test runner. Run
// `internal-control/tests/metrics.test.ts` once Node is available.
// ============================================================

export type DataWarning =
  | "no_losses" | "no_wins" | "missing_timestamp" | "cost_unmodeled"
  | "stop_missing" | "zero_variance" | "insufficient_samples" | "symbol_unmapped";

export interface MetricResult<T> {
  value: T | null;
  status: "ok" | "insufficient_evidence";
  sampleSize: number;
  warnings: DataWarning[];
}

export interface ClosedTrade {
  id: string;
  openedAt: Date;
  closedAt: Date;
  pnlGross: number;
  commission: number | null;
  swap: number | null;
  spreadCost: number | null;
  slippageCost: number | null;
  costsKnown: boolean; // false if any of commission/swap/spread/slippage was missing (not zero)
}

export interface EquityPoint {
  t: Date;
  equity: number;
  externalFlow: number; // net deposits/withdrawals during this period, 0 if none
}

const ok = <T>(value: T, sampleSize: number, warnings: DataWarning[] = []): MetricResult<T> =>
  ({ value, status: "ok", sampleSize, warnings });
const insufficient = <T>(sampleSize: number, warnings: DataWarning[] = []): MetricResult<T> =>
  ({ value: null, status: "insufficient_evidence", sampleSize, warnings });

/** Net PnL after costs for one closed trade — report §6.2. */
export function netTradePnl(t: ClosedTrade): number {
  return t.pnlGross - (t.commission ?? 0) - (t.swap ?? 0) - (t.spreadCost ?? 0) - (t.slippageCost ?? 0);
}

/** report §6.1 — daily account returns adjusted for external flow.
 * Stops (returns null) if any E_{t-1} <= 0, per the report's explicit
 * instruction to halt rather than divide by a non-positive base. */
export function dailyReturnSeries(points: EquityPoint[]): MetricResult<number[]> {
  if (points.length < 2) return insufficient(points.length, ["insufficient_samples"]);
  const sorted = [...points].sort((a, b) => a.t.getTime() - b.t.getTime());
  const returns: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].equity;
    if (prev <= 0) return insufficient(returns.length, ["insufficient_samples"]); // halt: capital-loss/breach event
    const cur = sorted[i].equity;
    const flow = sorted[i].externalFlow;
    returns.push((cur - prev - flow) / prev);
  }
  return ok(returns, returns.length);
}

function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}
function stddev(xs: number[]): number { return Math.sqrt(variance(xs)); }

/** report §6.3 profit factor. Never returns Infinity — null + "no_losses" instead. */
export function profitFactor(trades: ClosedTrade[]): MetricResult<number> {
  const pnls = trades.map(netTradePnl);
  const grossWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = pnls.filter((p) => p < 0).reduce((a, b) => a + Math.abs(b), 0);
  if (grossLoss === 0) return insufficient(trades.length, ["no_losses"]);
  return ok(grossWin / grossLoss, trades.length, trades.some((t) => !t.costsKnown) ? ["cost_unmodeled"] : []);
}

/** report §6.3 expectancy — mean net PnL per trade idea. */
export function expectancy(trades: ClosedTrade[]): MetricResult<number> {
  if (trades.length === 0) return insufficient(0, ["insufficient_samples"]);
  const pnls = trades.map(netTradePnl);
  return ok(mean(pnls), trades.length, trades.some((t) => !t.costsKnown) ? ["cost_unmodeled"] : []);
}

export function winRate(trades: ClosedTrade[]): MetricResult<number> {
  if (trades.length === 0) return insufficient(0, ["insufficient_samples"]);
  const wins = trades.filter((t) => netTradePnl(t) > 0).length;
  return ok(wins / trades.length, trades.length);
}

/** report §6.3 payoff ratio — undefined if mean negative PnL is zero (no losses). */
export function payoffRatio(trades: ClosedTrade[]): MetricResult<number> {
  const pnls = trades.map(netTradePnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  if (losses.length === 0) return insufficient(trades.length, ["no_losses"]);
  if (wins.length === 0) return insufficient(trades.length, ["no_wins"]);
  const meanWin = mean(wins);
  const meanLoss = Math.abs(mean(losses));
  if (meanLoss === 0) return insufficient(trades.length, ["no_losses"]);
  return ok(meanWin / meanLoss, trades.length);
}

const TRADING_DAYS_PER_YEAR = 252;

/** report §6.4 annualized volatility. */
export function annualizedVolatility(returns: number[], tradingDaysPerYear = TRADING_DAYS_PER_YEAR): MetricResult<number> {
  if (returns.length < 2) return insufficient(returns.length, ["insufficient_samples"]);
  const sd = stddev(returns);
  if (sd === 0) return insufficient(returns.length, ["zero_variance"]);
  return ok(sd * Math.sqrt(tradingDaysPerYear), returns.length);
}

/** report §6.4 downside deviation, default MAR = 0. */
export function downsideDeviation(returns: number[], mar = 0, tradingDaysPerYear = TRADING_DAYS_PER_YEAR): MetricResult<number> {
  if (returns.length === 0) return insufficient(0, ["insufficient_samples"]);
  const downside = returns.map((r) => Math.min(r - mar, 0) ** 2);
  const d = Math.sqrt(mean(downside));
  return ok(d * Math.sqrt(tradingDaysPerYear), returns.length);
}

/** report §6.4 Sharpe. Undefined (not fabricated as 0 or Infinity) when variance is zero. */
export function sharpeRatio(returns: number[], riskFreeDaily = 0, tradingDaysPerYear = TRADING_DAYS_PER_YEAR): MetricResult<number> {
  if (returns.length < 2) return insufficient(returns.length, ["insufficient_samples"]);
  const sd = stddev(returns);
  if (sd === 0) return insufficient(returns.length, ["zero_variance"]);
  const excess = mean(returns) - riskFreeDaily;
  return ok((excess / sd) * Math.sqrt(tradingDaysPerYear), returns.length);
}

/** report §6.4 Sortino. Undefined when downside deviation is zero. */
export function sortinoRatio(returns: number[], riskFreeDaily = 0, mar = 0, tradingDaysPerYear = TRADING_DAYS_PER_YEAR): MetricResult<number> {
  if (returns.length < 2) return insufficient(returns.length, ["insufficient_samples"]);
  const dd = downsideDeviation(returns, mar, tradingDaysPerYear);
  if (dd.value === null || dd.value === 0) return insufficient(returns.length, ["zero_variance"]);
  const excess = mean(returns) - riskFreeDaily;
  return ok((excess * Math.sqrt(tradingDaysPerYear)) / dd.value, returns.length);
}

export interface DrawdownResult { maxDrawdownPct: number; longestDurationDays: number; currentDrawdownPct: number; currentDurationDays: number; }

/** report §6.4 max drawdown + duration, computed from an equity curve
 * (not returns) so duration can be measured in real calendar days. */
export function maxDrawdown(points: EquityPoint[]): MetricResult<DrawdownResult> {
  if (points.length < 2) return insufficient(points.length, ["insufficient_samples"]);
  const sorted = [...points].sort((a, b) => a.t.getTime() - b.t.getTime());
  let peak = sorted[0].equity;
  let peakAt = sorted[0].t;
  let maxDD = 0;
  let longestDurationMs = 0;
  let curDD = 0;
  let curDurationMs = 0;
  for (const p of sorted) {
    if (p.equity > peak) {
      const durMs = p.t.getTime() - peakAt.getTime();
      if (durMs > longestDurationMs) longestDurationMs = durMs;
      peak = p.equity;
      peakAt = p.t;
      curDurationMs = 0;
    } else {
      curDurationMs = p.t.getTime() - peakAt.getTime();
    }
    const dd = peak > 0 ? p.equity / peak - 1 : 0;
    if (dd < maxDD) maxDD = dd;
    curDD = dd;
  }
  if (curDurationMs > longestDurationMs) longestDurationMs = curDurationMs;
  const msPerDay = 86400000;
  return ok({
    maxDrawdownPct: maxDD, longestDurationDays: longestDurationMs / msPerDay,
    currentDrawdownPct: curDD, currentDurationDays: curDurationMs / msPerDay,
  }, sorted.length);
}

export interface ExposureSnapshot { symbol: string; notional: number; direction: 1 | -1; }

/** report §6.4 gross/net exposure as a fraction of equity. */
export function exposure(snapshots: ExposureSnapshot[], equity: number): MetricResult<{ gross: number; net: number }> {
  if (equity <= 0) return insufficient(snapshots.length, ["insufficient_samples"]);
  const gross = snapshots.reduce((s, x) => s + Math.abs(x.notional), 0) / equity;
  const net = snapshots.reduce((s, x) => s + x.direction * x.notional, 0) / equity;
  return ok({ gross, net }, snapshots.length);
}

/** report §6.4 HHI concentration + top-1/top-3 share. */
export function concentrationHHI(snapshots: ExposureSnapshot[]): MetricResult<{ hhi: number; top1Share: number; top3Share: number }> {
  const byAbs = snapshots.map((s) => Math.abs(s.notional)).sort((a, b) => b - a);
  const total = byAbs.reduce((a, b) => a + b, 0);
  if (total <= 0) return insufficient(snapshots.length, ["insufficient_samples"]);
  const shares = byAbs.map((n) => n / total);
  const hhi = shares.reduce((s, w) => s + w * w, 0);
  const top1 = shares[0] ?? 0;
  const top3 = shares.slice(0, 3).reduce((a, b) => a + b, 0);
  return ok({ hhi, top1Share: top1, top3Share: top3 }, snapshots.length);
}

/** report §6.4 position-size stability. Falls back to a realized-vol
 * proxy (flagged stop_missing) when no stop distance is available,
 * exactly as the report specifies — never silently drops the trade. */
export function positionSizeStability(
  sizes: { qty: number; stopDistance: number | null; volProxy: number }[]
): MetricResult<number> {
  if (sizes.length < 2) return insufficient(sizes.length, ["insufficient_samples"]);
  const warnings: DataWarning[] = [];
  const riskSizes = sizes.map((s) => {
    if (s.stopDistance !== null) return Math.abs(s.qty) * s.stopDistance;
    warnings.push("stop_missing");
    return Math.abs(s.qty) * s.volProxy;
  });
  const m = mean(riskSizes);
  if (m === 0) return insufficient(sizes.length, ["zero_variance"]);
  return ok(stddev(riskSizes) / m, sizes.length, [...new Set(warnings)]);
}

/** report §6.4 median + p90 holding time, in minutes. */
export function holdingTimeStats(trades: ClosedTrade[]): MetricResult<{ medianMinutes: number; p90Minutes: number }> {
  if (trades.length === 0) return insufficient(0, ["insufficient_samples"]);
  const mins = trades
    .map((t) => (t.closedAt.getTime() - t.openedAt.getTime()) / 60000)
    .sort((a, b) => a - b);
  const pct = (p: number) => mins[Math.min(mins.length - 1, Math.floor(p * mins.length))];
  return ok({ medianMinutes: pct(0.5), p90Minutes: pct(0.9) }, trades.length);
}

/** report §6.4 best-day P&L concentration. */
export function bestDayShare(dailyPnl: number[]): MetricResult<number> {
  const positiveDays = dailyPnl.filter((p) => p > 0);
  const totalPositive = positiveDays.reduce((a, b) => a + b, 0);
  if (totalPositive <= 0) return insufficient(dailyPnl.length, ["insufficient_samples"]);
  return ok(Math.max(...positiveDays) / totalPositive, dailyPnl.length);
}

/** report §6.4 signed slippage per fill, in relative terms. */
export function slippageStats(fills: { side: "buy" | "sell"; fillPrice: number; decisionMid: number | null }[]): MetricResult<{ medianBps: number; p95Bps: number }> {
  const known = fills.filter((f) => f.decisionMid !== null && f.decisionMid !== 0) as { side: "buy" | "sell"; fillPrice: number; decisionMid: number }[];
  if (known.length === 0) return insufficient(fills.length, ["missing_timestamp"]);
  const signed = (side: "buy" | "sell") => (side === "buy" ? 1 : -1);
  const slips = known
    .map((f) => signed(f.side) * ((f.fillPrice - f.decisionMid) / f.decisionMid) * 10000)
    .sort((a, b) => a - b);
  const pct = (p: number) => slips[Math.min(slips.length - 1, Math.floor(p * slips.length))];
  return ok({ medianBps: pct(0.5), p95Bps: pct(0.95) }, known.length, known.length < fills.length ? ["missing_timestamp"] : []);
}

/** report §6.4 gap/news exposure — fraction of equity held through a
 * scheduled high-impact window. */
export function newsExposure(
  eventWindowNotional: number, equity: number
): MetricResult<number> {
  if (equity <= 0) return insufficient(0, ["insufficient_samples"]);
  return ok(eventWindowNotional / equity, 1);
}
