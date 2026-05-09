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
      "www-authenticate": `Bearer realm="docket"`,
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

export function internalError(message: string): Response {
  return new Response(JSON.stringify({ error: "internal_error", message }), {
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
