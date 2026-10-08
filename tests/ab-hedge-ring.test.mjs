// Hedge-ring detector: accounts that take opposite sides of the same trades (owner red-team review 2026-10-08).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const sql = fs.readFileSync(new URL('../supabase/migrations/20261008150000_ab_hedge_ring_detection.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const deps = process.env.DEMO_TEST_DEPS;

test('the Brain alerts on every open ring flag and the scan runs every five minutes', () => {
  assert.match(sql, /select 'ring:' \|\| f\.id, case when f\.level = 'block' then 'critical' else 'warning' end, 'rules'/);
  assert.match(sql, /where f\.status = 'open'/);
  assert.match(sql, /cron\.schedule\('ipfx-hedge-scan', '\*\/5 \* \* \* \*', 'select public\.ab_hedge_scan\(\)'\)/);
  assert.match(sql, /create or replace function public\.ab_alerts_scan\(\)/);
  assert.match(sql, /'system:hub'/, 'the existing alert blocks are preserved');
  assert.match(sql, /'cost:spread:'/, 'the spread-parity block is preserved');
  assert.doesNotMatch(sql, /update public\.trading_accounts|investigation_hold/, 'nothing is frozen automatically');
  assert.match(sql, /select 'ident:' \|\| d\.kind \|\| ':' \|\| d\.k/);
  assert.match(sql, /from public\.ab_identity_dupes\(\) d/);
});

