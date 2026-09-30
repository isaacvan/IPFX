import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../assets/js/desktop-downloads.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../downloads.html', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../supabase/migrations/20260930223000_desktop_preview_registered_downloads.sql', import.meta.url), 'utf8');

async function loadPage(user) {
  const keys = ['windows', 'mac-arm64', 'mac-x64'];
  const buttons = keys.map((key) => ({
    dataset: { desktopDownload: key },
    disabled: true,
    textContent: 'Private preview unavailable',
    addEventListener(_event, handler) { this.click = handler; },
  }));
  const availability = Object.fromEntries(keys.map((key) => [key, { textContent: '' }]));
  const status = { textContent: '', innerHTML: '' };
  const navigations = [];
  const client = {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    storage: { from: () => ({
      list: async () => ({ data: keys.map((key) => ({
        name: `IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.3-${key === 'windows' ? 'win-x64.exe' : key === 'mac-arm64' ? 'mac-arm64.dmg' : 'mac-x64.dmg'}.manifest.json`,
      })), error: null }),
    }) },
  };
  runInNewContext(script, {
    document: {
      getElementById: () => status,
      querySelectorAll: () => buttons,
      querySelector: (selector) => availability[selector.match(/="([^"]+)"/)[1]],
    },
    window: {
      supabase: { createClient: () => client },
      location: { assign: (path) => navigations.push(path) },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { buttons, status, navigations };
}

test('anonymous visitors get an actionable sign-in button', async () => {
  const { buttons, status, navigations } = await loadPage(null);
  assert.match(status.textContent, /Sign in/);
  assert.ok(buttons.every((button) => !button.disabled && button.textContent === 'Sign in to download'));
  buttons[0].click();
  assert.equal(navigations[0], '/login.html?next=%2Fdownloads.html');
});

test('a signed-in non-owner sees all three preview downloads', async () => {
  const { buttons, status } = await loadPage({ id: 'non-owner-ipfx-user' });
  assert.ok(buttons.every((button) => !button.disabled && button.textContent.startsWith('Download ')));
  assert.match(status.textContent, /Signed-in access confirmed/);
});

test('preview stays private to signed-in accounts and is clearly labelled', () => {
  assert.match(policy, /for select to authenticated/);
  assert.match(policy, /bucket_id = 'desktop-releases'/);
  assert.match(page, /unsigned preview/);
  assert.match(script, /UNSIGNED-PREVIEW-0\.1\.0-preview\.3-Windows-x64\.exe/);
});
