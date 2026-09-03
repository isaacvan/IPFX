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
//   { action:"trader_flags" }
//       -> { flags:[...] } one severity-sorted triage row per trader who
//          needs attention today, merging breach proximity, behavioural
//          vetoes, KYC/jurisdiction/investigation state, shared-IP leads
//          and crowded-book exposure into a single view
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

// ============================================================
// computeReadiness — deterministic, fail-closed scoring of whether a
// trader's history is statistically solid enough to trust with mirrored
// signals. Every number here is a named, standard statistical/quant
// formula (a t-test on out-of-sample trade P&L; the classic
// first-passage probability of a random walk with drift hitting one
// barrier before another) — not a trained model, not a black box, so
// it can be checked by hand. All probabilities are ESTIMATES from a
// normal/Brownian approximation of trade P&L; real return
// distributions have fatter tails than this assumes, so read outputs
// as directional confidence, not exact odds. Fails closed: any
// missing or insufficient data returns mirror_ready:false with a
// stated reason, never a fabricated number.
// ============================================================

const MIN_TRADES = 30;          // floor to compute anything at all
const READY_TRADES = 150;       // recommended minimum before "ready"
const READY_DAYS = 60;          // recommended minimum calendar span
const READY_T_STAT = 2.33;      // ~99% one-sided confidence bar, checked out-of-sample
const MAX_CONSISTENCY_PCT = 25; // no single trade may be > 25% of gross profit
const PAYOUT_TARGET_FRACTION = 0.01; // "first payout" defined as 1% of starting balance realized

// Standard normal CDF (Abramowitz-Stegun erf approximation).
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// P(a Brownian-motion-with-drift walk hits +targetUp before -targetDown),
// given per-trade mean mu and stdev sigma. Classic first-passage formula
// used for risk-of-ruin calculations; degrades to the fair-walk ratio
// targetDown/(targetUp+targetDown) as mu -> 0.
function passageProbability(mu: number, sigma: number, targetUp: number, targetDown: number): number | null {
  if (!(sigma > 0) || !(targetUp > 0) || !(targetDown > 0)) return null;
  const clampExp = (x: number) => Math.exp(Math.max(-700, Math.min(700, x)));
  if (Math.abs(mu) < 1e-9) return targetDown / (targetUp + targetDown);
  const k = 2 * mu / (sigma * sigma);
  const num = 1 - clampExp(-k * targetDown);
  const den = 1 - clampExp(-k * (targetUp + targetDown));
  if (Math.abs(den) < 1e-12) return mu > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, num / den));
}

