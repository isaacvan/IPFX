// Infinity funnel model — decision support, not a forecast of customer results.
//
// Extends scripts/infinity-rule-model.mjs with the parts the launch decision
// actually turns on:
//   1. Stage 3 and the first cash payout, not just Stages 1-2.
//   2. Every v3 gate the engine really enforces, including the ones held in
//      qualification_progress_v2 (observation period, meaningful days, merged
//      exposure sessions, best-day concentration) and the effective risk cap
//      (min of base, 20% of drawdown buffer, 25% of daily buffer).
//   3. Trading costs, which at a $1,000 account with 0.5% risk are large in R.
//   4. A population with a distribution of skill, so we can ask the question
//      that matters: of the traders who reach a payout, how many are actually
//      good? That is a posterior, and no per-cohort pass rate answers it.
//   5. Retries (3 Stage 1 attempts per month), which separate the per-attempt
//      rate from the per-trader rate the way Topstep's 16.8% and 51.8% do.
//
// Usage: node scripts/infinity-funnel-model.mjs [traders] [costR]

import { fileURLToPath } from 'node:url';
const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const TRADERS = Number(process.argv[2] || 200_000);
const COST_R = process.argv[3] === undefined ? 0.10 : Number(process.argv[3]);

// ---------------------------------------------------------------- rng
let seed = 0x9e3779b9;
function random() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 2 ** 32;
}
function normal() {
  let u = 0, v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------- rules (live v3)
// challenge_presets + challenge_qualification_versions, 21 September 2026.
export const STAGES = [
  {
    name: "Stage 1", balance: 1000, targetPct: 8, ddPct: 5, dailyLossPct: 2.5,
    riskPct: 0.5, capPct: 1.5, minDays: 10, minSessions: 30, minElapsedDays: 14,
    maxBestDayShare: 0.35, minProfitableDaysPct: 0, splitPct: 0,
  },
  {
    name: "Stage 2", balance: 5000, targetPct: 6, ddPct: 4, dailyLossPct: 2,
    riskPct: 0.35, capPct: 1.25, minDays: 15, minSessions: 60, minElapsedDays: 21,
    maxBestDayShare: 0.25, minProfitableDaysPct: 55, splitPct: 85,
  },
  {
    name: "Stage 3", balance: 10000, targetPct: 7, ddPct: 4, dailyLossPct: 2,
    riskPct: 0.35, capPct: 1.25, minDays: 10, minSessions: 40, minElapsedDays: 14,
    maxBestDayShare: 0.30, minProfitableDaysPct: 50, splitPct: 85,
  },
];
// Terms 4.6.3: the held Stage 2 profit share is released at this much closed
// profit in Stage 3. The public page says 3%; the launch model says 5%.
const STAGE3_RELEASE_PCT = Number(process.env.RELEASE_PCT || 3);

const WIN_R = 1.2;                 // reward:risk on a winning session
const SESSIONS_PER_DAY = 4;        // attempted; the daily cap often ends the day sooner
const MEANINGFUL_DAY_FRACTION = 0.001;  // |net| >= 0.1% of balance for the day to count
const PROFITABLE_DAY_FRACTION = 0.0025; // >= 0.25% of balance to count as a profitable day
const MAX_TRADING_DAYS = 250;      // ~1 year; beyond this we treat the attempt as abandoned
const CALENDAR_PER_TRADING_DAY = 7 / 5;

// ---------------------------------------------------------------- one attempt
// Returns { passed, breached, tradingDays, peakEquityPct, releasedAtPct }
// Everything is expressed in percent of the stage starting balance.
export { random };
export function runStage(rule, winProb, costR, milestonePct, sessionsPerDay = SESSIONS_PER_DAY, winR = WIN_R) {
  let equity = 0, peak = 0, sessions = 0, tradingDays = 0;
  const dayNets = [];
  let hitMilestone = false;

  while (tradingDays < MAX_TRADING_DAYS) {
    const dayStart = equity;
    let breachedToday = false;

    for (let s = 0; s < sessionsPerDay; s++) {
      // Effective risk: the engine shrinks size as the buffers shrink.
      const ddFloor = peak - rule.ddPct;
      const dailyFloor = dayStart - rule.dailyLossPct;
      const ddRemaining = Math.max(0, equity - ddFloor);
      const dailyRemaining = Math.max(0, equity - dailyFloor);
      const risk = Math.min(rule.riskPct, 0.20 * ddRemaining, 0.25 * dailyRemaining);
      if (risk <= 0.0001) break; // no room left to place a compliant order today

      const won = random() < winProb;
      equity += (won ? winR : -1) * risk - costR * risk;
      sessions++;
      if (equity > peak) peak = equity;

      if (equity <= peak - rule.ddPct + 1e-12) { breachedToday = true; break; }
      if (equity - dayStart <= -rule.dailyLossPct + 1e-12) { breachedToday = true; break; }
      if (milestonePct != null && !hitMilestone && equity >= milestonePct) hitMilestone = true;
      if (equity - dayStart >= rule.capPct) break; // daily profit cap: no new orders today
    }

    tradingDays++;
    dayNets.push(equity - dayStart);
    if (breachedToday) return { passed: false, breached: true, tradingDays, hitMilestone };

    // gates
    const meaningfulDays = dayNets.filter((n) => Math.abs(n) >= MEANINGFUL_DAY_FRACTION * 100).length;
    const profitableDays = dayNets.filter((n) => n >= PROFITABLE_DAY_FRACTION * 100).length;
    const positives = dayNets.filter((n) => n > 0);
    const sumPositive = positives.reduce((a, b) => a + b, 0);
    const bestDay = positives.length ? Math.max(...positives) : 0;
    const concentrated = sumPositive <= 0 || bestDay / sumPositive > rule.maxBestDayShare;
    const profitableOk = rule.minProfitableDaysPct === 0 ||
      (dayNets.length > 0 && (profitableDays / dayNets.length) * 100 >= rule.minProfitableDaysPct);
    const elapsedOk = tradingDays * CALENDAR_PER_TRADING_DAY >= rule.minElapsedDays;

    if (equity >= rule.targetPct && meaningfulDays >= rule.minDays && sessions >= rule.minSessions &&
        elapsedOk && !concentrated && profitableOk) {
      return { passed: true, breached: false, tradingDays, hitMilestone };
    }
  }
  return { passed: false, breached: false, tradingDays: MAX_TRADING_DAYS, hitMilestone };
}

// ---------------------------------------------------------------- skill population
// Calibrated so that, at the central cost assumption, roughly 5% of entrants
// have any positive net expectancy and roughly 1% have a clear edge — the range
// the Taiwan and Brazil datasets support for active retail speculators.
const SKILL_MEAN = 0.45, SKILL_SD = 0.031;
function drawWinProb() {
  const p = SKILL_MEAN + SKILL_SD * normal();
  return Math.min(0.72, Math.max(0.28, p));
}
// Net expectancy per session, in R.
const expectancy = (p, costR) => (p * WIN_R - (1 - p)) - costR * (p * 0 + 1) * 1;
function tierOf(e) {
  if (e <= 0) return "no edge";
  if (e <= 0.05) return "marginal";
  if (e <= 0.15) return "genuine edge";
  return "strong edge";
}
const TIERS = ["no edge", "marginal", "genuine edge", "strong edge"];

// ---------------------------------------------------------------- funnel
// A trader gets up to 3 Stage 1 attempts a month. Most people stop after a
// couple of failures; `persistence` is the chance of trying again after a fail.
const MAX_S1_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 12);
const PERSISTENCE = Number(process.env.PERSISTENCE || 0.55);

