// Infinity: Stage 2 target 6%, Stage 3 target 8%, Stage 3 payout 85% of eligible profit capped at $700 (owner decision 2026-10-08).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const targets = read('supabase/migrations/20261008100000_infinity_targets_payout_cap.sql');
const cap = read('supabase/migrations/20261008110000_infinity_cap_700_dynamic_target.sql');

test('targets move to 6% (Stage 2) and 8% (Stage 3) for new stage accounts only', () => {
  assert.match(targets, /update public\.challenge_presets set profit_target_pct = 6 where id = 'infinity_s2' and profit_target_pct = 5;/);
  assert.match(targets, /update public\.challenge_presets set profit_target_pct = 8 where id = 'infinity_s3' and profit_target_pct = 6;/);
  assert.doesNotMatch(targets + cap, /update public\.trading_accounts/, 'existing accounts keep the target they were created with');
});

test('the Stage 3 payout is 85% of profit but never more than $700, and the $500 minimum stays', () => {
  assert.match(cap, /share:=least\(round\(gross\*0\.85,2\),700\);/);
  assert.match(cap, /if share<500 then raise exception 'BELOW_MINIMUM:MINIMUM \$500'/);
  assert.match(cap, /held_share:=case when first_exists then 0 else least\(round\(greatest\(s2_profit,0\)\*0\.85,2\),700\) end/);
  assert.match(cap, /available_share:=least\(round\(\(greatest\(s3_profit,0\)\+case when first_exists then 0 else greatest\(s2_profit,0\) end\)\*0\.85,2\),700\);/);
  assert.match(cap, /'max_payout',700/);
  assert.doesNotMatch(cap, /722/, 'the earlier $722 cap is fully replaced');
});

test('completion follows the account target, not a fixed 6%, in SQL and in the engine', () => {
  assert.match(cap, /s3\.balance < s3\.starting_balance\*\(1\+s3\.profit_target_pct\/100\)/);
  assert.match(cap, /s3\.balance>=s3\.starting_balance\*\(1\+s3\.profit_target_pct\/100\)/);
  assert.doesNotMatch(cap, /starting_balance\*1\.06/);
  assert.match(read('supabase/functions/trading-engine/index.ts'), /starting_balance\) \* \(1 \+ Number\(infinityStage3\.profit_target_pct \?\? 6\) \/ 100\)/);
  for (const g of ['KYC_NOT_VERIFIED', 'STAGE3_COMPLETION_PAYOUT_ALREADY_REQUESTED', 'INVALID_PAYOUT_METHOD']) assert.match(cap, new RegExp(g));
});

test('chatbot answers state 8% via the preset placeholder and the $700 cap', () => {
  assert.match(cap, /'reaching \*\*\{\{p:infinity_s3\.target_pct\}\} closed profit\*\*'/);
  assert.match(cap, /maximum of \$700/);
  assert.match(cap, /\$700 maximum Stage 3 payout \(85% of eligible profit\)/);
  assert.match(read('supabase/seed/support_kb.json'), /reaching \*\*\{\{p:infinity_s3\.target_pct\}\} closed profit\*\*/);
  assert.doesNotMatch(read('supabase/seed/support_kb.json'), /reaching \*\*5% closed profit\*\*/);
});

test('public pages show Stage 2 = 6%, Stage 3 = 8% and the $700 maximum, with no stale Infinity numbers', () => {
  const inf = read('infinity.html'), idx = read('index.html'), terms = read('terms.html'), dash = read('dashboard.html');
  assert.match(inf, /<p>6% target\. 15 trading days and 60 exposure sessions\./);
  assert.match(inf, /<p>8% target\. Stage 2 earnings remain visible but held\./);
  assert.match(inf, /Reach 6% while completing at least 21 elapsed calendar days/);
  assert.match(inf, /data-field="target">\$300 \(6%\)<\/span>/);
  assert.match(inf, /Complete the <strong>8% \(\$800\) target<\/strong>/);
  assert.match(inf, /data-field="target_rev">8% \(\$800\)<\/span>/);
  assert.match(inf, /maximum of <strong>\$700<\/strong>/);
  assert.match(inf, /full 8% Stage 3 target[^<]*up to a maximum of \$700/);
  assert.match(idx, /stage-subtitle">6% target\. Min 15 trading days/);
  assert.match(idx, /stage-subtitle">8% target\. Stage 2 earnings stay visible but held\.[^<]*maximum of \$700/);
  assert.match(terms, /Profit Target:<\/strong> 6% net profit \(\$300\)/);
  assert.match(terms, /Full Profit Target:<\/strong> 8% net profit \(\$800\)/);
  assert.match(terms, /up to a maximum of US\$700/);
  assert.match(terms, /capped at US\$700/);
  assert.match(dash, /Complete the full 8% target and published rules/);
  const infinityTerms = terms.slice(terms.indexOf('4.6.2'), terms.indexOf('4.7 Traditional Challenge'));
  assert.ok(infinityTerms.length > 1000, 'found the Infinity section of the Terms (the Traditional table legitimately has 6% ($600) as its max loss)');
  for (const [name, html] of [['infinity.html', inf], ['index.html', idx], ['terms.html (Infinity section)', infinityTerms], ['dashboard.html', dash]]) {
    assert.doesNotMatch(html, /\$250 \(5%\)|6% \(\$600\)|6% net profit \(\$600\)|5% net profit \(\$250\)|full 6% Stage 3 target|full 6% target/, name + ' still shows the old Infinity numbers');
  }
});

// The page hides the whole pathway when the live presets differ from what it expects. Run the real guard script.
import vm from 'node:vm';
function runGuard(presets) {
  const html = read('infinity.html');
  const start = html.indexOf("document.addEventListener('ipfx:presets', function(event) {");
  assert.ok(start > 0, 'guard script exists');
  const end = html.indexOf('</script>', start);
  const style = (id) => ({ id, style: { display: 'initial' } });
  const els = { infinityRulesSyncWarning: style('w'), 'how-it-works': style('h'), infinityRulesSection: style('s') };
  let handler;
  const document = { addEventListener: (n, f) => { handler = f; }, getElementById: (id) => els[id] };
  vm.runInNewContext(html.slice(start, end), { document, Number });
  handler({ detail: presets });
  return els;
}
const live = { infinity_s1: { profit_target_pct: '4.00' }, infinity_s2: { profit_target_pct: '6.00', min_profitable_days_pct: '40.00' }, infinity_s3: { profit_target_pct: '8.00' } };

test('page guard accepts the live 6% / 8% presets: pathway shown, warning hidden', () => {
  const e = runGuard(live);
  assert.equal(e.infinityRulesSyncWarning.style.display, 'none');
  assert.equal(e['how-it-works'].style.display, '');
  assert.equal(e.infinityRulesSection.style.display, '');
});

test('page guard still hides the pathway if the live presets ever differ from the published page', () => {
  const old = { ...live, infinity_s2: { ...live.infinity_s2, profit_target_pct: '5.00' }, infinity_s3: { profit_target_pct: '6.00' } };
  const e = runGuard(old);
  assert.equal(e.infinityRulesSyncWarning.style.display, 'block');
  assert.equal(e['how-it-works'].style.display, 'none');
});