test('real detector SQL: rings flagged, coincidences, practice accounts and mismatched sizes are not', { skip: !deps }, async () => {
  const { PGlite } = await import(pathToFileURL(deps + '/node_modules/@electric-sql/pglite/dist/index.js').href);
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema cron; create table cron.job(jobid bigint generated always as identity, jobname text);
      create function cron.unschedule(bigint) returns boolean language sql as 'select true';
      create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';
      create table trading_accounts(id uuid primary key default gen_random_uuid(), user_id uuid not null, status text not null default 'active', phase text);
      create table trades(id uuid primary key default gen_random_uuid(), account_id uuid not null, user_id uuid, symbol text, side text, volume numeric, pnl numeric, status text, opened_at timestamptz);
      create table user_profiles(user_id uuid, full_name text);
      create table ab_heartbeats(worker text primary key, ok boolean, at timestamptz, detail jsonb);
      create function ab_person_of(u uuid) returns uuid language sql as 'select u';
      create table accts(label text primary key, id uuid, user_id uuid);
      create table trader_identity_private(user_id uuid primary key, legal_first_name text, legal_last_name text, date_of_birth date, phone_e164 text, address_line_1 text, postal_code text, country_code text);`);
    await db.exec(sql);

    const mk = async (label, user, status = 'active') => {
      const r = await db.query('insert into trading_accounts(user_id,status) values ($1,$2) returning id', [user, status]);
      await db.query('insert into accts values ($1,$2,$3)', [label, r.rows[0].id, user]);
    };
    const U = (n) => `00000000-0000-0000-0000-00000000000${n}`;
    for (const [l, u, s] of [['A', U(1)], ['B', U(2)], ['C', U(3)], ['D', U(4)], ['E', U(5)], ['F', U(6)], ['G', U(7)], ['H', U(8)], ['I', U(8)], ['P', U(9), 'demo'], ['Q', U(9), 'demo'], ['V', U(1)], ['W', U(2)]]) await mk(l, u, s);

    // pairs of opposite trades: (accountX, accountY, count, volX, volY, pnlX, pnlY, symbol)
    let slot = 0;
    const hedge = async (x, y, n, vx, vy, px, py, sym = 'EURUSD') => {
      slot += 1;   // every pair trades in its own time slot, so unrelated accounts never coincide
      for (let i = 0; i < n; i++) {
        const base = `now() - interval '${slot * 40 + i} hours'`;
        for (const [acc, side, vol, pnl, off] of [[x, 'buy', vx, px, 0], [y, 'sell', vy, py, 15]]) {
          await db.query(`insert into trades(account_id,user_id,symbol,side,volume,pnl,status,opened_at)
            select a.id, a.user_id, $2, $3, $4, $5, 'closed', ${base} + interval '${off} seconds' from accts a where a.label = $1`, [acc, sym, side, vol, pnl]);
        }
      }
    };
    await hedge('A', 'B', 6, 1, 1, 50, -48);       // a hedge: results cancel -> review
    await hedge('C', 'D', 9, 1, 1, 80, -79);       // clear-cut ring -> block
    await hedge('E', 'F', 2, 1, 1, 30, -29);       // coincidence: too few shared trades
    await hedge('E', 'G', 6, 1, 1, -50, -50);      // opposite sides but both lose: not a hedge
    await hedge('H', 'I', 6, 1, 1, 40, -41);       // two accounts of the SAME person
    await hedge('P', 'Q', 9, 1, 1, 80, -79);       // practice (demo) accounts are ignored
    await hedge('V', 'W', 6, 1, 0.4, 50, -48);     // volumes do not match: not a hedge

    const scan = (await db.query('select ab_hedge_scan() r')).rows[0].r;
    const flags = (await db.query(`select (select label from accts where id = f.account_a) a, (select label from accts where id = f.account_b) b, f.level, f.shared, f.status, f.person_a = f.person_b as same_person
                                   from ab_hedge_flags f order by 1, 2`)).rows;
    const by = Object.fromEntries(flags.map((f) => [[f.a, f.b].sort().join(''), f]));
    assert.deepEqual(Object.keys(by).sort(), ['AB', 'CD', 'HI'], JSON.stringify(flags));
    assert.equal(by.AB.level, 'review');
    assert.equal(by.CD.level, 'block');
    assert.equal(by.HI.same_person, true, 'a person hedging against themselves is flagged');
    assert.equal(scan.open, 3);

    // idempotent; a repeat scan neither duplicates nor downgrades
    await db.query('select ab_hedge_scan()');
    assert.equal((await db.query('select count(*)::int c from ab_hedge_flags')).rows[0].c, 3);
    assert.equal((await db.query(`select level from ab_hedge_flags f where f.account_a in (select id from accts where label in ('C','D'))`)).rows[0].level, 'block');
    assert.equal((await db.query(`select (detail->>'open')::int o from ab_heartbeats where worker='hedge-scan'`)).rows[0].o, 3);

    // duplicate identity details: shared phone, shared name + date of birth, shared address are reported; different people are not
    await db.exec(`insert into trader_identity_private values
       ('00000000-0000-0000-0000-000000000001','Ann','Lee','1990-01-01','+447700900001','1 High St','AB1 2CD','GB'),
       ('00000000-0000-0000-0000-000000000002','Bob','Ray','1991-02-02','+447700900001','2 Low Rd','ZZ9 9ZZ','GB'),
       ('00000000-0000-0000-0000-000000000003','ann','LEE','1990-01-01','+447700900003','3 Mid Ln','QQ1 1QQ','GB'),
       ('00000000-0000-0000-0000-000000000004','Cy','Day','1985-05-05','+447700900004','1 high st','ab1 2cd','GB'),
       ('00000000-0000-0000-0000-000000000005','Di','Fox','1980-06-06','+447700900005','9 Far Way','FF5 5FF','GB');`);
    const dupes = (await db.query('select kind, n::int n from ab_identity_dupes() order by kind')).rows;
    assert.deepEqual(dupes, [{ kind: 'home address', n: 2 }, { kind: 'name and date of birth', n: 2 }, { kind: 'phone number', n: 2 }]);

    // clearing needs a reason, and a cleared pair stays cleared on later scans
    const id = (await db.query(`select id from ab_hedge_flags where account_a in (select id from accts where label in ('H','I'))`)).rows[0].id;
    await assert.rejects(db.query('select ab_hedge_clear($1, $2)', [id, 'no']), /note explaining/);
    await db.query('select ab_hedge_clear($1, $2)', [id, 'Same person, hedging their own practice strategy; reviewed']);
    await db.query('select ab_hedge_scan()');
    assert.equal((await db.query('select status from ab_hedge_flags where id = $1', [id])).rows[0].status, 'cleared');
    assert.equal((await db.query(`select count(*)::int c from ab_hedge_flags where status='open'`)).rows[0].c, 2);
  } finally { await db.close(); }
});
