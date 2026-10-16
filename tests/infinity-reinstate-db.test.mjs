// Real SQL: owner reinstatement of max-drawdown breaches that did not break the closed-balance rule (Terms 2.2).
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { pathToFileURL } from 'node:url';
const skip = !process.env.DEMO_TEST_DEPS;
const read = (n) => fs.readFileSync(new URL('../supabase/migrations/' + n, import.meta.url), 'utf8');
const OWNER = '11111111-1111-4111-8111-111111111111', U1 = '22222222-2222-4222-8222-222222222222', U2 = '33333333-3333-4333-8333-333333333333', U3 = '44444444-4444-4444-8444-444444444444', U4 = '55555555-5555-4555-8555-555555555555';
const A1 = '6e509428-4799-4e0c-91fa-ec852eee73e1', A2 = 'bb46cae7-4ff8-4ac2-b023-0848bd7ac9fb', A3 = 'd26502b4-3bd9-40e9-889c-2ffe3bd2d78c', A4 = '99999999-9999-4999-8999-999999999999';

async function db0() {
  const { PGlite } = await import(pathToFileURL(process.env.DEMO_TEST_DEPS + '/node_modules/@electric-sql/pglite/dist/index.js').href), db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
   create table auth.users(id uuid primary key,email text);insert into auth.users values('${OWNER}','paulade491@gmail.com'),('${U1}','one@example.invalid'),('${U2}','two@example.invalid'),('${U3}','three@example.invalid'),('${U4}','four@example.invalid');
   create table admins(user_id uuid);insert into admins values('${OWNER}');
   create table admin_audit_log(actor_id uuid,action text,target_user_id uuid,detail jsonb);
   create table trading_accounts(id uuid primary key,user_id uuid,challenge_type text,phase text,stage int,status text,balance numeric,starting_balance numeric,max_drawdown_pct numeric,
    drawdown_mode text,trailing_peak numeric,day_start_equity numeric,day_start_date date,breach_reason text,breached_at timestamptz,breach_equity numeric,breach_floor numeric,
    access_revoked_at timestamptz,access_revoked_reason text,updated_at timestamptz);
   create table trades(id uuid primary key default gen_random_uuid(),account_id uuid,status text,pnl numeric,closed_at timestamptz);
   create table email_templates(key text primary key,category text,subject text,preheader text,body_html text,body_text text,is_active boolean);
   create table email_events(id bigint generated always as identity,user_id uuid,template_key text,to_email text,subject text,status text,provider text,payload jsonb);
   create function public.fn_keep_breached_account_frozen() returns trigger language plpgsql set search_path to '' as $f$
begin
 if old.status='breached' and old.phase<>'demo' and(new.status<>'breached'
  or new.breach_reason is distinct from old.breach_reason or new.breached_at is distinct from old.breached_at
  or new.breach_equity is distinct from old.breach_equity or new.breach_floor is distinct from old.breach_floor
  or (old.access_revoked_at is not null and new.access_revoked_at is null)
  or new.stage is distinct from old.stage or new.phase is distinct from old.phase) then
  raise exception 'BREACHED_ACCOUNT_IS_FROZEN';end if;
 return new;
end $f$;
   create trigger trg_keep_breached_account_frozen before update on trading_accounts for each row execute function fn_keep_breached_account_frozen();`);
  const breached = (id, user, reason, bal) => db.query(`insert into trading_accounts values($1,$2,'infinity','evaluation',1,'breached',$4,1000,5,'trailing_intraday',1100,null,null,$3,'2026-10-15T20:33:42Z',1081,1083,'2026-10-15T20:33:42Z','challenge_rule_breach',null)`, [id, user, reason, bal]);
  await breached(A1, U1, 'max_drawdown', 1080.73); await breached(A2, U2, 'max_drawdown', 997.86); await breached(A3, U3, 'max_drawdown', 990.46); await breached(A4, U4, 'daily_loss', 974.28);
  await db.query(`insert into trades(account_id,status,pnl,closed_at)values($1,'closed',-14.66,'2026-10-15T10:00:00Z'),($1,'closed',95.39,'2026-10-15T20:33:44Z')`, [A1]);
  await db.query(`insert into trades(account_id,status,pnl,closed_at)values($1,'closed',5,'2026-10-12T04:00:00Z'),($1,'closed',-7.14,'2026-10-12T05:11:12Z')`, [A2]);
  return db;
}

test('only max-drawdown breaches that pass the new rule are unlocked, balance kept, emailed; the freeze still holds otherwise', { skip }, async () => {
  const db = await db0();
  try {
    await assert.rejects(db.exec(`update trading_accounts set status='active' where id='${A1}'`), /BREACHED_ACCOUNT_IS_FROZEN/);
    await db.exec(read('20261016121000_infinity_reinstate_closed_balance.sql').replace(/^begin;|commit;$/gm, ''));
    const a1 = (await db.query('select * from trading_accounts where id=$1', [A1])).rows[0];
    assert.equal(a1.status, 'active'); assert.equal(Number(a1.balance), 1080.73); assert.equal(a1.breach_reason, null); assert.equal(a1.access_revoked_at, null);
    assert.equal(a1.drawdown_mode, 'trailing_balance'); assert.equal(Number(a1.trailing_peak), 1080.73); assert.equal(Number(a1.day_start_equity), 1080.73);
    const a2 = (await db.query('select * from trading_accounts where id=$1', [A2])).rows[0];
    assert.equal(a2.status, 'active'); assert.equal(Number(a2.trailing_peak), 1005);
    assert.equal((await db.query('select status from trading_accounts where id=$1', [A3])).rows[0].status, 'active');
    // The daily-loss breach is not in the list and stays breached and frozen.
    assert.equal((await db.query('select status from trading_accounts where id=$1', [A4])).rows[0].status, 'breached');
    assert.equal((await db.query("select count(*)n from email_events where template_key='infinity_account_reinstated' and status='queued'")).rows[0].n, 3);
    assert.equal((await db.query('select count(*)n from infinity_breach_reinstatements')).rows[0].n, 3);
  } finally { await db.close(); }
});

test('the reinstatement refuses daily-loss breaches, open trades, a second active run and accounts that also break the new rule', { skip }, async () => {
  const db = await db0();
  try {
    const m = read('20261016121000_infinity_reinstate_closed_balance.sql');
    await db.exec(m.slice(0, m.indexOf('-- The three max-drawdown breaches')).replace(/^begin;/m, ''));
    const run = (id, actor = OWNER) => db.query(`select public.fn_reinstate_infinity_closed_balance($1,$2,'Synthetic owner reinstatement')r`, [id, actor]);
    await assert.rejects(run(A4), /NOT_A_REINSTATABLE_DRAWDOWN_BREACH/);
    await assert.rejects(run(A1, U1), /OWNER_PERMISSION_REQUIRED/);
    await db.query(`insert into trades(account_id,status) values($1,'open')`, [A2]); await assert.rejects(run(A2), /OPEN_TRADES_ON_BREACHED_ACCOUNT/); await db.exec(`delete from trades where status='open'`);
    await db.exec(`update trades set pnl=200 where account_id='${A2}' and pnl=5`); await assert.rejects(run(A2), /ACCOUNT_BREACHES_THE_NEW_RULE_TOO/);
    const ok = (await run(A1)).rows[0].r; assert.equal(ok.ok, true); assert.equal(Number(ok.dd_floor), 1030.73);
    assert.equal((await db.query('select count(*)n from infinity_breach_reinstatements')).rows[0].n, 1);
    // The original breach is kept on record.
    const rec = (await db.query('select * from infinity_breach_reinstatements')).rows[0]; assert.equal(rec.original_breach_reason, 'max_drawdown'); assert.equal(Number(rec.original_breach_floor), 1083);
    // The freeze flag does not leak: another breached account still cannot be edited directly.
    await assert.rejects(db.exec(`update trading_accounts set status='active' where id='${A4}'`), /BREACHED_ACCOUNT_IS_FROZEN/);
    await db.exec('set role authenticated'); await assert.rejects(run(A2), /permission denied/);
  } finally { await db.close(); }
});
