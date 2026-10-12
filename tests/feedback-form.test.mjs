// On-site feedback form -> feedback_submissions -> admin inbox. Mirrors the backtest_submissions pattern:
// visitors may only INSERT, the table self-limits size and flooding, only the service role reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('migration locks the table down: visitor insert only, service-role read, flood guard', () => {
  const m = read('supabase/migrations/20261012210000_feedback_submissions.sql');
  assert.match(m, /create table if not exists public\.feedback_submissions/);
  assert.match(m, /category text not null check \(category in \('bug', 'complaint', 'suggestion', 'question', 'praise', 'other'\)\)/);
  assert.match(m, /message text not null check \(char_length\(btrim\(message\)\) between 5 and 5000\)/);
  assert.match(m, /enable row level security/);
  assert.match(m, /revoke all on public\.feedback_submissions from public, anon, authenticated/);
  assert.match(m, /grant insert on public\.feedback_submissions to anon, authenticated/);
  assert.doesNotMatch(m, /grant select[^;]*to (anon|authenticated)/, 'visitors must never be able to read feedback');
  assert.match(m, /for insert to anon, authenticated with check \(true\)/);
  // guard forces status/timestamps and blocks flooding
  assert.match(m, /new\.status := 'new'/);
  assert.match(m, /new\.admin_note := null/);
  assert.match(m, /FEEDBACK_RATE_LIMITED/);
  assert.match(m, />= 8 then/);   // per-email daily cap
  assert.match(m, />= 400 then/); // hourly flood cap
  assert.match(m, /before insert on public\.feedback_submissions for each row execute function public\.feedback_submissions_guard/);
});

test('feedback.html posts the expected fields to the REST endpoint', () => {
  const h = read('feedback.html');
  assert.match(h, /\/rest\/v1\/feedback_submissions/);
  assert.match(h, /'Prefer':'return=minimal'/);
  const body = h.match(/JSON\.stringify\(\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\)/);
  assert.ok(body, 'found the POST body');
  for (const f of ['name', 'email', 'category', 'message', 'page', 'user_agent']) assert.match(body[1], new RegExp('\\b' + f + '\\b'), 'posts ' + f);
  assert.match(h, /FEEDBACK_RATE_LIMITED/, 'handles the rate-limit message');
  assert.doesNotMatch(h, /status:\s*['"]/, 'the page must not try to set status (guard forces it)');
  // no review-gating: the form does not branch to Trustpilot on positive sentiment
  assert.doesNotMatch(h.toLowerCase(), /trustpilot/, 'feedback form must not route to Trustpilot');
});

test('the feedback link is in the site nav and footer', () => {
  const idx = read('index.html');
  assert.match(idx, /<a href="feedback\.html">Send Feedback<\/a>/);
  assert.match(idx, /<a href="\/feedback\.html">Send Feedback<\/a>/);
});

test('admin-console exposes admin-gated feedback_list and feedback_update', () => {
  const a = read('supabase/functions/admin-console/index.ts');
  assert.match(a, /action === "feedback_list"/);
  assert.match(a, /action === "feedback_update"/);
  assert.match(a, /from\("feedback_submissions"\)\.select\("\*"\)/);
  assert.match(a, /from\("feedback_submissions"\)\.update\(patch\)/);
  assert.match(a, /logAdmin\("feedback_update"/);
  // both sit after the admin gate (which returns is_admin:false before any action)
  const gate = a.indexOf('if (!isAdmin) return json({ ok: true, is_admin: false');
  assert.ok(gate > 0 && a.indexOf('action === "feedback_list"') > gate, 'feedback actions are behind the admin gate');
});

test('admin.html renders the feedback inbox', () => {
  const a = read('admin.html');
  assert.match(a, /Feedback inbox/);
  assert.match(a, /async function loadFeedback\(/);
  assert.match(a, /async function feedbackSet\(/);
  assert.match(a, /action:'feedback_list'/);
  assert.match(a, /action:'feedback_update'/);
});
import vm from 'node:vm';
test('feedback source prefills safely without leaking URL tokens or account query strings',()=>{
 const h=read('feedback.html');
 const fn=h.slice(h.indexOf('function prefillFeedbackPage(){'),h.indexOf('\nprefillFeedbackPage();'));
 const cases=[
 {query:'?from=trading',ref:'',expected:'/trading.html'},
 {query:'?from=dashboard',ref:'',expected:'/dashboard.html'},
 {query:'?from=__proto__',ref:'https://ipfxcapital.com/trading.html?token=private&account=private',expected:'/trading.html'},
 {query:'?from=https://other.invalid/private',ref:'https://other.invalid/private',expected:''},
 ];
 for(const c of cases){const field={value:''},ctx=vm.createContext({URL,URLSearchParams,Object,location:{host:'ipfxcapital.com',search:c.query},document:{referrer:c.ref,getElementById:()=>field}});
 vm.runInContext(fn,ctx);ctx.prefillFeedbackPage();assert.equal(field.value,c.expected);}
 const inline=[...h.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter(m=>m[1].trim());
 for(const script of inline)new vm.Script(script[1]);
});
