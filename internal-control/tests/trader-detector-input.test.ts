import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalEvidence, isFreshEvidence, readAllPages, requiredNumber, tradeStage, verifiedRuleSnapshot, verifyRiskEvidence, resolveAccountLineage, verifyCopyEvidence } from '../../supabase/functions/_shared/trader-detector-input.ts';

test('missing numeric data is never converted to measured zero', () => {
  for (const value of [null, undefined, '', '  ', false, NaN, Infinity, [], {}, '0x20']) assert.throws(() => requiredNumber(value, 'x'));
  assert.equal(requiredNumber(0, 'x'), 0);
  assert.equal(requiredNumber('-3.2', 'x'), -3.2);
});

test('stage attribution is point in time and never borrows the current account stage', () => {
  const snapshots = [{ effective_at: '2026-01-01', rules: { stage: 1 } }, { effective_at: '2026-02-01', rules: { stage: 2 } }];
  assert.equal(tradeStage({ opened_at: '2026-01-10' }, snapshots), 1);
  assert.equal(tradeStage({ opened_at: '2025-12-10' }, snapshots), 0);
  assert.equal(tradeStage({ opened_at: '2026-01-10', detector_stage: 3 }, snapshots), 0);
  assert.equal(tradeStage({ opened_at: 'invalid', detector_stage: 1 }, snapshots), 0);
});

test('stale, missing and future copy evidence fails freshness', () => {
  const now = Date.parse('2026-01-10T12:00:00Z');
  assert.equal(isFreshEvidence('2026-01-10T11:00:00Z', now, 86400000), true);
  for (const value of [null, '', '2026-01-11', '2026-01-08']) assert.equal(isFreshEvidence(value, now, 86400000), false);
});

test('pagination keeps reading short server pages until empty', async () => {
  const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const result = await readAllPages(async (after) => ({ data: all.filter((row) => after === null || row.id > after).slice(0, 1), error: null }));
  assert.deepEqual(result, all);
  await assert.rejects(readAllPages(async () => ({ data: [{ id: 'a' }], error: null })), /NOT_ADVANCING/);
  await assert.rejects(readAllPages(async (after) => ({ data: all.filter((row) => after === null || row.id > after), error: null }), 2), /LIMIT_EXCEEDED/);
});

test('canonical evidence detects changed trades despite unchanged aggregate profit', () => {
  for (const value of [NaN, Infinity, new Date(), { value: undefined }, () => 1]) assert.throws(() => canonicalEvidence(value));
  assert.equal(canonicalEvidence({ b: 2, a: 1 }), canonicalEvidence({ a: 1, b: 2 }));
  assert.notEqual(canonicalEvidence([{ id: 'a', pnl: 1 }, { id: 'b', pnl: 2 }]), canonicalEvidence([{ id: 'a', pnl: 2 }, { id: 'b', pnl: 1 }]));
});

test('rule verification requires typed contract content and the correct account', () => {
  const trade = { opened_at: '2026-01-10', detector_stage: 1 };
  const row = { trading_account_id: 'a', effective_at: '2026-01-01', config_version_id: 'config',
    anchor_mode: 'MIDNIGHT_UTC', loss_measure: 'EQUITY', day_anchor_amount: 1000,
    max_daily_loss_fraction: 0.02, max_total_loss_fraction: 0.04,
    rules: { stage: 1, challenge_type: 'futures', drawdown_mode: 'trailing_eod', starting_balance: 1000 } };
  const binding = { accountId: 'a', challengeType: 'futures' };
  assert.equal(verifiedRuleSnapshot(trade, [row], binding), row);
  for (const changed of [{ ...row, rules: {} }, { ...row, trading_account_id: 'other' },
    { ...row, max_daily_loss_fraction: null }, { ...row, rules: { ...row.rules, stage: 2 } }]) {
    assert.equal(verifiedRuleSnapshot(trade, [changed], binding), null);
  }
  assert.equal(verifiedRuleSnapshot(trade, [row, { ...row }], binding), null);
});

