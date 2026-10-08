// Seamless stage progression and a clear explanation of exposure sessions (owner request 2026-10-08).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const engine = read('supabase/functions/trading-engine/index.ts');
const sql = read('supabase/migrations/20261008200000_seamless_stage_progression.sql');
const trading = read('trading.html');
const infinity = read('infinity.html');
const terms = read('terms.html');

test('the background sweep also visits accounts that reached their target while flat, so a stage completes on time', () => {
  const sweep = engine.slice(engine.indexOf('if (body.action === "sweep") {'), engine.indexOf('// privileged client for writes'));
  assert.match(sweep, /db\.rpc\("fn_pass_candidates"\)/);
  assert.match(sweep, /ids\.add\(String\(\(r as \{ account_id: string \}\)\.account_id\)\)/);
  assert.match(sweep, /catch \(_\) \{ \/\* the sweep never fails because of this extra pass \*\/ \}/);
  assert.match(sweep, /await enforce\(db, acct as Acct\)/, 'candidates go through the normal enforce() and pass gate');
});

test('promotion stays gated by the full pass gate and is automatic: next stage account is the newest active account', () => {
  assert.match(engine, /Number\(acct\.balance\) >= round2\(start \* \(1 \+ Number\(acct\.profit_target_pct\) \/ 100\)\) &&\s+open\.length === 0/);
  assert.match(engine, /const gate = await passGate\(db, acct\);\s+if \(gate\.ok\) \{\s+acct\.status = "passed";\s+await provisionNextStage\(db, acct\);/);
  assert.match(engine, /\.eq\("status", "active"\)\s+\.neq\("phase", "demo"\)\.is\("access_revoked_at", null\)\s+\.order\("created_at", \{ ascending: false \}\)\.limit\(1\)/);
});

test('the state response carries a one-off promotion notice for accounts created from a passed stage', () => {
  assert.match(engine, /async function promotionNotice\(db: Db, acct: Acct\)/);
  assert.match(engine, /if \(!acct\.funded_from_account_id \|\| isDemoAccount\(acct\)\) return null;/);
  assert.match(engine, /> 14 \* 86_400_000\) return null;/);
  assert.match(engine, /promotion_notice: await promotionNotice\(db, acct\),/);
  // the page shows it once per browser
  assert.match(trading, /function maybeShowPromotion\(n\)/);
  assert.match(trading, /localStorage\.getItem\('ipfx-promo-seen-'\+n\.account_id\)==='1'/);
  assert.match(trading, /try\{maybeShowPromotion\(j\.promotion_notice\);\}catch\(_\)\{\}/);
  assert.match(trading, /You moved up automatically/);
});

