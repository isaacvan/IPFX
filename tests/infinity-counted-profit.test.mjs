// Counted profit: at most the daily cap of each day's profit counts toward the target (Terms 2.1 runs), and every
// requirement must be met at the same time before moving up (owner request 2026-10-12).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sql = read('supabase/migrations/20261012210000_infinity_counted_profit.sql');
const engine = read('supabase/functions/trading-engine/index.ts');
const page = read('trading.html');
const terms = read('legal/2026-10-12-v2.1/terms.html');

test('the pass gate refuses to move a Terms 2.1 run up until counted profit reaches the target', () => {
  assert.match(engine, /const c = await db\.rpc\("fn_infinity_counted_profit", \{ p_account: acct\.id \}\);/);
  assert.match(engine, /if \(counted\.applies === true && counted\.met !== true\) unmet\.push\("DAILY_CAPPED_PROFIT"\);/);
  assert.match(engine, /if \(c\.error \|\| !c\.data\) unmet\.push\("Counted profit verification unavailable"\);/);
  assert.match(engine, /counted_profit: gate\.counted,/);
  assert.match(sql, /if coalesce\(accepted, ''\) < '2026-10-12-2\.1' then return jsonb_build_object\('applies', false\);/);
});

test('real PostgreSQL: each day counts at most the cap, losses count in full', { skip: !process.env.DEMO_TEST_DEPS }, async () => {
  const { PGlite } = await import(pathToFileURL(process.env.DEMO_TEST_DEPS + '/node_modules/@electric-sql/pglite/dist/index.js').href);
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table trading_accounts(id uuid primary key, challenge_type text, phase text, daily_profit_cap_pct numeric, profit_target_pct numeric,
        starting_balance numeric, funded_from_account_id uuid, approval_request_id uuid);
      create table challenge_enrolment_requests(id uuid primary key, application_details jsonb);
      create table trades(account_id uuid, status text, pnl numeric, closed_at timestamptz);
      insert into challenge_enrolment_requests values ('00000000-0000-4000-8000-000000000001', '{"terms_version":"2026-10-12-2.1"}'),
                                                    ('00000000-0000-4000-8000-000000000002', '{"terms_version":"2026-10-10-1.9"}');
      insert into trading_accounts values ('10000000-0000-4000-8000-000000000001','infinity','evaluation',1.4,4,1000,null,'00000000-0000-4000-8000-000000000001'),
                                         ('10000000-0000-4000-8000-000000000002','infinity','evaluation',1.4,4,1000,null,'00000000-0000-4000-8000-000000000002');`);
    await db.exec(sql);
    const add = (acct, day, pnl) => db.query(`insert into trades values ($1,'closed',$2,$3)`, [acct, pnl, `2026-10-${day}T10:00:00Z`]);
    const A = '10000000-0000-4000-8000-000000000001';
    await add(A, 13, 41.86);                          // one big day: counts as 14
    let r = (await db.query(`select fn_infinity_counted_profit($1) j`, [A])).rows[0].j;
    assert.equal(r.applies, true); assert.equal(Number(r.counted_usd), 14); assert.equal(r.met, false);
    await add(A, 14, 20); await add(A, 15, -5); await add(A, 16, 13);   // 14 + 14 - 5 + 13 = 36
    r = (await db.query(`select fn_infinity_counted_profit($1) j`, [A])).rows[0].j;
    assert.equal(Number(r.counted_usd), 36); assert.equal(r.met, false);
    await add(A, 17, 9);                               // 45 >= 40
    r = (await db.query(`select fn_infinity_counted_profit($1) j`, [A])).rows[0].j;
    assert.equal(Number(r.counted_usd), 45); assert.equal(r.met, true);
    const old = (await db.query(`select fn_infinity_counted_profit($1) j`, ['10000000-0000-4000-8000-000000000002'])).rows[0].j;
    assert.equal(old.applies, false, 'runs that accepted an earlier Terms version keep their rule');
  } finally { await db.close(); }
});

test('IPFX Markets shows counted profit and says every box must be ticked', () => {
  assert.match(page, /Every box below must be ticked at the same time before you move up to the next stage\. Reaching the profit target alone does not move you up\./);
  assert.match(page, /const C=P\.counted_profit;\s+if\(C&&C\.applies\)\{/);
  assert.match(page, /counted profit<span class="ch-sub">At most \$\{money\(perDay\)\} of each day's profit counts toward the target/);
  assert.match(page, /At '\+money\(L\.daily_profit_cap_usd\)\+' daily gain, open trades close and new trades pause until 00:00 UTC/);
});

test('Terms 2.1 states counted profit and the every-requirement rule', () => {
  assert.match(terms, /<span>Version 2\.1<\/span>/);
  assert.match(terms, /<strong>Counted profit \(daily credit limit\)\.<\/strong> For runs whose application accepted Terms version 2\.1 or later/);
  assert.match(terms, /a \$20 day counts as \$14, so the \$40 target needs at least three profitable days/);
  assert.match(terms, /<strong>Every requirement at the same time\.<\/strong>/);
  // Terms 2.2 keeps these clauses (and adds the closed-balance trailing drawdown).
  const v22 = read('legal/2026-10-16-v2.2/terms.html');
  assert.match(v22, /<strong>Every requirement at the same time\.<\/strong>/);
  assert.match(v22, /highest closed balance/);
});
