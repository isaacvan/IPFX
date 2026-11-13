// The IPFX Markets app for iPhone and Android (Capacitor project in mobile/), 13 Nov 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8');

test('the app opens IPFX Markets and carries only trader pages', () => {
  const copy = read('mobile/scripts/copy-web.mjs');
  assert.match(copy, /appId: 'com\.ipfxcapital\.markets'/);
  assert.match(copy, /appName: 'IPFX Markets'/);
  assert.match(copy, /location\.replace\("\/trading\.html\?source=app"\)/);
  assert.match(copy, /url: 'https:\/\/ipfxcapital\.com\/trading\.html\?source=app'/, 'live mode opens the published Markets page');
  const pages = copy.slice(copy.indexOf('const PAGES'), copy.indexOf('const FILES'));
  assert.doesNotMatch(pages, /team-|admin|workspace|test-signup|internal/, 'no team, admin or test pages inside the app');
  for (const p of pages.match(/'[a-z0-9-]+\.html'/g)) assert.ok(fs.existsSync(new URL(p.slice(1, -1), root)), p);
});

test('Android app: internet only, no backups of the signed-in session, keyboard does not cover fields', () => {
  const m = read('mobile/android/app/src/main/AndroidManifest.xml');
  assert.deepEqual(m.match(/uses-permission android:name="[^"]+"/g), ['uses-permission android:name="android.permission.INTERNET"']);
  assert.match(m, /android:allowBackup="false"/);
  assert.match(m, /android:windowSoftInputMode="adjustResize"/);
  assert.match(read('mobile/android/app/src/main/res/values/strings.xml'), /<string name="app_name">IPFX Markets<\/string>/);
});

test('iPhone app: name and the reason shown before the camera or photos open', () => {
  const p = read('mobile/ios/App/App/Info.plist');
  assert.match(p, /<key>CFBundleDisplayName<\/key>\s*<string>IPFX Markets<\/string>/);
  assert.match(p, /<key>NSCameraUsageDescription<\/key>\s*<string>[^<]*ID[^<]*<\/string>/);
  assert.match(p, /<key>NSPhotoLibraryUsageDescription<\/key>/);
});

test('the Android build script leaves the SDK licence to the owner and saves the app to the Desktop', () => {
  const s = read('mobile/build-android-app.ps1');
  assert.match(s, /& \$sdkmanager --sdk_root=\$sdk --licenses\r?\n/, 'licence shown to the owner');
  assert.doesNotMatch(s, /yes \||echo y|'y' \|/i, 'never accepts the licence automatically');
  assert.match(s, /'IPFX-Markets\.apk'/);
});

test('the phone preview is served on the home network only and from the app copy of the pages', () => {
  const s = read('mobile/preview-on-my-phone.ps1');
  assert.match(s, /python -m http\.server \$port --bind \$ip --directory \(Join-Path \$here 'www'\)/);
  assert.doesNotMatch(s, /0\.0\.0\.0|cloudflared|ngrok|localtunnel/);
});

test('the app project is not served on the website and the cloud build only runs when asked', () => {
  assert.match(read('_config.yml'), /\n  - mobile\n/);
  const wf = read('.github/workflows/mobile-android-build.yml');
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /branches:\n\s+- 'mobile\/\*\*'/);
  assert.doesNotMatch(wf, /branches:\n\s+- main/);
  assert.match(read('mobile/.gitignore'), /\*\.keystore/);
});