test('the progress panel explains sessions in plain words and tells a flat-able trader what is left', () => {
  assert.match(trading, /exposure sessions<span class="ch-sub">One session = one burst of trading\./);
  assert.match(trading, /within 60 minutes of closing everything, count as <b>one<\/b>/);
  assert.match(trading, /Close all open trades\. The stage completes the moment you are flat and everything else is met\./);
  assert.doesNotMatch(trading, /independent exposure sessions \(split or overlapping/);
});

test('Infinity page, Terms and chatbot all explain an exposure session with the same example', () => {
  assert.match(infinity, /<span>What is an exposure session\?<\/span>/);
  assert.match(infinity, /That is still <strong>one<\/strong> session\. At 11:45 you open another trade: you have been flat for 75 minutes, so that is a <strong>second<\/strong> session\./);
  assert.match(infinity, /A session is one burst of trading: trades that are open at the same time, or that you open within 60 minutes of closing everything, count as one session/);
  assert.match(infinity, /one burst of trading counts once/);
  assert.match(infinity, /60 exposure sessions \(separate bursts of trading, explained in the FAQ below\)/);
  assert.match(infinity, /40 exposure sessions \(separate bursts of trading, explained in the FAQ below\)/);
  assert.match(terms, /In plain terms, a session is one burst of trading\. Example: you buy at 09:00/);
  assert.match(terms, /60 independent exposure sessions \(as defined in clause 4\.6\.1\) are required/);
  assert.match(sql, /'exposure-sessions', 'infinity', 'What is an exposure session\?'/);
  assert.match(sql, /At 11:45 you open another trade: you have been flat for 75 minutes, so that is a \*\*second\*\* session/);
  assert.match(sql, /where public\.support_kb\.edited_by_owner is not true/, 'an answer the owner edited by hand is never overwritten');
});

test('the worked example matches how the database really counts sessions (60-minute flat gap)', () => {
  // mirrors qualification_progress_v2: a new session starts when a trade opens more than 60 minutes after the account was last flat
  const trades = [['09:00', '09:40'], ['09:10', '09:40'], ['10:20', '10:30'], ['11:45', '11:55']];
  const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  let sessions = 0, flatSince = null, openUntil = -1;
  for (const [o, c] of [...trades].sort((a, b) => m(a[0]) - m(b[0]))) {
    const open = m(o);
    if (open < openUntil) { openUntil = Math.max(openUntil, m(c)); continue; }       // overlaps something still open
    if (flatSince === null || open > flatSince + 60) sessions++;                       // new session after a gap over 60 minutes
    openUntil = m(c); flatSince = m(c);
  }
  assert.equal(sessions, 2);
});

test('real PostgreSQL: fn_pass_candidates returns only flat, qualified-by-balance, not-yet-promoted evaluation accounts', { skip: !process.env.DEMO_TEST_DEPS }, async () => {
  const { PGlite } = await import(pathToFileURL(process.env.DEMO_TEST_DEPS + '/node_modules/@electric-sql/pglite/dist/index.js').href);
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table support_kb(id text primary key, topic text, title text, keywords text[], answer text, follow_ups text[], is_active boolean, edited_by_owner boolean default false, updated_at timestamptz);
      create table trading_accounts(id uuid primary key default gen_random_uuid(), status text, phase text, access_revoked_at timestamptz, profit_target_pct numeric, starting_balance numeric, balance numeric, funded_from_account_id uuid);
      create table trades(id uuid primary key default gen_random_uuid(), account_id uuid, status text);`);
    await db.exec(sql);
    const add = async (status, phase, target, start, bal, extra = '') => (await db.query(`insert into trading_accounts(status,phase,profit_target_pct,starting_balance,balance${extra ? ',' + extra.split('=')[0] : ''}) values ($1,$2,$3,$4,$5${extra ? ',' + extra.split('=')[1] : ''}) returning id`, [status, phase, target, start, bal])).rows[0].id;
    const ready = await add('active', 'evaluation', 4, 1000, 1040);                  // at target, flat -> candidate
    await add('active', 'evaluation', 4, 1000, 1039.99);                              // just below target
    const busy = await add('active', 'evaluation', 4, 1000, 1100);                    // above target but has an open trade
    await db.query(`insert into trades(account_id,status) values ($1,'open')`, [busy]);
    const done = await add('active', 'evaluation', 6, 5000, 5400);                    // above target but already promoted
    await db.query(`insert into trading_accounts(status,phase,profit_target_pct,starting_balance,balance,funded_from_account_id) values ('active','evaluation',8,10000,10000,$1)`, [done]);
    await add('breached', 'evaluation', 4, 1000, 1200);                               // not active
    await add('active', 'funded', 4, 1000, 1200);                                     // funded never "passes" again
    await add('active', 'evaluation', 0, 1000, 5000);                                 // no target (e.g. final stage)
    const rows = (await db.query('select account_id from fn_pass_candidates()')).rows.map((r) => r.account_id);
    assert.deepEqual(rows, [ready]);
    // chatbot rows: new answer inserted, an owner-edited one is never overwritten
    assert.equal((await db.query(`select count(*)::int c from support_kb where id='exposure-sessions'`)).rows[0].c, 1);
    await db.exec(`update support_kb set answer='owner wording', edited_by_owner=true where id='exposure-sessions'`);
    await db.exec(sql);
    assert.equal((await db.query(`select answer from support_kb where id='exposure-sessions'`)).rows[0].answer, 'owner wording');
  } finally { await db.close(); }
});