function simulate(traders, costR) {
  const counts = {};
  for (const t of TIERS) counts[t] = { n: 0, s1: 0, s2: 0, release: 0, s3: 0, s1FirstTry: 0, attempts: 0 };
  let attemptsTotal = 0, attemptsPassed = 0;

  for (let i = 0; i < traders; i++) {
    const p = drawWinProb();
    const e = expectancy(p, costR);
    const tier = tierOf(e);
    const c = counts[tier];
    c.n++;

    // ---- Stage 1, with retries
    let passedS1 = false;
    for (let a = 0; a < MAX_S1_ATTEMPTS; a++) {
      const r = runStage(STAGES[0], p, costR, null);
      attemptsTotal++; c.attempts++;
      if (r.passed) {
        attemptsPassed++;
        if (a === 0) c.s1FirstTry++;
        passedS1 = true;
        break;
      }
      if (random() > PERSISTENCE) break; // gave up
    }
    if (!passedS1) continue;
    c.s1++;

    // ---- Stage 2 (one shot: a breach sends you back to Stage 1 and forfeits)
    const r2 = runStage(STAGES[1], p, costR, null);
    if (!r2.passed) continue;
    c.s2++;

    // ---- Stage 3: one continuous attempt. The held Stage 2 share is released
    // when closed profit first touches the milestone; completing the stage is
    // a separate, later event on the same account.
    const r3 = runStage(STAGES[2], p, costR, STAGE3_RELEASE_PCT);
    if (r3.hitMilestone) c.release++;
    if (r3.passed) c.s3++;
  }
  return { counts, attemptsTotal, attemptsPassed };
}

