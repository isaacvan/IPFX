import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHoldout, evidenceHash, type ValidationManifest, type HoldoutPrediction } from '../lib/detector-validation.ts';

function fixture() {
  const target = 'Positive net destination profit after every execution cost over the next thirty calendar days, with no contractual or live-risk breach.';
  const ids = Array.from({length:100}, (_,i)=>`trader-${String(i).padStart(3,'0')}`);
  const manifest: ValidationManifest = {
    schemaVersion:1, challengeType:'traditional', modelSha256:'a'.repeat(64),
    targetDefinition:target,targetSha256:evidenceHash(target),
    policyFrozenAt:'2026-01-10T00:00:00Z',trainingCutoffAt:'2026-01-01T00:00:00Z',
    evaluationStartAt:'2026-02-01T00:00:00Z',evaluationEndAt:'2026-03-01T00:00:00Z',asOfAt:'2026-04-02T00:00:00Z',
    horizonDays:30,embargoDays:14,trainedTraderIds:['training-only'],baselineProbability:0.5,
    alertThreshold:0.75,minMatureTraders:30,minAlertTraders:20,minPrecisionLower95:0.6,maxEce:0.1,minCoverage:0.9,
    eligibleTraderIds:ids,cohortSha256:evidenceHash(ids),
  };
  const rows: HoldoutPrediction[] = ids.map((id,i)=>({predictionId:`forecast-${i}`,traderId:id,
    challengeType:manifest.challengeType,modelSha256:manifest.modelSha256,targetSha256:manifest.targetSha256,
    predictedAt:'2026-02-01T00:00:00Z',featureAsOfAt:'2026-01-31T23:59:00Z',
    outcomeStartAt:'2026-02-01T00:00:00Z',outcomeEndAt:'2026-03-03T00:00:00Z',outcomeObservedAt:'2026-03-04T00:00:00Z',
    probability:i<50?0.8:0.2,abstentionReason:null,outcome:(i<40 || i>=50&&i<60)?1:0}));
  return {manifest,rows};
}

test('frozen held-out probabilities can pass research checks without authorizing production',()=>{
  const {manifest,rows}=fixture(); const result=evaluateHoldout(manifest,rows);
  assert.equal(result.status,'RESEARCH_GATES_PASSED_REVIEW_REQUIRED');
  assert.equal(result.policyPromotionAllowed,false);
  assert.ok(Math.abs(result.metrics.brier!-0.16)<1e-9);
  assert.equal(result.metrics.precision,0.8);
  assert.ok(result.metrics.precisionWilson95![0]<0.8);
});
test('winner-only exports, reused traders and feature lookahead are rejected',()=>{
  const {manifest,rows}=fixture();
  assert.throws(()=>evaluateHoldout(manifest,rows.slice(0,40)),/COHORT_INCOMPLETE/);
  assert.throws(()=>evaluateHoldout({...manifest,trainedTraderIds:[rows[0].traderId]},rows),/TRADER_LEAKAGE/);
  assert.throws(()=>evaluateHoldout(manifest,rows.map((r,i)=>i? r:{...r,featureAsOfAt:'2026-02-02T00:00:00Z'})),/FEATURE_LOOKAHEAD/);
  assert.throws(()=>evaluateHoldout(manifest,[rows[0],...rows.slice(0,99)]),/ONE_PREDECLARED/);
});
test('abstentions and missing mature labels stay in the denominator',()=>{
  const {manifest,rows}=fixture();
  const result=evaluateHoldout(manifest,rows.map((r,i)=>i<20?{...r,probability:null,abstentionReason:'missing evidence'}:i===99?{...r,outcome:null,outcomeObservedAt:null}:r));
  assert.ok(result.blockers.includes('LOW_FORECAST_COVERAGE'));
  assert.ok(result.blockers.includes('MATURE_OUTCOMES_MISSING'));
  assert.equal(result.cohort.eligible,100); assert.equal(result.cohort.abstentions,20);
});
test('confident but wrong predictions fail scoring and calibration checks',()=>{
  const {manifest,rows}=fixture();
  const result=evaluateHoldout(manifest,rows.map(r=>({...r,probability:r.outcome?0.01:0.99})));
  assert.ok(result.blockers.includes('BRIER_NOT_BETTER_THAN_FROZEN_BASELINE'));
  assert.ok(result.blockers.includes('CALIBRATION_ERROR_TOO_HIGH'));
  assert.ok(result.blockers.includes('ALERT_PRECISION_LOWER_BOUND_TOO_LOW'));
});
test('ending evaluation early cannot make an incomplete prospective window pass',()=>{
  const {manifest,rows}=fixture();
  assert.ok(evaluateHoldout({...manifest,asOfAt:'2026-03-05T00:00:00Z'},rows).blockers.includes('EVALUATION_WINDOW_NOT_FULLY_MATURE'));
});
test('unknown outcomes, wrong horizon, changed target and nonfinite scores are rejected',()=>{
  const {manifest,rows}=fixture();
  assert.throws(()=>evaluateHoldout({...manifest,targetDefinition:manifest.targetDefinition+' changed'},rows),/TARGET_HASH/);
  assert.throws(()=>evaluateHoldout(manifest,rows.map((r,i)=>i?r:{...r,outcomeEndAt:'2026-03-04T00:00:00Z'})),/INCONSISTENT_FUTURE_HORIZON/);
  assert.throws(()=>evaluateHoldout(manifest,rows.map((r,i)=>i?r:{...r,probability:NaN})),/INVALID_PROBABILITY/);
  assert.throws(()=>evaluateHoldout(manifest,rows.map((r,i)=>i?r:{...r,outcomeObservedAt:'2026-02-02T00:00:00Z'})),/UNMATURED/);
});
