// Hedge-first (STP) execution for copied / A-book trades.
// 1) Unit tests of the pure core (_shared/stp-fill.ts).
// 2) Monte Carlo stress test: a simulated market with a lagging, offset IPFX feed, a broker
//    feed, random latencies, news spikes, gaps and a latency-arbitrage trader. Compares the old
//    pipeline (trader fills first, hedge copies afterwards) with hedge-first.
// 3) Concurrency test: many requests racing to close the same copied trade.
// 4) Source wiring: the engine and live-mirror actually use the core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capturePerUnit, closeClaimAction, disasterStop, worseFill } from '../supabase/functions/_shared/stp-fill.ts';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('worseFill: higher when buying, lower when selling, ignores missing prices', () => {
  assert.equal(worseFill(true, 1.1, 1.1002, null), 1.1002);
  assert.equal(worseFill(false, 1.1, 1.1002, undefined), 1.1);
  assert.equal(worseFill(true, NaN, 0, -1), null);
  assert.equal(worseFill(false, 1.2), 1.2);
});

test('disasterStop sits 3x the stop distance beyond entry, never a take-profit', () => {
  assert.ok(Math.abs(disasterStop('buy', 1.1, 1.099) - 1.097) < 1e-12);
  assert.ok(Math.abs(disasterStop('sell', 1.1, 1.101) - 1.103) < 1e-12);
  assert.equal(disasterStop('buy', 1.1, null), null);
  assert.equal(disasterStop('buy', 1.1, 1.1), null);
  assert.equal(disasterStop('buy', 0.5, 0.3), null); // would be negative
});

test('closeClaimAction: use the price, wait for an in-flight close, never stick forever', () => {
  const now = Date.parse('2026-10-02T12:00:10Z');
  assert.equal(closeClaimAction({ status: 'reconciliation_required', fill_price: 1.1 }, now), 'use_price');
  assert.equal(closeClaimAction({ status: 'sent', created_at: '2026-10-02T12:00:05Z' }, now), 'busy');
  assert.equal(closeClaimAction({ status: 'sent', created_at: '2026-10-02T11:59:00Z' }, now), 'proceed_unhedged');
  assert.equal(closeClaimAction({ status: 'error', created_at: '2026-10-02T12:00:09Z' }, now), 'proceed_unhedged');
  assert.equal(closeClaimAction(null, now), 'proceed_unhedged');
});

// ---------------------------------------------------------------- Monte Carlo
function rng(seed) { // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const PIP = 0.0001;
const roundAdverse = (px, takingAsk) => { const f = 1e5; return (takingAsk ? Math.ceil(px * f - 1e-7) : Math.floor(px * f + 1e-7)) / f; };

// One market path sampled every 10 ms; true mid, IPFX (lagged + offset, wider) and broker quotes.
function simulate({ trades = 40_000, seed = 7, failRate = 0.01 } = {}) {
  const r = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
  const out = { old: [], neu: [], unpriced: 0, arb: { old: [], neu: [] } };
  for (let i = 0; i < trades; i++) {
    // regime: calm 80%, busy 15%, news spike 5% (vol in pips per sqrt(second), plus a jump)
    const reg = r();
    const vol = reg < 0.8 ? 0.4 : reg < 0.95 ? 1.5 : 6;
    const jump = reg >= 0.95 ? (r() < 0.5 ? -1 : 1) * (5 + 20 * r()) * PIP : 0;
    const steps = 600; // 6 s window around the open, same model reused for the close
    const mid = new Float64Array(steps); mid[0] = 1.1 + gauss() * 0.01;
    const jumpAt = 50 + Math.floor(r() * 400);
    for (let k = 1; k < steps; k++) mid[k] = mid[k - 1] + gauss() * vol * PIP * Math.sqrt(0.01) + (k === jumpAt ? jump : 0);
    const lagSteps = 10 + Math.floor(r() * 140);           // IPFX feed lag 100-1500 ms
    const basis = gauss() * 0.15 * PIP;                     // IPFX vs broker mid offset
    const ipfxHalf = 0.5 * PIP, brokerHalf = 0.3 * PIP;     // spreads 1.0 vs 0.6 pips
    const ipfx = (k, ask) => mid[Math.max(0, k - lagSteps)] + basis + (ask ? ipfxHalf : -ipfxHalf);
    const broker = (k, ask) => mid[Math.min(steps - 1, k)] + (ask ? brokerHalf : -brokerHalf) + (ask ? 1 : -1) * Math.abs(gauss()) * 0.05 * PIP;
    const arbitrageur = r() < 0.25; // knows the true price: trades in the direction the lagging feed will move
    const side = arbitrageur ? (mid[100] > mid[Math.max(0, 100 - lagSteps)] ? 'buy' : 'sell') : (r() < 0.5 ? 'buy' : 'sell');
    const dir = side === 'buy' ? 1 : -1;
    const bps = 0.3;
    const delaySteps = 30 + Math.floor(r() * 61);          // engine delay 300-900 ms
    const hedgeSteps = 25 + Math.floor(r() * 100);         // broker round trip 250-1250 ms
    const failed = r() < failRate;
    const leg = (t0, opening) => {
      const takingAsk = opening ? side === 'buy' : side === 'sell';
      const decision = ipfx(t0, takingAsk);
      // OLD: trader fills after the delay at the worse IPFX price; hedge is sent afterwards.
      const oldTrader = roundAdverse((takingAsk ? Math.max : Math.min)(decision, ipfx(t0 + delaySteps, takingAsk)) * (1 + (takingAsk ? 1 : -1) * bps / 1e4), takingAsk);
      const oldHedge = broker(t0 + delaySteps + 5 + hedgeSteps, takingAsk);
      // NEW: hedge first; the trader waits max(delay, hedge) and gets the worst of all three.
      const newHedge = broker(t0 + 5 + hedgeSteps, takingAsk);
      const wait = Math.max(delaySteps, 5 + hedgeSteps);
      const worst = (takingAsk ? Math.max : Math.min)(decision, ipfx(t0 + wait, takingAsk), failed ? -Infinity * (takingAsk ? 1 : -1) : newHedge);
      const newTrader = roundAdverse(worst * (1 + (takingAsk ? 1 : -1) * bps / 1e4), takingAsk);
      return { oldTrader, oldHedge, newTrader, newHedge };
    };
    const o = leg(100, true), c = leg(100 + 200 + Math.floor(r() * 150), false);
    const capOld = capturePerUnit(side, o.oldTrader, c.oldTrader, o.oldHedge, c.oldHedge) / PIP;
    const capNew = capturePerUnit(side, o.newTrader, c.newTrader, o.newHedge, c.newHedge) / PIP;
    out.old.push(capOld);
    if (failed) { out.unpriced++; continue; }
    out.neu.push(capNew);
    if (arbitrageur) { out.arb.old.push(capOld); out.arb.neu.push(capNew); }
    void dir;
  }
  return out;
}
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  const sum = s.reduce((a, b) => a + b, 0);
  return { n, mean: sum / n, min: s[0], p1: s[Math.floor(n * 0.01)], p50: s[Math.floor(n / 2)],
    negShare: s.filter((x) => x < -1e-9).length / n, leakPips: -s.filter((x) => x < 0).reduce((a, b) => a + b, 0) };
};

