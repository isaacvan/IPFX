// Replays a strategy's trades through an IPFX challenge stage exactly as the live system judges it.
//
// Mirrors, rule for rule:
//   trading-engine/index.ts   effectiveRiskLimit (per-trade risk shrinks with the drawdown and
//                             daily buffers), total open risk <= 3x that limit, 20 open positions,
//                             daily profit cap blocking new orders, drawdown floors by mode
//                             (static / trailing_intraday / trailing_eod), daily loss floor from the
//                             UTC day-start equity, pass only when flat and at the target, profit
//                             from trades held under 60s not counting toward the target
//   account_progress view     trading days and closed trades count only trades held >= 60s;
//                             a profitable day is day P&L > 0.25% of the starting balance
//   qualification_progress_v2 observation period, meaningful days (|day net| >= 0.1%),
//                             merged exposure sessions (60-minute flat gap), best-day share
//
// Input trades are in R (multiples of the planned risk, net of costs):
//   { entryTime, exitTime (unix seconds), r, maeR (<= 0), mfeR (>= 0), peakBeforeTroughR (>= 0) }
// maeR is the worst open loss during the trade and peakBeforeTroughR the best open profit before
// that trough. Both matter: a trailing intraday drawdown is judged on equity, not closed balance.
//
// Known approximations (all conservative or neutral):
//   - the engine samples equity when it runs; this assumes it saw every excursion
//   - with several positions open, each trade's excursion is judged with the others at zero
//     floating P&L (strategies from backtest.mjs hold one position at a time, so this is exact there)
//   - the day-start equity and the trailing_eod peak use balance when a position spans midnight

import { ENGINE } from "./rules.mjs";

const DAY = 86400;
const dayOf = (t) => Math.floor(t / DAY);
const EPS = 1e-9;

