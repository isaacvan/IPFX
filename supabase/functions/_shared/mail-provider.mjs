// One place that sends an email, whichever provider is configured.
//   SES    : Amazon SES v2 over HTTPS (about $0.10 per 1,000 emails, no daily cap once AWS approves production access).
//   Resend : the original provider (free plan is 100 a day).
// Chosen by EMAIL_PROVIDER ("ses" | "resend"). If it is not set, SES is used when the AWS keys exist, otherwise Resend.
// Plain JavaScript so Deno (the edge functions) and the Node tests can both import it.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (data) => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

// AWS Signature Version 4. Returns the request headers to send, including Authorization.
export async function signV4({ method, url, headers = {}, body = "", service, region, accessKeyId, secretAccessKey, sessionToken, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const all = { ...headers, host: u.host, "x-amz-date": amzDate };
  if (sessionToken) all["x-amz-security-token"] = sessionToken;
  const lower = {};
  for (const k of Object.keys(all)) lower[k.toLowerCase()] = String(all[k]).trim().replace(/\s+/g, " ");
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...u.searchParams.entries()].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalRequest = [method, u.pathname, query, canonicalHeaders, signedHeaders, await sha256Hex(body)].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmac(enc.encode("AWS4" + secretAccessKey), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));
  return { ...all, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

export function pickProvider(env) {
  const want = String(env.EMAIL_PROVIDER ?? "").toLowerCase();
  const ses = !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION);
  if (want === "resend") return env.RESEND_API_KEY ? "resend" : null;
  if (want === "ses") return ses ? "ses" : null;
  if (ses) return "ses";
  return env.RESEND_API_KEY ? "resend" : null;
}

// SES errors that are worth retrying later. The word "rate limit" is written into the message because the outbox
// retries rows whose error mentions "rate" or "limit".
const RETRYABLE_SES = /Throttl|TooManyRequests|LimitExceeded|ServiceUnavailable|InternalFailure|RequestTimeout/i;

async function sendSes(m, env, fetchImpl) {
  const region = env.AWS_REGION;
  const body = JSON.stringify({
    FromEmailAddress: m.from,
    Destination: { ToAddresses: [m.to] },
    ReplyToAddresses: m.replyTo ? [m.replyTo] : undefined,
    ConfigurationSetName: env.SES_CONFIGURATION_SET || undefined,
    EmailTags: m.tags ? Object.entries(m.tags).map(([Name, Value]) => ({ Name, Value: String(Value) })) : undefined,
    Content: {
      Simple: {
        Subject: { Data: m.subject, Charset: "UTF-8" },
        Body: { Html: { Data: m.html, Charset: "UTF-8" }, ...(m.text ? { Text: { Data: m.text, Charset: "UTF-8" } } : {}) },
        Headers: m.headers ? Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value: String(Value) })) : undefined,
      },
    },
  });
  const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
  const headers = await signV4({
    method: "POST", url, headers: { "content-type": "application/json" }, body, service: "ses", region,
    accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN,
  });
  const res = await fetchImpl(url, { method: "POST", headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, provider: "ses", id: data?.MessageId ?? null };
  const type = String(res.headers?.get?.("x-amzn-errortype") ?? data?.__type ?? data?.Type ?? "").split(":")[0];
  const retryable = res.status === 429 || res.status >= 500 || RETRYABLE_SES.test(type) || RETRYABLE_SES.test(String(data?.message ?? ""));
  return { ok: false, provider: "ses", status: res.status, retryable, error: `${retryable ? "rate limit: " : ""}SES ${type || res.status}: ${String(data?.message ?? "").slice(0, 300)}`.trim() };
}

async function sendResend(m, env, fetchImpl) {
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", ...(m.idempotencyKey ? { "Idempotency-Key": m.idempotencyKey } : {}) },
    body: JSON.stringify({ from: m.from, to: m.to, subject: m.subject, html: m.html, text: m.text, reply_to: m.replyTo, headers: m.headers }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, provider: "resend", id: data?.id ?? null };
  return { ok: false, provider: "resend", status: res.status, retryable: res.status === 429, error: String(data?.message ?? `Resend ${res.status}`).slice(0, 500) };
}

// m: { from, to, subject, html, text, replyTo, headers, idempotencyKey, tags }.  Never throws on a provider error.
export async function sendEmail(m, env, fetchImpl = fetch) {
  const provider = pickProvider(env);
  if (!provider) return { ok: false, provider: null, retryable: false, error: "No email provider configured" };
  try {
    return provider === "ses" ? await sendSes(m, env, fetchImpl) : await sendResend(m, env, fetchImpl);
  } catch (e) {
    return { ok: false, provider, retryable: true, error: `rate limit retry: ${String(e).slice(0, 200)}` };
  }
}
