// Which Infinity v3 rule is actually doing the filtering, and what does each
// one cost in pass rate? Ablation plus a style-bias test.
//
// Usage: node scripts/infinity-rule-sensitivity.mjs [runs]

import { STAGES, runStage } from "./infinity-funnel-model.mjs";

const RUNS = Number(process.argv[2] || 20_000);
const pct = (a, b) => (b === 0 ? 0 : +(a / b * 100).toFixed(2));

function passRate(rule, p, cost, runs = RUNS, sessionsPerDay = 4, winR = 1.2) {
  let n = 0;
  for (let i = 0; i < runs; i++) if (runStage(rule, p, cost, null, sessionsPerDay, winR).passed) n++;
  return pct(n, runs);
}

const relax = (rule, patch) => ({ ...rule, ...patch });
const OFF = {
  "none (as published)": {},
  "no profitable-day rule": { minProfitableDaysPct: 0 },
  "no best-day rule": { maxBestDayShare: 1 },
  "no session minimum": { minSessions: 0 },
  "no observation period": { minElapsedDays: 0 },
  "no daily profit cap": { capPct: 999 },
  "no min trading days": { minDays: 0 },
  "double the risk cap": { riskPct: null },
};

console.log(`\nAblation — pass rate for one attempt, ${RUNS.toLocaleString()} runs, cost 0.10R, 4 sessions/day.`);
console.log("Each row removes exactly one rule, so the gap from the first row is that rule's cost.\n");

for (const stageIdx of [0, 1, 2]) {
  const base = STAGES[stageIdx];
  const rows = [];
  for (const [label, patch] of Object.entries(OFF)) {
    const p2 = patch.riskPct === null ? { riskPct: base.riskPct * 2 } : patch;
    const rule = relax(base, p2);
    rows.push({
      "rule removed": label,
      "coin-flip (p=.4545)": passRate(rule, 1 / 2.2, 0.10),
      "p=.50": passRate(rule, 0.50, 0.10),
      "p=.55": passRate(rule, 0.55, 0.10),
    });
  }
  console.log(`--- ${base.name} ---`);
  console.table(rows);
}

// ---------------------------------------------------------------- style bias
// Hold net expectancy constant and vary how it is earned. A rule set that is
// style-neutral should pass these at similar rates. One that implicitly
// requires a high win rate will not.
console.log("\nStyle bias — same expectancy (+0.10R per session, net of 0.10R cost), earned differently.");
console.log("A style-neutral rule set would pass these at similar rates.\n");

// expectancy E = p*winR - (1-p) - cost  =>  p = (E + 1 + cost) / (winR + 1)
const styleRows = [];
for (const winR of [1.0, 1.2, 1.5, 2.0, 3.0, 5.0]) {
  const E = 0.10, cost = 0.10;
  const p = (E + 1 + cost) / (winR + 1);
  if (p <= 0.02 || p >= 0.98) continue;
  styleRows.push({
    "reward:risk": winR,
    "win rate %": +(p * 100).toFixed(1),
    "Stage 1 pass %": passRate(STAGES[0], p, cost, RUNS, 4, winR),
    "Stage 2 pass %": passRate(STAGES[1], p, cost, RUNS, 4, winR),
    "Stage 3 pass %": passRate(STAGES[2], p, cost, RUNS, 4, winR),
  });
}
console.table(styleRows);

// ---------------------------------------------------------------- costs
console.log("\nCost sensitivity — trading cost as a share of the risked amount per session.");
console.log("At a $1,000 balance and 0.5% risk ($5), a 2-pip spread on a 10-pip stop is ~0.20R.\n");
console.table([0.0, 0.05, 0.10, 0.20, 0.30].map((c) => ({
  "cost per session (R)": c,
  "S1 coin-flip %": passRate(STAGES[0], 1 / 2.2, c),
  "S1 p=.50 %": passRate(STAGES[0], 0.50, c),
  "S1 p=.55 %": passRate(STAGES[0], 0.55, c),
  "S2 p=.55 %": passRate(STAGES[1], 0.55, c),
})));

// ---------------------------------------------------------------- pace
console.log("\nSessions per day — the trader's own choice, and it matters a lot.\n");
console.table([1, 2, 3, 4, 6, 8].map((s) => ({
  "sessions/day": s,
  "S1 p=.50 %": passRate(STAGES[0], 0.50, 0.10, RUNS, s),
  "S1 p=.55 %": passRate(STAGES[0], 0.55, 0.10, RUNS, s),
  "S2 p=.50 %": passRate(STAGES[1], 0.50, 0.10, RUNS, s),
  "S2 p=.55 %": passRate(STAGES[1], 0.55, 0.10, RUNS, s),
})));
console.log("");
