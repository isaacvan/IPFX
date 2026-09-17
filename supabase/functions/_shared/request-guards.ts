type ServiceClient = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
};

export class RequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

export function requestId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && /^[a-zA-Z0-9._:-]{1,80}$/.test(supplied) ? supplied : crypto.randomUUID();
}

export async function readJsonObject(request: Request, maxBytes = 16_384): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestError("Request is too large", 413);

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new RequestError("Request is too large", 413);

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestError("Invalid request", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError("Invalid request", 400);
  return value as Record<string, unknown>;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function allowRequest(
  db: ServiceClient,
  scope: string,
  subject: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<boolean> {
  const { data, error } = await db.rpc("enforce_api_rate_limit", {
    p_scope: scope,
    p_subject_hash: await sha256(subject),
    p_max_requests: maxRequests,
    p_window_seconds: windowSeconds,
  });
  if (error) throw new RequestError("Request protection is temporarily unavailable", 503);
  return data === true;
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof RequestError) return error.name;
  if (error instanceof DOMException && error.name === "AbortError") return "UPSTREAM_TIMEOUT";
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 80);
  }
  return error instanceof Error ? error.name.slice(0, 80) : "UNKNOWN";
}
