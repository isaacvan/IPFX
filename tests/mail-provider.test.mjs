// Sending through Amazon SES or Resend, the signed unsubscribe link, and the do-not-email list (owner request 2026-11-11).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { signV4, pickProvider, sendEmail } from '../supabase/functions/_shared/mail-provider.mjs';
import { signUnsubToken, verifyUnsubToken, unsubscribeLinks, blockedBySuppression, isMarketing } from '../supabase/functions/_shared/email-suppression.mjs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('AWS Signature V4 matches the published AWS test vector (get-vanilla)', async () => {
  const h = await signV4({
    method: 'GET', url: 'https://example.amazonaws.com/', service: 'service', region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(h.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('provider choice: SES when the AWS keys exist, otherwise Resend, and EMAIL_PROVIDER can force one', () => {
  const aws = { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', AWS_REGION: 'eu-west-2' };
  assert.equal(pickProvider({ ...aws, RESEND_API_KEY: 'r' }), 'ses');
  assert.equal(pickProvider({ RESEND_API_KEY: 'r' }), 'resend');
  assert.equal(pickProvider({ ...aws, RESEND_API_KEY: 'r', EMAIL_PROVIDER: 'resend' }), 'resend');
  assert.equal(pickProvider({ EMAIL_PROVIDER: 'ses', RESEND_API_KEY: 'r' }), null, 'forced SES without keys sends nothing');
  assert.equal(pickProvider({}), null);
});

test('SES send: signed v2 request with the headers and tags, MessageId returned', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ MessageId: 'abc123' }), { status: 200 }); };
  const r = await sendEmail({ from: 'IPFX Capital <enquiries@ipfxcapital.com>', to: 'a@b.co', subject: 'Hi', html: '<p>x</p>', text: 'x', replyTo: 'enquiries@ipfxcapital.com',
    headers: { 'List-Unsubscribe': '<https://x/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, tags: { template: 'infinity_comeback' } },
  { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 's', AWS_REGION: 'eu-west-2', SES_CONFIGURATION_SET: 'ipfx-events' }, fetchImpl);
  assert.deepEqual([r.ok, r.provider, r.id], [true, 'ses', 'abc123']);
  assert.equal(seen.url, 'https://email.eu-west-2.amazonaws.com/v2/email/outbound-emails');
  assert.match(seen.init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/eu-west-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  const b = JSON.parse(seen.init.body);
  assert.equal(b.ConfigurationSetName, 'ipfx-events');
  assert.deepEqual(b.Destination.ToAddresses, ['a@b.co']);
  assert.deepEqual(b.Content.Simple.Headers.map((h) => h.Name), ['List-Unsubscribe', 'List-Unsubscribe-Post']);
  assert.deepEqual(b.EmailTags, [{ Name: 'template', Value: 'infinity_comeback' }]);
});

test('SES errors: throttling is retryable and says "rate limit"; a rejected address is not', async () => {
  const env = { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', AWS_REGION: 'eu-west-2' };
  const mk = (status, type, message) => async () => new Response(JSON.stringify({ message }), { status, headers: { 'x-amzn-ErrorType': type } });
  const t = await sendEmail({ from: 'f', to: 't', subject: 's', html: 'h' }, env, mk(400, 'TooManyRequestsException', 'Maximum sending rate exceeded.'));
  assert.equal(t.ok, false); assert.equal(t.retryable, true); assert.match(t.error, /rate limit/);
  const bad = await sendEmail({ from: 'f', to: 't', subject: 's', html: 'h' }, env, mk(400, 'MessageRejected', 'Email address is not verified.'));
  assert.equal(bad.retryable, false); assert.doesNotMatch(bad.error, /rate|limit/i);
});

test('Resend send keeps the idempotency key and passes the unsubscribe headers', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ id: 'r1' }), { status: 200 }); };
  const r = await sendEmail({ from: 'f', to: 't@x.co', subject: 's', html: 'h', idempotencyKey: 'email-event-9', headers: { 'List-Unsubscribe': '<u>' } }, { RESEND_API_KEY: 'k' }, fetchImpl);
  assert.deepEqual([r.ok, r.provider, r.id], [true, 'resend', 'r1']);
  assert.equal(seen.init.headers['Idempotency-Key'], 'email-event-9');
  assert.equal(JSON.parse(seen.init.body).headers['List-Unsubscribe'], '<u>');
  const limited = await sendEmail({ from: 'f', to: 't', subject: 's', html: 'h' }, { RESEND_API_KEY: 'k' }, async () => new Response('{}', { status: 429 }));
  assert.equal(limited.retryable, true);
});

