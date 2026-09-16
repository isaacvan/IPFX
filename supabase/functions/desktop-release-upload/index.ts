import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const EXPECTED_ISSUER = "https://token.actions.githubusercontent.com";
const EXPECTED_AUDIENCE = "ipfx-desktop-upload";
const EXPECTED_REPOSITORY = "isaacvan/IPFX";
const EXPECTED_REF = "refs/heads/codex/desktop-preview-build";
const EXPECTED_WORKFLOW_PREFIX = "isaacvan/IPFX/.github/workflows/desktop-build.yml@";
const BUCKET = "desktop-releases";
const ALLOWED_PATH = /^v0\.1\.0-preview\.1\/IPFX-Markets-UNSIGNED-PREVIEW-0\.1\.0-preview\.1-(?:win-x64\.exe|mac-(?:arm64|x64)\.dmg)\.(?:manifest\.json|part-\d{4}-of-\d{4})$/;

type JsonObject = Record<string, unknown>;
let jwks: { keys: JsonObject[]; fetchedAt: number } | null = null;

function json(body: JsonObject, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJsonPart(value: string): JsonObject {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as JsonObject;
}

async function getJwks(): Promise<JsonObject[]> {
  if (jwks && Date.now() - jwks.fetchedAt < 60 * 60 * 1000) return jwks.keys;
  const response = await fetch(`${EXPECTED_ISSUER}/.well-known/jwks`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("GitHub signing keys unavailable");
  const body = await response.json() as { keys?: JsonObject[] };
  if (!Array.isArray(body.keys)) throw new Error("GitHub signing keys invalid");
  jwks = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

async function verifyGitHubToken(token: string): Promise<JsonObject> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed GitHub token");

  const header = decodeJsonPart(parts[0]);
  const payload = decodeJsonPart(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported GitHub token");

  const keys = await getJwks();
  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk) {
    jwks = null;
    throw new Error("Unknown GitHub signing key");
  }

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!validSignature) throw new Error("Invalid GitHub signature");

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== EXPECTED_ISSUER) throw new Error("Invalid GitHub issuer");
  if (!audiences.includes(EXPECTED_AUDIENCE)) throw new Error("Invalid GitHub audience");
  if (typeof payload.exp !== "number" || payload.exp < now - 30) throw new Error("Expired GitHub token");
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) throw new Error("Inactive GitHub token");
  if (payload.repository !== EXPECTED_REPOSITORY) throw new Error("Invalid GitHub repository");
  if (payload.ref !== EXPECTED_REF) throw new Error("Invalid GitHub ref");
  if (
    typeof payload.workflow_ref !== "string" ||
    !payload.workflow_ref.startsWith(EXPECTED_WORKFLOW_PREFIX) ||
    !payload.workflow_ref.endsWith(`@${EXPECTED_REF}`)
  ) throw new Error("Invalid GitHub workflow");

  return payload;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    await verifyGitHubToken(authorization.slice(7));

    const body = await request.json() as { path?: unknown };
    if (typeof body.path !== "string" || !ALLOWED_PATH.test(body.path)) {
      return json({ error: "Release path not allowed" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRole) return json({ error: "Storage configuration unavailable" }, 500);

    const storage = createClient(supabaseUrl, serviceRole, {
      auth: { autoRefreshToken: false, persistSession: false },
    }).storage;
    const { data, error } = await storage.from(BUCKET).createSignedUploadUrl(body.path, { upsert: true });
    if (error || !data?.token) {
      console.error("signed upload creation failed", error);
      return json({ error: "Signed upload could not be created" }, 500);
    }

    return json({ path: body.path, token: data.token });
  } catch (error) {
    console.error("desktop release upload authorization failed", error);
    return json({ error: "Unauthorized" }, 401);
  }
});
