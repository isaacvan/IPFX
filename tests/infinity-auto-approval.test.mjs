// Infinity applications are approved automatically (owner decision, 11 Nov 2026). Identity documents are checked
// afterwards: the identity check stays "pending" until a person verifies it, a payout still needs a verified
// identity, and rejecting the check stops the account.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { autoApprovalHold, AUTO_APPROVAL_NOTE, IDENTITY_STOP_REASON } from '../supabase/functions/_shared/infinity-auto-approval.mjs';

const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const now = new Date('2026-11-11T12:00:00Z');
const good = { challengeType: 'infinity', kycStatus: 'pending', docTypes: ['id_front'], dateOfBirth: '1995-06-01', now };

test('a normal application is approved straight away', () => {
  assert.equal(autoApprovalHold(good), null);
  assert.equal(autoApprovalHold({ ...good, kycStatus: 'verified', docTypes: ['id_front', 'id_back'] }), null);
  assert.equal(autoApprovalHold({ ...good, dateOfBirth: '2008-11-11' }), null, '18 today');
});

test('applications a machine can tell are wrong still wait for a person', () => {
  assert.equal(autoApprovalHold({ ...good, dateOfBirth: '2008-11-12' }), 'under_18', '18 tomorrow');
  assert.equal(autoApprovalHold({ ...good, dateOfBirth: '2012-01-01' }), 'under_18');
  assert.equal(autoApprovalHold({ ...good, dateOfBirth: null }), 'date_of_birth_missing');
  assert.equal(autoApprovalHold({ ...good, dateOfBirth: '1995-02-30' }), 'date_of_birth_missing', 'not a real date');
  assert.equal(autoApprovalHold({ ...good, dateOfBirth: '1900-01-01' }), 'date_of_birth_implausible');
  assert.equal(autoApprovalHold({ ...good, docTypes: ['id_back'] }), 'no_id_photo');
  assert.equal(autoApprovalHold({ ...good, docTypes: [] }), 'no_id_photo');
  assert.equal(autoApprovalHold({ ...good, kycStatus: 'rejected' }), 'identity_check_not_open');
  assert.equal(autoApprovalHold({ ...good, kycStatus: undefined }), 'identity_check_not_open');
});

test('paid programmes and the off switch keep manual review', () => {
  assert.equal(autoApprovalHold({ ...good, challengeType: 'traditional' }), 'not_infinity');
  assert.equal(autoApprovalHold({ ...good, challengeType: 'pac' }), 'not_infinity');
  assert.equal(autoApprovalHold({ ...good, enabled: false }), 'auto_approval_off');
});

test('the engine approves a pending application, opens the account and sends the ready email', () => {
  const engine = read('supabase/functions/trading-engine/index.ts');
  const claim = engine.slice(engine.indexOf('if (body.action === "claim_infinity")'), engine.indexOf('// Live quote for the order ticket'));
  assert.match(claim, /application\.status === "pending"[\s\S]*autoApproveInfinityApplication\(db, user\.id, application\.id\)/);
  assert.match(claim, /if \(hold\) return new Response\(JSON\.stringify\(\{\s*ok: true, pending_review: true/, 'held applications keep the waiting answer');
  assert.match(claim, /if \(autoApproved\) await sendLifecycleEmail\(db, "infinity_ready", user\.id/);
  assert.ok(claim.indexOf('insertAccountFromPreset') < claim.indexOf('"infinity_ready"'), 'email only after the account exists');
  const fn = engine.slice(engine.indexOf('async function autoApproveInfinityApplication'), engine.indexOf('async function provisionFromPromoClaim'));
  assert.match(fn, /\.eq\("id", applicationId\)\.eq\("status", "pending"\)/, 'never overwrites a decision a person already made');
  assert.match(fn, /decision_note: AUTO_APPROVAL_NOTE, reviewed_by: null/);
  assert.match(fn, /INFINITY_AUTO_APPROVE/);
  assert.doesNotMatch(fn, /from\("trader_kyc"\)\.(update|upsert)/, 'the identity check is NOT marked verified by the machine');
  assert.match(AUTO_APPROVAL_NOTE, /checked after approval/);
});

test('a payout still needs a verified identity', () => {
  const engine = read('supabase/functions/trading-engine/index.ts');
  assert.match(engine, /kyc_not_verified: "Identity verification \(KYC\) must be completed before you can request a payout\."/);
});

test('rejecting the identity check stops the account; verifying gives back only what it stopped', () => {
  const admin = read('supabase/functions/admin-console/index.ts');
  const block = admin.slice(admin.indexOf('if (action === "set_kyc_status")'), admin.indexOf('if (action === "advance_stage")'));
  assert.match(block, /status === "rejected"[\s\S]*access_revoked_reason: IDENTITY_STOP_REASON[\s\S]*\.eq\("is_demo", false\)\.eq\("status", "active"\)\.is\("access_revoked_at", null\)/);
  assert.match(block, /status === "verified"[\s\S]*access_revoked_at: null[\s\S]*\.eq\("access_revoked_reason", IDENTITY_STOP_REASON\)/);
  assert.equal(IDENTITY_STOP_REASON, 'identity_check_rejected');
  const queue = admin.slice(admin.indexOf('if (action === "kyc_queue")'), admin.indexOf('if (action === "chatbot_overview")'));
  assert.match(queue, /already_trading: tradingUsers\.has\(row\.user_id\)/);
  assert.match(read('assets/js/ws-queues.js'), /k\.already_trading \?/);
});

test('the trader sees "ready to trade" straight after applying, and the dashboard retries', () => {
  const flow = read('assets/js/checkout-flow.js');
  assert.match(flow, /call\(\{ action: 'claim_infinity', confirm_age: true \}, 'trading-engine'\)/);
  assert.match(flow, /status === 'pending' && challengeTypeForSku\(selectedSku\(\)\) === 'infinity'[\s\S]*if \(await openInfinityNow\(\)\) showReady\(\); else showReview\(application\)/);
  assert.match(flow, /Congratulations, you are ready to trade/);
  assert.match(flow, /Identity must be verified before any payout/);
  const dash = read('dashboard.html');
  assert.match(dash, /st\.eligible&&!loadInfinityPanel\.claimTried[\s\S]*action:'claim_infinity'/);
  assert.match(read('start-challenge.html'), /checkout-flow\.js\?v=20261111-autoapprove/);
});

test('the ready email exists, has the key rule, and does not claim the identity is verified', () => {
  const sql = read('supabase/migrations/20261111130000_infinity_ready_email.sql');
  assert.match(sql, /'infinity_ready', 'account'/);
  assert.match(sql, /Congratulations, you are ready to trade with IPFX/);
  assert.match(sql, /stop-loss to every trade within 30 seconds/);
  assert.match(sql, /\{\{trading_url\}\}/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /identity is verified|identity has been verified/i);
  assert.match(sql, /must be verified before any payout/);
});
