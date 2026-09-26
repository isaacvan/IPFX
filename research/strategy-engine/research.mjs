// The research pipeline: is a strategy family's best configuration a real edge, and can it pass
// IPFX's challenges? Every gate below comes from the published plan and the literature behind it;
// a strategy is accepted only if it clears ALL of them. Challenge results are reported separately,
// because a real edge can still be a poor fit for a particular stage's rules, and the reverse.
//
// Order matters: the last 30% of history is the hold-out and is used exactly once, after the
// configuration has been chosen on the first 70%.

import * as S from "./stats.mjs";
import { backtest, tradingDays, dailyR } from "./backtest.mjs";
import { FAMILIES, gridOf } from "./library.mjs";
import { PRESETS, traditional } from "./rules.mjs";
import { passProbability, pathProbability } from "./challenge-sim.mjs";
import { datasetId } from "./data.mjs";

export const GATES = Object.freeze({
  minTrades: 300,          // enough trades for the statistics to mean anything (MinTRL at SR 0.1/trade is ~270)
  minYears: 10,            // spans several regimes; MinBTL for a few dozen trials at SR 1 is ~5 years
  holdoutMinT: 3,          // Harvey, Liu & Zhu: t > 3 once you allow for everyone's data mining
  minDsr: 0.95,            // Deflated Sharpe Ratio, charged for every trial in the registry
  maxPbo: 0.10,            // probability of backtest overfitting (CSCV)
  minCpcvPathsProfitable: 0.80,
  costStress: 1.5,         // still profitable with spreads and slippage 50% worse
  minPlateau: 0.70,        // neighbouring parameters mostly profitable too: not a lucky spike
});

const YEAR = 365.25 * 86400;

function tradeStats(trades) {
  const r = trades.map((t) => t.r);
  if (r.length < 2) return { trades: r.length };
  const m = S.moments(r), sr = S.sharpe(r);
  return {
    trades: r.length, winRate: r.filter((x) => x > 0).length / r.length, expectancyR: m.mean, totalR: S.sum(r),
    sharpePerTrade: sr, tStat: S.tStat(r), psr: S.psr(sr, r.length, m.skew, m.kurt),
    minTrackRecordTrades: Math.ceil(S.minTrackRecord(sr, m.skew, m.kurt)),
    avgCostR: S.mean(trades.map((t) => t.costR)), avgBars: S.mean(trades.map((t) => t.bars)),
  };
}

function neighbours(grid, a, b) {
  let diff = 0;
  for (const k of Object.keys(grid)) {
    if (a[k] === b[k]) continue;
    const vals = grid[k];
    if (Math.abs(vals.indexOf(a[k]) - vals.indexOf(b[k])) !== 1) return false;
    diff++;
  }
  return diff === 1;
}

// CPCV: choose the best configuration on the training groups (with an embargo either side of each
// test group), record how that choice did on the test groups, and stitch the tests into paths.
function cpcv(matrix, { groups = 6, testGroups = 2, embargoDays = 5 } = {}) {
  const T = matrix.length, N = matrix[0].length, size = Math.floor(T / groups);
  const bounds = [...Array(groups).keys()].map((g) => [g * size, g === groups - 1 ? T : (g + 1) * size]);
  const plan = S.cpcvPlan(groups, testGroups);
  const chosen = plan.splits.map((test) => {
    const testRanges = test.map((g) => bounds[g]);
    const train = [];
    for (let t = 0; t < T; t++) if (!testRanges.some(([a, b]) => t >= a - embargoDays && t < b + embargoDays)) train.push(t);
    let best = 0, bestV = -Infinity;
    for (let n = 0; n < N; n++) { const v = S.sharpe(train.map((t) => matrix[t][n])); if (v > bestV) { bestV = v; best = n; } }
    return best;
  });
  const paths = plan.paths.map((path) => {
    let total = 0;
    path.forEach((split, g) => { const [a, b] = bounds[g]; for (let t = a; t < b; t++) total += matrix[t][chosen[split]]; });
    return total;
  });
  return { paths, profitableShare: paths.filter((p) => p > 0).length / paths.length };
}

