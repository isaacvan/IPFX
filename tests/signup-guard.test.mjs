// Sign-up abuse guard (Terms 3.4): Supabase Auth "before user created" hook + Cloudflare Turnstile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('signup-guard verifies the hook signature, checks Turnstile first, then the per-IP limit', () => {
  const fn = read('supabase/functions/signup-guard/index.ts');
  assert.match(fn, /new Webhook\(hookSecret\.replace\("v1,whsec_", ""\)\)\.verify\(raw, Object\.fromEntries\(req\.headers\)\)/);
  assert.match(fn, /challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/);
  assert.match(fn, /ALLOWED_HOSTS = new Set\(\["ipfxcapital\.com", "www\.ipfxcapital\.com"\]\)/);
  assert.ok(fn.indexOf('TURNSTILE_SECRET_KEY') < fn.indexOf('signup_guard_check'), 'bot check must run before the IP allowance is used');
  assert.match(fn, /db\.rpc\("signup_guard_check"/);
  // Rejections use the documented hook error shape; the email is stored only as a hash.
  assert.match(fn, /json\(\{ error: \{ http_code: code, message \} \}, 400\)/);
  assert.match(fn, /email_hash: emailHash/);
  assert.doesNotMatch(fn, /insert\(\{[^}]*\bemail: /);
});

test('the per-IP check is atomic and private', () => {
  const sql = read('supabase/migrations/20261003090000_signup_guard.sql');
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('signup_guard:' \|\| p_ip\)\)/);
  assert.match(sql, /alter table public\.signup_guard_log enable row level security/);
  assert.match(sql, /revoke all on public\.signup_guard_log from public, anon, authenticated/);
  assert.match(sql, /revoke all on function public\.signup_guard_check\(text, text, int, int\) from public, anon, authenticated/);
  assert.match(sql, /interval '30 days'/);
});

test('signup page sends the Turnstile token only when a site key is configured', () => {
  const page = read('signup.html');
  assert.match(page, /const TURNSTILE_SITE_KEY = '[^']*';/);
  assert.match(page, /if \(TURNSTILE_SITE_KEY\) \{/);
  assert.match(page, /captcha_token: tsToken \|\| null/);
  assert.match(page, /if \(TURNSTILE_SITE_KEY && !tsToken\) \{/);
  assert.match(page, /resetTurnstile\(\);/);
  // Never ship a Turnstile secret in a public page.
  assert.doesNotMatch(page, /0x4AAAA[A-Za-z0-9_-]{20,}.*secret/i);
});