// ---------------------------------------------------------------- report
if (!IS_MAIN) { /* imported as a library */ } else {
const pct = (a, b) => (b === 0 ? 0 : +(a / b * 100).toFixed(2));
const { counts, attemptsTotal, attemptsPassed } = simulate(TRADERS, COST_R);

const totals = { n: 0, s1: 0, s2: 0, release: 0, s3: 0, s1FirstTry: 0, attempts: 0 };
for (const t of TIERS) for (const k of Object.keys(totals)) totals[k] += counts[t][k];

console.log(`\nInfinity v3 funnel — ${TRADERS.toLocaleString()} traders, cost ${COST_R}R per session,`);
console.log(`Stage 3 release at ${STAGE3_RELEASE_PCT}%, up to ${MAX_S1_ATTEMPTS} Stage 1 attempts, ${PERSISTENCE} persistence.\n`);

console.log("By skill tier (share of entrants, then conversion):");
console.table(TIERS.map((t) => {
  const c = counts[t];
  return {
    tier: t,
    "% of entrants": pct(c.n, totals.n),
    "S1 first try %": pct(c.s1FirstTry, c.n),
    "S1 ever %": pct(c.s1, c.n),
    "S2 | S1 %": pct(c.s2, c.s1),
    "payout | S2 %": pct(c.release, c.s2),
    "reach payout %": pct(c.release, c.n),
    "complete S3 %": pct(c.s3, c.n),
  };
}));

console.log("\nWhole population:");
console.table([{
  metric: "per attempt", "S1 pass %": pct(attemptsPassed, attemptsTotal),
}, {
  metric: "per trader", "S1 pass %": pct(totals.s1, totals.n),
}]);
console.table([{
  "entrants": totals.n,
  "pass S1 %": pct(totals.s1, totals.n),
  "pass S2 %": pct(totals.s2, totals.n),
  "reach payout %": pct(totals.release, totals.n),
  "complete S3 %": pct(totals.s3, totals.n),
  "S2|S1 %": pct(totals.s2, totals.s1),
  "payout|S2 %": pct(totals.release, totals.s2),
}]);

// ---- the posterior: who are the people who got paid?
console.log("\nComposition at each stage (this is the filter's precision):");
const mix = (key) => {
  const row = { stage: key };
  for (const t of TIERS) row[t] = pct(counts[t][key], totals[key]);
  return row;
};
console.table([
  { ...mix("n"), stage: "entrants" },
  { ...mix("s1"), stage: "passed S1" },
  { ...mix("s2"), stage: "passed S2" },
  { ...mix("release"), stage: "got first payout" },
  { ...mix("s3"), stage: "completed S3" },
]);

const skilled = (key) => pct(counts["genuine edge"][key] + counts["strong edge"][key], totals[key]);
console.log(`\nP(real edge | entrant)          = ${skilled("n")}%`);
console.log(`P(real edge | passed Stage 1)   = ${skilled("s1")}%`);
console.log(`P(real edge | passed Stage 2)   = ${skilled("s2")}%`);
console.log(`P(real edge | first payout)     = ${skilled("release")}%`);
console.log(`P(real edge | completed S3)     = ${skilled("s3")}%`);

// ---- what it costs the firm
const perTrader = totals.release / totals.n;
const stage2Share = STAGES[1].balance * STAGES[1].targetPct / 100 * STAGES[1].splitPct / 100;
console.log(`\nStage 2 profit share carried to the first payout: $${stage2Share.toFixed(2)} per qualifying trader`);
console.log(`Expected first-payout liability per 1,000 entrants: $${(perTrader * 1000 * stage2Share).toFixed(0)}`);
console.log(`Entrants needed per trader who reaches a payout: ${perTrader > 0 ? Math.round(1 / perTrader) : "n/a"}\n`);
}
