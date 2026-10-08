// Identity documents bucket: only the owner (service role, via the admin function) can read (2026-10-08).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const sql = readFileSync(new URL('../supabase/migrations/20261008190000_kyc_storage_owner_only.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the trader read rule is removed and browsers are blocked from reading, changing or deleting the bucket', () => {
  assert.match(sql, /drop policy if exists "kyc own read" on storage\.objects;/);
  assert.match(sql, /create policy "kyc no client read" on storage\.objects as restrictive for select to anon, authenticated\s+using \(bucket_id <> 'kyc-documents'\);/);
  assert.match(sql, /create policy "kyc no client change" on storage\.objects as restrictive for update to anon, authenticated/);
  assert.match(sql, /create policy "kyc no client delete" on storage\.objects as restrictive for delete to anon, authenticated/);
  const live = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(live, /create policy "kyc own read"/, 'the undo statement exists only as a comment');
  assert.doesNotMatch(sql, /drop policy[^;]*"kyc own upload"/, 'uploads into the trader\'s own folder stay allowed');
});

test('the site only UPLOADS to the documents bucket (upsert:false needs only the INSERT rule) and never reads from it', () => {
  const files = ['dashboard.html', 'assets/js/checkout-flow.js', 'start-challenge.html', 'admin.html', ...readdirSync(new URL('../assets/js/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => 'assets/js/' + f)];
  const uses = [];
  for (const f of new Set(files)) {
    const text = read(f);
    for (const m of text.matchAll(/storage\.from\(\s*['"]kyc-documents['"]\s*\)\s*\.(\w+)\(([^)]*)\)/g)) uses.push({ f, call: m[1], args: m[2] });
  }
  assert.ok(uses.length >= 2, 'the two upload calls are found');
  for (const u of uses) {
    assert.equal(u.call, 'upload', `${u.f} calls ${u.call} on the identity bucket; only upload is allowed from a browser`);
    assert.match(u.args, /upsert:\s*false/, `${u.f} must not upsert (that would need read and update rules)`);
  }
});

test('the only server code that reads the bucket is the owner-only, audited, 60-second link action', () => {
  const fn = read('supabase/functions/admin-console/index.ts');
  assert.equal((fn.match(/storage\.from\("kyc-documents"\)/g) || []).length, 1);
  assert.match(fn, /storage\.from\("kyc-documents"\)\.createSignedUrl\(doc\.storage_path, 60\)/);
});
