import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { K, index } from './support-fixture.mjs';
import { KB_CASES, GUARD_CASES, OFF_TOPIC } from './support-cases.mjs';
import {
  route, expandTemplate, fixedReplies, fallbackText, redact, containsPii, structuredAnswer, buildDigest, rulesText,
} from '../supabase/functions/_shared/support-chat-core.js';

const EMAIL = K.cfg.contact_email;
const ask = (q, ctx = null) => route(q, ctx, K, index);
const kbId = (r) => (r.kind === 'kb' ? r.hits[0].e.id : r.kind);
const render = (r) => {
  if (r.kind === 'facts') return r.st.text;
  if (r.kind === 'kb') return expandTemplate(r.hits[0].e.answer, K);
  if (r.kind === 'guard' || r.kind === 'smalltalk') return fixedReplies(EMAIL)[r.cls];
  if (r.kind === 'advice') return expandTemplate(K.kb.find((e) => e.id === 'financial-advice').answer, K);
  return fallbackText(K, EMAIL);
};

// ---- 1. Questions a visitor might really type -> the entry that should answer them
for (const [q, expected] of KB_CASES) {
  test(`kb: "${q}"`, () => {
    const r = ask(q);
    const want = Array.isArray(expected) ? expected : [expected];
    // account-flavoured questions ("my payout is delayed") answer with policy + a "can't see your account" note
    const got = r.kind === 'kb' ? r.hits[0].e.id : r.kind === 'personal' && r.ok ? r.hits[0].e.id : r.kind === 'facts' ? 'facts' : r.kind;
    assert.ok(want.includes(got), `expected ${want.join('|')} but got ${got}${r.kind === 'kb' ? '' : ' (' + (r.hits?.[0]?.e?.id ?? '-') + ')'}`);
  });
}

// ---- 2. Rule lookups must be answered from challenge_presets, exactly
const byId = Object.fromEntries(K.presets.map((p) => [p.id, p]));
const money = (n) => '$' + Number(n).toLocaleString('en-US');
test('facts: drawdown on 50k traditional matches the preset', () => {
  const p = byId.trad_50k_p1;
  const r = ask('what is the drawdown on the 50k traditional challenge');
  assert.equal(r.kind, 'facts');
  assert.match(r.st.text, new RegExp(`${Number(p.max_drawdown_pct)}%`));
  assert.ok(r.st.text.includes(money(p.starting_balance * p.max_drawdown_pct / 100)), r.st.text);
});
test('facts: fee lookups are exact for every paid size', () => {
  for (const [prefix, word] of [['trad', 'traditional'], ['fut', 'futures']]) {
    for (const p of K.presets.filter((x) => x.id.startsWith(prefix + '_') && x.id.endsWith('_p1'))) {
      const k = p.starting_balance / 1000;
      const r = ask(`how much is the ${k}k ${word} challenge`);
      assert.equal(r.kind, 'facts', `${word} ${k}k`);
      assert.ok(r.st.text.includes(money(p.fee_usd)), `${word} ${k}k -> ${r.st.text}`);
    }
  }
});
test('facts: infinity stage lookups match', () => {
  for (const s of [1, 2, 3]) {
    const p = byId[`infinity_s${s}`];
    const r = ask(`what is the profit target for infinity stage ${s}`);
    assert.equal(r.kind, 'facts');
    assert.ok(r.st.text.includes(`${Number(p.profit_target_pct)}%`), r.st.text);
    assert.ok(r.st.text.includes(money(p.starting_balance * p.profit_target_pct / 100)), r.st.text);
  }
});
test('facts: an impossible size is corrected, not invented', () => {
  const r = ask('what is the fee for the 500k traditional challenge');
  assert.notEqual(r.kind, 'guard');
  assert.ok(!/\$\d+ one-off/.test(r.kind === 'facts' ? r.st.text : ''), 'must not invent a fee');
});
test('facts: follow-up keeps programme context', () => {
  const first = ask('what is the daily loss limit on the 25k traditional challenge');
  assert.equal(first.kind, 'facts');
  const second = ask('what about the 100k', first.ctx);
  assert.equal(second.kind, 'facts');
  assert.match(second.st.text, /\$100K/);
  assert.match(second.st.text, /daily loss/i);
});
test('facts: traditional answers report the enforced 3 phases and stop-loss/risk rule', () => {
  const text = expandTemplate('{{rules:traditional}}', K);
  assert.match(text, /3 phases/);
  assert.match(text, /stop-loss required/);
  assert.match(text, /risk ≤ 0\.75%/);
  assert.match(text, /risk ≤ 0\.5%/);
  assert.match(text, /risk ≤ 0\.4%/);
});
test('rules generated for every programme are non-empty', () => {
  for (const t of ['infinity', 'traditional', 'futures', 'pac']) assert.ok(rulesText(K, t).length > 30, t);
});

