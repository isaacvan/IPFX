const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function unb64(value: string): Uint8Array {
  const raw = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = raw + "=".repeat((4 - raw.length % 4) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  const bytes = unb64(secret);
  if (bytes.length !== 32) throw new Error("TRADELOCKER_TOKEN_ENCRYPTION_KEY must be 32 bytes in base64url form");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), encoder.encode(value));
  return `v1.${b64(iv)}.${b64(new Uint8Array(cipher))}`;
}

export async function decryptSecret(value: string, secret: string): Promise<string> {
  const [version, iv, cipher] = value.split(".");
  if (version !== "v1" || !iv || !cipher) throw new Error("unsupported encrypted token format");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(secret), unb64(cipher));
  return decoder.decode(plain);
}

export function jwtExpiresAt(token: string): string | null {
  try {
    const payload = JSON.parse(decoder.decode(unb64(token.split(".")[1])));
    return Number.isFinite(payload.exp) ? new Date(payload.exp * 1000).toISOString() : null;
  } catch (_) { return null; }
}
