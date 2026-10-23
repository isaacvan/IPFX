// Queues > Applications > Pending: an "Approve all" button for applications that have BOTH the front and back ID photo.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const src = fs.readFileSync(new URL('../assets/js/ws-queues.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../workspace/queues.html', import.meta.url), 'utf8');

const a = src.indexOf('  const hasBothIds'), b = src.indexOf('  async function approveAll');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(src.slice(a, b) + '\nglobalThis.api = { hasBothIds, isPep, canBulkApprove, approveRun };', ctx);
const api = ctx.api;
const doc = (t) => ({ id: t + '-id', doc_type: t });
const app = (docs, kyc = 'pending', details = {}) => ({ id: Math.random().toString(36).slice(2), documents: docs.map(doc), kyc: { status: kyc }, application_details: details });

test('only applications with BOTH the front and back ID photo are included', () => {
  assert.equal(api.canBulkApprove(app(['id_front', 'id_back'])), true);
  assert.equal(api.canBulkApprove(app(['id_front', 'id_back', 'selfie', 'proof_of_address'])), true);
  assert.equal(api.canBulkApprove(app(['id_front'])), false, 'front only');
  assert.equal(api.canBulkApprove(app(['id_back'])), false, 'back only');
  assert.equal(api.canBulkApprove(app(['selfie', 'proof_of_address'])), false, 'no ID photos');
  assert.equal(api.canBulkApprove(app(['passport'])), false, 'a passport alone is not front and back');
  assert.equal(api.canBulkApprove({ id: 'x', kyc: { status: 'pending' } }), false, 'no documents list at all');
});

test('rejected or missing identity checks and PEP applicants are left for a person to review', () => {
  assert.equal(api.canBulkApprove(app(['id_front', 'id_back'], 'verified')), true);
  assert.equal(api.canBulkApprove(app(['id_front', 'id_back'], 'rejected')), false);
  assert.equal(api.canBulkApprove(app(['id_front', 'id_back'], 'unverified')), false);
  assert.equal(api.canBulkApprove(app(['id_front', 'id_back'], 'pending', { pep: true })), false);
  assert.equal(api.canBulkApprove(app(['id_front', 'id_back'], 'pending', { pep: false })), true);
});

test('approveRun decides one at a time, reports progress, and one failure does not stop the rest', async () => {
  const list = [app(['id_front', 'id_back']), app(['id_front', 'id_back']), app(['id_front', 'id_back'])];
  const seen = [], steps = [];
  const out = await api.approveRun(list, async (x) => { seen.push(x.id); if (x === list[1]) throw new Error('Could not issue account'); }, (i, n) => steps.push([i, n]));
  assert.deepEqual(seen, list.map((x) => x.id));
  assert.deepEqual(steps, [[1, 3], [2, 3], [3, 3]]);
  assert.equal(out.approved, 2); assert.equal(out.failed, 1); assert.equal(out.firstError, 'Could not issue account');
});

test('the button sits top right of the pending list, loads every page, and uses the normal approve action', () => {
  assert.match(src, /data-act="appAll"/);
  assert.match(src, /appStatus === 'pending' && \(bulkN > 0 \|\| r\.has_more\)/, 'only on the Pending tab');
  assert.match(src, /<span style="margin-left:auto" class="row">\$\{appStatus === 'pending'[^\n]*data-act="appPrev"/, 'right-aligned, before Previous and Next');
  assert.match(src, /while \(more && page < 40\) \{ const r = await T\.admin\('application_queue', \{ status: 'pending', page \}\)/, 'every page, not just the visible one');
  assert.match(src, /T\.admin\('application_decide', \{ application_id: a\.id, status: 'approved' \}\)/);
  assert.match(src, /case 'appAll': approveAll\(\); break;/);
  assert.match(src, /T\.sheet\(\{\s*title: `Approve \$\{ok\.length\}/, 'always asks first, with the exact count');
  assert.match(page, /ws-queues\.js\?v=20261023-approveall/, 'cache-busted so the button shows up');
});