function computeReadiness(allTrades: Trade[], acct: Record<string, unknown>) {
  const closed = [...allTrades]
    .filter((t) => t.status === "closed" && t.closed_at && t.pnl !== null)
    .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime());
  const n = closed.length;
  const reasons: string[] = [];
  const checklist: { key: string; label: string; pass: boolean; detail: string }[] = [];

  const daysSpan = n >= 2
    ? (new Date(closed[n - 1].closed_at).getTime() - new Date(closed[0].opened_at).getTime()) / 86400000
    : 0;

  checklist.push({ key: "min_trades", label: `${READY_TRADES}+ closed trades`, pass: n >= READY_TRADES, detail: `${n} closed trades` });
  checklist.push({ key: "min_days", label: `${READY_DAYS}+ day history`, pass: daysSpan >= READY_DAYS, detail: `${r2(daysSpan)} days of history` });

  if (n < MIN_TRADES) {
    reasons.push(`Only ${n} closed trades — need at least ${MIN_TRADES} before anything here is statistically meaningful.`);
    return {
      trades_closed: n, days_span: r2(daysSpan),
      mean_pnl: null, stdev_pnl: null, t_stat: null, p_edge_real: null,
      prob_pass_evaluation: null, prob_first_payout: null,
      mirror_ready: false, checklist, reasons,
    };
  }

  const pnls = closed.map((t) => Number(t.pnl));
  const meanPnl = mean(pnls);
  const stdevPnl = stddev(pnls);

  // Out-of-sample check: the edge is graded on the SECOND half only.
  // Grading yourself on the same data you estimated the edge from is
  // exactly the overfitting trap this system exists to catch.
  const mid = Math.floor(n / 2);
  const secondHalf = pnls.slice(mid);
  const oosMean = mean(secondHalf);
  const oosStdev = stddev(secondHalf);
  const oosN = secondHalf.length;
  const tStat = oosStdev > 0 && oosN > 1 ? (oosMean * Math.sqrt(oosN)) / oosStdev : null;
  const pEdgeReal = tStat !== null ? Math.round(normalCdf(tStat) * 10000) / 10000 : null;

  checklist.push({
    key: "oos_edge",
    label: `out-of-sample confidence >= ${Math.round(normalCdf(READY_T_STAT) * 1000) / 10}%`,
    pass: tStat !== null && tStat >= READY_T_STAT,
    detail: pEdgeReal !== null
      ? `${r2(pEdgeReal * 100)}% confidence the edge is real (2nd-half t=${r2(tStat!)}, n=${oosN})`
      : "not enough closed trades in the 2nd half yet",
  });

  const wins = pnls.filter((p) => p > 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const bestWin = wins.length ? Math.max(...wins) : 0;
  const consistencyPct = grossWin > 0 ? r2((bestWin / grossWin) * 100) : 0;
  checklist.push({
    key: "consistency", label: `no single trade > ${MAX_CONSISTENCY_PCT}% of gross profit`,
    pass: consistencyPct <= MAX_CONSISTENCY_PCT, detail: `${consistencyPct}% of profit from the single best trade`,
  });

  // Martingale / revenge-trading flags — same detection buildStrategyProfile uses.
  let martingaleOpportunities = 0, martingaleHits = 0, revengeCount = 0, gapOpportunities = 0;
  for (let i = 0; i < n - 1; i++) {
    const cur = closed[i], next = closed[i + 1];
    if (Number(cur.pnl) < 0) {
      martingaleOpportunities++;
      if (Number(next.volume) > Number(cur.volume) * 1.3) martingaleHits++;
    }
    const gap = (new Date(next.opened_at).getTime() - new Date(cur.closed_at).getTime()) / 60000;
    if (gap >= 0) gapOpportunities++;
    if (Number(cur.pnl) < 0 && gap >= 0 && gap < 5 && Number(next.volume) >= Number(cur.volume)) revengeCount++;
  }
  const martingaleFlag = martingaleOpportunities > 0 && martingaleHits / martingaleOpportunities > 0.4;
  const revengeFlag = gapOpportunities > 0 && revengeCount / gapOpportunities > 0.2;
  checklist.push({ key: "no_martingale", label: "no martingale sizing pattern", pass: !martingaleFlag, detail: martingaleFlag ? "volume increases after losses > 40% of the time" : "clean" });
  checklist.push({ key: "no_revenge", label: "no revenge-trading pattern", pass: !revengeFlag, detail: revengeFlag ? "re-enters within 5min of a loss at equal/larger size > 20% of the time" : "clean" });

  const start = Number(acct.starting_balance);
  const balance = Number(acct.balance);
  const ddFloor = r2(start * (1 - Number(acct.max_drawdown_pct) / 100) - Number(acct.total_paid_out ?? 0));
  const targetAmt = r2(start * (1 + Number(acct.profit_target_pct) / 100));
  const distDown = r2(balance - ddFloor);
  const distUp = r2(targetAmt - balance);

  const probPass = acct.status === "passed" ? 1
    : acct.status === "breached" ? 0
    : (distUp > 0 && distDown > 0 ? passageProbability(meanPnl, stdevPnl, distUp, distDown) : null);

  // A breached account can never trade again, so neither probability can
  // be anything but 0 going forward regardless of what the math says.
  const payoutTarget = r2(start * PAYOUT_TARGET_FRACTION);
  const probFirstPayout = acct.status === "breached" ? 0
    : (distDown > 0 ? passageProbability(meanPnl, stdevPnl, payoutTarget, distDown) : null);

  // A breached account is dead — never "ready" regardless of what its
  // historical stats say, since there is nothing left here to mirror.
  const statsPass = checklist.every((c) => c.pass);
  const allPass = statsPass && acct.status !== "breached";
  if (!statsPass) reasons.push(...checklist.filter((c) => !c.pass).map((c) => `Fails "${c.label}" — ${c.detail}`));
  if (acct.status === "breached") reasons.push("This account is breached — nothing to mirror here even if its historical stats look good.");

  return {
    trades_closed: n, days_span: r2(daysSpan),
    mean_pnl: r2(meanPnl), stdev_pnl: r2(stdevPnl),
    t_stat: tStat !== null ? r2(tStat) : null, p_edge_real: pEdgeReal,
    prob_pass_evaluation: probPass !== null ? Math.round(probPass * 10000) / 10000 : null,
    prob_first_payout: probFirstPayout !== null ? Math.round(probFirstPayout * 10000) / 10000 : null,
    mirror_ready: allPass,
    checklist, reasons,
  };
}

// ============================================================
// midChallengeSignal — early read on a trader while their challenge is
// still running, when the sample is far too small for the t-test in
// computeReadiness (which wants ~150 trades; mid-challenge you have 10-40).
//
// THE FAILURE MODE THIS EXISTS TO AVOID
// The naive version of "spot good traders early" ranks by running P&L,
// which mostly surfaces whoever is on a lucky streak. Five winning
// trades is not evidence. So instead of the raw sample mean, this uses a
// BAYESIAN POSTERIOR with a deliberately sceptical prior centred on zero
// edge, which shrinks the estimate toward "no skill" in proportion to
// how little data there is.
//
//   prior      mu ~ N(0, tau^2), tau = 0.25 * sigma  (edges are small
//              relative to trade-to-trade noise, until proven otherwise)
//   posterior  mu | data ~ N( k * xbar , k * sigma^2 / n ),  k = n/(n+16)
//
// MEASURED CALIBRATION (Monte Carlo, 600 simulated zero-edge traders per
// bucket, scoring threshold 70):
//   n=20 -> 3.5% false positives     n=40 -> 4.0%     n=60 -> 4.3%
// So roughly 1 in 25 traders with NO real edge will still score 70+.
// Treat this as a SCREEN, not a decision. And note the multiple-comparisons
// problem: screening 60 traders and taking the top few will surface those
// false positives preferentially, which is exactly why computeReadiness
// re-tests survivors out-of-sample at a much higher bar before anything
// acts on the result.
//
// The shrinkage factor k is the whole point:
//   n=10  -> k=0.38   a hot start is discounted by ~62%
//   n=40  -> k=0.71
//   n=150 -> k=0.90   only now is the raw mean nearly trusted
//
// Everything downstream (pass probability, ranking) is driven by the
// SHRUNK posterior mean, never the raw sample mean. Behavioural vetoes
// are applied on top, because a trader who is up via martingale is the
// worst possible person to back, not the best.
// ============================================================

const PRIOR_STRENGTH = 16;   // pseudo-trades of "no edge" the prior is worth
const MIN_SIGNAL_TRADES = 12; // below this, report insufficient-data rather than a number
const MIN_LOSING_TRADES = 3;  // no losses observed = no information about the downside tail