test('stress: hedge-first captures every tick on every priced trade; the old copy pipeline leaks', () => {
  const runs = [1, 2, 3, 4, 5].map((seed) => simulate({ seed, trades: 20_000 }));
  for (const run of runs) {
    const neu = stats(run.neu), old = stats(run.old);
    // The guarantee: no priced copied trade ever earns the trader more than its hedge.
    assert.ok(neu.min >= -1e-9, `hedge-first leaked ${neu.min} pips`);
    assert.equal(neu.negShare, 0);
    // The old pipeline demonstrably leaks (this is the problem being fixed).
    assert.ok(old.negShare > 0.05, `expected old leakage, got ${old.negShare}`);
    assert.ok(old.leakPips > 0);
    // Unpriced (failed / timed-out hedges) stay at the injected ~1% and are counted, never hidden.
    assert.ok(run.unpriced / run.old.length < 0.02);
  }
  const all = runs.flatMap((x) => x.neu), allOld = runs.flatMap((x) => x.old);
  const arbNew = runs.flatMap((x) => x.arb.neu), arbOld = runs.flatMap((x) => x.arb.old);
  const s = { new: stats(all), old: stats(allOld), arbNew: stats(arbNew), arbOld: stats(arbOld) };
  console.log('A-book capture per trade, pips (>= 0 means every tick captured):');
  for (const [k, v] of Object.entries(s)) {
    console.log(`  ${k.padEnd(7)} n=${v.n} mean=${v.mean.toFixed(3)} p1=${v.p1.toFixed(3)} min=${v.min.toFixed(3)} trades-leaking=${(v.negShare * 100).toFixed(1)}% total-leak=${v.leakPips.toFixed(0)} pips`);
  }
  // Latency arbitrage is where the old pipeline hurts most; hedge-first neutralises it.
  assert.ok(s.arbNew.min >= -1e-9);
  assert.ok(s.arbOld.mean < s.arbNew.mean);
});