// One attempt at one stage. Returns what happened and why.
//   startTime        account start (the contract's accepted_at); trades before it are ignored
//   maxCalendarDays  give up after this long (an attempt nobody would keep paying for)
//   riskScale        fraction of the allowed risk the trader uses on each order (1 = the maximum)
export function runChallenge(trades, preset, { startTime = trades.length ? trades[0].entryTime : 0, maxCalendarDays = 365, riskScale = 1 } = {}) {
  const start = preset.balance;
  const endTime = startTime + maxCalendarDays * DAY;
  const ddAmount = (start * preset.ddPct) / 100;
  const baseRisk = (start * preset.riskPct) / 100;
  const cap = preset.dailyProfitCapPct == null ? null : (start * preset.dailyProfitCapPct) / 100;
  const target = preset.targetPct > 0 ? start * (1 + preset.targetPct / 100) : null;
  const q = preset.qualification;

  let balance = start, peak = start, day = dayOf(startTime), dayStart = start;
  let quickProfit = 0, tradesClosed = 0, sessions = 0, lastFlat = null, lastExitSeen = null, taken = 0, blocked = { cap: 0, risk: 0, positions: 0 };
  let minEquity = start, maxEquity = start;
  const days = new Map(); // day -> { net, counting }
  const open = []; // { exitTime, risk, t }

  const ddFloor = () => (preset.ddMode === "static" ? start - ddAmount : peak - ddAmount);
  const dailyFloor = () => dayStart - (start * preset.dailyLossPct) / 100;
  const allowedRisk = () => Math.max(0, Math.min(baseRisk,
    ENGINE.drawdownBufferRiskFraction * Math.max(0, balance - ddFloor()),
    ENGINE.dailyBufferRiskFraction * Math.max(0, balance - dailyFloor())));

  function rollTo(t) {
    const d = dayOf(t);
    if (d === day) return;
    if (preset.ddMode === "trailing_eod" && balance > peak) peak = balance;
    day = d;
    dayStart = balance;
  }

  function progress(now) {
    let tradingDays = 0, profitable = 0, meaningful = 0, sumPos = 0, best = 0;
    for (const v of days.values()) {
      if (v.counting > 0) { tradingDays++; if (v.net > start * ENGINE.profitableDayFraction) profitable++; }
      if (q && Math.abs(v.net) >= start * q.minDailyNetFraction) meaningful++;
      if (v.net > 0) { sumPos += v.net; if (v.net > best) best = v.net; }
    }
    const unmet = [];
    if (target == null) unmet.push("NO_TARGET");
    else {
      if (balance < target - EPS) unmet.push("PROFIT_TARGET");
      else if (balance - quickProfit < target - EPS) unmet.push("QUICK_TRADE_PROFIT");
    }
    if (tradingDays < preset.minTradingDays) unmet.push("TRADING_DAYS");
    if (tradesClosed < preset.minTrades) unmet.push("TRADES");
    if (preset.minProfitableDaysPct != null && (tradingDays ? (100 * profitable) / tradingDays : 0) < preset.minProfitableDaysPct - EPS) unmet.push("PROFITABLE_DAYS");
    if (q) {
      if ((now - startTime) / DAY < q.minElapsedDays) unmet.push("OBSERVATION_PERIOD");
      if (meaningful < q.minTradingDays) unmet.push("MEANINGFUL_TRADING_DAYS");
      if (sessions < q.minSessions) unmet.push("EXPOSURE_SESSIONS");
      if (sumPos <= 0 || best / sumPos > q.maxBestDayShare + EPS) unmet.push("PROFIT_CONCENTRATION");
    }
    if (open.length) unmet.push("OPEN_POSITIONS");
    return { unmet, tradingDays, profitableDays: profitable, meaningfulDays: meaningful, bestDayShare: sumPos > 0 ? best / sumPos : null };
  }

  function result(outcome, time, reason, extra = {}) {
    const p = progress(time);
    return {
      outcome, reason, time, calendarDays: (time - startTime) / DAY, balance, returnPct: ((balance - start) / start) * 100,
      tradesTaken: taken, tradesClosed, sessions, tradingDays: p.tradingDays, profitableDays: p.profitableDays,
      meaningfulDays: p.meaningfulDays, bestDayShare: p.bestDayShare, unmet: p.unmet.filter((u) => u !== "OPEN_POSITIONS"),
      maxDrawdownPct: ((maxEquity - minEquity) / start) * 100, blocked, ...extra,
    };
  }

  // Nothing but the observation period changes between trades, so when every other gate is met the
  // engine's next check passes the account as soon as that period ends, which can be between trades.
  function passTime(now) {
    if (open.length || target == null || lastFlat == null) return null;
    const p = progress(now);
    if (p.unmet.some((u) => u !== "OBSERVATION_PERIOD")) return null;
    const at = Math.max(lastFlat, q ? startTime + q.minElapsedDays * DAY : lastFlat);
    return at <= now ? at : null;
  }

  function close(pos) {
    const { t, risk } = pos;
    // intraday excursions first: the peak (if it came first) then the trough
    if (preset.ddMode === "trailing_intraday") peak = Math.max(peak, balance + (t.peakBeforeTroughR ?? 0) * risk);
    maxEquity = Math.max(maxEquity, balance + (t.peakBeforeTroughR ?? 0) * risk);
    const trough = balance + Math.min(t.maeR ?? Math.min(0, t.r), t.r) * risk;
    minEquity = Math.min(minEquity, trough);
    if (trough <= ddFloor() + EPS) return "max_drawdown";
    if (trough <= dailyFloor() + EPS) return "daily_loss";
    const pnl = t.r * risk, held = t.exitTime - t.entryTime;
    if (preset.ddMode === "trailing_intraday") peak = Math.max(peak, balance + (t.mfeR ?? Math.max(0, t.r)) * risk, balance + pnl);
    balance += pnl;
    maxEquity = Math.max(maxEquity, balance);
    const counts = held >= ENGINE.minHoldSeconds;
    if (!counts && pnl > 0) quickProfit += pnl;
    if (counts) tradesClosed++;
    const d = dayOf(t.exitTime), rec = days.get(d) || { net: 0, counting: 0 };
    rec.net += pnl; if (counts) rec.counting++;
    days.set(d, rec);
    return null;
  }

  const sorted = trades.filter((t) => t.entryTime >= startTime).sort((a, b) => a.entryTime - b.entryTime);
  let i = 0;
  for (;;) {
    const nextEntry = i < sorted.length ? sorted[i].entryTime : Infinity;
    let nextExitIdx = -1;
    for (let k = 0; k < open.length; k++) if (nextExitIdx < 0 || open[k].t.exitTime < open[nextExitIdx].t.exitTime) nextExitIdx = k;
    const nextExit = nextExitIdx >= 0 ? open[nextExitIdx].t.exitTime : Infinity;
    const now = Math.min(nextEntry, nextExit);

    const passAt = passTime(Math.min(now, endTime));
    if (passAt != null) return result("pass", passAt, null);
    if (now === Infinity) return result("data_end", lastFlat ?? startTime, "ran out of trades", { censored: true });
    if (now > endTime) return result("timeout", endTime, "time limit");

    rollTo(now);
    if (nextExit <= nextEntry) {
      const [pos] = open.splice(nextExitIdx, 1);
      const breach = close(pos);
      if (breach) return result("breach", pos.t.exitTime, breach);
      if (!open.length) lastFlat = pos.t.exitTime;
      continue;
    }

    const t = sorted[i++];
    if (open.length >= ENGINE.maxOpenPositions) { blocked.positions++; continue; }
    if (cap != null && balance - dayStart >= cap - EPS) { blocked.cap++; continue; }
    const limit = allowedRisk();
    const risk = limit * riskScale;
    const openRisk = open.reduce((s, p) => s + p.risk, 0);
    if (risk <= 0.01 || openRisk + risk > limit * ENGINE.maxTotalRiskMultiple + 0.01) { blocked.risk++; continue; }
    // SQL: a new exposure session starts when the entry is over 60 minutes after the latest exit so far
    const gap = (q ? q.sessionFlatGapMinutes : 60) * 60;
    if (lastExitSeen == null || t.entryTime > lastExitSeen + gap) sessions++;
    lastExitSeen = Math.max(lastExitSeen ?? -Infinity, t.exitTime);
    open.push({ t, risk });
    taken++;
  }
}
// Pass probability over rolling start dates. Windows that run out of data before finishing are
// censored and excluded (counting them as failures would punish short histories). Overlapping
// windows are not independent: `independentWindows` is the honest sample size.
export function passProbability(trades, preset, { stepDays = 7, maxCalendarDays = 365, riskScale = 1 } = {}) {
  if (!trades.length) return { windows: 0, passRate: NaN };
  const first = dayOf(trades[0].entryTime) * DAY, last = Math.max(...trades.map((t) => t.exitTime));
  const outcomes = [];
  for (let s = first; s < last; s += stepDays * DAY) {
    const r = runChallenge(trades, preset, { startTime: s, maxCalendarDays, riskScale });
    if (r.outcome !== "data_end") outcomes.push(r);
  }
  return summarise(outcomes, (last - first) / DAY / Math.max(1, median(outcomes.map((o) => o.calendarDays)) || maxCalendarDays));
}

