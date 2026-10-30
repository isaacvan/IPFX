// Copy-book policy v5 (red team, 30 Oct 2026): run-wide consistency-score gate replaces the 2.75% Stage 2 rule, identity before
// any copy state, and a kill switch when the copies themselves keep losing. Policy v4 behaviour must be unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { POLICY_V1, decide } from '../supabase/functions/_shared/ab-classifier.ts';
import { countedTrades, consistencyScore, runGate, copyKill } from '../supabase/functions/_shared/copy-gate.ts';

const DAY = 86_400_000, MIN = 60_000;
const T0 = Date.parse('2026-11-02T08:00:00Z');
const mig = readFileSync(new URL('../supabase/migrations/20261030121000_copy_gate_policy_v5.sql', import.meta.url), 'utf8');
const V4_SAVED = JSON.parse(readFileSync(new URL('../supabase/migrations/20261004160000_ab_policy_v4_herd_and_crowd5.sql', import.meta.url), 'utf8').match(/values \(4, 'ACTIVE',\s*'(\{[\s\S]*?\})'/)[1]);
const V4 = { ...POLICY_V1, ...V4_SAVED, version: 4 };
const V5 = { ...POLICY_V1, ...JSON.parse(mig.match(/values \(5, 'DRAFT',\s*'(\{[\s\S]*?\})'/)[1]), version: 5 };

let n = 0;
const tr = (o) => ({ id: 't' + (++n), parentId: null, accountId: 'A', symbol: 'EURUSD', side: 'buy', openedAt: T0, closedAt: T0 + 10 * MIN, pnlUsd: 5, riskUsd: 5, ...o });

test('v5 is a DRAFT that only adds the gate, identity and kill switch to v4', () => {
  assert.match(mig, /values \(5, 'DRAFT'/);
  for (const k of Object.keys(V4_SAVED)) if (k !== 'stage2AutoTarget') assert.deepEqual(V5[k], V4_SAVED[k], k + ' unchanged from v4');
  assert.equal(V4_SAVED.stage2AutoTarget, 'AB_LIVE'); assert.equal(V5.stage2AutoTarget, 'AB_DEMO', 'the gate starts a demo copy test, never live copying');
  assert.equal(V5.gateRunScore, 2.33); assert.equal(V5.gateRunMinCounted, 80); assert.equal(V5.gateRequireKyc, true);
  assert.equal(V5.killCopyScore, -1); assert.equal(V5.killMinCopied, 40); assert.equal(V5.killDrawdownR, 12);
});

test('counted trades: same account/symbol/side within 15 min or overlapping is one trade; partials join their root', () => {
  const a = tr({ openedAt: T0, closedAt: T0 + 30 * MIN, pnlUsd: 10, riskUsd: 5 });
  const b = tr({ openedAt: T0 + 20 * MIN, closedAt: T0 + 40 * MIN, pnlUsd: -2, riskUsd: 5 });          // opened while a was open
  const c = tr({ openedAt: T0 + 54 * MIN, closedAt: T0 + 60 * MIN, pnlUsd: 3, riskUsd: 5 });           // within 15 min of b's entry? no (34 min) but b closed at 40: new trade
  const d = tr({ side: 'sell', openedAt: T0 + 5 * MIN, closedAt: T0 + 6 * MIN, pnlUsd: -5, riskUsd: 5 }); // other side: separate
  const part = tr({ parentId: c.id, openedAt: c.openedAt, closedAt: T0 + 70 * MIN, pnlUsd: 2, riskUsd: null });
  const ct = countedTrades([a, b, c, d, part]);
  assert.equal(ct.length, 3);
  assert.deepEqual(ct.map((x) => +x.r.toFixed(3)).sort(), [-1, 0.8, 1].sort());
});

test('counted trades: open legs and missing risk are not scored; R is capped at +-5', () => {
  assert.equal(countedTrades([tr({ closedAt: null })]).length, 0);
  assert.equal(countedTrades([tr({ riskUsd: null })]).length, 0);
  assert.equal(countedTrades([tr({ pnlUsd: 100, riskUsd: 5 })])[0].r, 5);
});

test('score formula matches the trader-facing v2 score (sample sd, 0.5 floor)', () => {
  assert.equal(consistencyScore([]), 0);
  assert.ok(Math.abs(consistencyScore([1, 1, 1, 1]) - 1 / (0.5 / 2)) < 1e-12);
  const xs = [2, -1, 0.5, 1.5, -0.5];
  const m = xs.reduce((a, b) => a + b) / 5, sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / 4);
  assert.ok(Math.abs(consistencyScore(xs) - m / (sd / Math.sqrt(5))) < 1e-12);
});

// A person whose replayed copies average +0.3R: enough for the copyable guard (>= 15 trades, mean >= 0), not enough for strong().
function person(trades = 20) {
  const pts = [];
  for (let i = 0; i < trades; i++) pts.push({ closedAt: T0 - (trades - i) * 6 * 3600_000, sameR: i % 3 === 0 ? -1 : 0.95, reverseR: -0.3, holdSeconds: 900, traderR: 0.3 });
  return pts;
}
const base = { state: 'BB_DEMO', stateSince: T0 - 60 * DAY, lastAbExitAt: null, now: T0, points: person(), stage2ProfitPct: 3.1, herd: false, kycVerified: true };

test('v4 unchanged: the 2.75% Stage 2 rule still promotes and ignores the gate inputs', () => {
  const d = decide({ ...base, runGate: { score: 0.1, counted: 3, startedAt: T0 - 9 * DAY }, kycVerified: false }, V4);
  assert.equal(d?.to, 'AB_LIVE'); assert.match(d.reason, /2\.75/);
});

test('v5: Stage 2 profit alone no longer promotes; the run-wide gate does', () => {
  assert.equal(decide({ ...base, runGate: null }, V5), null, 'no run data: no promotion');
  assert.equal(decide({ ...base, runGate: { score: 2.32, counted: 120, startedAt: T0 - 9 * DAY } }, V5), null, 'score below 2.33');
  assert.equal(decide({ ...base, runGate: { score: 3, counted: 79, startedAt: T0 - 9 * DAY } }, V5), null, 'fewer than 80 counted trades');
  const d = decide({ ...base, stage2ProfitPct: null, runGate: { score: 2.33, counted: 80, startedAt: T0 - 9 * DAY } }, V5);
  assert.equal(d?.to, 'AB_DEMO'); assert.match(d.reason, /run-wide consistency score 2\.33 over 80/);
});

test('v5: identity must be verified, herd members and copy-negative traders still need full evidence', () => {
  const ok = { ...base, runGate: { score: 3, counted: 100, startedAt: T0 - 9 * DAY } };
  assert.equal(decide({ ...ok, kycVerified: false }, V5), null, 'no identity, no copying');
  assert.equal(decide({ ...ok, herd: true }, V5), null, 'co-trading cluster blocks the automatic gate');
  assert.equal(decide({ ...ok, points: person().map((p) => ({ ...p, sameR: -0.2 })) }, V5), null, 'copies losing so far: blocked');
});

test('v5: after a kill switch the same run cannot re-promote; a new run can', () => {
  const exit = T0 - 2 * DAY;
  assert.equal(decide({ ...base, lastAbExitAt: exit, runGate: { score: 3, counted: 100, startedAt: T0 - 9 * DAY } }, V5), null);
  assert.equal(decide({ ...base, lastAbExitAt: exit, runGate: { score: 3, counted: 100, startedAt: T0 - DAY } }, V5)?.to, 'AB_DEMO');
});

test('kill switch: copy score <= -1 only after 40 copied trades, or a 12R drawdown at any count', () => {
  const losing = Array.from({ length: 39 }, (_, i) => (i % 3 === 0 ? 0.6 : -0.5));
  assert.equal(copyKill(losing, V5).stop, false, '39 copied trades: too early');
  const k = copyKill([...losing, -0.5], V5); assert.equal(k.stop, true); assert.match(k.reason, /copy score/);
  const dd = copyKill([2, -3, -3, -3, -3.5], V5); assert.equal(dd.stop, true); assert.match(dd.reason, /12\.\dR from their peak/);
  assert.equal(copyKill([1, -1, 1, -1, 1], V5).stop, false);
  assert.equal(copyKill(Array(60).fill(-1), V4).stop, false, 'v4: kill switch off');
});

test('kill switch moves AB_LIVE and AB_DEMO back to BB_DEMO; v4 keeps its own rules', () => {
  const since = T0 - 20 * DAY;
  const pts = Array.from({ length: 45 }, (_, i) => ({ closedAt: since + (i + 1) * 3600_000, sameR: i % 4 === 0 ? 0.5 : -0.6, reverseR: 0.4, holdSeconds: 900, traderR: -0.5 }));
  for (const state of ['AB_LIVE', 'AB_DEMO']) {
    const d = decide({ ...base, state, stateSince: since, points: pts }, V5);
    assert.equal(d?.to, 'BB_DEMO', state); assert.match(d.reason, /copy kill switch/);
  }
  const v4 = decide({ ...base, state: 'AB_DEMO', stateSince: since, points: pts }, V4);
  assert.ok(v4 === null || !/kill switch/.test(v4.reason));
});

test('the classifier job loads gate inputs and refuses to run without them', () => {
  const src = readFileSync(new URL('../supabase/functions/ab-classifier/index.ts', import.meta.url), 'utf8');
  assert.match(src, /runGate: gate\.get\(p\.person_id\) \?\? null, kycVerified: kyc\.has\(p\.person_id\)/);
  assert.match(src, /copy gate inputs unavailable/);
  assert.match(src, /if \(!Number\.isFinite\(policy\.gateRunScore\) && !policy\.gateRequireKyc\) return \{ gate, kyc \};/, 'v4: no extra reads');
  assert.match(mig, /grant execute on function public\.ab_copy_gate_inputs\(\) to service_role/);
  assert.match(mig, /revoke all on function public\.ab_copy_gate_inputs\(\) from public, anon, authenticated/);
});

test('runGate end to end: 80 steady counted trades pass, choppy ones do not', () => {
  const steady = Array.from({ length: 80 }, (_, i) => tr({ openedAt: T0 + i * 3 * 3600_000, closedAt: T0 + i * 3 * 3600_000 + 20 * MIN, pnlUsd: i % 3 === 0 ? -5 : 6, riskUsd: 5 }));
  const g = runGate(steady); assert.equal(g.counted, 80); assert.ok(g.score >= 2.33, 'score ' + g.score);
  const choppy = steady.map((t, i) => ({ ...t, pnlUsd: i % 2 ? 5 : -5 }));
  assert.ok(runGate(choppy).score < 2.33);
});

test('ab_copy_gate_inputs: current run = latest Stage 1 account and its children; identity per person', { skip: !process.env.DEMO_TEST_DEPS }, async () => {
  const { pathToFileURL } = await import('node:url');
  const { PGlite } = await import(pathToFileURL(process.env.DEMO_TEST_DEPS + '/node_modules/@electric-sql/pglite/dist/index.js').href);
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.trading_accounts(id uuid primary key, user_id uuid, challenge_type text, stage int, created_at timestamptz, funded_from_account_id uuid);
      create table public.trader_kyc(user_id uuid primary key, status text);
      create table public.ab_policy_versions(version int primary key, status text, thresholds jsonb, note text);
      create function public.ab_person_of(p_user uuid) returns uuid language sql immutable as $$ select p_user $$;`);
    await db.exec(mig);
    const u1 = '00000000-0000-0000-0000-000000000001', u2 = '00000000-0000-0000-0000-000000000002';
    const old1 = '10000000-0000-0000-0000-000000000001', s1 = '10000000-0000-0000-0000-000000000002', s2 = '10000000-0000-0000-0000-000000000003', s3 = '10000000-0000-0000-0000-000000000004', other = '10000000-0000-0000-0000-000000000005';
    await db.query(`insert into public.trading_accounts values
      ($1,$6,'infinity',1,'2026-10-01',null), ($2,$6,'infinity',1,'2026-11-02',null), ($3,$6,'infinity',2,'2026-11-20',$2), ($4,$6,'infinity',3,'2026-12-10',$3),
      ($5,$7,'infinity',1,'2026-11-03',null)`, [old1, s1, s2, s3, other, u1, u2]);
    await db.query(`insert into public.trader_kyc values ($1,'verified'), ($2,'pending')`, [u1, u2]);
    const rows = (await db.query('select * from public.ab_copy_gate_inputs() order by person_id')).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual([...rows[0].run_accounts].sort(), [s1, s2, s3].sort(), 'old run excluded, all stages of the current run included');
    assert.equal(new Date(rows[0].run_started_at).toISOString(), '2026-11-02T00:00:00.000Z');
    assert.equal(rows[0].kyc_verified, true); assert.equal(rows[1].kyc_verified, false);
    assert.equal((await db.query("select status from public.ab_policy_versions where version=5")).rows[0].status, 'DRAFT');
  } finally { await db.close(); }
});
