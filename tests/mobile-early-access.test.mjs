// Phone early access from the email: real SQL in PGlite (needs DEMO_TEST_DEPS).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const skip = !process.env.DEMO_TEST_DEPS;
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const U = '22222222-2222-4222-8222-222222222222', OWNER = 'f77286ef-8b51-47f3-b6b7-a62f541a4239';

test('a valid token claims early access once and counts every tap; bad tokens do nothing', { skip }, async () => {
  const { PGlite } = await import(pathToFileURL(process.env.DEMO_TEST_DEPS + '/node_modules/@electric-sql/pglite/dist/index.js').href);
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      insert into auth.users values('${U}'),('${OWNER}');`);
    await db.exec(read('supabase/migrations/20261128100000_mobile_early_access.sql'));
    assert.ok((await db.query(`select claimed_at from mobile_early_access where user_id='${OWNER}'`)).rows[0].claimed_at, 'owner already on');
    const tok = (await db.query(`insert into mobile_early_access(user_id) values('${U}') returning invite_token`)).rows[0].invite_token;
    assert.match(tok, /^[0-9a-f]{64}$/);
    const claim = async (t) => (await db.query('select public.fn_claim_mobile_early_access($1) ok', [t])).rows[0].ok;
    assert.equal(await claim('x'.repeat(64)), false);
    assert.equal(await claim("' or 1=1 --"), false);
    assert.equal(await claim(tok), true);
    const first = (await db.query(`select claimed_at from mobile_early_access where user_id='${U}'`)).rows[0].claimed_at;
    assert.equal(await claim(tok), true);
    const r = (await db.query(`select claimed_at, claim_count from mobile_early_access where user_id='${U}'`)).rows[0];
    assert.equal(r.claim_count, 2); assert.deepEqual(r.claimed_at, first, 'first tap time is kept');
  } finally { await db.close(); }
});