test('unsubscribe tokens: the right secret verifies, a forged or edited token does not', async () => {
  const t = await signUnsubToken('Trader@Example.com', 'secret-1');
  assert.equal(await verifyUnsubToken(t, 'secret-1'), 'trader@example.com');
  assert.equal(await verifyUnsubToken(t, 'secret-2'), null);
  const sig = t.split('.')[1];
  const other = btoa('victim@example.com').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  assert.equal(await verifyUnsubToken(other + '.' + sig, 'secret-1'), null, 'a signature cannot be moved to another address');
  assert.equal(await verifyUnsubToken('garbage', 'secret-1'), null);
  const links = await unsubscribeLinks('a@b.co', 'secret-1');
  assert.match(links.page, /^https:\/\/ipfxcapital\.com\/unsubscribe\.html\?t=/);
  assert.match(links.oneClick, /^https:\/\/agulweemteoeagscmppy\.supabase\.co\/functions\/v1\/email-unsubscribe\?t=/);
});

test('do-not-email list: an unsubscribe stops marketing only; a bounce or complaint stops everything', () => {
  assert.equal(isMarketing('infinity_comeback'), true);
  assert.equal(isMarketing('infinity_breach_notice'), false);
  assert.equal(blockedBySuppression('infinity_comeback', 'unsubscribe'), true);
  assert.equal(blockedBySuppression('infinity_breach_notice', 'unsubscribe'), false, 'a trader still gets notices they need');
  assert.equal(blockedBySuppression('infinity_breach_notice', 'bounce'), true);
  assert.equal(blockedBySuppression('infinity_breach_notice', 'complaint'), true);
  assert.equal(blockedBySuppression('infinity_comeback', null), false);
});

test('the outbox checks the list, adds the one-click header, and holds marketing mail until the secret is set', () => {
  const fn = read('supabase/functions/email-outbox/index.ts');
  assert.match(fn, /from\("email_suppressions"\)\.select\("reason"\)\.eq\("email", normEmail\(to\)\)/);
  assert.match(fn, /"List-Unsubscribe-Post": "List-Unsubscribe=One-Click"/);
  assert.match(fn, /unsubSecret \|\| !isMarketing\(r\.template_key\)/);
  assert.match(fn, /Date\.now\(\) - startedAt > 100_000/);
});

test('migration: list table is closed to browsers; come-back footer links the unsubscribe page; outbox runs every 5 minutes', () => {
  const sql = read('supabase/migrations/20261111120000_email_suppressions_and_ses.sql');
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on public\.email_suppressions from anon, authenticated/);
  assert.match(sql, /\{\{unsubscribe_link\}\}/);
  assert.match(sql, /cron\.schedule\('ipfx-email-outbox', '\*\/5 \* \* \* \*'/);
});

test('the SNS endpoint needs the secret and only follows AWS subscription links; the unsubscribe page posts the confirmation', () => {
  const fn = read('supabase/functions/ses-events/index.ts');
  assert.match(fn, /searchParams\.get\("k"\) !== secret/);
  assert.match(fn, /amazonaws\\\.com\$\/\.test\(host\)/);
  assert.match(fn, /bounce\?\.bounceType === "Permanent"/);
  const page = read('unsubscribe.html');
  assert.match(page, /method: 'POST'/);
  assert.match(page, /noindex/);
});
