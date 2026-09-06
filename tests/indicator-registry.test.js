#!/usr/bin/env node
// ============================================================
// IPFX Markets — indicator registry test
//
// Runs trading.html's actual inline <script> code inside a sandboxed VM
// with the DOM stubbed out, then asserts on the real runtime objects
// (INDS, SETUP_IND_MAP) rather than a hand-copied re-parse of the source.
// This is the parameterised registry test called for in the trading
// terminal upgrade spec: it exists to make sure a bug like "the catalog
// entry labelled ADX actually points at the DM (Directional Movement
// Index / DMI) study" can never silently ship again.
//
// No dependencies, no build step (this repo has neither) — run with:
//   node tests/indicator-registry.test.js
// Exits non-zero on any failed assertion, so it's CI-friendly as-is.
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_PATH = path.join(__dirname, '..', 'trading.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// ---- pull every inline <script> block (skip <script src=...> tags) ----
const scriptBlocks = [];
const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html))) {
  const attrs = m[1] || '';
  if (/\bsrc=/.test(attrs)) continue; // external script, nothing to run
  scriptBlocks.push(m[2]);
}
if (!scriptBlocks.length) {
  console.error('FAIL: found no inline <script> blocks in trading.html — did the file move or change structure?');
  process.exit(1);
}
let code = scriptBlocks.join('\n;\n');
// Node's vm module does NOT attach top-level const/let bindings to the
// context object (only var and function declarations, and plain
// assignments, become context properties) — found by actually running
// this, not by reasoning about it in advance. Without this trailer,
// `sandbox.INDS`/`sandbox.SETUP_IND_MAP` are always undefined even
// though the script runs with no error, which silently made every
// assertion below vacuously fail. Plain assignment onto `this` at
// top-level script scope (non-strict, non-module) targets the context
// global and can still see the const bindings via the shared lexical
// scope from this same concatenated script.
code += `
;this.INDS = (typeof INDS !== 'undefined') ? INDS : undefined;
this.SETUP_IND_MAP = (typeof SETUP_IND_MAP !== 'undefined') ? SETUP_IND_MAP : undefined;
`;

// ---- minimal DOM/browser stub sufficient to survive far enough to
// define INDS / SETUP_IND_MAP, which are declared early in the file.
// It is expected (and fine) for execution to eventually throw once it
// reaches code this stub can't fully emulate — whatever was already
// assigned on the sandbox object survives past that point. ----
function fakeEl() {
  const listeners = {};
  const el = {
    style: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach(x => this._set.add(x)); },
      remove(...c) { c.forEach(x => this._set.delete(x)); },
      toggle(c, f) { if (f === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (f) this._set.add(c); else this._set.delete(c); return this._set.has(c); },
      contains(c) { return this._set.has(c); },
    },
    dataset: {},
    attributes: {},
    children: [],
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    focus() {}, blur() {}, click() {}, remove() {},
    get textContent() { return this._text || ''; },
    set textContent(v) { this._text = v; },
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) { this._html = v; },
    get value() { return this._value || ''; },
    set value(v) { this._value = v; },
  };
  return el;
}
const fakeDoc = {
  getElementById: () => fakeEl(),
  querySelector: () => fakeEl(),
  querySelectorAll: () => [],
  createElement: () => fakeEl(),
  addEventListener: () => {},
  body: fakeEl(),
  head: fakeEl(),
  documentElement: fakeEl(),
  title: '',
};
const store = new Map();
const sandbox = {
  console,
  document: fakeDoc,
  window: undefined, // filled in below to self-reference
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  location: { search: '', href: 'http://localhost/trading.html', hostname: 'localhost' },
  navigator: { userAgent: 'node-test' },
  URLSearchParams,
  performance: { now: () => Date.now() },
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: () => {},
  setInterval: () => 0,
  setTimeout,
  clearInterval: () => {},
  clearTimeout,
  fetch: () => Promise.reject(new Error('network disabled in test sandbox')),
  addEventListener: () => {},
  removeEventListener: () => {},
  alert: () => {},
  confirm: () => false,
  prompt: () => null,
  TradingView: undefined,
  Image: function () {},
  matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
};
sandbox.window = sandbox;
vm.createContext(sandbox);

try {
  new vm.Script(code, { filename: 'trading.html (inline scripts)' }).runInContext(sandbox, { timeout: 5000 });
} catch (e) {
  // Expected: the script does a LOT more than define the indicator
  // registry, and this stub doesn't emulate all of it. As long as INDS
  // and SETUP_IND_MAP got assigned before the throw, we can still test
  // them below. If they didn't, the assertions after this block fail
  // loudly with a clear reason rather than silently passing on nothing.
  console.log('(sandbox run stopped early at: ' + e.message + ' — expected, continuing with whatever was defined)');
}

// ---- assertions ----
let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('FAIL: ' + msg); }
  else console.log('ok:   ' + msg);
}

const INDS = sandbox.INDS;
check(Array.isArray(INDS) && INDS.length > 0, 'INDS registry is defined and non-empty');

if (Array.isArray(INDS)) {
  const idPattern = /^[A-Za-z0-9]+@tv-basicstudies$/;
  const seenIds = new Set(), seenNames = new Set();
  for (const ind of INDS) {
    const label = `${ind.name || '?'} (${ind.id || 'no id'})`;
    check(typeof ind.cat === 'string' && ind.cat.length > 0, `${label}: has a category`);
    check(typeof ind.id === 'string' && idPattern.test(ind.id), `${label}: id looks like a real tv-basicstudies identifier`);
    check(typeof ind.name === 'string' && ind.name.length > 0, `${label}: has a short display name`);
    check(typeof ind.full === 'string' && ind.full.length > 0, `${label}: has a full display name`);
    check(typeof ind.brief === 'string' && ind.brief.length > 0, `${label}: has a one-line brief`);
    check(typeof ind.explain === 'string' && ind.explain.length > 20, `${label}: has a real explanation`);
    check(!seenIds.has(ind.id), `${label}: id is not a duplicate within the registry`);
    check(!seenNames.has(ind.name), `${label}: display name is not a duplicate within the registry`);
    seenIds.add(ind.id); seenNames.add(ind.name);
  }

  // Regression pin for the specific reported bug: selecting "ADX" must
  // resolve to the real single-line ADX study, never the DMI bundle.
  const adx = INDS.find(i => i.name === 'ADX');
  check(!!adx && adx.id === 'ADX@tv-basicstudies', 'ADX catalog entry points at ADX@tv-basicstudies, not DM@tv-basicstudies');
  check(!adx || !/directional movement/i.test(adx.full || ''), 'ADX catalog entry is not mislabeled as Directional Movement Index');

  const dmi = INDS.find(i => i.id === 'DM@tv-basicstudies');
  check(!!dmi && dmi.name === 'DMI', 'DMI (Directional Movement Index, the real DM@tv-basicstudies study) is separately offered and correctly labelled');
}

const SETUP_IND_MAP = sandbox.SETUP_IND_MAP;
check(SETUP_IND_MAP && typeof SETUP_IND_MAP === 'object', 'SETUP_IND_MAP (the "Match My Trading Setup" keyword → indicator map) is defined');
if (SETUP_IND_MAP && Array.isArray(INDS)) {
  const validIds = new Set(INDS.map(i => i.id));
  for (const [keyword, ids] of Object.entries(SETUP_IND_MAP)) {
    for (const id of ids) {
      check(validIds.has(id), `SETUP_IND_MAP['${keyword}'] → '${id}' resolves to a real catalog entry`);
    }
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing assertion(s).`);
process.exit(failures === 0 ? 0 : 1);
