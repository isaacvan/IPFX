// Bar-by-bar backtester that cannot see the future.
//
// A strategy decides on the CLOSE of bar i and is filled at the OPEN of bar i+1. Prices in the bars
// are mid; the trader buys at the ask and sells at the bid (IPFX's quoted spread, see rules.mjs),
// stops pay extra slippage, and a gap through a stop fills at the open, not the stop. When one bar
// touches both the stop and the target we assume the stop came first. Every trade comes back in R
// (multiples of the risk actually taken) with the open-trade excursions the challenge rules judge.
//
// strategy.prepare(bars, params) -> {
//   entry(i) -> null | { side: 1|-1, stopDist, targetDist?, maxBars? }   decided at bar i close
//   exit?(j, side) -> boolean                                             exit at bar j close
// }

import { SPREADS } from "./rules.mjs";

export function barSeconds(bars) {
  const gaps = [];
  for (let i = 1; i < Math.min(bars.length, 500); i++) gaps.push(bars[i].time - bars[i - 1].time);
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1] || 3600;
}

export function backtest(bars, strategy, params, { symbol, spread = SPREADS[symbol] ?? 0, slippage = 0, costMultiplier = 1, maxHoldBars = 2000, from = 0, to = bars.length } = {}) {
  const sig = strategy.prepare(bars, params);
  const h = (spread / 2) * costMultiplier, slip = slippage * costMultiplier;
  const secs = barSeconds(bars);
  const trades = [];
  let i = Math.max(from, 0);
  while (i < to - 1) {
    const e = sig.entry(i);
    if (!e || !(e.stopDist > 0)) { i++; continue; }
    const side = e.side, j0 = i + 1, open = bars[j0].open;
    const entry = open + side * h;
    const stop = entry - side * e.stopDist;
    const target = e.targetDist > 0 ? entry + side * e.targetDist : null;
    const risk = Math.abs(entry - stop);
    const limit = Math.min(to - 1, j0 + (e.maxBars > 0 ? e.maxBars : maxHoldBars) - 1);
    const R = (px) => (side * (px - entry)) / risk;
    let mae = 0, mfe = 0, peakBeforeTrough = 0, exitPx = null, exitTime = null, reason = null, j = j0;
    for (; j <= limit; j++) {
      const b = bars[j];
      // what the trader's position can actually be closed at: bid for longs, ask for shorts
      const worst = side > 0 ? b.low - h : b.high + h, best = side > 0 ? b.high - h : b.low + h;
      const openPx = b.open - side * h;
      const stopHit = side > 0 ? worst <= stop : worst >= stop;
      const targetHit = target != null && (side > 0 ? best >= target : best <= target);
      if (stopHit) {
        const gapped = side > 0 ? openPx <= stop : openPx >= stop;
        exitPx = (gapped ? openPx : stop) - side * slip;
        reason = gapped ? "stop_gap" : "stop";
      } else if (targetHit) {
        const gapped = side > 0 ? openPx >= target : openPx <= target;
        exitPx = gapped ? openPx : target;
        reason = "target";
      }
      // excursions, clamped to the exit on the exit bar
      const adverse = exitPx != null && reason.startsWith("stop") ? R(exitPx) : R(worst);
      const favourable = exitPx != null && reason === "target" ? R(exitPx) : R(best);
      if (favourable > mfe) mfe = favourable;
      if (adverse < mae) { mae = adverse; peakBeforeTrough = mfe; } // same-bar high counted first: conservative
      if (exitPx != null) { exitTime = b.time + secs / 2; break; } // somewhere inside the bar
      const timeUp = j === limit;
      if (timeUp || (sig.exit && sig.exit(j, side))) {
        exitPx = b.close - side * h - side * slip;
        exitTime = b.time + secs;
        reason = timeUp ? "time" : "exit";
        const rr = R(exitPx);
        if (rr < mae) { mae = rr; peakBeforeTrough = mfe; }
        break;
      }
    }
    if (exitPx == null) break; // ran off the end of the data with a position open
    const r = R(exitPx);
    trades.push({
      entryTime: bars[j0].time, exitTime, side, entry, exit: exitPx, stop, target, r,
      maeR: Math.min(mae, r, 0), mfeR: Math.max(mfe, r, 0), peakBeforeTroughR: Math.max(0, peakBeforeTrough),
      costR: (2 * h + (reason === "target" ? 0 : slip)) / risk, bars: j - j0 + 1, reason,
    });
    i = j; // may re-enter on the close of the exit bar
  }
  return trades;
}

// Per-day R, on the calendar of days the market traded, for comparing configurations on the same
// timeline (PBO, CPCV, Reality Check). Days are UTC; a trade counts on the day it closed.
export function tradingDays(bars) {
  const days = [];
  let last = null;
  for (const b of bars) { const d = Math.floor(b.time / 86400); if (d !== last) { days.push(d); last = d; } }
  return days;
}
export function dailyR(trades, days) {
  const index = new Map(days.map((d, k) => [d, k]));
  const out = new Array(days.length).fill(0);
  for (const t of trades) {
    const k = index.get(Math.floor(t.exitTime / 86400));
    if (k !== undefined) out[k] += t.r;
  }
  return out;
}