test('risk evidence requires fresh reconciled audit of the identical decision inputs', () => {
  const binding = { accountId: 'a', policyId: 'p', inputSha256: 'a'.repeat(64), now: Date.parse('2026-01-10T12:00:00Z'), maxAgeMs: 3600000 };
  const row = { trading_account_id: 'a', policy_id: 'p', input_sha256: binding.inputSha256,
    audit_sha256: 'b'.repeat(64), verified_by: 'reviewer', as_of_at: '2026-01-10T11:59:00Z', source_cutoff_at: '2026-01-10T11:58:00Z',
    expires_at: '2026-01-10T12:30:00Z', rule_snapshot_id: 'r', evidence_reference: 'audit:r',
    reconciled: true, complete_history: true, open_positions_marked: true, cash_flows_reconciled: true, rule_breach: false,
    equity: 1000, daily_floor: 980, total_floor: 960, stressed_open_loss: 10 };
  assert.equal(verifyRiskEvidence(row, binding), true);
  for (const changed of [{ ...row, trading_account_id: 'b' }, { ...row, policy_id: 'old' },
    { ...row, input_sha256: 'c'.repeat(64) }, { ...row, open_positions_marked: false },
    { ...row, source_cutoff_at: '2026-01-11T11:58:00Z' }, { ...row, stressed_open_loss: 20 },
    { ...row, equity: null }, { ...row, rule_breach: true }, { ...row, complete_history: 'true' },
    { ...row, expires_at: '2026-01-10T12:00:00Z' }, { ...row, evidence_reference: '' }]) {
    assert.equal(verifyRiskEvidence(changed, binding), false);
  }
});

test('lineage joins only passed provisioned stages and rejects unrelated attempts', () => {
  const parent = { id: 'p', user_id: 'u', challenge_type: 'infinity', stage: 1, status: 'passed', funded_from_account_id: null };
  const child = { ...parent, id: 'c', stage: 2, status: 'active', funded_from_account_id: 'p' };
  assert.deepEqual(resolveAccountLineage(child, [parent, child]), [parent, child]);
  for (const invalid of [{ ...parent, user_id: 'v' }, { ...parent, challenge_type: 'pac' },
    { ...parent, status: 'breached' }, { ...parent, stage: 2 }]) {
    assert.throws(() => resolveAccountLineage(child, [invalid, child]), /LINEAGE/);
  }
  assert.throws(() => resolveAccountLineage(child, [child]), /MISSING_PARENT/);
  assert.throws(() => resolveAccountLineage(child, [parent, parent, child]), /DUPLICATE/);
  assert.deepEqual(resolveAccountLineage(parent, [parent, { ...parent, id: 'unrelated' }]), [parent]);
});

test('funding at the same stage preserves lineage without inventing another phase',()=>{
  const parent={id:'p',user_id:'u',challenge_type:'traditional',stage:3,status:'passed',phase:'evaluation',funded_from_account_id:null};
  const child={...parent,id:'c',status:'active',phase:'funded',funded_from_account_id:'p'};
  assert.deepEqual(resolveAccountLineage(child,[parent,child]),[parent,child]);
  assert.throws(()=>resolveAccountLineage({...child,phase:'evaluation'},[parent,child]),/NONINCREASING/);
});

test('copy review rejects cumulative PnL alone, unmatched cohorts and changed inputs',()=>{
  const binding={accountId:'a',policyId:'p',inputSha256:'a'.repeat(64),now:Date.parse('2026-01-10T12:00:00Z'),maxAgeMs:300000};
  const row={trading_account_id:'a',as_of_at:'2026-01-10T11:59:00Z',source_net_pnl:1000,destination_net_pnl:990,
    provenance:{policy_id:'p',input_sha256:binding.inputSha256,audit_sha256:'b'.repeat(64),verified_by:'reviewer',
      source_cutoff_at:'2026-01-09T12:00:00Z',expires_at:'2026-01-10T12:03:00Z',matched_ideas_complete:true,risk_normalised:true,
      provider_permission_reference:'permission:v1',reserve_review_reference:'reserve:v1',net_edge_lower90_bps:2}};
  assert.equal(verifyCopyEvidence(row,binding),true);
  assert.equal(verifyCopyEvidence({...row,provenance:{}},binding),false);
  for(const changed of [{matched_ideas_complete:false},{risk_normalised:false},{net_edge_lower90_bps:0},
    {input_sha256:'c'.repeat(64)},{expires_at:'2026-01-09T12:00:00Z'}]) {
    assert.equal(verifyCopyEvidence({...row,provenance:{...row.provenance,...changed}},binding),false);
  }
});
