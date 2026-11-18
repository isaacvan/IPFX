// Real SQL: the two daily-loss breaches caused by the automatic-stop bug are reinstated (18 Nov 2026); nothing else is.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { pathToFileURL } from 'node:url';
const skip = !process.env.DEMO_TEST_DEPS;
const read = (n) => fs.readFileSync(new URL('../supabase/migrations/' + n, import.meta.url), 'utf8');
const OWNER = '11111111-1111-4111-8111-111111111111', U1 = '22222222-2222-4222-8222-222222222222', U2 = '33333333-3333-4333-8333-333333333333', U3 = '44444444-4444-4444-8444-444444444444';
const A1 = 'ddb5c31a-a1aa-495a-b320-a65b5e380336', A2 = '60aa4219-e399-4983-a867-6944d6b71ec7', OTHER = '99999999-9999-4999-8999-999999999999';

async function db0() {
  const { PGlite } = await import(pathToFileURL(process.env.DEMO_TEST_DEPS + '/node_modules/@electric-sql/pglite/dist/index.js').href), db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
   create table auth.users(id uuid primary key,email text);insert into auth.users values('${OWNER}','paulade491@gmail.com'),('${U1}','one@example.invalid'),('${U2}','two@example.invalid'),('${U3}','three@example.invalid');
   create table admins(user_id uuid);insert into admins values('${OWNER}');
   create table admin_audit_log(actor_id uuid,action text,target_user_id uuid,detail jsonb);
   create table infinity_breach_reinstatements(account_id uuid primary key,user_id uuid,actor_id uuid,reason text,original_breach_reason text,original_breached_at timestamptz,original_breach_equity numeric,original_breach_floor numeric,balance numeric,new_trailing_peak numeric,reinstated_at timestamptz default now());
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
  const breached = (id, user, reason, bal, at) => db.query(`insert into trading_accounts values($1,$2,'infinity','evaluation',1,'breached',$4,1000,5,'trailing_balance',1000,null,null,$3,$5,974.71,975,$5,'challenge_rule_breach:'||$3,null)`, [id, user, reason, bal, at]);
  await breached(A1, U1, 'daily_loss', 986.35, '2026-11-17T11:37:40Z'); await breached(A2, U2, 'daily_loss', 992.28, '2026-11-18T00:23:38Z');
  await breached(OTHER, U3, 'daily_loss', 980, '2026-11-17T09:00:00Z');
  await db.query(`insert into trades(account_id,status,pnl,closed_at)values($1,'closed',-13.65,'2026-11-17T11:30:00Z')`, [A1]);
  return db;
}

test('the two accounts become active on their closed balance, are recorded and emailed; any other breach stays frozen', { skip }, async () => {
  const db = await db0();
  try {
    await assert.rejects(db.exec(`update trading_accounts set status='active' where id='${A1}'`), /BREACHED_ACCOUNT_IS_FROZEN/);
    await db.exec(read('20261118130000_reinstate_two_platform_fault_breaches.sql').replace(/^begin;|^commit;$/gm, ''));
    for (const [id, bal] of [[A1, 986.35], [A2, 992.28]]) {
      const a = (await db.query('select * from trading_accounts where id=$1', [id])).rows[0];
      assert.equal(a.status, 'active'); assert.equal(Number(a.balance), bal); assert.equal(a.breach_reason, null); assert.equal(a.breached_at, null);
      assert.equal(a.access_revoked_at, null); assert.equal(Number(a.day_start_equity), bal); assert.ok(a.day_start_date);
    }
    // The breach of a different account is not touched and the exception does not leak.
    assert.equal((await db.query('select status from trading_accounts where id=$1', [OTHER])).rows[0].status, 'breached');
    await assert.rejects(db.exec(`update trading_accounts set status='active' where id='${OTHER}'`), /BREACHED_ACCOUNT_IS_FROZEN/);
    const rec = (await db.query('select * from infinity_breach_reinstatements order by account_id')).rows;
    assert.equal(rec.length, 2); assert.ok(rec.every((r) => r.original_breach_reason === 'daily_loss'));
    assert.equal((await db.query("select count(*)n from admin_audit_log where action='infinity_reinstate_platform_fault'")).rows[0].n, 2);
    const mail = (await db.query("select * from email_events where template_key='infinity_account_unlocked_fault' and status='queued' order by user_id")).rows;
    assert.equal(mail.length, 2); assert.equal(mail[0].payload.vars.balance, '$986.35'); assert.equal(mail[1].payload.vars.balance, '$992.28');
    const t = (await db.query("select body_html from email_templates where key='infinity_account_unlocked_fault'")).rows[0].body_html;
    assert.match(t, /A fault on our side stopped one of your trades/); assert.doesNotMatch(t, /drawdown|—/);
  } finally { await db.close(); }
});

test('the migration refuses an account with an open trade and does nothing twice', { skip }, async () => {
  const db = await db0();
  try {
    const sql = read('20261118130000_reinstate_two_platform_fault_breaches.sql').replace(/^begin;|^commit;$/gm, '');
    await db.query(`insert into trades(account_id,status) values($1,'open')`, [A2]);
    await assert.rejects(db.exec(sql), /OPEN_TRADES_ON_BREACHED_ACCOUNT/);
    await db.exec(`delete from trades where status='open'`);
    await db.exec(sql); await db.exec(sql);
    assert.equal((await db.query("select count(*)n from email_events where template_key='infinity_account_unlocked_fault'")).rows[0].n, 2);
    assert.equal((await db.query('select count(*)n from infinity_breach_reinstatements')).rows[0].n, 2);
  } finally { await db.close(); }
});

test('the guard keeps the exception narrow, and the new email is wired into the outbox', () => {
  const sql = read('20261118130000_reinstate_two_platform_fault_breaches.sql');
  assert.match(sql, /ipfx\.owner_reinstatement',true\),''\)='platform_fault_2026_11_18' and old\.challenge_type='infinity'\s+and old\.breach_reason='daily_loss'/);
  assert.match(sql, /ipfx\.owner_reinstatement',true\),''\)='closed_balance_2026_10_16'/, 'the earlier exception is kept');
  const outbox = fs.readFileSync(new URL('../supabase/functions/email-outbox/index.ts', import.meta.url), 'utf8');
  assert.equal((outbox.match(/infinity_account_unlocked_fault/g) || []).length >= 3, true);
});
