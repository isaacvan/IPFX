#!/usr/bin/env node
// Strategy engine command line.
//
//   node research/strategy-engine/run.mjs --csv eurusd-h1.csv --symbol EURUSD --tf 60 [--family donchian|all]
//   node research/strategy-engine/run.mjs --fetch --symbol XAUUSD --tf D       (smoke test only: <= 2,000 bars)
//   node research/strategy-engine/run.mjs --trades trades.json                 (challenge report for any trade list)
//   options: --resample 14400 (aggregate bars first), --no-registry (don't log trials; tests only)
//
// Reports go to research/strategy-engine/.data/reports (git-ignored).

import fs from "node:fs";
import path from "node:path";
import { loadCsv, fetchCandles, resample, validate } from "./data.mjs";
import { FAMILIES } from "./library.mjs";
import { evaluateFamily, challengeReport } from "./research.mjs";
import { Registry, DATA_DIR } from "./registry.mjs";
import { barSeconds } from "./backtest.mjs";

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf("--" + k); return i < 0 ? d : args[i + 1]; };
const flag = (k) => args.includes("--" + k);
const pct = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) + "%" : "n/a");
const outDir = path.join(DATA_DIR, "reports");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

function printChallenge(ch) {
  if (!ch) return;
  if (Object.values(ch.stages).every((rows) => rows.every((r) => !r.windows))) {
    console.log("  Challenges: not enough history for one complete attempt (each needs up to a year of trades)");
    return;
  }
  // one line per stage: pass rate at each risk level, then what stopped the rest at the best level
  for (const [name, rows] of Object.entries(ch.stages)) {
    const best = rows.reduce((a, b) => ((b.passRate || 0) > (a.passRate || 0) ? b : a), rows[0]);
    const why = Object.entries(best.reasons).filter(([k]) => k !== "pass").sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([k, n]) => `${k} ${pct(n / best.windows)}`).join(", ");
    console.log(`  ${name.padEnd(24)} pass ` + rows.map((r) => `${pct(r.passRate)} @x${r.riskScale}`).join(" / ") +
      `  (${best.windows} starts, ~${best.independentWindows} independent)${why ? "  others: " + why : ""}`);
  }
  const path_ = ch.infinityPath.reduce((a, b) => ((b.reachedAtLeast[2] || 0) > (a.reachedAtLeast[2] || 0) ? b : a), ch.infinityPath[0]);
  console.log(`  Infinity S1->S3 @x${path_.riskScale}: reach S2 ${pct(path_.reachedAtLeast[0])}, S3 ${pct(path_.reachedAtLeast[1])}, pass S3 ${pct(path_.reachedAtLeast[2])} (${path_.windows} starts)`);
}

if (opt("trades")) {
  const trades = JSON.parse(fs.readFileSync(opt("trades"), "utf8")).sort((a, b) => a.entryTime - b.entryTime);
  const ch = challengeReport(trades);
  printChallenge(ch);
  const file = path.join(outDir, `challenge-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(ch, null, 1));
  console.log("\nReport: " + file);
  process.exit(0);
}

const symbol = (opt("symbol") || "").toUpperCase();
if (!symbol) { console.error("--symbol is required"); process.exit(2); }
let data = opt("csv") ? loadCsv(opt("csv")) : flag("fetch") ? await fetchCandles(symbol, opt("tf", "D")) : null;
if (!data) { console.error("Give --csv <file> or --fetch"); process.exit(2); }
if (opt("resample")) data = validate(resample(data.bars, Number(opt("resample"))));
const bars = data.bars;
const tf = opt("tf") || String(barSeconds(bars));
console.log(`${symbol} ${tf}: ${bars.length} bars, ${data.years.toFixed(1)} years, issues ${JSON.stringify(data.issues)}`);
if (data.years < 10) console.log("  Warning: under 10 years of history. Results cannot be accepted, only screened.");

const registry = flag("no-registry") ? null : new Registry();
const intraday = barSeconds(bars) < 86400;
const families = (opt("family", "all") === "all" ? Object.keys(FAMILIES) : opt("family").split(","))
  .filter((f) => intraday || !FAMILIES[f].intradayOnly);

const reports = [];
for (const familyId of families) {
  const t0 = Date.now();
  const rep = evaluateFamily({ bars, symbol, timeframe: tf, familyId, registry });
  reports.push(rep);
  const d = rep.fullHistory;
  console.log(`\n${rep.familyName} [${rep.verdict.toUpperCase()}] best ${JSON.stringify(rep.best)}  (${rep.configsTested} configs, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`  ${d.trades} trades, win ${pct(d.winRate)}, expectancy ${d.expectancyR?.toFixed(3)}R, total ${d.totalR?.toFixed(1)}R, t ${d.tStat?.toFixed(2)}, cost ${d.avgCostR?.toFixed(3)}R/trade`);
  console.log("  gates: " + rep.gates.map((g) => `${g.pass ? "ok" : "FAIL"} ${g.name}=${g.value}`).join(", "));
  printChallenge(rep.challenge);
}

const file = path.join(outDir, `${symbol}-${tf}-${stamp}.json`);
fs.writeFileSync(file, JSON.stringify(reports.map(({ trades, ...r }) => r), null, 1));
fs.writeFileSync(file.replace(/\.json$/, "-trades.json"), JSON.stringify(Object.fromEntries(reports.map((r) => [r.family, r.trades]))));
console.log(`\nAccepted: ${reports.filter((r) => r.verdict === "accepted").map((r) => r.familyName).join(", ") || "none"}`);
console.log("Report: " + file);
