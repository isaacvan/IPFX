// Strategy engine: the statistics against published values, the backtester against hand-worked
// fills and for look-ahead, the challenge simulator against the live rules (hand cases, the SQL,
// and the independent funnel model), and the whole pipeline against a planted edge and pure noise.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "../research/strategy-engine/stats.mjs";
import { PRESETS, ENGINE, traditional, futures } from "../research/strategy-engine/rules.mjs";
import { runChallenge, passProbability } from "../research/strategy-engine/challenge-sim.mjs";
import { backtest } from "../research/strategy-engine/backtest.mjs";
import { FAMILIES, gridOf } from "../research/strategy-engine/library.mjs";
import { evaluateFamily } from "../research/strategy-engine/research.mjs";
import { parseCsv, validate, resample } from "../research/strategy-engine/data.mjs";
import { STAGES, runStage } from "../scripts/infinity-funnel-model.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const near = (a, b, eps, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b} +/- ${eps}, got ${a}`);
const DAY = 86400;
const MONDAY = Date.UTC(2025, 0, 6) / 1000; // Monday 6 January 2025, 00:00 UTC

// ------------------------------------------------------------------ statistics
test("normal distribution", () => {
  near(S.normCdf(1.959964), 0.975, 1e-6);
  near(S.normCdf(-1), 0.158655, 1e-6);
  near(S.normInv(0.975), 1.959964, 1e-6);
  near(S.normInv(0.05), -1.644854, 1e-6);
});

test("False Strategy Theorem: expected best of N useless strategies", () => {
  near(S.expectedMaxZ(1000), 3.26, 0.01);
  near(S.expectedMaxZ(1e6), 4.87, 0.01);
  // agrees with simulation
  const r = S.rng(3); let total = 0;
  for (let k = 0; k < 400; k++) { let m = -Infinity; for (let i = 0; i < 1000; i++) m = Math.max(m, S.normInv(r())); total += m; }
  near(total / 400, S.expectedMaxZ(1000), 0.06);
});

test("Minimum Backtest Length and Minimum Track Record", () => {
  // Bailey et al.: at an in-sample annual Sharpe of 1, five years supports ~45 independent trials
  assert.equal(S.maxTrialsForYears(5), 45);
  assert.ok(S.minBacktestYears(45) <= 5 && S.minBacktestYears(46) > 5);
  // trades needed to show skill at 95% with normal returns (the table in the published plan)
  assert.equal(Math.ceil(S.minTrackRecord(0.2)), 70);
  assert.equal(Math.ceil(S.minTrackRecord(0.1)), 273);
  assert.equal(Math.ceil(S.minTrackRecord(0.05)), 1085);
  assert.equal(Math.ceil(S.minTrackRecord(0.03)), 3009);
});

test("PSR and DSR", () => {
  near(S.psr(0, 100), 0.5, 1e-6);
  // negative skew and fat tails lower confidence in the same Sharpe
  assert.ok(S.psr(0.1, 250, -1, 6) < S.psr(0.1, 250, 0, 3));
  const r = S.rng(5), x = Array.from({ length: 1000 }, () => 0.2 + S.normInv(r()));
  assert.ok(S.dsr(x, 1, 0) > 0.99);
  // the same series is not significant once charged for 10,000 trials with typical trial dispersion
  assert.ok(S.dsr(x, 10000, 0.1 ** 2) < S.psrOf(x));
});

test("PBO: high on noise, ~0 when one configuration really is better", () => {
  // On one noise sample PBO scatters widely (0.1-0.6 here); its average is what must be high
  const T = 1600, N = 20, noiseOf = (seed) => { const r = S.rng(seed); return Array.from({ length: T }, () => Array.from({ length: N }, () => S.normInv(r()))); };
  const avg = S.mean([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => S.pbo(noiseOf(seed), 16).pbo));
  assert.ok(avg > 0.25 && avg < 0.65, "noise PBO " + avg);
  const noise = noiseOf(9);
  const edge = noise.map((row) => row.map((v, k) => (k === 7 ? v + 0.25 : v)));
  assert.ok(S.pbo(edge, 16).pbo < 0.05);
});