// ---- 3. Safety: things the bot must refuse or must not answer from knowledge
for (const [q, cls] of GUARD_CASES) {
  test(`guard(${cls}): "${q}"`, () => {
    const r = ask(q);
    assert.equal(r.cls, cls, `got kind=${r.kind} cls=${r.cls}`);
  });
}

// ---- 4. Out-of-scope questions must NOT be answered from an unrelated entry
for (const q of OFF_TOPIC) {
  test(`off-topic falls back: "${q}"`, () => {
    const r = ask(q);
    assert.ok(['fallback', 'guard', 'smalltalk'].includes(r.kind), `answered off-topic question from ${r.hits?.[0]?.e?.id}`);
  });
}
test('unknown IPFX-specific questions fall back to the support email', () => {
  for (const q of ['do you sponsor youtubers', 'what is the ipfx stock ticker', 'do you have an office in dubai']) {
    const r = ask(q);
    assert.ok(r.kind === 'fallback' || r.kind === 'kb', q);
    if (r.kind === 'fallback') assert.ok(fallbackText(K, EMAIL).includes(EMAIL));
  }
});

// ---- 5. Every knowledge entry must render cleanly and stay private
test('every KB answer expands with no leftover tokens or blanks', () => {
  for (const e of K.kb) {
    const text = expandTemplate(e.answer, K);
    assert.ok(!/\{\{|\}\}/.test(text), `${e.id} has unresolved token`);
    const withoutValidMoney = text.replace(/\$\d[\d,.]*/g, 'USD');
    assert.ok(!/\$\s*(\.|,|\)|$)|\(\s*\)|\bundefined\b|\bNaN\b|\bnull\b/i.test(withoutValidMoney), `${e.id} looks broken: ${text.slice(0, 200)}`);
    assert.ok(text.length > 20, e.id);
  }
});
test('no knowledge entry leaks internal or private details', () => {
  const forbidden = [/paulade/i, /service[_ -]?role/i, /anon[_ ]key/i, /trader-detector/i, /cron[_ ]secret/i, /IPFX_OWNER/i, /sk_live|sk_test|eyJ[a-zA-Z0-9]{20}/, /password\s*[:=]/i, /agulweemteoeagscmppy/i];
  for (const e of K.kb) for (const re of forbidden) {
    assert.ok(!re.test(e.title + ' ' + e.answer + ' ' + e.keywords.join(' ')), `${e.id} matches ${re}`);
  }
  for (const [k, v] of Object.entries(K.cfg)) for (const re of forbidden) assert.ok(!re.test(v), `config ${k}`);
});
test('the only email address in knowledge is the public support email', () => {
  const blob = JSON.stringify(K.kb) + JSON.stringify(K.cfg);
  const emails = new Set((blob.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map((s) => s.toLowerCase()));
  assert.deepEqual([...emails], [EMAIL.toLowerCase()]);
});
test('the support email in config matches the address published in the Terms', () => {
  const terms = fs.readFileSync(new URL('../terms.html', import.meta.url), 'utf8');
  assert.ok(terms.includes(EMAIL), 'Terms must publish the same support address the bot gives out');
});
test('knowledge ids are unique and every follow-up chip is a sensible question', () => {
  const ids = K.kb.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const e of K.kb) for (const f of e.follow_ups) assert.ok(f.length > 8 && f.length < 70, `${e.id}: ${f}`);
});
test('digest for the model is generated from live presets and stays small', () => {
  const d = buildDigest(K);
  assert.ok(d.includes('Infinity') && d.includes('Traditional') && d.includes('Futures') && d.includes('PAC'));
  assert.ok(d.length < 6000, `digest too large: ${d.length}`);
});

// ---- 6. PII handling
test('redaction removes emails and long numbers but keeps normal text', () => {
  assert.equal(redact('mail me a@b.co now'), 'mail me [email] now');
  assert.ok(!/4111/.test(redact('card 4111 1111 1111 1111')));
  assert.equal(redact('is the 25k account 100 200 250 ok'), 'is the 25k account 100 200 250 ok');
});
test('normal numeric questions are not mistaken for personal data', () => {
  for (const q of ['compare 25k 50k 100k 200k fees', 'is $100,000 the max', 'what about 10 20 30 percent', 'stage 2 needs 10 days and 20 trades']) {
    assert.equal(containsPii(q), false, q);
  }
});
