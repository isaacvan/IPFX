// Infinity v2 public pages (1 Nov 2026): Terms 2.3, the Infinity page, homepage, application page, chatbot answers and the
// monthly restart notice must all state the same rules, and the v1 clauses must stay in the Terms for runs started earlier.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const terms = read('terms.html'), v23 = read('legal/2026-10-31-v2.3/terms.html');
const infinity = read('infinity.html'), index = read('index.html'), start = read('start-challenge.html');
const kb = JSON.parse(read('supabase/seed/support_kb.json')).kb;
const rules = JSON.parse(read('assets/js/infinity-v2-preview.json'));

test('terms.html is Terms 2.3: Infinity v2 in clause 4.6A, v1 clauses kept for runs started before 1 November', () => {
  assert.equal(terms, v23);
  assert.match(terms, /<span>Version 2\.3<\/span>/);
  assert.match(terms, /<h3>4\.6A Infinity v2 /);
  for (const n of ['4.6A.1', '4.6A.2', '4.6A.3', '4.6A.4', '4.6A.5', '4.6A.6']) assert.match(terms, new RegExp('<h3>' + n.replace('.', '\\.') + ' '));
  assert.match(terms, /Clauses 4\.6\.0 to 4\.6\.6 are the <strong>Infinity v1<\/strong> rules/);
  assert.match(terms, /4\.6\.1 Stage 1 — Evaluation/, 'v1 Stage 1 clause kept');
  assert.match(terms, /60 independent exposure sessions/, 'v1 exposure-session clause kept');
});

test('the Terms 2.3 stage table uses the thresholds saved in the Infinity v2 version row', () => {
  const s = rules.stages;
  assert.equal(s[1].stage_score, 1); assert.equal(s[2].stage_score, 1.65); assert.equal(s[2].combined_score, 2); assert.equal(s[3].combined_score, 2);
  assert.match(terms, /&ge; 1\.0 on Stage 1<\/td><td>&ge; 1\.65 on Stage 2 and &ge; 2\.0 over Stages 1&ndash;2<\/td><td>&ge; 2\.0 over Stages 1&ndash;3/);
  assert.match(terms, /Minimum counted trades in the stage<\/td><td>20<\/td><td>40<\/td><td>50</);
  assert.match(terms, /commission per lot \(round turn\) is charged, currently US\$7\.50/);
});

test('the published document row matches the page served as /legal/2026-10-31-v2.3/terms.html', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(new URL('../legal/2026-10-31-v2.3/terms.html', import.meta.url))).digest('hex');
  const m = read('supabase/migrations/20261031010000_publish_terms_v23_enable_infinity_v2.sql');
  assert.ok(m.includes(sha), 'document hash recorded in the migration');
  assert.match(read('supabase/migrations/20261101190000_legal_terms_v23_current.sql'), /set version='2026-10-31-2\.3' where kind='terms'/);
  assert.match(read('assets/js/checkout-flow.js'), /terms_version: '2026-10-31-2\.3'/);
  assert.match(read('start-challenge.html'), /\/legal\/2026-10-31-v2\.3\/terms\.html/);
  assert.doesNotMatch(read('start-challenge.html'), /2026-10-16-v2\.2/);
});

test('Infinity page, homepage and application page all state the Infinity v2 requirements', () => {
  for (const [name, html] of [['infinity.html', infinity], ['index.html', index]]) {
    assert.match(html, /20 counted trades/, name);
    assert.match(html, /consistency score of 1\.0/, name);
    assert.match(html, /1\.65/, name); assert.match(html, /overall score of 2\.0/, name);
    assert.doesNotMatch(html, /30 independent sessions|60 independent sessions|1\.40% daily profit cap|40%\+ profitable days/, name + ' has no v1 requirements');
  }
  assert.match(infinity, /Infinity v2: the rules below apply to every run started or restarted from 1 November 2026/);
  assert.match(infinity, /Every trader gets one free restart each calendar month, including this month/);
  assert.match(infinity, /I started before 1 November 2026\. Which rules apply to me\?/);
  assert.match(infinity, /at least 8× the current spread/);
  assert.match(start, /<td>Minimum counted trades in the stage<\/td><td>20<\/td><td>40<\/td><td>50<\/td>/);
  assert.match(start, /<td>Consistency score<\/td><td>1\.0<\/td><td>1\.65 this stage and 2\.0 overall<\/td><td>2\.0 overall<\/td>/);
  assert.match(start, /<td>Daily profit cap<\/td><td>None<\/td>/);
  assert.match(start, /<strong>Restarts:<\/strong> one free Stage 1 restart each calendar month, on Infinity v2 from 1 November 2026/);
  assert.doesNotMatch(start, /Minimum exposure sessions|Profitable-day requirement|1\.4% \(\$14\)/);
});

