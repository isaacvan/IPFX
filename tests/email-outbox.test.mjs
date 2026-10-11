// Email outbox: delivers queued lifecycle emails in daily batches inside the provider's free limit (owner request 2026-10-11).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fn = read('supabase/functions/email-outbox/index.ts');
const sql = read('supabase/migrations/20261011200000_email_outbox.sql');
const sched = read('supabase/migrations/20261011201000_email_outbox_schedule.sql');

test('the outbox only delivers rows the platform already queued, inside a daily and per-run cap', () => {
  assert.match(fn, /const DAILY_CAP = Number\(Deno\.env\.get\("EMAIL_DAILY_CAP"\) \?\? "80"\)/);
  assert.match(fn, /const PER_RUN = Number\(Deno\.env\.get\("EMAIL_PER_RUN"\) \?\? "10"\)/);
  assert.match(fn, /\.from\("email_events"\)[\s\S]*\.in\("template_key", TEMPLATES\)/);
  assert.doesNotMatch(fn, /\.insert\(/, 'the outbox never creates emails');
  assert.match(fn, /let budget = Math\.min\(PER_RUN, DAILY_CAP - \(sentToday \?\? 0\)\);/);
});

test('nothing goes to traders until the owner switches the outbox live; owner tests go first', () => {
  assert.match(fn, /const live = Deno\.env\.get\("EMAIL_OUTBOX_LIVE"\) === "1";/);
  assert.match(fn, /\.filter\(\(r: any\) => live \|\| r\.payload\?\.test === true\)/);
});

test('each email is claimed before sending, carries an idempotency key, and stops on a provider rate limit', () => {
  assert.match(fn, /update\(\{ status: "sending" \}\)\s*\.eq\("id", row\.id\)\.eq\("status", row\.status\)/);
  assert.match(fn, /"Idempotency-Key": `email-event-\$\{row\.id\}`/);
  assert.match(fn, /if \(res\.status === 429\) break;/);
  assert.match(sql, /array\['queued', 'sending', 'sent', 'failed', 'skipped'\]/);
  assert.match(sql, /status = 'sending' and sent_at is null and created_at < now\(\) - interval '30 minutes'/);
});

test('approval emails are skipped for traders whose Infinity account is no longer active', () => {
  assert.match(fn, /\.eq\("challenge_type", "infinity"\)\.eq\("status", "active"\)\.is\("access_revoked_at", null\)/);
  assert.match(fn, /error_message: "Infinity account no longer active"/);
});

test('the sender and reply address default to the real enquiries mailbox', () => {
  assert.match(fn, /IPFX Capital <enquiries@ipfxcapital\.com>/);
  assert.match(fn, /reply_to: Deno\.env\.get\("SUPPORT_EMAIL"\) \?\? "enquiries@ipfxcapital\.com"/);
  assert.match(sched, /cron\.schedule\('ipfx-email-outbox', '7 \* \* \* \*'/);
});
