(function () {
  'use strict';

  const SUPABASE_URL = 'https://agulweemteoeagscmppy.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndWx3ZWVtdGVvZWFnc2NtcHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MzU0ODIsImV4cCI6MjA4MTQxMTQ4Mn0.I70jN5DCuCn8OtISqvTRzuzGFaYd2pV8vviEED6gFlQ';
  const BUCKET = 'desktop-releases';
  const RELEASE = 'v0.1.0-preview.3';
  const MAX_PARTS = 16;
  const MAX_PART_BYTES = 42 * 1024 * 1024;
  const RELEASES = {
    windows: {
      sourceName: 'IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.3-win-x64.exe',
      filename: 'IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.3-Windows-x64.exe',
      contentType: 'application/vnd.microsoft.portable-executable',
      label: 'Download Windows preview'
    },
    'mac-arm64': {
      sourceName: 'IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.3-mac-arm64.dmg',
      filename: 'IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.3-Apple-Silicon.dmg',
      contentType: 'application/x-apple-diskimage',
      label: 'Download Apple Silicon preview'
    },
    'mac-x64': {
      sourceName: 'IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.3-mac-x64.dmg',
      filename: 'IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.3-Intel-Mac.dmg',
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
    status.textContent = 'Sign in to your IPFX account in this browser to download the unsigned preview.';
    for (const button of buttons) {
      button.disabled = false;
      button.textContent = 'Sign in to download';
      setAvailability(button.dataset.desktopDownload, 'IPFX account required · unsigned preview');
      button.addEventListener('click', () => {
        window.location.assign('/login.html?next=' + encodeURIComponent('/downloads.html'));
      }, { once: true });
    }
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
    if (error || !user) throw new Error('IPFX sign-in required');
  }

  async function startDownload(key, button) {
    const release = RELEASES[key];
    if (!release) return;
    button.disabled = true;
    const original = button.textContent;
    try {
      await requireAuthorizedUser();
      button.textContent = 'Preparing preview download…';
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
      status.textContent = 'Installer download requested. Check your browser downloads for the file.';
    } catch (_) {
      status.textContent = 'The download could not be prepared. Confirm you are signed in to IPFX in this browser, then refresh and try again.';
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
    const { data: objects, error: listError } = await client.storage.from(BUCKET).list(RELEASE, { limit: 100 });
    if (listError) {
      status.textContent = 'You are signed in, but release availability could not be checked. Please retry.';
      return;
    }

    const names = new Set((objects || []).map((item) => item.name));
    let availableCount = 0;
    for (const button of buttons) {
      const key = button.dataset.desktopDownload;
      const release = RELEASES[key];
      const manifestName = release.manifestPath.slice(RELEASE.length + 1);
      if (!names.has(manifestName)) {
        setAvailability(key, 'Preview build is still being transferred');
        continue;
      }
      availableCount += 1;
      button.disabled = false;
      button.textContent = release.label;
      setAvailability(key, 'IPFX account required · unsigned preview');
      button.addEventListener('click', () => startDownload(key, button));
    }

    status.textContent = availableCount
      ? 'Signed-in access confirmed. These installers are unsigned previews, not production releases.'
      : 'Signed-in access confirmed. Installers are still being transferred.';
  }

  initialize().catch(() => {
    status.textContent = 'Private downloads are temporarily unavailable.';
  });
})();
