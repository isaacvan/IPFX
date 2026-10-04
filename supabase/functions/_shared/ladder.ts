// Evaluation-ladder controller (pure). Recommends whether IPFX should buy more prop-firm evaluations to trade
// on pooled A-book signals. It never buys: the owner acts on the recommendation.
//   Gate: the copied traders' pooled same-direction results (ledger replay, after costs) must beat the
//         break-even edge with confidence (daily lower bound > 0 and mean >= break-even), over enough trades.
//         Simulation: below ~+0.03R per trade an evaluation loses its fee on average.
//   Budget: seed + reinvest_fraction x payouts received - fees already paid. The seed is the most the ladder
//         can ever lose; after that only profits are put back at risk.
export type LadderSettings = { seed: number; reinvest: number; fee: number; maxActive: number; minTrades: number; breakEvenR: number };
export type GateEvidence = { trades: number; meanR: number | null; days: number; dayMean: number | null; daySd: number | null };
export type LadderDecision = { action: "buy" | "hold" | "stop"; accounts: number; budget: number; gate: boolean; reason: string; lower: number | null };

export function ladderDecision(s: LadderSettings, e: GateEvidence, activeAccounts: number, payoutsReceived: number, feesPaid: number): LadderDecision {
  const budget = Math.max(0, s.seed + s.reinvest * payoutsReceived - feesPaid);
  const lower = e.days >= 2 && e.dayMean != null && e.daySd != null ? e.dayMean - 1.645 * e.daySd / Math.sqrt(e.days) : null;
  const gate = e.trades >= s.minTrades && lower != null && lower > 0 && (e.meanR ?? -1) >= s.breakEvenR;
  if (gate) {
    const room = Math.max(0, s.maxActive - activeAccounts);
    const n = Math.min(room, Math.floor(budget / s.fee));
    if (n > 0) return { action: "buy", accounts: n, budget, gate, lower, reason: `copied traders beat break-even with confidence (${e.trades} trades, mean ${(e.meanR ?? 0).toFixed(3)}R); budget allows ${n}` };
    return { action: "hold", accounts: 0, budget, gate, lower, reason: room === 0 ? "at the maximum number of accounts" : "edge confirmed but budget used: wait for payouts" };
  }
  if (activeAccounts > 0 && e.trades >= s.minTrades && (e.meanR ?? 0) < 0)
    return { action: "stop", accounts: 0, budget, gate, lower, reason: `copied traders are losing after costs (mean ${(e.meanR ?? 0).toFixed(3)}R): buy nothing; consider pausing accounts` };
  return { action: "hold", accounts: 0, budget, gate, lower,
    reason: e.trades < s.minTrades ? `not enough evidence yet (${e.trades}/${s.minTrades} copied trades)` : "edge not confirmed above break-even yet" };
}
