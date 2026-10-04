// A/B-book Day 5: evaluation-ladder controller and routing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ladderDecision } from '../supabase/functions/_shared/ladder.ts';
const S = { seed: 1500, reinvest: 0.5, fee: 300, maxActive: 30, minTrades: 200, breakEvenR: 0.03 };
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('no purchase until the copied traders beat break-even with confidence', () => {
  assert.equal(ladderDecision(S, { trades: 50, meanR: 0.2, days: 5, dayMean: 2, daySd: 1 }, 0, 0, 0).action, 'hold');
  assert.equal(ladderDecision(S, { trades: 400, meanR: 0.01, days: 20, dayMean: 0.2, daySd: 0.5 }, 0, 0, 0).action, 'hold');
  assert.equal(ladderDecision(S, { trades: 400, meanR: 0.08, days: 20, dayMean: 1.6, daySd: 9 }, 0, 0, 0).action, 'hold', 'noisy days: lower bound below zero');
});

test('confirmed edge: buy what the seed allows; afterwards only from profits', () => {
  const ev = { trades: 400, meanR: 0.09, days: 20, dayMean: 1.8, daySd: 2 };
  const first = ladderDecision(S, ev, 0, 0, 0);
  assert.equal(first.action, 'buy'); assert.equal(first.accounts, 5);
  assert.equal(ladderDecision(S, ev, 5, 0, 1500).action, 'hold', 'seed spent, no payouts yet');
  const after = ladderDecision(S, ev, 5, 4000, 1500);
  assert.equal(after.action, 'buy'); assert.equal(after.accounts, 6); // 1500 + 0.5*4000 - 1500 = 2000 -> 6 x $300
  assert.equal(ladderDecision(S, ev, 30, 99999, 1500).accounts, 0, 'never above the maximum');
});

test('losing copied traders: stop buying', () => {
  assert.equal(ladderDecision(S, { trades: 400, meanR: -0.05, days: 20, dayMean: -1, daySd: 2 }, 4, 0, 1200).action, 'stop');
});

test('ladder accounts: owner-enabled only, per-account limits, split signal groups, worst-leg pricing', () => {
  const sql = read('supabase/migrations/20261004110000_ladder_and_sponsorships.sql');
  assert.match(sql, /execution_enabled boolean not null default false/);
  assert.match(sql, /if la is null or not la\.execution_enabled or la\.status not in \('evaluation', 'funded'\)/);
  assert.match(sql, /per_trade := la\.size_usd \* coalesce\(lim\.per_trade_max_pct, 0\.5\) \/ 100; open_max := la\.size_usd \* 0\.025;/);
  assert.match(sql, /create trigger trading_accounts_graduate_sponsorship/);
  const x = read('supabase/functions/book-executor/index.ts');
  assert.match(x, /Number\(la\.signal_group\) % groups === signalGroup\(String\(person\), groups\)/);
  assert.match(x, /const worst = fills\.length \? \(side === "buy" \? Math\.max\(\.\.\.fills\) : Math\.min\(\.\.\.fills\)\) : null;/);
  assert.match(x, /const fillA = aFills\.length \? \(traderLong \? Math\.min\(\.\.\.aFills\) : Math\.max\(\.\.\.aFills\)\) : null;/);
  const e = read('supabase/functions/trading-engine/index.ts');
  assert.match(e, /return \{ a: \[\.\.\.books\]\.some\(\(x\) => x === "a" \|\| \/\^l\[0-9\]\+\$\/\.test\(x\)\), b: books\.has\("b"\) \};/);
  assert.match(e, /if \(r\?\.duplicate_a === true\) return false;/);
});

test('owner control: MFA owner only, passwords never stored, every change audited, nothing trades or pays', () => {
  const f = read('supabase/functions/ladder-admin/index.ts');
  assert.ok(f.includes('!== "aal2"') && f.includes('authHeader.replace('), 'MFA (aal2) session required');
  assert.match(f, /String\(user\.email \|\| ""\)\.toLowerCase\(\) !== ownerEmail/);
  assert.match(f, /execution_enabled: false,/);
  assert.doesNotMatch(f, /password[^,]*:\s*password/);
  for (const a of ['treasury_set_reserve', 'ab_book_halt', 'ladder_account_add', 'ladder_account_update', 'ladder_payout_add', 'graduate_sponsorship_decide']) assert.ok(f.includes('audit("' + a + '"'), 'audited: ' + a);
  const page = read('team-treasury.html');
  assert.match(page, /Nothing on this page places a trade or makes a payment/);
  assert.match(page, /team-treasury\.js\?v=/);
  assert.match(read('assets/js/team-treasury.js'), /functions\/v1\/ladder-admin/);
});
