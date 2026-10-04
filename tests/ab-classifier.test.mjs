// A/B-book Day 2: classification engine, exercised with synthetic traders day by day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { POLICY_V1, decide, eValue } from '../supabase/functions/_shared/ab-classifier.ts';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-09T08:00:00Z');
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Net same-direction R per trade with expectancy mu (wins +1.2R, losses -1R). Reversing pays costs again: -0.15R.
function trade(r, mu) { const p = (1 + mu) / 2.2; return r() < p ? 1.2 : -1.0; }

function run({ seed = 1, days = 80, mu = () => 0, perDay = 3, hold = 600, suspendAt = null, stage2 = () => null }) {
  const r = rng(seed);
  let state = 'BB_DEMO', since = T0, lastAbExit = null; const points = [], path = [];
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < perDay; k++) {
      const s = trade(r, mu(d, state));
      points.push({ closedAt: T0 + d * DAY + k * 3_600_000, sameR: s, reverseR: -s - 0.15, holdSeconds: hold });
    }
    const now = T0 + d * DAY + 23 * 3_600_000;
    const dec = decide({ state, stateSince: since, lastAbExitAt: lastAbExit, now, points,
      suspend: suspendAt != null && d >= suspendAt ? 'investigation hold' : null, stage2ProfitPct: stage2(d) });
    if (dec) {
      if ((state === 'AB_DEMO' || state === 'AB_LIVE') && dec.to.startsWith('BB')) lastAbExit = now;
      path.push(`${d}:${state}->${dec.to}`); state = dec.to; since = now;
    }
  }
  return { state, path };
}

test('e-value stays near 1 under no edge and grows with a real edge', () => {
  const r = rng(9);
  const nulls = Array.from({ length: 400 }, () => eValue(Array.from({ length: 150 }, () => trade(r, POLICY_V1.minEdgeR)), POLICY_V1.minEdgeR));
  assert.ok(nulls.reduce((a, b) => a + b, 0) / nulls.length < 1.5, 'average e-value under the null should be about 1');
  assert.ok(nulls.filter((e) => e >= 10).length / nulls.length < 0.1);
  assert.ok(eValue(Array.from({ length: 150 }, () => trade(r, 0.3)), POLICY_V1.minEdgeR) > 20);
});

test('everyone starts on B-book demo; a no-edge trader is rarely promoted anywhere', () => {
  let promoted = 0;
  for (let s = 0; s < 300; s++) if (run({ seed: s, mu: () => -0.075 }).path.length) promoted++;
  assert.ok(promoted / 300 < 0.05, `false promotions ${promoted}/300`);
});

test('a trader whose reverse is clearly profitable reaches B-book live, not before 20 trading days', () => {
  let live = 0;
  for (let s = 0; s < 40; s++) {
    const { state, path } = run({ seed: 100 + s, mu: () => -0.45 });
    if (state === 'BB_LIVE') { live++; assert.ok(Number(path[0].split(':')[0]) >= 19); }
  }
  assert.ok(live >= 30, `reached BB_LIVE ${live}/40`);
});

test('a skilled trader goes B-book demo -> A-book demo -> A-book live, the live step on prospective evidence only', () => {
  let ok = 0;
  for (let s = 0; s < 40; s++) {
    const { state, path } = run({ seed: 200 + s, days: 90, mu: () => 0.35 });
    if (state === 'AB_LIVE' && path[0].includes('BB_DEMO->AB_DEMO')) {
      ok++;
      const toDemo = Number(path[0].split(':')[0]), toLive = Number(path.find((p) => p.includes('->AB_LIVE')).split(':')[0]);
      assert.ok(toLive - toDemo >= POLICY_V1.minDays - 1, 'A-book live needs its own fresh evidence window');
    }
  }
  assert.ok(ok >= 28, `reached AB_LIVE ${ok}/40`);
});

test('a skilled trader who fades is taken off A-book live', () => {
  let demoted = 0;
  for (let s = 0; s < 40; s++) {
    const { path } = run({ seed: 300 + s, days: 140, mu: (d) => d < 60 ? 0.35 : -0.35 });
    if (path.some((p) => p.includes('AB_LIVE->AB_DEMO'))) demoted++;
  }
  assert.ok(demoted >= 25, `demoted ${demoted}/40`);
});

test('a B-book live trader who turns profitable moves straight to A-book demo', () => {
  let flipped = 0;
  for (let s = 0; s < 40; s++) {
    const { path } = run({ seed: 400 + s, days: 120, mu: (d) => d < 45 ? -0.45 : 0.45 });
    if (path.some((p) => p.includes('BB_LIVE->AB_DEMO'))) flipped++;
  }
  assert.ok(flipped >= 25, `flipped ${flipped}/40`);
});

test('a steadily skilled trader is not flipped back and forth (hysteresis)', () => {
  let calm = 0;
  for (let s = 0; s < 40; s++) if (run({ seed: 500 + s, days: 150, mu: () => 0.35 }).path.length <= 3) calm++;
  assert.ok(calm >= 34, `calm paths ${calm}/40`);
});

