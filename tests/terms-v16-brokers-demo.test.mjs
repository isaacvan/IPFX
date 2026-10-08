// Terms 1.6 / Privacy 1.2: demo and simulated copies, and what order data goes to brokers (owner request 2026-10-08).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const terms = read('terms.html');
const privacy = read('privacy.html');
const sql = read('supabase/migrations/20261008250000_legal_terms_v16_privacy_v12.sql');

test('Terms 11.3 covers demo, practice and simulated copies and says what is sent to brokers', () => {
  assert.match(terms, /<span>Version 1\.6<\/span>/);
  const s = terms.slice(terms.indexOf('11.3 Use of Trading Data'), terms.indexOf('11.4 Participant Warranties'));
  assert.match(s, /<strong>Demo, practice and simulated copies\.<\/strong> The Company may also copy your orders onto demo or practice accounts that it operates, including accounts with third-party brokers, and may simulate your trades internally using recorded market prices/);
  assert.match(s, /reverse or mirror your trades, scale them to a different account size/);
  assert.match(s, /it is not your result, it does not change your Challenge outcome or payout eligibility, and it gives you no claim to any profit/);
  assert.match(s, /instrument, direction, size, price, stop-loss, take-profit and timing/);
  assert.match(s, /We do not send them your name, contact details or identity documents/);
  assert.ok(s.indexOf('Demo, practice and simulated copies') < s.indexOf('Conflict of interest'));
});

test('the Privacy Policy lists brokers and liquidity providers as recipients of order data, never identity documents', () => {
  assert.match(privacy, /<span>Version 1\.2<\/span>/);
  const s = privacy.slice(privacy.indexOf('id="sharing"'), privacy.indexOf('id="cookies"'));
  assert.match(s, /<td>Brokers and liquidity providers<\/td>/);
  assert.match(s, /order data: instrument, direction, size, price, stop-loss, take-profit and timing/);
  assert.match(s, /We do not send them your name, contact details or identity documents/);
  assert.match(privacy, /and brokers or liquidity providers that receive order data\) may process data outside the United Kingdom/);
});

test('new versions are published as immutable records and the form records them', () => {
  assert.match(sql, /\('2026-10-08-1\.6','terms','[0-9a-f]{64}','\/legal\/2026-10-08-v1\.6\/terms\.html'\)/);
  assert.match(sql, /\('2026-10-08-1\.2','privacy','[0-9a-f]{64}','\/legal\/2026-10-08-v1\.2\/privacy\.html'\)/);
  assert.match(sql, /update public\.platform_legal_current set version='2026-10-08-1\.6' where kind='terms'/);
  assert.match(sql, /update public\.platform_legal_current set version='2026-10-08-1\.2' where kind='privacy'/);
  assert.doesNotMatch(sql, /delete from public\.platform_legal_documents|update public\.platform_legal_documents/);
  assert.equal(terms, read('legal/2026-10-08-v1.6/terms.html'));
  assert.equal(privacy, read('legal/2026-10-08-v1.2/privacy.html'));
  const flow = read('assets/js/checkout-flow.js');
  assert.match(flow, /privacy_notice_version: '2026-10-08-1\.2'/);
  assert.match(flow, /terms_version: '2026-10-08-1\.6'/);
  const page = read('start-challenge.html');
  assert.match(page, /\/legal\/2026-10-08-v1\.6\/terms\.html/);
  assert.match(page, /\/legal\/2026-10-08-v1\.2\/privacy\.html/);
  assert.doesNotMatch(page, /legal\/2026-10-08\/privacy\.html|2026-10-08-v1\.5\/terms/);
});
