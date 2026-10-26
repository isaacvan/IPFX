// The team sees each trader's stage boxes (the ones the trader sees on their Challenge tab) when they open the trader.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
const fn = fs.readFileSync(new URL('../supabase/functions/admin-console/index.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../assets/js/ws-traders.js', import.meta.url), 'utf8');
test('admin trader_detail returns stage_requirements per account, read-only and never failing the page', () => {
  assert.match(fn, /async function stageChecklist\(/);
  assert.match(fn, /stage_requirements: stageReqs\[i\]/);
  assert.match(fn, /\.catch\(\(\) => null\)/);
  const body = fn.slice(fn.indexOf('async function stageChecklist('), fn.indexOf('function computeReadiness('));
  assert.doesNotMatch(body, /\.(insert|update|upsert|delete)\(/);
  for (const k of ["Profit they really must reach", 'elapsed observation days', 'meaningful trading days', 'exposure sessions', 'Best positive day', 'closed trades', 'trading days', 'counted profit']) assert.ok(body.includes(k), k);
});
test('the trader drawer shows the boxes and whether all are ticked', () => {
  assert.match(ui, /function stageSection\(/);
  assert.match(ui, /x\.stage_requirements/);
  assert.match(ui, /Can move up/);
});