// ---------------------------------------------------------------- concurrency
// Model of live-mirror's claim (unique idempotency key) + engine closeTrade's conditional update.
test('stress: racing closes of one copied trade send one broker close and close the trade once', async () => {
  const r = rng(99);
  for (let round = 0; round < 600; round++) {
    const claims = new Map(); // idempotency key -> row
    const trade = { status: 'open', close_price: null, closes: 0 };
    let brokerCloses = 0;
    const crashFirst = r() < 0.1; // the request that claims the close dies before writing its price
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const liveMirrorClose = async () => {
      if (claims.has('close')) return { ok: true, skipped: 'duplicate event', existing: { ...claims.get('close') } };
      const row = { status: 'sent', fill_price: null, created_at: new Date(Date.now()).toISOString() };
      claims.set('close', row);
      brokerCloses++;
      await sleep(Math.floor(r() * 3));
      if (crashFirst && brokerCloses === 1 && !row.crashed) { row.crashed = true; row.created_at = new Date(Date.now() - 60_000).toISOString(); throw new Error('crash'); }
      row.fill_price = 1.1;
      row.status = 'reconciliation_required';
      return { ok: true, fill_price: 1.1 };
    };
    const closer = async (ipfxExit) => {
      await sleep(Math.floor(r() * 3));
      let res;
      try { res = await liveMirrorClose(); } catch { res = null; }
      let exit = ipfxExit;
      if (res?.ok && !res.skipped && res.fill_price > 0) exit = Math.min(exit, res.fill_price);
      else if (res?.skipped === 'duplicate event') {
        const a = closeClaimAction(res.existing, Date.now());
        if (a === 'busy') return false;
        if (a === 'use_price') exit = Math.min(exit, res.existing.fill_price);
      }
      if (trade.status !== 'open') return false; // conditional UPDATE ... where status='open'
      trade.status = 'closed'; trade.close_price = exit; trade.closes++;
      return true;
    };
    const n = 2 + Math.floor(r() * 5);
    await Promise.all(Array.from({ length: n }, () => closer(1.1002)));
    // A later sweep retries anything still open (busy callers return false and the next pass closes it).
    for (let pass = 0; pass < 3 && trade.status === 'open'; pass++) await closer(1.1002);
    assert.equal(brokerCloses, 1, 'exactly one broker close per trade');
    assert.equal(trade.status, 'closed', 'never stuck open');
    assert.equal(trade.closes, 1, 'closed exactly once');
    assert.ok(trade.close_price <= 1.1002);
  }
});

// ---------------------------------------------------------------- wiring
test('engine fills copied trades hedge-first on market opens, pending fills and every close', () => {
  const engine = read('supabase/functions/trading-engine/index.ts');
  assert.match(engine, /import \{ closeClaimAction, worseFill \} from "\.\.\/_shared\/stp-fill\.ts"/);
  assert.match(engine, /if \(await hedgeOpenArmed\(db, A\)\) \{/);
  assert.match(engine, /const hedge = await hedgeNow\(db, A, srcTrade, "open", riskUsd\);/);
  // A slow broker is waited on with a timer, never aborted, so an in-flight order is always recorded.
  assert.match(engine, /const call = fireMirror\(db, acct, t, event, riskUsd, \{ sync: true, armed: true \}\);\s*\n\s*mirrorLater\(call\);/);
  assert.doesNotMatch(engine, /signal: AbortSignal\.timeout\(opts\.timeoutMs\)/);
  assert.match(engine, /worseFill\(takingAsk, fill, later \? \(takingAsk \? later\.ask : later\.bid\) : null, brokerFill\)/);
  assert.match(engine, /const hedge = await hedgeCloseFirst\(db, acct, t\);\s*\n\s*if \(hedge\.state === "busy"\) return false;/);
  assert.match(engine, /if \(hedge\.state !== "filled"\) mirrorLater\(fireMirror\(db, acct, t, "close"\)\);/);
  assert.match(engine, /function roundAdverse\(/);
  // Pending (limit/stop) fills on a copied account are re-priced to no better than the broker.
  assert.match(engine, /if \(await hedgeOpenArmed\(db, acct\)\) \{\s*\n\s*\/\/ Copied account: the hedge fills first/);
  // B-book accounts keep the instant path.
  assert.match(engine, /\} else \{\s*\n\s*mirrorLater\(fireMirror\(db, acct, inserted as Tr, "open", sourceRiskUsd\)\);/);
});

test('live-mirror returns the exact broker fill and gives the broker no take-profit', () => {
  const lm = read('supabase/functions/live-mirror/index.ts');
  assert.match(lm, /const sync = body\.sync === true;/);
  assert.match(lm, /sl: brokerStop, tp: null/);
  assert.match(lm, /orderFill\(accessToken, String\(connection\.tradelocker_account_id\)/);
  assert.match(lm, /fill_price: fillPrice/);
  assert.match(lm, /skipped: "duplicate event", existing:/);
  assert.doesNotMatch(lm, /\{ takeProfit \}/);
  const sql = read('supabase/migrations/20261002130000_abook_hedge_first_fills.sql');
  assert.match(sql, /add column if not exists fill_price numeric/);
  assert.match(sql, /create or replace view public\.abook_execution_capture/);
  assert.match(sql, /revoke all on public\.abook_execution_capture from anon, authenticated/);
});