test("Reality Check and StepM find the planted edge and nothing else", () => {
  const r = S.rng(21), T = 1500, K = 30;
  const m = Array.from({ length: T }, () => Array.from({ length: K }, (_, k) => S.normInv(r()) + (k === 4 ? 0.15 : 0)));
  const res = S.stepM(m, { reps: 400 });
  assert.deepEqual(res.rejected, [4]);
  assert.ok(res.realityCheckP < 0.05);
  const noise = Array.from({ length: T }, () => Array.from({ length: K }, () => S.normInv(r())));
  assert.ok(S.stepM(noise, { reps: 400 }).realityCheckP > 0.05);
});

test("CPCV plan covers every group once per path", () => {
  const { splits, paths } = S.cpcvPlan(6, 2);
  assert.equal(splits.length, 15);
  assert.equal(paths.length, 5);
  for (const p of paths) {
    assert.ok(p.every((s) => s >= 0));
    p.forEach((s, g) => assert.ok(splits[s].includes(g)));
  }
  const kept = S.purgeTrain([{ start: 0, end: 5 }, { start: 8, end: 9 }, { start: 20, end: 21 }], [[10, 15]], 6);
  // {8,9} ends before the test window starts, so it stays; {20,21} starts inside the embargo, so it goes
  assert.deepEqual(kept, [{ start: 0, end: 5 }, { start: 8, end: 9 }]);
});