// Run a whole family on one instrument's history.
//   registry: a Registry (every grid point is logged and counted toward DSR)
//   timeframe: label for the registry ("60", "D", ...)
export function evaluateFamily({ bars, symbol, timeframe, familyId, registry = null, holdoutFraction = 0.3, costs = {} }) {
  const family = FAMILIES[familyId];
  if (!family) throw new Error("unknown family " + familyId);
  const configs = gridOf(family);
  const split = Math.floor(bars.length * (1 - holdoutFraction));
  const devBars = bars.slice(0, split);
  const devDays = tradingDays(devBars);
  const years = (bars[bars.length - 1].time - bars[0].time) / YEAR;
  const dataset = datasetId(bars);

  // 1. every configuration on the development period
  const runs = configs.map((params) => {
    const trades = backtest(bars, family, params, { symbol, ...costs, to: split });
    const daily = dailyR(trades, devDays);
    return { params, trades, daily, sharpeDaily: S.sharpe(daily), expectancyR: trades.length ? S.mean(trades.map((t) => t.r)) : 0 };
  });
  if (registry) registry.append(runs.map((r) => ({ symbol, timeframe, family: familyId, params: r.params, dataset, trades: r.trades.length, sharpeDaily: r.sharpeDaily, expectancyR: r.expectancyR })));

  const bestIdx = runs.reduce((b, r, k) => (r.sharpeDaily > runs[b].sharpeDaily ? k : b), 0);
  const best = runs[bestIdx];

  // 2. overfitting diagnostics on the development matrix (days x configurations)
  const matrix = devDays.map((_, t) => runs.map((r) => r.daily[t]));
  const pboRes = runs.length >= 2 && devDays.length >= 64 ? S.pbo(matrix, 16) : { pbo: NaN };
  const cpcvRes = runs.length >= 2 && devDays.length >= 60 ? cpcv(matrix) : { profitableShare: NaN, paths: [] };
  const snoop = runs.length >= 2 ? S.stepM(matrix, { reps: 500 }) : null;

  // 3. Deflated Sharpe: every trial on this instrument and timeframe, from the registry if given
  const history = registry ? registry.all().filter((t) => t.symbol === symbol && t.timeframe === timeframe) : runs.map((r) => ({ sharpeDaily: r.sharpeDaily }));
  const trialSharpes = history.map((t) => t.sharpeDaily).filter(Number.isFinite);
  const nTrials = Math.max(trialSharpes.length, runs.length);
  const dsr = S.dsr(best.daily, nTrials, S.variance(trialSharpes));

  // 4. plateau: are the neighbours of the chosen parameters profitable too?
  const near = runs.filter((r) => neighbours(family.grid, r.params, best.params));
  const plateau = near.length ? near.filter((r) => r.expectancyR > 0).length / near.length : NaN;

  // 5. the hold-out, used once
  const holdout = backtest(bars, family, best.params, { symbol, ...costs, from: split });
  const holdoutStats = tradeStats(holdout);

  // 6. whole history: count, costs x1.5, and without its best year
  const all = backtest(bars, family, best.params, { symbol, ...costs });
  const stressed = backtest(bars, family, best.params, { symbol, ...costs, costMultiplier: GATES.costStress });
  const byYear = {};
  for (const t of all) { const y = new Date(t.exitTime * 1000).getUTCFullYear(); byYear[y] = (byYear[y] || 0) + t.r; }
  const bestYear = Object.entries(byYear).sort((a, b) => b[1] - a[1])[0];
  const withoutBestYear = S.sum(all.map((t) => t.r)) - (bestYear ? bestYear[1] : 0);

  const gates = [
    gate("trades", all.length, all.length >= GATES.minTrades, `>= ${GATES.minTrades}`),
    gate("history_years", round(years, 1), years >= GATES.minYears, `>= ${GATES.minYears}`),
    gate("holdout_t", round(holdoutStats.tStat ?? 0, 2), (holdoutStats.tStat ?? 0) >= GATES.holdoutMinT, `>= ${GATES.holdoutMinT}`),
    gate("deflated_sharpe", round(dsr, 3), dsr >= GATES.minDsr, `>= ${GATES.minDsr} (charged for ${nTrials} trials)`),
    gate("pbo", round(pboRes.pbo, 3), pboRes.pbo <= GATES.maxPbo, `<= ${GATES.maxPbo}`),
    gate("cpcv_paths_profitable", round(cpcvRes.profitableShare, 2), cpcvRes.profitableShare >= GATES.minCpcvPathsProfitable, `>= ${GATES.minCpcvPathsProfitable}`),
    gate("cost_stress_total_r", round(S.sum(stressed.map((t) => t.r)), 1), S.sum(stressed.map((t) => t.r)) > 0, `> 0 at ${GATES.costStress}x costs`),
    gate("parameter_plateau", round(plateau, 2), plateau >= GATES.minPlateau, `>= ${GATES.minPlateau} of neighbours profitable`),
    gate("without_best_year_r", round(withoutBestYear, 1), withoutBestYear > 0, "> 0"),
  ];

  return {
    symbol, timeframe, family: familyId, familyName: family.name, rationale: family.rationale, dataset,
    period: { from: bars[0].time, to: bars[bars.length - 1].time, years: round(years, 2), holdoutFrom: bars[split]?.time },
    configsTested: runs.length, trialsCharged: nTrials, best: best.params,
    development: tradeStats(best.trades), holdout: holdoutStats, fullHistory: tradeStats(all), byYear,
    realityCheckP: snoop?.realityCheckP ?? null, stepMSurvivors: snoop ? snoop.rejected.map((k) => runs[k].params) : [],
    gates, verdict: gates.every((g) => g.pass) ? "accepted" : "rejected", failed: gates.filter((g) => !g.pass).map((g) => g.name),
    challenge: challengeReport(all),
    trades: all,
  };
}

function gate(name, value, pass, rule) { return { name, value, pass: Boolean(pass), rule }; }
function round(x, d) { return Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x; }

// How the strategy's own trades fare against each live challenge, at the maximum allowed risk and at
// lower risk (the effective-risk cap often makes trading smaller the better way to pass).
export function challengeReport(trades, { riskScales = [0.5, 0.75, 1] } = {}) {
  if (!trades.length) return null;
  const ladder = [PRESETS.infinity_s1, PRESETS.infinity_s2, PRESETS.infinity_s3];
  const stages = {};
  for (const p of [...ladder, traditional(10000, 1), traditional(10000, 2)]) {
    stages[p.name] = riskScales.map((riskScale) => ({ riskScale, ...passProbability(trades, p, { riskScale }) }));
  }
  const infinityPath = riskScales.map((riskScale) => ({ riskScale, ...pathProbability(trades, ladder, { riskScale }) }));
  return { stages, infinityPath };
}
