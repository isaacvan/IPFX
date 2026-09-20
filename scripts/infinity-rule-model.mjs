// Deterministic Monte Carlo model for the Infinity qualification funnel.
// This is a decision-support model, not a promise of trader performance.

const RUNS = Number(process.argv[2] || 200_000);
let seed = 0x1f2e3d4c;
function random() {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 2 ** 32;
}

const phases = [
  {
    name: "Stage 1",
    targetPct: 8,
    trailingDrawdownPct: 5,
    dailyLossPct: 2.5,
    riskPct: 0.5,
    dailyProfitCapPct: 1.5,
    minDays: 10,
    minSessions: 30,
    minProfitableDaysPct: 0,
    maxBestDayShare: 0.35,
  },
  {
    name: "Stage 2",
    targetPct: 6,
    trailingDrawdownPct: 4,
    dailyLossPct: 2,
    riskPct: 0.35,
    dailyProfitCapPct: 1.25,
    minDays: 15,
    minSessions: 60,
    minProfitableDaysPct: 55,
    maxBestDayShare: 0.25,
  },
];

function runPhase(rule, winProbability, winR = 1.2) {
  let equity = 0;
  let peak = 0;
  let sessions = 0;
  const daily = [];

  for (let day = 1; day <= 120; day += 1) {
    const start = equity;
    for (let trade = 0; trade < 4; trade += 1) {
      equity += (random() < winProbability ? winR : -1) * rule.riskPct;
      sessions += 1;
      peak = Math.max(peak, equity);
      if (equity <= peak - rule.trailingDrawdownPct) return false;
      if (equity - start <= -rule.dailyLossPct) return false;
      if (equity - start >= rule.dailyProfitCapPct) break;
    }
    daily.push(equity - start);

    const positive = daily.filter((value) => value > 0);
    const profitableDaysPct = positive.length / daily.length * 100;
    const sumPositive = positive.reduce((sum, value) => sum + value, 0);
    const bestDay = positive.length ? Math.max(...positive) : 0;
    const concentrated = sumPositive <= 0 || bestDay / sumPositive > rule.maxBestDayShare;
    const requirementsMet = daily.length >= rule.minDays &&
      sessions >= rule.minSessions &&
      profitableDaysPct >= rule.minProfitableDaysPct &&
      !concentrated;

    if (equity >= rule.targetPct && requirementsMet) return true;
  }
  return false;
}

function model(label, winProbability) {
  let stage1 = 0;
  let both = 0;
  for (let i = 0; i < RUNS; i += 1) {
    if (!runPhase(phases[0], winProbability)) continue;
    stage1 += 1;
    if (runPhase(phases[1], winProbability)) both += 1;
  }
  return {
    label,
    winProbability,
    stage1PassPct: +(stage1 / RUNS * 100).toFixed(2),
    stage2ConditionalPassPct: stage1 ? +(both / stage1 * 100).toFixed(2) : 0,
    twoStagePassPct: +(both / RUNS * 100).toFixed(2),
  };
}

console.table([
  model("zero expectancy", 1 / 2.2),
  model("modest edge", 0.50),
  model("strong edge", 0.55),
]);
