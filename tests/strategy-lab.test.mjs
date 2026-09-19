import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const migration=read('supabase/migrations/20260919023000_strategy_lab_and_tradesyncer_handoff.sql');
const trading=read('trading.html');
const analytics=read('trader-analytics.html');
const admin=read('supabase/functions/admin-console/index.ts');

test('strategy lab is isolated, explainable, daily, and never places trades',()=>{
  assert.match(migration,/create table if not exists public\.trader_strategy_hypotheses/i);
  assert.match(migration,/evidence jsonb/i);
  assert.match(migration,/contradictions jsonb/i);
  assert.match(migration,/v_closed < 8 then continue/i);
  assert.match(migration,/ipfx-strategy-lab-daily/i);
  assert.match(migration,/10 0 \* \* \*/);
  assert.doesNotMatch(migration,/insert\s+into\s+public\.trades\b/i);
  assert.match(migration,/revoke all on function private\.run_strategy_lab_daily/i);
});

test('chart evidence contains configuration only and is owned by the signed-in trader',()=>{
  assert.match(migration,/own indicator evidence insert/i);
  assert.match(migration,/user_id = \(select auth\.uid\(\)\)/i);
  assert.match(trading,/chart_indicator_events/);
  assert.match(trading,/selectedStudies=new Set\(inds\)/);
  assert.doesNotMatch(trading,/chart_indicator_events[\s\S]{0,600}(screenshot|image_data|base64)/i);
});

test('employee view exposes hypotheses and paper comparisons without claiming proof',()=>{
  assert.match(admin,/strategy_hypotheses/);
  assert.match(admin,/paper_plans/);
  assert.match(analytics,/Research hypothesis, not proof/);
  assert.match(analytics,/demo-only paper plans/);
  assert.match(analytics,/never places a live trade/);
});

test('TradeSyncer button launches only the app and leaks no selected trader context',()=>{
  assert.match(analytics,/Connect to TradeSyncer/);
  assert.match(analytics,/tradesyncer:\/\/open/);
  assert.doesNotMatch(analytics,/tradesyncer:\/\/open[^'"\s]*(account|user|token|handoff)/i);
});