function median(x) { if (!x.length) return NaN; const s = [...x].sort((a, b) => a - b); return s[s.length >> 1]; }
function summarise(outcomes, independent) {
  const n = outcomes.length, count = (o) => outcomes.filter((x) => x.outcome === o).length;
  const reasons = {};
  for (const o of outcomes) {
    const key = o.outcome === "breach" ? "breach:" + o.reason : o.outcome === "timeout" ? "timeout:" + (o.unmet[0] || "?") : o.outcome;
    reasons[key] = (reasons[key] || 0) + 1;
  }
  const passes = outcomes.filter((o) => o.outcome === "pass");
  return {
    windows: n, independentWindows: Math.max(1, Math.floor(independent)),
    passRate: n ? count("pass") / n : NaN, breachRate: n ? count("breach") / n : NaN, timeoutRate: n ? count("timeout") / n : NaN,
    medianDaysToPass: median(passes.map((p) => p.calendarDays)), reasons,
  };
}

// The whole Infinity ladder: Stage 1, then Stage 2 from the day after passing, then Stage 3.
export function runPath(trades, presets, { startTime, maxCalendarDays = 365, riskScale = 1 } = {}) {
  const stages = [];
  let t = startTime;
  for (const p of presets) {
    const r = runChallenge(trades, p, { startTime: t, maxCalendarDays, riskScale });
    stages.push({ stage: p.name, ...r });
    if (r.outcome !== "pass") break;
    t = (dayOf(r.time) + 1) * DAY;
  }
  const lastStage = stages[stages.length - 1];
  return { reached: stages.filter((s) => s.outcome === "pass").length, censored: lastStage.outcome === "data_end", stages };
}
export function pathProbability(trades, presets, { stepDays = 14, maxCalendarDays = 365, riskScale = 1 } = {}) {
  if (!trades.length) return { windows: 0 };
  const first = dayOf(trades[0].entryTime) * DAY, last = Math.max(...trades.map((t) => t.exitTime));
  const runs = [];
  for (let s = first; s < last; s += stepDays * DAY) {
    const r = runPath(trades, presets, { startTime: s, maxCalendarDays, riskScale });
    if (!r.censored) runs.push(r);
  }
  const n = runs.length;
  return {
    windows: n,
    reachedAtLeast: presets.map((_, k) => (n ? runs.filter((r) => r.reached >= k + 1).length / n : NaN)),
  };
}