test('integrity problems suspend at once and only a person can release', () => {
  const { state, path } = run({ seed: 7, days: 30, mu: () => 0.35, suspendAt: 3 });
  assert.equal(state, 'SUSPENDED');
  assert.equal(path.length, 1);
});

test('the 2.75% Stage 2 rule promotes, to A-book demo by default', () => {
  const { path } = run({ seed: 8, days: 3, mu: () => 0, stage2: (d) => d === 1 ? 2.9 : null });
  assert.deepEqual(path, ['1:BB_DEMO->AB_DEMO']);
  assert.equal(POLICY_V1.stage2AutoTarget, 'AB_DEMO');
});

test('high-frequency style (most trades under a minute) is never promoted', () => {
  const { path } = run({ seed: 9, days: 60, mu: () => 0.35, hold: 20 });
  assert.equal(path.length, 0);
});

test('wiring: cron worker, audit log and optimistic state change', () => {
  const fn = readFileSync(new URL('../supabase/functions/ab-classifier/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /constantTimeEqual\(req\.headers\.get\("x-classifier-secret"\) \?\? "", secret\)/);
  assert.match(fn, /db\.rpc\("ab_apply_transition"/);
  const sql = readFileSync(new URL('../supabase/migrations/20261003170000_ab_classifier.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists public\.ab_lifecycle_events/);
  assert.match(sql, /where person_id = p_person and book_state = p_from/);
  assert.match(sql, /create trigger ab_lifecycle_events_immutable/);
  assert.match(sql, /'SUSPENDED'.*human/s);
});

test('feed-lag fingerprint: profitable on IPFX but not when copied is never promoted (when the guard is on)', async () => {
  const { copyGap } = await import('../supabase/functions/_shared/ab-classifier.ts');
  const r = rng(77); const pts = [];
  for (let d = 0; d < 40; d++) for (let k = 0; k < 3; k++) {
    const o = r() < 0.52 ? 1.2 : -1.0;                // looks like a +0.14R trader on IPFX
    pts.push({ closedAt: T0 + d * DAY + k * 3_600_000, sameR: o - 0.18, reverseR: -o - 0.02, holdSeconds: 90, traderR: o });
  }
  assert.ok(copyGap(pts).gap > 0.1);
  const guarded = { ...POLICY_V1, maxCopyGapR: 0.1 };
  const stage2 = decide({ state: 'BB_DEMO', stateSince: T0, lastAbExitAt: null, now: T0 + 41 * DAY, points: pts, stage2ProfitPct: 3 }, { ...guarded, stage2AutoTarget: 'AB_LIVE' });
  assert.equal(stage2, null);
  const normal = pts.map((p) => ({ ...p, sameR: p.traderR + 0.02 }));
  assert.ok(copyGap(normal).gap < 0, 'normal traders copy at or better than their IPFX result');
});

test('crowding cap: at most crowd_max copies of one instrument and direction per book in 15 minutes', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261004120000_ab_crowding_cap.sql', import.meta.url), 'utf8');
  assert.ok(sql.includes("'crowded: same instrument and direction already copied'"));
  assert.ok(sql.includes("created_at > now() - interval '15 minutes'"));
  assert.ok(sql.includes('crowd_max int not null default 3'));
});

test('policy v3 is the active policy and switches both copyable guards on', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261004130000_ab_policy_v3_copyable_guards.sql', import.meta.url), 'utf8');
  assert.match(sql, /set status = 'RETIRED' where version = 2/);
  assert.match(sql, /"stage2AutoMinTrades":15,"stage2AutoMinCopyR":0,"maxCopyGapR":0.1/);
});

test('herd: clusters of 3+ co-traders lose the automatic 2.75% rule when the policy says so', async () => {
  const { herdClusters } = await import('../supabase/functions/_shared/ab-classifier.ts');
  const h = herdClusters([{ person_a: 'a', person_b: 'b' }, { person_a: 'b', person_b: 'c' }, { person_a: 'x', person_b: 'y' }]);
  assert.deepEqual([...h].sort(), ['a', 'b', 'c'], 'a pair alone is not a herd; a chain of three is');
  const pts = Array.from({ length: 20 }, (_, i) => ({ closedAt: T0 + i * DAY, sameR: 0.3, reverseR: -0.5, holdSeconds: 600, traderR: 0.3 }));
  const input = { state: 'BB_DEMO', stateSince: T0, lastAbExitAt: null, now: T0 + 21 * DAY, points: pts, stage2ProfitPct: 3, herd: true };
  assert.equal(decide(input, { ...POLICY_V1, herdBlocksAuto: true }), null);
  assert.equal(decide(input, POLICY_V1)?.to, 'AB_DEMO');
  const sql = readFileSync(new URL('../supabase/migrations/20261004140000_ab_herd_pairs.sql', import.meta.url), 'utf8');
  assert.match(sql, /p_window_s int default 60, p_min_shared int default 5, p_min_share numeric default 0.3/);
  assert.match(sql, /grant execute on function public.ab_herd_pairs\(int, int, int, numeric\) to service_role/);
});
