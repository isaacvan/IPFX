// Copy start gate and copy kill switch (pure, no I/O). Red-team fixes, 30 Oct 2026
// (infinity-selection-study/v1_vs_v2/REPORT.md, sections 4.1 and 4.4).
//
// Start gate: a trader becomes copy-eligible from their run-wide consistency score (every counted trade since the current
// Infinity run began, across stages), never from reaching Stage 2. Simulated on real behaviour, score >= 2.33 over >= 80
// counted trades picked traders as good as Stage 3 passers (5.7% unprofitable to copy, +0.18R) about 40 days sooner, while
// copying at Stage 2 entry picked 52% unprofitable traders (-0.02R).
// Kill switch: stop copying when the copies themselves keep losing (score <= -1 after 40 copied trades) or draw down 12R.

export type GateTrade = { id: string; parentId: string | null; accountId: string; symbol: string; side: string; openedAt: number; closedAt: number | null; pnlUsd: number; riskUsd: number | null };
export type CountedTrade = { r: number; closedAt: number };

const GAP_MS = 15 * 60_000;
const R_CAP = 5;
const SD_FLOOR = 0.5;

// Counted trades: same account, symbol and side, opened while one of the group is open or within 15 minutes of the group's
// last entry. Partial closes (child rows) add their P&L to their root. R = group P&L / group opening risk, capped at +-5.
// A group with an open leg or without a usable risk is left out (it cannot be scored).
export function countedTrades(trades: GateTrade[]): CountedTrade[] {
  const roots = new Map<string, { t: GateTrade; pnl: number; open: boolean }>();
  for (const t of trades) if (!t.parentId) roots.set(t.id, { t, pnl: t.pnlUsd, open: t.closedAt == null });
  for (const t of trades) if (t.parentId) {
    const root = roots.get(t.parentId);
    if (root) { root.pnl += t.pnlUsd; if (t.closedAt == null) root.open = true; }
  }
  const byKey = new Map<string, { t: GateTrade; pnl: number; open: boolean }[]>();
  for (const r of roots.values()) {
    const k = r.t.accountId + "|" + r.t.symbol + "|" + r.t.side;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const out: CountedTrade[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.t.openedAt - b.t.openedAt);
    let g: { pnl: number; risk: number; valid: boolean; open: boolean; end: number; lastEntry: number } | null = null;
    const flush = () => { if (g && !g.open && g.valid && g.risk > 0) out.push({ r: Math.max(-R_CAP, Math.min(R_CAP, g.pnl / g.risk)), closedAt: g.end }); };
    for (const r of list) {
      const o = r.t.openedAt, risk = r.t.riskUsd;
      const joins = g && (o <= g.end || g.open || o - g.lastEntry <= GAP_MS);
      if (!joins) { flush(); g = { pnl: 0, risk: 0, valid: true, open: false, end: o, lastEntry: o }; }
      g!.pnl += r.pnl; g!.lastEntry = o;
      if (risk == null || !(risk > 0)) g!.valid = false; else g!.risk += risk;
      if (r.open) g!.open = true; else g!.end = Math.max(g!.end, r.t.closedAt ?? o);
    }
    flush();
  }
  return out.sort((a, b) => a.closedAt - b.closedAt);
}

// mean(R) / (max(sample sd, 0.5) / sqrt(n)) -- the same formula as the trader-facing Infinity v2 score.
export function consistencyScore(rs: number[]): number {
  const n = rs.length;
  if (n === 0) return 0;
  const m = rs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : 0;
  return m / (Math.max(sd, SD_FLOOR) / Math.sqrt(n));
}

export type RunGate = { counted: number; score: number };
export function runGate(trades: GateTrade[]): RunGate {
  const rs = countedTrades(trades).map((c) => c.r);
  return { counted: rs.length, score: consistencyScore(rs) };
}

export type KillPolicy = { killCopyScore: number; killMinCopied: number; killDrawdownR: number };
// copyRs: the copy results (R, after costs) since the trader entered their current copy state, oldest first.
export function copyKill(copyRs: number[], p: KillPolicy): { stop: boolean; reason: string; score: number; drawdownR: number } {
  const xs = copyRs.map((x) => Math.max(-R_CAP, Math.min(R_CAP, x)));
  let cum = 0, peak = 0, dd = 0;
  for (const x of copyRs) { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const score = consistencyScore(xs);
  if (Number.isFinite(p.killDrawdownR) && dd >= p.killDrawdownR)
    return { stop: true, reason: `copy kill switch: copies fell ${dd.toFixed(1)}R from their peak (limit ${p.killDrawdownR}R)`, score, drawdownR: dd };
  if (Number.isFinite(p.killCopyScore) && xs.length >= p.killMinCopied && score <= p.killCopyScore)
    return { stop: true, reason: `copy kill switch: copy score ${score.toFixed(2)} after ${xs.length} copied trades (limit ${p.killCopyScore} after ${p.killMinCopied})`, score, drawdownR: dd };
  return { stop: false, reason: "", score, drawdownR: dd };
}
