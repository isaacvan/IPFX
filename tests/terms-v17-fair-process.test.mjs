// Terms 1.7: fair process in Section 8, Infinity payout carve-out and Stage 4 payout defaults (owner request 2026-10-09).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const terms = read('terms.html');
const sql = read('supabase/migrations/20261008260000_legal_terms_v17.sql');

test('Section 8 no longer contradicts Section 12', () => {
  assert.match(terms, /<span>Version 1\.7<\/span>/);
  const s8 = terms.slice(terms.indexOf('Prohibited Trading Practices</h2>'), terms.indexOf('8.1 Arbitrage'));
  assert.doesNotMatch(s8, /closed immediately|no obligation to notify|strictly prohibited/);
  assert.match(s8, /we follow Section 12: we give you the reason and a chance to respond, and a person reviews the evidence/);
  assert.match(s8, /subject to your statutory rights/);
  assert.match(terms, /where the law, an active investigation or a regulator's request prevents it, without notifying the Participant or giving reasons/);
});

test('Infinity payouts are carved out of the generic payout rules and Stage 4 has stated defaults', () => {
  const s10 = terms.slice(terms.indexOf('10.2 Conditions for Payment'), terms.indexOf('10.3 Discretionary Nature'));
  assert.match(s10, /<strong>Infinity\.<\/strong> For the Infinity Stage 3 payout, clause 4\.6 applies in place of the seven-day wait and the single-trade consistency check/);
  assert.match(s10, /every 14 days, subject to the US\$500 minimum, with no first-payout profit threshold/);
  assert.match(terms, /We may also recover an amount paid in error, or one later shown to derive from a Prohibited Practice/);
  assert.match(terms, /This clause does not apply to the Infinity Challenge, which has no entry fee\./);
});

test('Terms 1.7 is published as a new immutable version and is the version the form records', () => {
  assert.match(sql, /values\('2026-10-08-1\.7','terms','[0-9a-f]{64}','\/legal\/2026-10-08-v1\.7\/terms\.html'\)/);
  assert.match(sql, /update public\.platform_legal_current set version='2026-10-08-1\.7' where kind='terms'/);
  assert.equal(terms, read('legal/2026-10-08-v1.7/terms.html'));
  assert.match(read('assets/js/checkout-flow.js'), /terms_version: '2026-10-08-1\.7'/);
  assert.match(read('start-challenge.html'), /\/legal\/2026-10-08-v1\.7\/terms\.html/);
});
