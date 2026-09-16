(function () {
  'use strict';

  const SUPABASE_URL = 'https://agulweemteoeagscmppy.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndWx3ZWVtdGVvZWFnc2NtcHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MzU0ODIsImV4cCI6MjA4MTQxMTQ4Mn0.I70jN5DCuCn8OtISqvTRzuzGFaYd2pV8vviEED6gFlQ';
  const AUTHORIZED_USER_ID = 'f77286ef-8b51-47f3-b6b7-a62f541a4239';
  const BUCKET = 'desktop-releases';
  const RELEASE = 'v0.1.0-preview.1';
  const RELEASES = {
    windows: {
      path: `${RELEASE}/IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.1-win-x64.exe`,
      filename: 'IPFX-Markets-0.1.0-preview.1-Windows-x64.exe',
      label: 'Download Windows preview'
    },
    'mac-arm64': {
      path: `${RELEASE}/IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.1-mac-arm64.dmg`,
      filename: 'IPFX-Markets-0.1.0-preview.1-Apple-Silicon.dmg',
      label: 'Download Apple Silicon preview'
    },
    'mac-x64': {
      path: `${RELEASE}/IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.1-mac-x64.dmg`,
      filename: 'IPFX-Markets-0.1.0-preview.1-Intel-Mac.dmg',
      label: 'Download Intel Mac preview'
    }
  };

  const status = document.getElementById('desktop-access-status');
  const buttons = Array.from(document.querySelectorAll('[data-desktop-download]'));
  const client = window.supabase && window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  function setAvailability(key, message) {
    const node = document.querySelector(`[data-desktop-availability="${key}"]`);
    if (node) node.textContent = message;
  }

  function requireSignIn() {
    status.innerHTML = 'Private preview access requires the authorized IPFX account. <a href="/login.html">Sign in</a>, then return to this page.';
  }

  async function startDownload(key, button) {
    const release = RELEASES[key];
    if (!release) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Preparing secure download…';
    try {
      const { data, error } = await client.storage.from(BUCKET).createSignedUrl(release.path, 60, { download: release.filename });
      if (error || !data || !data.signedUrl) throw error || new Error('Secure URL unavailable');
      window.location.assign(data.signedUrl);
    } catch (_) {
      status.textContent = 'The secure download could not be prepared. Refresh the page and try again.';
    } finally {
      button.textContent = original;
      button.disabled = false;
    }
  }

  async function initialize() {
    if (!client) {
      status.textContent = 'Private downloads are temporarily unavailable.';
      return;
    }

    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user) {
      requireSignIn();
      return;
    }
    if (user.id !== AUTHORIZED_USER_ID) {
      status.textContent = 'This account is not authorized for the private desktop preview.';
      return;
    }

    const { data: objects, error: listError } = await client.storage.from(BUCKET).list(RELEASE, { limit: 20 });
    if (listError) {
      status.textContent = 'Your account is authorized, but release availability could not be checked.';
      return;
    }

    const names = new Set((objects || []).map((item) => item.name));
    let availableCount = 0;
    for (const button of buttons) {
      const key = button.dataset.desktopDownload;
      const release = RELEASES[key];
      const objectName = release.path.slice(RELEASE.length + 1);
      if (!names.has(objectName)) {
        setAvailability(key, 'Private build is still being transferred');
        continue;
      }
      availableCount += 1;
      button.disabled = false;
      button.textContent = release.label;
      setAvailability(key, 'Authorized account only · unsigned preview');
      button.addEventListener('click', () => startDownload(key, button));
    }

    status.textContent = availableCount
      ? 'Private preview access confirmed. Secure links expire after 60 seconds.'
      : 'Private preview access confirmed. Installers are still being transferred.';
  }

  initialize().catch(() => {
    status.textContent = 'Private downloads are temporarily unavailable.';
  });
})();
