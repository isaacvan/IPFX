// Brain control room: per-person metrics and tags, alert scan wiring, owner-only API and page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { POLICY_V1 } from '../supabase/functions/_shared/ab-classifier.ts';
import { personMetrics, TAG_RULES } from '../supabase/functions/_shared/brain.ts';

const DAY = 86_400_000, NOW = Date.parse('2026-10-20T12:00:00Z');
const policy = { ...POLICY_V1, stage2AutoMinTrades: 15, stage2AutoMinCopyR: 0, maxCopyGapR: 0.1, herdBlocksAuto: true };
const ctx = (over = {}) => ({ state: 'BB_DEMO', herd: false, hold: false, criticalFlag: false, breaches7d: 0, expectedPayout: null, pGraduate: null, ...over });
const rowsOf = (rs, opts = {}) => rs.map((r, i) => ({ closedAt: NOW - (rs.length - i) * 3_600_000, pnlUsd: r * 100, traderR: r, holdSeconds: opts.hold ?? 600, riskBasis: opts.basis ?? 'STOP_LOSS' }));
const pointsOf = (n, same, rev, gap = 0) => Array.from({ length: n }, (_, i) => ({ closedAt: NOW - 60 * DAY + i * (DAY / 2), sameR: same(i), reverseR: rev(i), holdSeconds: 600, traderR: same(i) + gap }));

test('performance numbers: win rate, P&L, average R, profit factor, biggest fall and the trend line', () => {
  const m = personMetrics(rowsOf([1, -1, 2, -1, -1, 3]), [], ctx(), policy, NOW);
  assert.equal(m.trades, 6); assert.equal(m.wins, 3); assert.equal(m.win_rate, 0.5); assert.equal(m.pnl_usd, 300);
  assert.equal(m.avg_r, 0.5); assert.equal(m.profit_factor, 2); assert.equal(m.max_dd_r, 2);
  assert.deepEqual(m.curve, [1, 0, 2, 1, 0, 3]);
  assert.deepEqual(m.tags, ['NEW']);
});

test('rule tags: suspended, investigation, flag, breach, oversized loss, no stop loss, under-a-minute, herd', () => {
  const m = personMetrics(rowsOf(Array.from({ length: 25 }, (_, i) => i === 3 ? -4 : 0.2), { hold: 20, basis: 'ACCOUNT_RISK_LIMIT' }), [],
    ctx({ state: 'SUSPENDED', hold: true, criticalFlag: true, breaches7d: 1, herd: true }), policy, NOW);
  for (const t of ['SUSPENDED', 'HOLD', 'FLAG', 'BREACHED', 'BIG_LOSS', 'NO_SL', 'FAST', 'HERD']) assert.ok(m.tags.includes(t), t);
  assert.equal(m.no_sl_share, 1); assert.equal(m.under_60s_share, 1);
});

test('money tags: likely payout without copying, proven copy skill, getting worse, B-book earner and turning', () => {
  const rinse = personMetrics(rowsOf([1, 1, 1]), [], ctx({ expectedPayout: TAG_RULES.rinsePayoutUsd + 1, pGraduate: 0.4 }), policy, NOW);
  assert.ok(rinse.tags.includes('RINSE'));
  assert.ok(!personMetrics(rowsOf([1]), [], ctx({ state: 'AB_LIVE', expectedPayout: 900 }), policy, NOW).tags.includes('RINSE'), 'copied traders pay for themselves');

  const skilled = pointsOf(120, (i) => (i % 2 ? 1.2 : -0.6), (i) => (i % 2 ? -1.3 : 0.5));
  const star = personMetrics(rowsOf([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), skilled, ctx({ state: 'AB_LIVE' }), policy, NOW);
  assert.ok(star.tags.includes('STAR')); assert.ok(star.proof_copy >= 10);

  const fading = pointsOf(60, (i) => (i < 40 ? 0.4 : -0.6), (i) => (i < 40 ? -0.5 : 0.5));
  assert.ok(personMetrics(rowsOf([1]), fading, ctx({ state: 'AB_LIVE' }), policy, NOW).tags.includes('FADING'));

  const loser = pointsOf(120, (i) => (i % 2 ? -1.3 : 0.5), (i) => (i % 2 ? 1.2 : -0.6));
  assert.ok(personMetrics(rowsOf([-1]), loser, ctx({ state: 'BB_LIVE' }), policy, NOW).tags.includes('EARNER'));
  const turning = pointsOf(60, (i) => (i < 40 ? -0.5 : 0.6), (i) => (i < 40 ? 0.4 : -0.7));
  assert.ok(personMetrics(rowsOf([-1]), turning, ctx({ state: 'BB_LIVE' }), policy, NOW).tags.includes('TURNING'));
});

test('price-delay pattern: IPFX result well above the copy result', () => {
  const lag = pointsOf(30, () => -0.05, () => -0.1, 0.25);
  const m = personMetrics(rowsOf([1]), lag, ctx(), policy, NOW);
  assert.ok(m.tags.includes('SPEED')); assert.equal(m.copy_gap, 0.25);
});

test('alert scan: scheduled every 5 minutes, opens and resolves alerts, covers system, books, money, rules and moves', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261004170000_brain_control_room.sql', import.meta.url), 'utf8');
  assert.match(sql, /cron\.schedule\('ipfx-brain-scan', '4-59\/5 \* \* \* \*', 'select public\.ab_alerts_scan\(\)'\)/);
  assert.match(sql, /update public\.ab_alerts set resolved_at = now\(\) where resolved_at is null and key not in \(select key from _alert_now\)/);
  assert.match(sql, /first_seen = case when a\.resolved_at is not null then now\(\) else a\.first_seen end/);
  for (const k of ["'system:classifier'", "'system:prices'", "'book:loss:'", "'book:order:'", "'book:skips:'", "'money:treasury'", "'money:sponsor:'", "'trader:'", "'move:'"]) assert.ok(sql.includes(k), k);
  for (const t of ['ab_trader_metrics', 'ab_copy_skips', 'ab_heartbeats', 'ab_alerts']) assert.match(sql, new RegExp(`revoke all on public\\.${t} from public, anon, authenticated`));
});