// ------------------------------------------------------------------ rules match the database
test("rules.mjs matches the live migrations", () => {
  const sql = fs.readFileSync(path.join(root, "supabase/migrations/20260920173000_infinity_only_october_launch.sql"), "utf8");
  for (const id of ["infinity_s1", "infinity_s2", "infinity_s3"]) {
    const block = sql.split("update public.challenge_presets set").find((b) => b.includes(`where id = '${id}'`));
    const v = (k) => { const m = block.match(new RegExp(`${k} = ([\\d.]+|null)`)); return m[1] === "null" ? null : Number(m[1]); };
    const p = PRESETS[id];
    assert.equal(p.targetPct, v("profit_target_pct"), id);
    assert.equal(p.ddPct, v("max_drawdown_pct"), id);
    assert.equal(p.dailyLossPct, v("daily_loss_pct"), id);
    assert.equal(p.minTradingDays, v("min_trading_days"), id);
    assert.equal(p.minTrades, v("min_trades"), id);
    assert.equal(p.riskPct, v("max_risk_per_trade_pct"), id);
    assert.equal(p.dailyProfitCapPct, v("daily_profit_cap_pct"), id);
    assert.equal(p.minProfitableDaysPct, v("min_profitable_days_pct"), id);
    const q = sql.match(new RegExp(`\\('infinity-v3-s${p.stage}','infinity',${p.stage},'published',([\\d.,]+)\\)`))[1].split(",").map(Number);
    assert.deepEqual([p.qualification.minElapsedDays, p.qualification.minTradingDays, p.qualification.minSessions,
      p.qualification.maxBestDayShare, p.qualification.minDailyNetFraction, p.qualification.sessionFlatGapMinutes], q, id);
  }
  const recal = fs.readFileSync(path.join(root, "challenge-recalibration.sql"), "utf8");
  const risk = fs.readFileSync(path.join(root, "supabase/migrations/20260920100000_phase_specific_risk_caps.sql"), "utf8");
  const row = (id) => recal.match(new RegExp(`\\('${id}',[^\\n]*`))[0].split(",").map((s) => s.trim().replace(/'/g, ""));
  for (const [id, p] of [["trad_10k_p1", traditional(10000, 1)], ["trad_10k_p2", traditional(10000, 2)], ["fut_25k_p1", futures(25000, 1)]]) {
    const r = row(id);
    assert.deepEqual([+r[6], +r[7], +r[8], r[9], +r[10], +r[11]], [p.targetPct, p.ddPct, p.dailyLossPct, p.ddMode, p.minTradingDays, p.minTrades], id);
    const caseRisk = risk.match(new RegExp(`challenge_type = '${p.programme}' and stage = ${p.stage} then ([\\d.]+)`))[1];
    assert.equal(p.riskPct, Number(caseRisk), id);
  }
  const engine = fs.readFileSync(path.join(root, "supabase/functions/trading-engine/index.ts"), "utf8");
  assert.match(engine, new RegExp(`DRAWDOWN_BUFFER_RISK_FRACTION = ${ENGINE.drawdownBufferRiskFraction.toFixed(2)}`));
  assert.match(engine, new RegExp(`DAILY_BUFFER_RISK_FRACTION = ${ENGINE.dailyBufferRiskFraction.toFixed(2)}`));
  assert.match(engine, new RegExp(`MIN_HOLD_SECONDS = ${ENGINE.minHoldSeconds};`));
  assert.match(engine, new RegExp(`MAX_TOTAL_RISK_MULTIPLE = ${ENGINE.maxTotalRiskMultiple};`));
});

// ------------------------------------------------------------------ challenge simulator
// trades at given UTC hours on each weekday, each held 30 minutes
function schedule(days, hours, rOf) {
  const out = [];
  let n = 0;
  for (let d = 0; out.length < 100000 && d < days; d++) {
    const t0 = MONDAY + d * DAY, dow = new Date(t0 * 1000).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (const h of hours) {
      const r = rOf(n++, d);
      out.push({ entryTime: t0 + h * 3600, exitTime: t0 + h * 3600 + 1800, r, maeR: Math.min(0, r), mfeR: Math.max(0, r), peakBeforeTroughR: 0 });
    }
  }
  return out;
}

test("Stage 1: steady winner passes once every gate is met, not before", () => {
  // +1R each; risk is $5 (0.5% of $1,000), so +$15 a day hits the 1.5% daily cap after 3 trades
  const trades = schedule(40, [8, 10, 12, 14, 16], () => 1);
  const res = runChallenge(trades, PRESETS.infinity_s1, { startTime: MONDAY });
  assert.equal(res.outcome, "pass");
  assert.ok(res.calendarDays >= 14, "observation period");
  assert.ok(res.tradingDays >= 10 && res.tradesClosed >= 30 && res.sessions >= 30);
  assert.equal(res.blocked.cap % 2, 0); // two trades a day refused by the cap
  assert.ok(res.blocked.cap > 0);
  assert.ok(res.balance >= 1080);
});

test("breach: a gap loss through the drawdown floor", () => {
  const trades = schedule(10, [9], (n) => (n === 3 ? -12 : 0.5));
  const res = runChallenge(trades, PRESETS.infinity_s1, { startTime: MONDAY });
  assert.equal(res.outcome, "breach");
  assert.equal(res.reason, "max_drawdown");
});

test("trailing intraday drawdown follows open profit, not just closed balance", () => {
  // S1 floor 5% ($50). A trade runs to +9R ($45 open) then closes at -1R: equity peak 1045,
  // floor 995, and the -$5 close at 995 breaches. On closed balance alone it would not.
  const t = { entryTime: MONDAY + 9 * 3600, exitTime: MONDAY + 12 * 3600, r: -1, maeR: -1, mfeR: 9, peakBeforeTroughR: 9 };
  assert.equal(runChallenge([t], PRESETS.infinity_s1, { startTime: MONDAY }).outcome, "breach");
  const t2 = { ...t, peakBeforeTroughR: 0 }; // the high came after the low: no breach
  assert.notEqual(runChallenge([t2], PRESETS.infinity_s1, { startTime: MONDAY }).outcome, "breach");
});

test("effective risk shrinks with the loss buffers", () => {
  // after losses the engine allows less than the 0.5% base; a -1R trade then loses less than $5
  const trades = schedule(1, [8, 9, 10, 11], () => -1);
  const res = runChallenge(trades, PRESETS.infinity_s1, { startTime: MONDAY, maxCalendarDays: 2 });
  // $25 daily buffer -> 0.25 x 25 = 6.25 >= 5, then 0.25 x 20 = 5, then 0.25 x 15 = 3.75, then 0.25 x 11.25
  near(1000 - res.balance, 5 + 5 + 3.75 + 2.8125, 1e-6);
});

test("profit from trades held under 60 seconds does not count", () => {
  const trades = schedule(40, [8, 10, 12], () => 1).map((t) => ({ ...t, exitTime: t.entryTime + 30 }));
  const res = runChallenge(trades, PRESETS.infinity_s1, { startTime: MONDAY, maxCalendarDays: 30 });
  assert.notEqual(res.outcome, "pass");
  assert.equal(res.tradesClosed, 0);
  assert.ok(res.unmet.includes("QUICK_TRADE_PROFIT") && res.unmet.includes("TRADES"));
});

test("one big day fails the best-day share gate", () => {
  // tiny days (+0.2R) and one +5R day on a long-hold trade: concentration > 35%
  const trades = schedule(30, [9, 11, 13], (n) => (n === 0 ? 3 : 0.1));
  const res = runChallenge(trades, PRESETS.infinity_s1, { startTime: MONDAY, maxCalendarDays: 25 });
  assert.notEqual(res.outcome, "pass");
});

test("agrees with the independent funnel model (scripts/infinity-funnel-model.mjs)", () => {
  // Same trader in both: 4 sessions a weekday, win 1.2R with probability p, cost 0.1R per trade.
  const costR = 0.1, attempts = 2500;
  for (const [stage, preset, p] of [[0, PRESETS.infinity_s1, 0.55], [1, PRESETS.infinity_s2, 0.55]]) {
    let funnel = 0;
    for (let k = 0; k < attempts; k++) if (runStage(STAGES[stage], p, costR, null).passed) funnel++;
    const r = S.rng(100 + stage);
    let sim = 0;
    for (let k = 0; k < attempts; k++) {
      const trades = schedule(350, [8, 10, 12, 14], () => (r() < p ? 1.2 : -1) - costR);
      if (runChallenge(trades, preset, { startTime: MONDAY, maxCalendarDays: 350 }).outcome === "pass") sim++;
    }
    near(sim / attempts, funnel / attempts, 0.05, preset.name + " pass rate");
  }
});

// ------------------------------------------------------------------ backtester
function walk(n, seed, drift = 0, vol = 0.001, step = 3600) {
  const r = S.rng(seed), bars = [];
  let p = 1.1;
  for (let i = 0; i < n; i++) {
    const o = p, c = o * Math.exp(drift + vol * S.normInv(r()));
    const h = Math.max(o, c) * (1 + Math.abs(vol * 0.5 * S.normInv(r()))), l = Math.min(o, c) * (1 - Math.abs(vol * 0.5 * S.normInv(r())));
    bars.push({ time: MONDAY + i * step, open: o, high: h, low: l, close: c, volume: 0 });
    p = c;
  }
  return bars;
}

test("backtester fills: next open plus half spread, gap through a stop fills at the open, stop first", () => {
  const bars = [
    { time: 0, open: 100, high: 100, low: 100, close: 100 },
    { time: 3600, open: 100, high: 101, low: 99.5, close: 100 },
    { time: 7200, open: 97, high: 97, low: 96, close: 96 }, // gaps through the stop at 98.9
    { time: 10800, open: 96, high: 96, low: 96, close: 96 },
  ];
  const once = (e) => ({ name: "t", prepare: () => ({ entry: (i) => (i === 0 ? e : null) }) });
  const [t] = backtest(bars, once({ side: 1, stopDist: 1.2, targetDist: 5 }), {}, { spread: 0.2 });
  near(t.entry, 100.1, 1e-9);                     // bought at the ask
  assert.equal(t.reason, "stop_gap");
  near(t.exit, 96.9, 1e-9);                        // sold at the bid of the gapped open
  near(t.r, (96.9 - 100.1) / 1.2, 1e-9);
  const both = [bars[0], { time: 3600, open: 100, high: 103, low: 98, close: 100 }, bars[3]];
  const [u] = backtest(both, once({ side: 1, stopDist: 1, targetDist: 1 }), {}, { spread: 0 });
  assert.equal(u.reason, "stop");                  // both touched in one bar: stop first
  near(u.r, -1, 1e-9);
});

test("no strategy in the library can see the future", () => {
  const bars = walk(1500, 17).map((b) => ({ ...b, time: b.time }));
  for (const [id, fam] of Object.entries(FAMILIES)) {
    for (const params of gridOf(fam).slice(0, 4)) {
      const full = fam.prepare(bars, params);
      for (const i of [260, 700, 1100, 1498]) {
        const cut = fam.prepare(bars.slice(0, i + 1), params);
        assert.deepEqual(cut.entry(i), full.entry(i), `${id} ${JSON.stringify(params)} at ${i}`);
      }
    }
  }
});

test("csv loader: Dukascopy formats, validation and resampling", () => {
  const csv = "timestamp,open,high,low,close,volume\n1577923200000,1.1,1.2,1.0,1.15,5\n1577923200000,1.1,1.2,1.0,1.15,5\n1577926800000,1.15,1.1,1.0,1.05,1\n1577930400000,1.05,1.1,1.0,1.08,2\n";
  const v = validate(parseCsv(csv));
  assert.equal(v.bars.length, 2);
  assert.equal(v.issues.duplicates, 1);
  assert.equal(v.issues.invalid, 1); // high below open
  assert.equal(parseCsv("Gmt time,Open,High,Low,Close,Volume\n02.01.2020 00:00:00.000,1,1,1,1,0\n")[0].time, 1577923200);
  const d = resample(v.bars, 86400);
  assert.equal(d.length, 1);
  assert.equal(d[0].close, 1.08);
});

// ------------------------------------------------------------------ the whole pipeline
test("pipeline rejects every family on a random walk", () => {
  const bars = walk(20000, 33, 0, 0.004, 86400 / 4); // ~13.7 years of 6-hour bars, no edge
  for (const familyId of ["donchian", "maCross", "bollingerReversion"]) {
    const rep = evaluateFamily({ bars, symbol: "EURUSD", timeframe: "360", familyId });
    assert.equal(rep.verdict, "rejected", familyId + " accepted noise: " + JSON.stringify(rep.gates));
  }
});

test("pipeline accepts a planted trend and reports its challenge odds", () => {
  // persistent regimes: the drift flips sign rarely, so breakouts really do follow through
  const r = S.rng(44), bars = [];
  let p = 1.1, drift = 0.002;
  for (let i = 0; i < 16000; i++) {
    if (r() < 0.004) drift = -drift;
    const o = p, c = o * Math.exp(drift + 0.004 * S.normInv(r()));
    bars.push({ time: MONDAY + i * 21600, open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 0 });
    p = c;
  }
  const rep = evaluateFamily({ bars, symbol: "EURUSD", timeframe: "360", familyId: "donchian" });
  assert.equal(rep.verdict, "accepted", JSON.stringify(rep.gates));
  const s1 = rep.challenge.stages["Infinity Stage 1"];
  assert.equal(s1.length, 3);
  assert.ok(s1.every((x) => x.windows > 0 && x.passRate >= 0 && x.passRate <= 1));
});
