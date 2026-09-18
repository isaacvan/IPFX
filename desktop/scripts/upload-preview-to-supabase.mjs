import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://agulweemteoeagscmppy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndWx3ZWVtdGVvZWFnc2NtcHB5Iiwicm9sZSI6ImFub25iLCJpYXQiOjE3NjU4MzU0ODIsImV4cCI6MjA4MTQxMTQ4Mn0.I70jN5DCuCn8OtISqvTRzuzGFaYd2pV8vviEED6gFlQ';
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/desktop-release-upload`;
const AUDIENCE = 'ipfx-desktop-upload';
const BUCKET = 'desktop-releases';
const RELEASE = 'v0.1.0-preview.3';
const CHUNK_BYTES = 40 * 1024 * 1024;
const ALLOWED_FILES = new Map([
  ['IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.3-win-x64.exe', 'application/vnd.microsoft.portable-executable'],
  ['IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.3-mac-arm64.dmg', 'application/x-apple-diskimage'],
  ['IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.3-mac-x64.dmg', 'application/x-apple-diskimage'],
]);

async function getGitHubOidcToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) throw new Error('GitHub OIDC environment is unavailable');
  const separator = requestUrl.includes('?') ? '&' : '?';
  const response = await fetch(`${requestUrl}${separator}audience=${encodeURIComponent(AUDIENCE)}`, {
    headers: { Authorization: `Bearer ${requestToken}` },
  });
  if (!response.ok) throw new Error(`GitHub OIDC request failed: ${response.status}`);
  const body = await response.json();
  if (!body.value) throw new Error('GitHub OIDC response did not contain a token');
  return body.value;
}

async function createUploadToken(oidcToken, objectPath) {
  const response = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oidcToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: objectPath }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Private upload authorization failed: ${response.status} ${detail}`);
  }
  const body = await response.json();
  if (!body.token) throw new Error('Private upload authorization returned no token');
  return body.token;
}

function partPath(name, index, total) {
  return `${RELEASE}/${name}.part-${String(index).padStart(4, '0')}-of-${String(total).padStart(4, '0')}`;
}

async function uploadObject(storage, oidcToken, objectPath, bytes) {
  const token = await createUploadToken(oidcToken, objectPath);
  const { error } = await storage.from(BUCKET).uploadToSignedUrl(objectPath, token, bytes, {
    contentType: 'application/octet-stream',
    cacheControl: '3600',
    upsert: true,
  });
  if (error) throw error;
}

async function main() {
  const oidcToken = await getGitHubOidcToken();
  const firstName = ALLOWED_FILES.keys().next().value;
  if (process.argv.includes('--check')) {
    await createUploadToken(oidcToken, `${RELEASE}/${firstName}.manifest.json`);
    console.log('Private Supabase transfer authorization verified');
    return;
  }

  const dist = path.resolve('dist');
  const entries = await readdir(dist);
  const releaseFiles = entries.filter((name) => ALLOWED_FILES.has(name));
  if (!releaseFiles.length) throw new Error('No approved preview installer was found in desktop/dist');

  const storage = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  }).storage;

  for (const name of releaseFiles) {
    const bytes = await readFile(path.join(dist, name));
    const total = Math.ceil(bytes.length / CHUNK_BYTES);
    const parts = [];
    for (let index = 1; index <= total; index += 1) {
      const start = (index - 1) * CHUNK_BYTES;
      const end = Math.min(start + CHUNK_BYTES, bytes.length);
      const objectPath = partPath(name, index, total);
      const chunk = bytes.subarray(start, end);
      await uploadObject(storage, oidcToken, objectPath, chunk);
      parts.push({ path: objectPath, size: chunk.length });
      console.log(`Uploaded private chunk ${index}/${total}: ${name}`);
    }

    const manifest = {
      version: 1,
      filename: name,
      size: bytes.length,
      contentType: ALLOWED_FILES.get(name),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      parts,
    };
    const manifestPath = `${RELEASE}/${name}.manifest.json`;
    await uploadObject(storage, oidcToken, manifestPath, Buffer.from(JSON.stringify(manifest)));
    console.log(`Uploaded private desktop release manifest: ${name}`);
  }
}

main().catch((error) => {
  const reason = error instanceof Error ? error.message : String(error);
  const annotation = reason.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`::error title=Private Supabase transfer::${annotation}`);
  process.exitCode = 1;
});