test('chatbot: four Infinity v2 answers exist and every v1 rule answer carries the version note (seed and migration agree)', () => {
  const byId = Object.fromEntries(kb.map((r) => [r.id, r]));
  for (const id of ['infinity-v2-rules', 'infinity-v2-counted-trades', 'infinity-v2-which-rules', 'infinity-v2-restart']) assert.ok(byId[id], id);
  assert.match(byId['infinity-v2-rules'].answer, /\| Counted trades \| 20 \| 40 \| 50 \| none \|/);
  assert.match(byId['infinity-v2-rules'].answer, /\| Consistency score \| 1\.0 \| 1\.65 this stage and 2\.0 overall \| 2\.0 overall \| none \|/);
  assert.match(byId['infinity-v2-restart'].answer, /one free Stage 1 restart each calendar month/);
  const mig = read('supabase/migrations/20261101200000_support_kb_infinity_v2.sql');
  for (const id of ['how-it-works', 'infinity-stage1', 'infinity-stage2', 'infinity-stage3', 'infinity-profit-cap', 'profit-target', 'minimum-days-trades', 'consistency-rules', 'time-limit']) {
    assert.match(byId[id].answer, /\*\*Infinity v2 \(from 1 November 2026\):\*\*/, id + ' seed note');
    assert.ok(mig.includes("$q$" + id + "$q$"), id + ' in migration');
  }
  assert.equal((mig.match(/edited_by_owner is not true/g) || []).length, 5, 'four upserts and the note update never overwrite an owner-edited answer');
});

test('monthly restart notice: only v1 traders with a restart left, dismissible, opens the same agreement dialog', () => {
  const js = read('assets/js/infinity-restart.js');
  assert.match(js, /acct\.rules_version !== 'infinity_v2'/);
  assert.match(js, /left > 0 && !noteDismissed\(\)/);
  assert.match(js, /Keep my run/); assert.match(js, /Restart on v2/);
  assert.match(js, /else \{ note\.hidden = true; open\(\); \}/, 'restart goes through the two-step agree dialog, never directly');
  assert.match(read('trading.html'), /infinity-restart\.js\?v=20261101a/);
});

test('sign-up / pre-register form records the current published Terms and Privacy versions and links the live pages', () => {
  const signup = read('signup.html');
  assert.match(signup, /terms_version: '2026-10-31-2\.3'/);
  assert.match(signup, /privacy_version: '2026-10-09-1\.3'/);
  assert.doesNotMatch(signup, /terms_version: '1\.1'/);
  assert.match(signup, /agree to the <a href="\/terms\.html"[^>]*>Terms &amp; Conditions<\/a> and <a href="\/privacy\.html"/);
  assert.equal(read('terms.html'), v23, 'the page the form links to is Terms 2.3');
});

test('IPFX Markets v2 view: how-it-works guide, limit meters, first-time prompt, all driven by the account rules', () => {
  const ui = read('assets/js/infinity-v2-ui.js');
  assert.match(ui, /How Infinity v2 works/);
  assert.match(ui, /function guideHtml\(a\)/); assert.match(ui, /function metersHtml\(a\)/); assert.doesNotMatch(ui, /guideFirstTime/, 'no second popup: the read-and-tick step is the first-time moment');
  for (const k of ['stop_deadline_seconds', 'stop_spread_multiple', 'sl_strikes_max', 'total_risk_multiple', 'min_hold_seconds', 'stop_pause_seconds', 'group_gap_minutes', 'daily_loss_pct', 'max_drawdown_pct', 'risk_pct', 'target_pct', 'min_counted_trades', 'best_day_share'])
    assert.ok(ui.includes(k), 'guide reads ' + k + ' from the saved rules');
    assert.match(ui, /#iv2Overall\[hidden\]\{display:none\}/, 'the score chip really hides on v1 and demo accounts');
  assert.match(read('trading.html'), /infinity-v2-ui\.js\?v=20261102a/);
  const w=read('assets/js/challenge-warnings.js');assert.match(w,/rules_version==='infinity_v2'/);assert.match(w,/stage-read-iv2:/);assert.match(read('trading.html'), /challenge-warnings\.js\?v=20261101a/);
});

test('restart eligibility: traders who already hold an Infinity run skip identity and KYC in both the engine status and the database restart', () => {
  const eng = read('supabase/functions/trading-engine/index.ts');
  assert.match(eng, /const heldInfinityRun = list\.some\(\(a: \{ challenge_type: string \}\) => a\.challenge_type === "infinity"\);/);
  assert.match(eng, /else if \(!identity && !heldInfinityRun\) reason = "Complete your identity and residential address before starting the challenge\."/);
  assert.match(eng, /!\["pending", "verified"\]\.includes\(String\(kyc\?\.status \?\? ""\)\) && !heldInfinityRun/);
  assert.match(eng, /if \(!identity\) return \{ ok: false, status: 409, error: "Complete your identity and residential address before activating a challenge\."/, 'promo-claim activation (new accounts) is unchanged');
  const m = read('supabase/migrations/20261102010000_infinity_restart_existing_traders_skip_identity.sql');
  assert.match(m, /RESTART_IDENTITY_SOURCE_DRIFT/); assert.match(m, /COMPLETE_IDENTITY_FIRST/); assert.match(m, /COMPLETE_KYC_FIRST/);
});
