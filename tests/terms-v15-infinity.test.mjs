// Terms 1.5: Infinity protections, negotiated Stage 4, held-earnings tick box (owner request 2026-10-08).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const terms = read('terms.html');
const sql = read('supabase/migrations/20261008240000_legal_terms_v15_infinity.sql');
const page = read('start-challenge.html');
const flow = read('assets/js/checkout-flow.js');

test('the new Terms version says what the owner asked for, in plain words', () => {
  assert.match(terms, /<span>Version 1\.5<\/span>/);
  assert.match(terms, /<h3>4\.6\.0 Automatic Promotion and Key Definitions<\/h3>/);
  assert.match(terms, /you move up to the next stage automatically/);
  assert.match(terms, /<strong>Qualifying trade\.<\/strong> A trade closed by you or by your own stop-loss or take-profit, held for at least 60 seconds, that carried a stop-loss within 30 seconds of opening/);
  assert.match(terms, /30 in Stage 1, 60 in Stage 2 and 40 in Stage 3/);
  assert.match(terms, /<strong>Meaningful trading day\.<\/strong> A UTC day on which at least one qualifying trade was opened and closed/);
  assert.match(terms, /<strong>Held earnings can be lost:<\/strong> If you fail Stage 2 or Stage 3 before completing Stage 3, your held Stage 2 earnings are lost/);
  assert.match(terms, /<strong>Automatic detection\.<\/strong> We compare activity across accounts\. Repeated opposite positions[^]*the same person appears on more than one registered identity/);
  assert.match(terms, /<h3>14\.7 Identity documents<\/h3>[^]*expires after 60 seconds[^]*each opening is recorded/);
  assert.match(terms, /<strong>Conflict of interest\.<\/strong> The Company acts as principal in its own trading and may take the opposite side/);
  assert.match(terms, /"UTC day" \/ "server time"/);
});

test('Stage 4 is a negotiated, trust-based allocation and the old wording is gone', () => {
  const s4 = terms.slice(terms.indexOf('<h3>4.6.4 '), terms.indexOf('<h3>4.6.5 '));
  assert.match(s4, /4\.6\.4 Stage 4 — Your Allocation, Agreed With Us/);
  assert.match(s4, /up to \$300,000 or more/);
  assert.match(s4, /Everything can be discussed and agreed in writing/);
  assert.match(s4, /considerably more lenient than Stage 3/);
  assert.match(s4, /No allocation, amount or live account is guaranteed/);
  assert.match(s4, /Stage 4 remains simulated and no Participant trade is copied/);
  assert.doesNotMatch(terms, /subject to separate approval and account setup/);
  assert.doesNotMatch(terms, /applicable in Stage 3 remain in force on Stage 4/);
  assert.doesNotMatch(terms, /exact, mandatory, and non-negotiable\. Breach of any rule at any stage/);
});

test('crypto is gone from the cost clauses', () => {
  const costs = terms.slice(terms.indexOf('7.10 Order Execution'), terms.indexOf('8. Prohibited'));
  assert.doesNotMatch(costs, /cryptocurrenc/i);
  assert.match(terms, /Cryptocurrencies are not offered\./);
});

test('the held-earnings tick box is shown for Infinity, required by the page and enforced by the database', () => {
  assert.match(page, /id="heldEarningsGroup" style="display:none"/);
  assert.match(page, /<input type="checkbox" id="heldEarningsConfirm">/);
  assert.match(page, /my held Stage 2 earnings are lost and are not payable/);
  assert.match(page, /if \(type === 'infinity'\) document\.getElementById\('heldEarningsGroup'\)\.style\.display=''/);
  assert.match(flow, /held_earnings_acknowledged: challengeTypeForSku\(sku\) === 'infinity' \? \$\('heldEarningsConfirm'\)\.checked : null/);
  assert.match(flow, /if \(challengeTypeForSku\(selectedSku\(\)\) === 'infinity'\) consentIds\.push\('heldEarningsConfirm'\)/);
  assert.match(sql, /HELD_EARNINGS_ACK_REQUIRED/);
  assert.match(sql, /p_challenge_type=''infinity'' and coalesce\(\(p_details->>''held_earnings_acknowledged''\)::boolean,false\) is not true/);
  assert.match(sql, /HELD_EARNINGS_SOURCE_DRIFT/);
});

test('earlier Terms versions stay untouched and the new one is the published current version', () => {
  assert.match(sql, /values\('2026-10-08-1\.5','terms','[0-9a-f]{64}','\/legal\/2026-10-08-v1\.5\/terms\.html'\)/);
  assert.match(sql, /update public\.platform_legal_current set version='2026-10-08-1\.5' where kind='terms'/);
  assert.doesNotMatch(sql, /update public\.platform_legal_documents|delete from public\.platform_legal_documents/);
  assert.equal(read('terms.html'), read('legal/2026-10-08-v1.5/terms.html'));
  assert.ok(fs.existsSync(new URL('../legal/2026-10-08-v1.4/terms.html', import.meta.url)));
});
