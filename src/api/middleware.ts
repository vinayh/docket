import { verifyApiToken } from "../auth/api-token.ts";

export interface AuthenticatedRequest {
  userId: string;
  tokenId: string;
}

/**
 * Extracts a bearer token from `Authorization: Bearer <token>` and resolves it
 * to a user. Returns null when the header is missing, malformed, or the token
 * is unknown / revoked. Routes decide whether to 401 or to fall through.
 */
export async function authenticateBearer(req: Request): Promise<AuthenticatedRequest | null> {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return null;
  const verified = await verifyApiToken(match[1]!);
  if (!verified) return null;
  return verified;
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer realm="margin"`,
    },
  });
}

export function methodNotAllowed(allowed: readonly string[]): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: {
      "content-type": "application/json",
      allow: allowed.join(", "),
    },
  });
}

export function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: "bad_request", message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

export function notFound(message = "not found"): Response {
  return new Response(JSON.stringify({ error: "not_found", message }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 500 response. Body is a fixed shape and never includes the underlying
 * exception — Drizzle/Drive/Bun-sqlite errors regularly contain SQL
 * fragments, internal user IDs, or response snippets we don't want on the
 * wire. Callers log the detail with `console.error` before invoking this.
 */
export function internalError(): Response {
  return new Response(JSON.stringify({ error: "internal_error" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

export function jsonOk<T>(body: T, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Size-checks the request, parses JSON, and asserts the payload is an
 * object (`{...}`, not an array or primitive). Returns the parsed object
 * on success, or a 400 `Response` describing the failure. Routes pair
 * this with `readStringField` to pull out individual fields.
 */
export async function readJsonBody(
  req: Request,
  maxBodyBytes: number,
): Promise<Record<string, unknown> | Response> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > maxBodyBytes) {
    return badRequest(`request too large: ${contentLength} > ${maxBodyBytes}`);
  }
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return badRequest("invalid json");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return badRequest("expected a json object body");
  }
  return payload as Record<string, unknown>;
}

/**
 * Extracts a non-empty string field from a parsed JSON object, capped at
 * `maxLen` characters. Returns the value on success or a 400 `Response`
 * shaped after the route's field name. Pair with `readJsonBody`.
 */
export function readStringField(
  payload: Record<string, unknown>,
  key: string,
  maxLen: number,
): string | Response {
  const raw = payload[key];
  if (typeof raw !== "string" || raw.length === 0 || raw.length > maxLen) {
    return badRequest(`expected { ${key}: string }`);
  }
  return raw;
}
