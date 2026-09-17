(function () {
  'use strict';

  const SUPABASE_URL = 'https://agulweemteoeagscmppy.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndWx3ZWVtdGVvZWFnc2NtcHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MzU0ODIsImV4cCI6MjA4MTQxMTQ4Mn0.I70jN5DCuCn8OtISqvTRzuzGFaYd2pV8vviEED6gFlQ';
  const AUTHORIZED_USER_ID = 'f77286ef-8b51-47f3-b6b7-a62f541a4239';
  const BUCKET = 'desktop-releases';
  const RELEASE = 'v0.1.0-preview.2';
  const MAX_PARTS = 16;
  const MAX_PART_BYTES = 42 * 1024 * 1024;
  const RELEASES = {
    windows: {
      sourceName: 'IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.2-win-x64.exe',
      filename: 'IPFX-Markets-0.1.0-preview.2-Windows-x64.exe',
      contentType: 'application/vnd.microsoft.portable-executable',
      label: 'Download Windows preview'
    },
    'mac-arm64': {
      sourceName: 'IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.2-mac-arm64.dmg',
      filename: 'IPFX-Markets-0.1.0-preview.2-Apple-Silicon.dmg',
      contentType: 'application/x-apple-diskimage',
      label: 'Download Apple Silicon preview'
    },
    'mac-x64': {
      sourceName: 'IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.2-mac-x64.dmg',
      filename: 'IPFX-Markets-0.1.0-preview.2-Intel-Mac.dmg',
      contentType: 'application/x-apple-diskimage',
      label: 'Download Intel Mac preview'
    }
  };

  for (const release of Object.values(RELEASES)) {
    release.manifestPath = `${RELEASE}/${release.sourceName}.manifest.json`;
  }

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

  function validateManifest(manifest, release) {
    if (!manifest || manifest.version !== 1 || manifest.filename !== release.sourceName) throw new Error('Invalid release manifest');
    if (!Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size > 512 * 1024 * 1024) throw new Error('Invalid release size');
    if (!Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.length > MAX_PARTS) throw new Error('Invalid release parts');
    const escaped = release.sourceName.replace(/[.*+?^\$\{\}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${RELEASE}/${escaped}\\.part-\\d{4}-of-\\d{4}$`);
    let size = 0;
    for (const part of manifest.parts) {
      if (!part || typeof part.path !== 'string' || !pattern.test(part.path)) throw new Error('Invalid release part path');
      if (!Number.isSafeInteger(part.size) || part.size <= 0 || part.size > MAX_PART_BYTES) throw new Error('Invalid release part size');
      size += part.size;
    }
    if (size !== manifest.size) throw new Error('Release size mismatch');
    return manifest;
  }

  async function requireAuthorizedUser() {
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user || user.id !== AUTHORIZED_USER_ID) throw new Error('Owner session required');
  }

  async function startDownload(key, button) {
    const release = RELEASES[key];
    if (!release) return;
    button.disabled = true;
    const original = button.textContent;
    try {
      await requireAuthorizedUser();
      button.textContent = 'Preparing private download…';
      const { data: manifestBlob, error: manifestError } = await client.storage.from(BUCKET).download(release.manifestPath);
      if (manifestError || !manifestBlob) throw manifestError || new Error('Release manifest unavailable');
      const manifest = validateManifest(JSON.parse(await manifestBlob.text()), release);
      const chunks = [];
      for (let index = 0; index < manifest.parts.length; index += 1) {
        button.textContent = `Downloading ${index + 1} of ${manifest.parts.length}…`;
        const part = manifest.parts[index];
        const { data: chunk, error } = await client.storage.from(BUCKET).download(part.path);
        if (error || !chunk) throw error || new Error('Release chunk unavailable');
        if (chunk.size !== part.size) throw new Error('Release chunk size mismatch');
        chunks.push(chunk);
      }
      button.textContent = 'Finalizing download…';
      const objectUrl = URL.createObjectURL(new Blob(chunks, { type: release.contentType }));
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = release.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      status.textContent = 'Private preview download prepared for the authorized account.';
    } catch (_) {
      status.textContent = 'The private download could not be prepared. Confirm you are signed in as the authorized account, then refresh and try again.';
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

    const { data: objects, error: listError } = await client.storage.from(BUCKET).list(RELEASE, { limit: 100 });
    if (listError) {
      status.textContent = 'Your account is authorized, but release availability could not be checked.';
      return;
    }

    const names = new Set((objects || []).map((item) => item.name));
    let availableCount = 0;
    for (const button of buttons) {
      const key = button.dataset.desktopDownload;
      const release = RELEASES[key];
      const manifestName = release.manifestPath.slice(RELEASE.length + 1);
      if (!names.has(manifestName)) {
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
      ? 'Private preview access confirmed. Downloads require your active owner session.'
      : 'Private preview access confirmed. Installers are still being transferred.';
  }

  initialize().catch(() => {
    status.textContent = 'Private downloads are temporarily unavailable.';
  });
})();