test('owner-only API and the classifier heartbeat', () => {
  const fn = readFileSync(new URL('../supabase/functions/brain-monitor/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /aal\(authHeader\.replace\(\/\^Bearer\\s\+\/i, ""\)\) !== "aal2"/);
  assert.match(fn, /String\(user\.email \|\| ""\)\.toLowerCase\(\) !== ownerEmail/);
  assert.match(fn, /action: "brain_alert_ack"/);
  assert.doesNotMatch(fn, /book_orders"\)\.(insert|update)|ab_reserve_risk|placeOrder/, 'the Brain never trades');
  const cls = readFileSync(new URL('../supabase/functions/ab-classifier/index.ts', import.meta.url), 'utf8');
  assert.match(cls, /from\("ab_heartbeats"\)\.upsert\(\{ worker: "ab-classifier"/);
  assert.match(cls, /from\("ab_trader_metrics"\)\.upsert/);
  const ex = readFileSync(new URL('../supabase/functions/book-executor/index.ts', import.meta.url), 'utf8');
  assert.match(ex, /await logSkips\(db, body, r\)\.catch\(\(\) => \{\}\)/);
});

test('page: owner pages link to the Brain; local design preview only on localhost', () => {
  const html = readFileSync(new URL('../team-brain.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  const js = readFileSync(new URL('../assets/js/team-brain.js', import.meta.url), 'utf8');
  assert.match(js, /const FIXTURE = \/\^\(localhost\|127\\\.0\\\.0\\\.1\)\$\/\.test\(location\.hostname\)/);
  assert.match(js, /functions\/v1\/brain-monitor/);
  for (const p of ['team-a-book.html', 'team-b-book.html', 'team-treasury.html']) assert.match(readFileSync(new URL('../' + p, import.meta.url), 'utf8'), /href="team-brain\.html"/, p);
});

test('10-second updates: alert scan every 10s writing only changes, ledger and classifier every minute, page pulses every 10s', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261005090000_brain_ten_second_pulse.sql', import.meta.url), 'utf8');
  assert.match(sql, /cron\.schedule\('ipfx-brain-scan', '10 seconds', 'select public\.ab_alerts_scan\(\)'\)/);
  assert.match(sql, /cron\.schedule\('ipfx-ab-ledger', '\* \* \* \* \*', 'select public\.ab_ledger_tick\(\)'\)/);
  assert.match(sql, /cron\.schedule\('ipfx-ab-classifier', '\* \* \* \* \*', 'select public\.kick_ab_classifier\(\)'\)/);
  assert.match(sql, /or a\.last_seen < now\(\) - interval '1 minute';/);
  const fn = readFileSync(new URL('../supabase/functions/brain-monitor/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /action === "overview" \|\| action === "pulse"/);
  const js = readFileSync(new URL('../assets/js/team-brain.js', import.meta.url), 'utf8');
  assert.match(js, /const REFRESH_MS = 10000, FULL_MS = 60000;/);
});
