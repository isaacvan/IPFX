const test = require('node:test');
const assert = require('node:assert/strict');
const release = require('../builder.cjs');
const preview = require('../builder.preview.cjs');

test('public release requires signing and Mac notarization', () => {
  assert.equal(release.forceCodeSigning, true);
  assert.equal(release.mac.hardenedRuntime, true);
  assert.equal(release.mac.notarize, true);
  assert.equal(release.publish, null);
});

test('preview artifact is visibly unsigned and never automatically published', () => {
  assert.match(preview.artifactName, /UNSIGNED-PREVIEW/);
  assert.equal(preview.forceCodeSigning, false);
  assert.equal(preview.publish, null);
});

test('packaging excludes application secrets and disables privileged Electron entrypoints', () => {
  assert.deepEqual(release.files, ['main.cjs','policy.cjs','offline.html','build/icon.png','package.json']);
  assert.equal(release.electronFuses.runAsNode, false);
  assert.equal(release.electronFuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(release.electronFuses.enableNodeCliInspectArguments, false);
  assert.equal(release.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(release.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(release.electronFuses.grantFileProtocolExtraPrivileges, false);
});
