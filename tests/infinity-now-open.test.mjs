// Infinity is open: public copy, pre-registration only for the programmes that are not open, approval email (owner request 2026-10-09).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the home page says Infinity is open and points to the application, not to pre-registration', () => {
  const home = read('index.html');
  assert.match(home, /<div class="hero-badge">\s*Infinity Challenge is now open\s*<\/div>/);
  assert.doesNotMatch(home, /Infinity Challenge opens 9 October 2026|Infinity launches 9 October/);
  assert.match(home, /<a href="start-challenge\.html\?type=infinity" class="values-cta">Start the Infinity Challenge →<\/a>/);
  assert.doesNotMatch(home, /Pre-Register Free/);
  assert.doesNotMatch(home, /disabled aria-disabled="true">On Hold<\/button>/);
  const trad = home.slice(home.indexOf('id="tab-traditional"'), home.indexOf('id="tab-futures"'));
  const fut = home.slice(home.indexOf('id="tab-futures"'), home.indexOf('id="tab-futures"') + 9000);
  assert.equal((trad.match(/href="signup\.html\?interest=traditional"/g) || []).length, 4);
  assert.equal((fut.match(/href="signup\.html\?interest=futures"/g) || []).length, 4);
});

test('Futures, Personalised and the application page offer pre-registration, never Infinity', () => {
  assert.match(read('futures.html'), /The Infinity Challenge is now open\. Futures applications and payments are not open yet: <a href="signup\.html\?interest=futures"/);
  assert.doesNotMatch(read('futures.html'), />On Hold<\/span>/);
  assert.match(read('personalised-challenge.html'), /<a href="signup\.html\?interest=pac"/);
  const start = read('start-challenge.html');
  assert.match(start, /innerHTML = 'Not open<br>yet'/);
  assert.match(start, /signup\.html\?interest=' \+ encodeURIComponent\(programme\)/);
  assert.doesNotMatch(start, /apply from 9 October 2026/);
});

test('the sign-up page is a normal sign-up for Infinity and pre-registration only for the other programmes', () => {
  const s = read('signup.html');
  assert.match(s, /id="signupBadge">Infinity Challenge is now open<\/div>/);
  assert.doesNotMatch(s, /Pre-register for Infinity|Infinity launches 9 October/);
  assert.match(s, /traditional: 'the Traditional Challenge', futures: 'the Futures Challenge', pac: 'the Personalised Application Challenge'/);
  assert.match(s, /Object\.prototype\.hasOwnProperty\.call\(interestNames/);
  assert.match(s, /'Pre-register for ' \+ interestNames\[interest\]/);
  assert.match(s, /interest: interest,/);
  assert.match(s, /\(interest \|\| beforeInfinityLaunch\) \? 'Pre-register free' : 'Create Account'/);
});

test('the dashboard tells an approved Infinity trader that the account is ready and links to IPFX Markets', () => {
  const d = read('dashboard.html');
  assert.match(d, /a\.challenge_type==='infinity'\?'<strong style="color:#34d399">Approved\. Your Infinity Challenge account is ready\.<\/strong> <a href="\/trading\.html"/);
  assert.match(d, /Application approved\. Your challenge has not started/); // still used by the other programmes
});

test('approving an Infinity application issues the account and sends the approval email', () => {
  const a = read('supabase/functions/admin-console/index.ts');
  const block = a.slice(a.indexOf('trading_account_id: accountId, updated_at'), a.indexOf('if (accountId && status === "denied")'));
  assert.match(block, /await sendLifecycleEmail\(db, "infinity_approved", current\.user_id, \{/);
  assert.match(block, /trading_url: "https:\/\/ipfxcapital\.com\/trading\.html"/);
  const sql = read('supabase/migrations/20261009010000_infinity_approved_email.sql');
  assert.match(sql, /'infinity_approved', 'account'/);
  assert.match(sql, /Your Infinity Challenge has been approved\. Start trading now/);
  for (const v of ['{{customer_name}}', '{{trading_url}}', '{{dashboard_url}}']) assert.ok(sql.includes(v), v);
  assert.match(sql, /on conflict \(key\) do nothing/);
  const life = read('supabase/functions/_shared/lifecycle-email.ts');
  assert.match(life, /never throws|Never throws/);
});

test('a single choice (Infinity) is already selected so Continue is never greyed out', () => {
  const flow = read('assets/js/checkout-flow.js');
  assert.match(flow, /const onlyChoice = document\.querySelectorAll\('\.tier-card'\);\s+if \(onlyChoice\.length === 1\) onlyChoice\[0\]\.click\(\);/);
  // the selection handler that this click triggers is the one that enables Continue
  assert.ok(flow.indexOf("$('step1Next').disabled = false;") < flow.indexOf('const onlyChoice'));
});

test('United States residents can select their country on the application form; only sanctioned countries are disabled', () => {
  const start = read('start-challenge.html');
  assert.match(start, /const restricted = new Set\(\['CU','IR','KP','SY'\]\);/);
  assert.match(start, /if\(id==='country'&&restricted\.has\(code\)\)\{option\.disabled=true;/);
  assert.doesNotMatch(start, /code==='US'/);
  assert.match(start, /\['US','United States'\]/);
  assert.match(read('signup.html'), /RESTRICTED_COUNTRIES = \{ CU: 'Cuba', IR: 'Iran', KP: 'North Korea', SY: 'Syria' \}/);
});
