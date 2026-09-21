// Does the profitable-day rule reward skill, or reward pushing a losing day
// back into the green before the close?
//
// account_progress counts a day as profitable when that day's closed P&L
// exceeds 0.25% of the starting balance, and it only counts days on which the
// trader actually closed a trade. Two consequences worth testing:
//   - a trader can skip days, so flat days never dilute the ratio;
//   - a trader who keeps trading a red day until it turns green scores a
//     profitable day, while a trader who accepts the small loss does not.
//
// Usage: node scripts/infinity-profitable-day-gaming.mjs [runs]

import { STAGES, runStage } from "./infinity-funnel-model.mjs";

const RUNS = Number(process.argv[2] || 20_000);
const pct = (a, b) => (b === 0 ? 0 : +(a / b * 100).toFixed(2));

let seed = 0x2545f491;
function random() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 2 ** 32;
}

const PROFITABLE = 0.25; // % of balance a day must clear to count as profitable
const MEANINGFUL = 0.1;
const MAX_DAYS = 250;
const WIN_R = 1.2;

// behaviour:
//   "disciplined" — a fixed number of sessions, then stop for the day whatever happened
//   "chaser"      — keep trading a red day until it clears +0.25% or the daily limit stops you
function run(rule, p, cost, behaviour, plannedSessions = 3, hardCapSessions = 12) {
  let equity = 0, peak = 0, sessions = 0, days = 0;
  const dayNets = [];

  while (days < MAX_DAYS) {
    const dayStart = equity;
    let breached = false, sessionsToday = 0;

    for (;;) {
      const ddRemaining = Math.max(0, equity - (peak - rule.ddPct));
      const dailyRemaining = Math.max(0, equity - (dayStart - rule.dailyLossPct));
      const risk = Math.min(rule.riskPct, 0.20 * ddRemaining, 0.25 * dailyRemaining);
      if (risk <= 0.0001) break;

      equity += (random() < p ? WIN_R : -1) * risk - cost * risk;
      sessions++; sessionsToday++;
      if (equity > peak) peak = equity;
      if (equity <= peak - rule.ddPct + 1e-12) { breached = true; break; }
      if (equity - dayStart <= -rule.dailyLossPct + 1e-12) { breached = true; break; }
      if (equity - dayStart >= rule.capPct) break; // daily profit cap

      const dayNet = equity - dayStart;
      if (behaviour === "disciplined") {
        if (sessionsToday >= plannedSessions) break;
      } else {
        // stop once the day is safely green, otherwise keep pushing
        if (dayNet >= PROFITABLE) break;
        if (sessionsToday >= hardCapSessions) break;
      }
    }

    days++;
    dayNets.push(equity - dayStart);
    if (breached) return { passed: false, breached: true, days };

    const meaningful = dayNets.filter((n) => Math.abs(n) >= MEANINGFUL).length;
    const profitable = dayNets.filter((n) => n > PROFITABLE).length;
    const positives = dayNets.filter((n) => n > 0);
    const sumPos = positives.reduce((a, b) => a + b, 0);
    const best = positives.length ? Math.max(...positives) : 0;
    const concentrated = sumPos <= 0 || best / sumPos > rule.maxBestDayShare;
    const profOk = rule.minProfitableDaysPct === 0 ||
      (dayNets.length > 0 && (profitable / dayNets.length) * 100 >= rule.minProfitableDaysPct);

    if (equity >= rule.targetPct && meaningful >= rule.minDays && sessions >= rule.minSessions &&
        days * 7 / 5 >= rule.minElapsedDays && !concentrated && profOk) {
      return { passed: true, breached: false, days };
    }
  }
  return { passed: false, breached: false, days: MAX_DAYS };
}

function summarise(rule, p, cost, behaviour) {
  let pass = 0, breach = 0, daysSum = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = run(rule, p, cost, behaviour);
    if (r.passed) pass++;
    if (r.breached) breach++;
    daysSum += r.days;
  }
  return { "pass %": pct(pass, RUNS), "breached %": pct(breach, RUNS), "avg days": Math.round(daysSum / RUNS) };
}

console.log(`\nProfitable-day rule: does it reward skill or day-chasing? ${RUNS.toLocaleString()} runs, cost 0.10R.\n`);

for (const stage of [STAGES[1], STAGES[2]]) {
  console.log(`--- ${stage.name} (needs ${stage.minProfitableDaysPct}% of trading days above +0.25%) ---`);
  console.table([1 / 2.2, 0.50, 0.55].flatMap((p) => ([
    { skill: `p=${p.toFixed(3)}`, behaviour: "disciplined (3/day, accept red days)", ...summarise(stage, p, 0.10, "disciplined") },
    { skill: `p=${p.toFixed(3)}`, behaviour: "chaser (trade until the day is green)", ...summarise(stage, p, 0.10, "chaser") },
  ])));
}

// What the rule is really measuring: for a fixed number of sessions a day, the
// chance a day clears +0.25% is a step function of the win count, so the pass
// rate lurches around with pacing rather than tracking skill.
console.log("Chance a single day closes above +0.25% of balance, Stage 2 sizing (0.35% risk, 1.2R):\n");
const rows = [];
for (const sessionsPerDay of [1, 2, 3, 4, 5, 6]) {
  const row = { "sessions/day": sessionsPerDay };
  for (const p of [1 / 2.2, 0.50, 0.55, 0.60]) {
    let green = 0;
    for (let i = 0; i < 20000; i++) {
      let net = 0;
      for (let s = 0; s < sessionsPerDay; s++) net += (random() < p ? 1.2 : -1) * 0.35 - 0.10 * 0.35;
      if (net > 0.25) green++;
    }
    row[`p=${p.toFixed(2)}`] = pct(green, 20000);
  }
  rows.push(row);
}
console.table(rows);
console.log("");