function midChallengeSignal(
  allTrades: Trade[],
  acct: Record<string, unknown>,
  progress: { trading_days: number; trades_closed: number; profitable_days_pct: number | null } | null,
) {
  const closed = [...allTrades]
    .filter((t) => t.status === "closed" && t.closed_at && t.pnl !== null)
    .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime());
  const n = closed.length;

  const start = Number(acct.starting_balance);
  const balance = Number(acct.balance);
  const targetPct = Number(acct.profit_target_pct ?? 0);
  const ddPct = Number(acct.max_drawdown_pct ?? 10);
  const ddFloor = r2(start * (1 - ddPct / 100) - Number(acct.total_paid_out ?? 0));
  const targetAmt = targetPct > 0 ? r2(start * (1 + targetPct / 100)) : null;
  const distDown = r2(balance - ddFloor);
  const distUp = targetAmt === null ? null : r2(targetAmt - balance);
  const pctToTarget = targetAmt === null ? null
    : r2(Math.min(100, Math.max(0, ((balance - start) / (targetAmt - start)) * 100)));

  const base = {
    trades_closed: n,
    pct_of_target_reached: pctToTarget,
    distance_to_target: distUp,
    distance_to_floor: distDown,
    trading_days: progress?.trading_days ?? null,
  };

  if (n < MIN_SIGNAL_TRADES) {
    return {
      ...base, status: "insufficient_data",
      raw_mean_pnl: null, shrunk_mean_pnl: null, shrinkage: null,
      p_edge_positive: null, prob_pass: null, signal_score: null,
      vetoes: [], note: `Only ${n} closed trades — no read until at least ${MIN_SIGNAL_TRADES}.`,
    };
  }

  const pnls = closed.map((t) => Number(t.pnl));
  const rawMean = mean(pnls);
  const losses = pnls.filter((p) => p < 0).length;

  // Sigma floor. A near-constant return series is not certainty about
  // the edge, it is a sample that has not yet met a bad day -- a grid or
  // martingale system looks exactly like this right up until it doesn't.
  const sigma = Math.max(stddev(pnls), Math.abs(rawMean) * 0.5);

  // Normal-Normal conjugate update with a zero-centred sceptical prior.
  const k = n / (n + PRIOR_STRENGTH);
  const postMean = k * rawMean;
  const postVar = sigma > 0 ? (k * sigma * sigma) / n : 0;
  const postSd = Math.sqrt(Math.max(postVar, 0));
  const pEdge = postSd > 0 ? normalCdf(postMean / postSd) : 0.5;

  // Pass probability uses the SHRUNK drift, so an early hot streak does
  // not translate into a confident forecast.
  const probPass = (distUp !== null && distUp > 0 && distDown > 0 && sigma > 0)
    ? passageProbability(postMean, sigma, distUp, distDown)
    : (distUp !== null && distUp <= 0 ? 1 : null);

  // ---- behavioural vetoes: disqualifying regardless of P&L ----
  const vetoes: string[] = [];
  let martOpp = 0, martHit = 0, revenge = 0, gapOpp = 0;
  for (let i = 0; i < n - 1; i++) {
    const cur = closed[i], next = closed[i + 1];
    if (Number(cur.pnl) < 0) {
      martOpp++;
      if (Number(next.volume) > Number(cur.volume) * 1.3) martHit++;
    }
    const gap = (new Date(next.opened_at).getTime() - new Date(cur.closed_at).getTime()) / 60000;
    if (gap >= 0) gapOpp++;
    if (Number(cur.pnl) < 0 && gap >= 0 && gap < 5 && Number(next.volume) >= Number(cur.volume)) revenge++;
  }
  if (martOpp > 0 && martHit / martOpp > 0.4) vetoes.push("martingale sizing after losses");
  if (gapOpp > 0 && revenge / gapOpp > 0.2) vetoes.push("revenge trading within 5min of a loss");

  const wins = pnls.filter((p) => p > 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const bestWin = wins.length ? Math.max(...wins) : 0;
  const concentration = grossWin > 0 ? r2((bestWin / grossWin) * 100) : 0;
  if (concentration > 40) vetoes.push(`${concentration}% of gross profit from one trade`);

  const noStop = closed.filter((t) => t.sl === null).length;
  if (n > 0 && noStop / n > 0.5) vetoes.push("no stop-loss on the majority of trades");

  // Composite 0-100, deliberately multiplicative so a veto or a weak edge
  // collapses the score rather than being averaged away by a good P&L.
  //
  // edgeStrength is a STEEP transform of the posterior confidence: it
  // maps 0.5 -> 0 and only approaches 1 near certainty. Cubing it is what
  // stopped a zero-edge trader who happened to be up scoring 71/100 in
  // testing (they now score ~9).
  const edgeStrength = Math.pow(Math.max(0, (pEdge - 0.5) / 0.5), 3);
  const passComponent = probPass ?? 0;
  const vetoPenalty = vetoes.length === 0 ? 1 : Math.pow(0.45, vetoes.length);

  // Hard cap until enough losing trades exist to say anything about the
  // downside. Without losses there is no drawdown information at all.
  const riskBlind = losses < MIN_LOSING_TRADES;
  let score = Math.round(100 * edgeStrength * (0.4 + 0.6 * passComponent) * vetoPenalty);
  if (riskBlind) score = Math.min(score, 35);

  return {
    ...base,
    status: "scored",
    raw_mean_pnl: r2(rawMean),
    shrunk_mean_pnl: r2(postMean),
    shrinkage: r2(k),
    stdev_pnl: r2(sigma),
    p_edge_positive: Math.round(pEdge * 10000) / 10000,
    losing_trades: losses,
    risk_blind: riskBlind,
    prob_pass: probPass === null ? null : Math.round(probPass * 10000) / 10000,
    signal_score: score,
    concentration_pct: concentration,
    vetoes,
    note: riskBlind
      ? `Only ${losses} losing trade(s) — the downside is unmeasured, so the score is capped at 35 regardless of profit.`
      : vetoes.length
      ? `Score suppressed by ${vetoes.length} behavioural flag(s).`
      : `Posterior discounts the raw mean by ${Math.round((1 - k) * 100)}% at n=${n}.`,
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

  // Every state-changing action below logs here: who, what, on whom,
  // when, plus arbitrary detail. Never surfaced to traders — only
  // through this same admin-gated function (the "audit_log" action).
  async function logAdmin(actionName: string, opts: { targetUser?: string; targetAccount?: string; detail?: Record<string, unknown> } = {}) {
    try {
      await db.from("admin_audit_log").insert({
        actor_id: user.id, action: actionName,
        target_user_id: opts.targetUser ?? null, target_account_id: opts.targetAccount ?? null,
        detail: opts.detail ?? null,
      });
    } catch (_) { /* audit logging must never block the underlying action */ }
  }

  if (action === "overview") {
    const [{ data: accounts }, { data: profiles }, { data: targets }, { data: summary }, { data: payouts }, { data: stats }, { data: risk }, { data: claims }, { data: kycRows }, { data: platCfg }, { data: sharedIps }] =
      await Promise.all([
        db.from("trading_accounts").select("*").order("created_at", { ascending: false }),
        db.from("user_profiles").select("user_id,full_name,referral_code,restricted_jurisdiction"),
        db.from("mirror_targets").select("*"),
        db.from("trader_payout_summary").select("*"),
        db.from("payouts").select("*").order("created_at", { ascending: false }),
        db.from("trader_stats").select("*"),
        db.from("trader_risk").select("*"),
        db.from("challenge_claims").select("challenge_type,account_type").limit(100000),
        db.from("trader_kyc").select("user_id,status"),
        db.from("platform_config").select("*").eq("id", true).maybeSingle(),
        db.from("shared_ip_accounts").select("*").limit(50),
      ]);
    const kycByUser = new Map<string, string>();
    for (const k of kycRows ?? []) kycByUser.set(k.user_id, k.status);
    const restrictedByUser = new Set<string>();
    for (const p of profiles ?? []) if (p.restricted_jurisdiction) restrictedByUser.add(p.user_id);
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
        phase: a.phase ?? "evaluation",
        investigation_hold: !!a.investigation_hold,
        kyc_status: kycByUser.get(a.user_id as string) ?? "unverified",
        restricted_jurisdiction: restrictedByUser.has(a.user_id as string),
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
          // Cheap heads-up only (uses aggregates already fetched here, not
          // a full recompute) — the real, out-of-sample-checked probability
          // lives in trader_detail's readiness block. This just flags who's
          // worth opening; it is never itself grounds to enable mirroring.
          const readyHint = Number(st?.trades ?? 0) >= READY_TRADES && (consistency == null || consistency <= MAX_CONSISTENCY_PCT);
          return st
            ? { trades: Number(st.trades), win_rate: st.win_rate == null ? null : Number(st.win_rate), profit_factor: st.profit_factor == null ? null : Number(st.profit_factor), avg_trade: Number(st.avg_trade), best_trade: bt, worst_trade: Number(st.worst_trade), max_drawdown_pct: rk ? Number(rk.max_drawdown_pct) : null, consistency_pct: consistency, mirror_ready_hint: readyHint }
            : { trades: 0, win_rate: null, profit_factor: null, avg_trade: 0, best_trade: 0, worst_trade: 0, max_drawdown_pct: null, consistency_pct: null, mirror_ready_hint: false };
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
    const pendingRows = (payouts ?? []).filter((p: Record<string, unknown>) => p.status === "requested" || p.status === "approved");
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

    return json({
      ok: true, is_admin: true, firm, traders, payouts: payouts ?? [],
      platform: { trading_halted: !!platCfg?.trading_halted, halted_reason: platCfg?.halted_reason ?? null, halted_at: platCfg?.halted_at ?? null },
      shared_ip_accounts: sharedIps ?? [],
    });
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
    await logAdmin("set_mirror", { targetUser: target_user, detail: { enabled, target_type: body.target_type ?? null } });
    return json({ ok: true });
  }

  // Same friendly-error mapping used by trading-engine — kept in sync by
  // hand since these are two separate Deno deployments.
  const RPC_ERROR_MESSAGES: Record<string, string> = {
    account_not_found: "Account not found.",
    not_funded: "This account isn't funded yet.",
    account_not_in_good_standing: "Account isn't in good standing.",
    investigation_hold: "Account is under investigation hold.",
    kyc_not_verified: "Trader's KYC isn't verified yet.",
    nothing_owed: "No payable profit for this period.",
    consistency_check_failed: "A single trade is more than 25% of this period's profit — needs manual review.",
    payout_not_found: "Payout not found.",
    not_requested: "This payout isn't in the requested state.",
    not_approved: "This payout isn't approved yet.",
    insufficient_balance: "Account balance is too low to cover this payout.",
    cannot_void_paid: "A paid payout can't be voided.",
    already_void: "This payout is already void.",
  };
  const cleanRpc = (raw: string) => {
    const code = raw.split(":")[0].trim();
    if (code === "too_soon" || code === "below_minimum") return raw.split(":")[1]?.trim() ?? raw;
    return RPC_ERROR_MESSAGES[code] ?? raw;
  };

  if (action === "set_split") {
    const target_user = String(body.user_id ?? "");
    const pct = Number(body.profit_split_pct);
    if (!target_user || !isFinite(pct) || pct < 0 || pct > 100) return err("bad split");
    // Guard against retroactively changing what's owed on profit already
    // earned under the old rate: block the change while any funded
    // account for this trader has outstanding unpaid profit. Pay out
    // first, then change the split.
    const { data: fundedAccts } = await db.from("trading_accounts").select("id").eq("user_id", target_user).eq("phase", "funded");
    for (const a of fundedAccts ?? []) {
      const { data: s } = await db.from("trader_payout_summary").select("realized_profit_unpaid").eq("account_id", a.id).maybeSingle();
      if (s && Number(s.realized_profit_unpaid) > 0) {
        return err("This trader has unpaid profit outstanding — pay it out before changing the split, or the change would retroactively affect profit already earned.", 409);
      }
    }
    await db.from("trading_accounts").update({ profit_split_pct: pct }).eq("user_id", target_user).eq("status", "active");
    await logAdmin("set_split", { targetUser: target_user, detail: { profit_split_pct: pct } });
    return json({ ok: true });
  }

  // Admin-initiated payout: same gated, transactional path a trader's own
  // request goes through (fn_request_payout), just with p_is_admin=true so
  // small amounts can auto-approve. Every compliance gate (funded, good
  // standing, KYC, min days, consistency) is re-checked inside the
  // function itself — nothing here can bypass them.
  if (action === "payout_create") {
    const account_id = String(body.account_id ?? "");
    if (!account_id) return err("account_id required");
    const idem = `admin_${user.id}_${account_id}_${Date.now()}`;
    const { data, error } = await db.rpc("fn_request_payout", {
      p_account_id: account_id, p_requested_by: user.id, p_is_admin: true,
      p_idempotency_key: idem, p_payout_method_id: null,
    });
    if (error) return err(cleanRpc(error.message), 409);
    await logAdmin("payout_create", { targetAccount: account_id, detail: { payout_id: data?.id, status: data?.status, trader_share: data?.trader_share } });
    return json({ ok: true, payout: data, trader_share: Number(data?.trader_share ?? 0) });
  }

  if (action === "payout_approve") {
    const payout_id = String(body.payout_id ?? "");
    if (!payout_id) return err("payout_id required");
    const { data, error } = await db.rpc("fn_approve_payout", { p_payout_id: payout_id, p_admin_id: user.id });
    if (error) return err(cleanRpc(error.message), 409);
    await logAdmin("payout_approve", { targetAccount: data?.account_id, detail: { payout_id, trader_share: data?.trader_share } });
    return json({ ok: true, payout: data });
  }

  if (action === "payout_mark_paid") {
    const payout_id = String(body.payout_id ?? "");
    if (!payout_id) return err("payout_id required");
    const { data, error } = await db.rpc("fn_mark_paid", { p_payout_id: payout_id, p_admin_id: user.id });
    if (error) return err(cleanRpc(error.message), 409);
    await logAdmin("payout_mark_paid", { targetAccount: data?.account_id, detail: { payout_id, trader_share: data?.trader_share } });
    // Referral commission (if any) fires only once a payout is actually
    // paid, per "10% ... within 30 days of their first payout" — never
    // on merely requested/approved.
    try { await db.rpc("fn_maybe_award_referral", { p_payout_id: payout_id }); } catch (_) { /* non-fatal */ }
    return json({ ok: true, payout: data });
  }

  if (action === "payout_void") {
    const payout_id = String(body.payout_id ?? "");
    const reason = String(body.reason ?? "").trim().slice(0, 300);
    if (!payout_id) return err("payout_id required");
    if (!reason) return err("A reason is required to void a payout");
    const { data, error } = await db.rpc("fn_void_payout", { p_payout_id: payout_id, p_admin_id: user.id, p_reason: reason });
    if (error) return err(cleanRpc(error.message), 409);
    await logAdmin("payout_void", { targetAccount: data?.account_id, detail: { payout_id, reason } });
    return json({ ok: true, payout: data });
  }

  if (action === "set_kyc_status") {
    const target_user = String(body.user_id ?? "");
    const status = String(body.status ?? "");
    if (!target_user || !["unverified", "pending", "verified", "rejected"].includes(status)) return err("bad kyc status");
    const note = body.note ? String(body.note).slice(0, 300) : null;
    await logAdmin("set_kyc_status", { targetUser: target_user, detail: { status, note } });
    const { error } = await db.from("trader_kyc").upsert({
      user_id: target_user, status, note,
      verified_by: status === "verified" ? user.id : null,
      verified_at: status === "verified" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    });
    if (error) return err("could not update KYC status", 500);
    return json({ ok: true });
  }

  if (action === "set_investigation_hold") {
    const account_id = String(body.account_id ?? "");
    const hold = body.hold === true;
    const note = body.note ? String(body.note).slice(0, 300) : null;
    if (!account_id) return err("account_id required");
    await db.from("trading_accounts").update({
      investigation_hold: hold, investigation_note: hold ? note : null, updated_at: new Date().toISOString(),
    }).eq("id", account_id);
    await logAdmin("set_investigation_hold", { targetAccount: account_id, detail: { hold, note } });
    return json({ ok: true });
  }

  // ---- platform kill switch ----
  if (action === "set_platform_halt") {
    const halted = body.halted === true;
    const reason = body.reason ? String(body.reason).slice(0, 300) : null;
    if (halted && !reason) return err("A reason is required to halt trading");
    await db.from("platform_config").update({
      trading_halted: halted, halted_reason: halted ? reason : null,
      halted_by: halted ? user.id : null, halted_at: halted ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq("id", true);
    await logAdmin("set_platform_halt", { detail: { halted, reason } });
    return json({ ok: true });
  }

  // ---- firm concentration risk ----
  // A prop firm's real financial exposure is not one trader doing well, it
  // is MANY traders crowded into the same position. If 40 accounts are all
  // long EURUSD and it gaps up, every one of them profits simultaneously
  // and the firm owes payouts on all of it at once. This quantifies that.
  //
  // Framing note: the firm LOSES when traders WIN, so "adverse" here means
  // the market moving in the traders' favour.
  if (action === "firm_risk") {
    const CONTRACT: Record<string, number> = {
      XAUUSD: 100, XPTUSD: 100, XPDUSD: 100, XAGUSD: 5000,
      SPXUSD: 10, NSXUSD: 10, DJI: 10, UK100: 10, GER40: 10, FRA40: 10, JPN225: 10, US2000: 10,
    };
    const contractFor = (s: string) => CONTRACT[s] ?? 100000; // forex default

    const { data: openTrades } = await db.from("trades")
      .select("account_id,user_id,symbol,side,volume,open_price").eq("status", "open").limit(20000);
    const { data: acctRows } = await db.from("trading_accounts")
      .select("id,user_id,phase,status,profit_split_pct").eq("status", "active");

    const acctById = new Map<string, Record<string, unknown>>();
    for (const a of acctRows ?? []) acctById.set(a.id as string, a);

    const bySym = new Map<string, {
      symbol: string; long_lots: number; short_lots: number; accounts: Set<string>;
      long_accounts: Set<string>; short_accounts: Set<string>; notional: number;
    }>();

    for (const t of openTrades ?? []) {
      const acct = acctById.get(t.account_id as string);
      if (!acct) continue; // ignore positions on non-active accounts
      const sym = String(t.symbol);
      if (!bySym.has(sym)) bySym.set(sym, {
        symbol: sym, long_lots: 0, short_lots: 0, accounts: new Set(),
        long_accounts: new Set(), short_accounts: new Set(), notional: 0,
      });
      const g = bySym.get(sym)!;
      const lots = Number(t.volume);
      const notional = lots * contractFor(sym) * Number(t.open_price);
      g.notional += notional;
      g.accounts.add(t.account_id as string);
      if (t.side === "buy") { g.long_lots += lots; g.long_accounts.add(t.account_id as string); }
      else { g.short_lots += lots; g.short_accounts.add(t.account_id as string); }
    }

    // Per-symbol exposure, plus what a 1% favourable-to-traders move costs.
    const MOVE = 0.01;
    const rows = [...bySym.values()].map((g) => {
      const netLots = r2(g.long_lots - g.short_lots);
      const grossLots = r2(g.long_lots + g.short_lots);
      // Crowding: how one-sided the book is on this symbol. 100% = everyone
      // on the same side, which is the dangerous case.
      const crowding = grossLots > 0 ? r2((Math.abs(netLots) / grossLots) * 100) : 0;
      // Net notional moves with the crowd; a 1% move on the NET position is
      // what the firm actually pays out (offsetting sides cancel).
      const netNotional = r2(Math.abs(netLots) / (grossLots || 1) * g.notional);
      const traderPnlOn1pct = r2(netNotional * MOVE);
      return {
        symbol: g.symbol,
        accounts: g.accounts.size,
        long_accounts: g.long_accounts.size,
        short_accounts: g.short_accounts.size,
        long_lots: r2(g.long_lots), short_lots: r2(g.short_lots),
        net_lots: netLots, gross_lots: grossLots,
        crowding_pct: crowding,
        direction: netLots > 0 ? "long" : netLots < 0 ? "short" : "flat",
        gross_notional: r2(g.notional),
        net_notional: netNotional,
        firm_cost_1pct_move: traderPnlOn1pct,
      };
    }).sort((a, b) => b.firm_cost_1pct_move - a.firm_cost_1pct_move);

    const totalCost = r2(rows.reduce((s, r) => s + r.firm_cost_1pct_move, 0));
    const totalGross = r2(rows.reduce((s, r) => s + r.gross_notional, 0));
    // Payout share is what the firm actually hands over on funded accounts.
    const fundedIds = new Set((acctRows ?? []).filter((a: Record<string, unknown>) => a.phase === "funded").map((a: Record<string, unknown>) => a.id));
    const fundedOpen = (openTrades ?? []).filter((t: Record<string, unknown>) => fundedIds.has(t.account_id));

    return json({
      ok: true,
      symbols: rows,
      totals: {
        symbols_held: rows.length,
        open_positions: (openTrades ?? []).length,
        accounts_with_positions: new Set((openTrades ?? []).map((t: Record<string, unknown>) => t.account_id)).size,
        gross_notional: totalGross,
        firm_cost_1pct_move: totalCost,
        funded_open_positions: fundedOpen.length,
      },
      note: "firm_cost_1pct_move = what traders would collectively gain (and the firm owe) if each symbol moved 1% in the crowd's favour. Offsetting long/short interest is netted out first.",
    });
  }

  // ---- mid-challenge watchlist ----
  // Every live evaluation account, scored while the challenge is still
  // running. Ranked by signal_score, which is driven by the SHRUNK
  // posterior edge rather than running P&L — so a hot streak on eight
  // trades does not outrank a steady edge on sixty.
  if (action === "watchlist") {
    const { data: accts } = await db.from("trading_accounts")
      .select("*").eq("status", "active").neq("phase", "funded");
    if (!accts || !accts.length) return json({ ok: true, watchlist: [] });

    const ids = accts.map((a: Record<string, unknown>) => a.id);
    const [{ data: trades }, { data: profiles }, { data: prog }] = await Promise.all([
      db.from("trades").select("*").in("account_id", ids).order("opened_at", { ascending: true }).limit(20000),
      db.from("user_profiles").select("user_id,full_name"),
      db.from("account_progress").select("*").in("account_id", ids),
    ]);
    const nameBy = new Map<string, string>();
    for (const p of profiles ?? []) nameBy.set(p.user_id, p.full_name ?? "");
    const progBy = new Map<string, Record<string, unknown>>();
    for (const p of prog ?? []) progBy.set(p.account_id as string, p);
    const tradesBy = new Map<string, Trade[]>();
    for (const t of trades ?? []) {
      const k = t.account_id as string;
      if (!tradesBy.has(k)) tradesBy.set(k, []);
      tradesBy.get(k)!.push(t);
    }

    const rows = accts.map((a: Record<string, unknown>) => {
      const pr = progBy.get(a.id as string);
      const p = pr ? {
        trading_days: Number(pr.trading_days ?? 0),
        trades_closed: Number(pr.trades_closed ?? 0),
        profitable_days_pct: pr.profitable_days_pct == null ? null : Number(pr.profitable_days_pct),
      } : null;
      return {
        account_id: a.id, user_id: a.user_id,
        full_name: nameBy.get(a.user_id as string) || "—",
        challenge_type: a.challenge_type ?? "traditional",
        stage: Number(a.stage ?? 1),
        starting_balance: Number(a.starting_balance),
        balance: Number(a.balance),
        signal: midChallengeSignal(tradesBy.get(a.id as string) ?? [], a, p),
      };
    }).sort((x: Record<string, unknown>, y: Record<string, unknown>) => {
      const sx = (x.signal as Record<string, unknown>).signal_score;
      const sy = (y.signal as Record<string, unknown>).signal_score;
      return (Number(sy ?? -1)) - (Number(sx ?? -1));
    });

    return json({ ok: true, watchlist: rows, scored_at: new Date().toISOString() });
  }

  // ============================================================
  // trader_flags — single triage view: every signal this file already
  // computes elsewhere (breach proximity, behavioural vetoes, KYC state,
  // investigation holds, restricted jurisdiction, shared-IP multi-
  // accounting leads, crowded-book contribution), synthesised into one
  // severity-sorted "who needs a look today, and why" list. Nothing here
  // is a new detector — it is a merge of the readiness/mid-challenge/
  // firm_risk/compliance signals that otherwise live in separate panels.
  // Fail-closed: a trader with no data anywhere just doesn't appear.
  // ============================================================
  if (action === "trader_flags") {
    const SEV_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };

    const [{ data: accounts }, { data: profiles }, { data: kycRows }, { data: sharedIps }, { data: openTrades }] =
      await Promise.all([
        db.from("trading_accounts").select("*").neq("status", "void"),
        db.from("user_profiles").select("user_id,full_name,restricted_jurisdiction"),
        db.from("trader_kyc").select("user_id,status,note,updated_at"),
        db.from("shared_ip_accounts").select("*"),
        db.from("trades").select("account_id,user_id,symbol,side,volume,open_price").eq("status", "open").limit(20000),
      ]);
    if (!accounts || !accounts.length) return json({ ok: true, flags: [], scored_at: new Date().toISOString() });

    const nameBy = new Map<string, string>();
    const restrictedBy = new Set<string>();
    for (const p of profiles ?? []) {
      nameBy.set(p.user_id, p.full_name ?? "");
      if (p.restricted_jurisdiction) restrictedBy.add(p.user_id);
    }
    const kycBy = new Map<string, Record<string, unknown>>();
    for (const k of kycRows ?? []) kycBy.set(k.user_id, k);
    const sharedByUser = new Map<string, { client_ip: string; distinct_users: number }[]>();
    for (const row of sharedIps ?? []) {
      for (const uid of (row.user_ids as string[]) ?? []) {
        if (!sharedByUser.has(uid)) sharedByUser.set(uid, []);
        sharedByUser.get(uid)!.push({ client_ip: row.client_ip, distinct_users: Number(row.distinct_users) });
      }
    }

    // closed-trade history per account, only for the accounts we're scoring
    const activeAccts = accounts.filter((a: Record<string, unknown>) => a.status !== "breached" || a.investigation_hold);
    const ids = accounts.map((a: Record<string, unknown>) => a.id);
    const { data: allTrades } = await db.from("trades").select("*").in("account_id", ids).limit(40000);
    const tradesBy = new Map<string, Trade[]>();
    for (const t of allTrades ?? []) {
      const k = t.account_id as string;
      if (!tradesBy.has(k)) tradesBy.set(k, []);
      tradesBy.get(k)!.push(t);
    }

    // crowded-book contribution: same netting logic as firm_risk, but we
    // only need each account's share of its symbol's dominant side.
    const CONTRACT: Record<string, number> = {
      XAUUSD: 100, XPTUSD: 100, XPDUSD: 100, XAGUSD: 5000,
      SPXUSD: 10, NSXUSD: 10, DJI: 10, UK100: 10, GER40: 10, FRA40: 10, JPN225: 10, US2000: 10,
    };
    const contractFor = (s: string) => CONTRACT[s] ?? 100000;
    const symAgg = new Map<string, { longLots: number; shortLots: number }>();
    const acctLots = new Map<string, { symbol: string; side: string; lots: number }[]>();
    for (const t of openTrades ?? []) {
      const sym = String(t.symbol);
      const lots = Number(t.volume);
      if (!symAgg.has(sym)) symAgg.set(sym, { longLots: 0, shortLots: 0 });
      const g = symAgg.get(sym)!;
      if (t.side === "buy") g.longLots += lots; else g.shortLots += lots;
      const aid = t.account_id as string;
      if (!acctLots.has(aid)) acctLots.set(aid, []);
      acctLots.get(aid)!.push({ symbol: sym, side: t.side as string, lots });
    }

    const results: Record<string, unknown>[] = [];

    for (const a of activeAccts) {
      const aid = a.id as string;
      const trades = tradesBy.get(aid) ?? [];
      const sig = midChallengeSignal(trades, a, null);
      const flags: { severity: string; category: string; label: string; detail?: string }[] = [];

      // -- breach proximity (evaluation and funded accounts alike) --
      if (a.status === "active" && sig.distance_to_floor !== null) {
        const start = Number(a.starting_balance);
        const ddPct = Number(a.max_drawdown_pct ?? 10);
        const budget = r2(start * ddPct / 100);
        const pctLeft = budget > 0 ? r2((sig.distance_to_floor / budget) * 100) : null;
        if (pctLeft !== null && pctLeft <= 30) {
          flags.push({
            severity: pctLeft <= 15 ? "critical" : "high",
            category: "near_breach",
            label: `${pctLeft}% of drawdown budget left`,
            detail: `Balance sits $${sig.distance_to_floor} above the breach floor, out of a $${budget} total budget.`,
          });
        }
      }

      // -- investigation hold --
      if (a.investigation_hold) {
        flags.push({ severity: "critical", category: "investigation", label: "Under investigation hold", detail: (a.investigation_note as string) || "No note recorded." });
      }

      // -- KYC --
      const kyc = kycBy.get(a.user_id as string);
      if (kyc?.status === "rejected") {
        flags.push({ severity: "high", category: "kyc", label: "KYC rejected", detail: (kyc.note as string) || "" });
      } else if (kyc?.status === "pending") {
        const ageDays = Math.round((Date.now() - new Date(kyc.updated_at as string).getTime()) / 86400000);
        if (ageDays >= 3) flags.push({ severity: ageDays >= 7 ? "high" : "medium", category: "kyc", label: `KYC pending review for ${ageDays} day(s)` });
      }

      // -- restricted jurisdiction --
      if (restrictedBy.has(a.user_id as string)) {
        const acute = a.phase === "funded" || !!a.mirror_enabled;
        flags.push({
          severity: acute ? "critical" : "medium",
          category: "jurisdiction",
          label: acute ? "Restricted jurisdiction on a funded/mirrored account" : "Flagged as a restricted jurisdiction",
        });
      }

      // -- behavioural vetoes (martingale, revenge trading, concentration, no stop-loss) --
      if (sig.status === "scored" && sig.vetoes.length) {
        flags.push({
          severity: sig.vetoes.length >= 2 ? "high" : "medium",
          category: "behavior",
          label: sig.vetoes.join("; "),
          detail: sig.note,
        });
      }

      // -- shared IP / possible multi-accounting --
      const shared = sharedByUser.get(a.user_id as string);
      if (shared?.length) {
        const others = Math.max(...shared.map((s) => s.distinct_users)) - 1;
        flags.push({
          severity: "medium",
          category: "shared_ip",
          label: `Shares an IP with ${others} other account(s)`,
          detail: "Innocent causes (household, office, VPN) are common — this is a lead, not proof.",
        });
      }

      // -- crowded-book contribution --
      for (const pos of acctLots.get(aid) ?? []) {
        const g = symAgg.get(pos.symbol);
        if (!g) continue;
        const dominant = g.longLots >= g.shortLots ? "buy" : "sell";
        const dominantLots = Math.max(g.longLots, g.shortLots);
        const grossLots = g.longLots + g.shortLots;
        const crowding = grossLots > 0 ? (Math.abs(g.longLots - g.shortLots) / grossLots) * 100 : 0;
        if (pos.side === dominant && crowding >= 70 && dominantLots > 0 && pos.lots / dominantLots >= 0.2) {
          flags.push({
            severity: "low",
            category: "concentration",
            label: `Holds ${r2((pos.lots / dominantLots) * 100)}% of the crowded ${pos.symbol} ${dominant === "buy" ? "long" : "short"} book`,
            detail: "A large single contributor to a one-sided book — worth knowing about before that symbol moves.",
          });
        }
      }

      // -- surfaced opportunity: a genuinely strong mid-challenge signal, not just a problem --
      if (sig.status === "scored" && !sig.vetoes.length && sig.risk_blind === false && (sig.signal_score ?? 0) >= 70 && a.phase !== "funded") {
        flags.push({ severity: "low", category: "opportunity", label: `High-quality signal (score ${sig.signal_score}) — worth a closer look`, detail: sig.note });
      }

      if (!flags.length) continue;
      flags.sort((x, y) => SEV_RANK[y.severity] - SEV_RANK[x.severity]);
      results.push({
        user_id: a.user_id, account_id: aid,
        full_name: nameBy.get(a.user_id as string) || "—",
        status: a.status, phase: a.phase ?? "evaluation",
        balance: Number(a.balance), starting_balance: Number(a.starting_balance),
        max_severity: flags[0].severity, flag_count: flags.length,
        flags,
      });
    }

    results.sort((x, y) => {
      const s = SEV_RANK[y.max_severity as string] - SEV_RANK[x.max_severity as string];
      return s !== 0 ? s : (y.flag_count as number) - (x.flag_count as number);
    });

    return json({ ok: true, flags: results, scored_at: new Date().toISOString() });
  }

  // ---- admin audit log (read-only, admin-gated by definition since
  // this whole function already is) ----
  if (action === "audit_log") {
    const target_user = body.user_id ? String(body.user_id) : null;
    let q = db.from("admin_audit_log").select("*").order("created_at", { ascending: false }).limit(200);
    if (target_user) q = q.eq("target_user_id", target_user);
    const { data } = await q;
    return json({ ok: true, entries: data ?? [] });
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
      return {
        account_id: a.id, label: a.label, status: a.status, created_at: a.created_at,
        profile: buildStrategyProfile(ts), readiness: computeReadiness(ts, a),
        mid_challenge: midChallengeSignal(ts, a, null),
      };
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
