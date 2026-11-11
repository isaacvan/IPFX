// Unsubscribe links and the do-not-email list.
// An unsubscribe link carries a signed token (the address plus an HMAC), so it cannot be forged for someone else.
// "Marketing" emails (come-back, launch) honour every suppression. Notices a trader needs (breach, restart, stage-up)
// are only held back for addresses that bounced or complained.

export const MARKETING_TEMPLATES = ["infinity_comeback", "infinity_v2_launch"];
const HARD_REASONS = ["bounce", "complaint"];

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
async function mac(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

export const normEmail = (e) => String(e ?? "").trim().toLowerCase();

export async function signUnsubToken(email, secret) {
  const e = normEmail(email);
  return `${b64url(enc.encode(e))}.${b64url(await mac(secret, "unsub:" + e))}`;
}

// Returns the address if the token is genuine, otherwise null.
export async function verifyUnsubToken(token, secret) {
  try {
    const [a, sig] = String(token ?? "").split(".");
    if (!a || !sig) return null;
    const email = new TextDecoder().decode(fromB64url(a));
    const want = await mac(secret, "unsub:" + email), got = fromB64url(sig);
    if (want.length !== got.length) return null;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
    return diff === 0 ? email : null;
  } catch { return null; }
}

// page: the link people click in the email body. oneClick: the URL mail apps POST to (RFC 8058).
export async function unsubscribeLinks(email, secret, { pageBase = "https://ipfxcapital.com/unsubscribe.html", fnBase = "https://agulweemteoeagscmppy.supabase.co/functions/v1/email-unsubscribe" } = {}) {
  const t = await signUnsubToken(email, secret);
  return { page: `${pageBase}?t=${t}`, oneClick: `${fnBase}?t=${t}` };
}

export const isMarketing = (templateKey) => MARKETING_TEMPLATES.includes(templateKey);

// reason: the stored suppression reason for this address, or null if the address is not on the list.
export function blockedBySuppression(templateKey, reason) {
  if (!reason) return false;
  return isMarketing(templateKey) ? true : HARD_REASONS.includes(reason);
}
