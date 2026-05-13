import * as v from "valibot";
import { auth } from "../auth/server.ts";

export interface AuthenticatedRequest {
  userId: string;
  sessionId: string;
}

// Upper bound for opaque ids on the wire. Routes with user-supplied URLs override locally.
export const MAX_ID_LEN = 200;

export const IdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LEN));

// Memoized on Request so pre-handler gates + the handler share one session lookup.
const sessionCache = new WeakMap<Request, Promise<AuthenticatedRequest | null>>();

export function authenticateBearer(req: Request): Promise<AuthenticatedRequest | null> {
  const hit = sessionCache.get(req);
  if (hit) return hit;
  const p = (async () => {
    const result = await auth.api.getSession({ headers: req.headers });
    if (!result) return null;
    return { userId: result.user.id, sessionId: result.session.id };
  })();
  sessionCache.set(req, p);
  return p;
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

// Never include the underlying exception — driver errors can leak SQL / ids / response bodies.
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

// Enforces the size cap at the stream level; Content-Length is advisory and can lie.
export async function readJsonBody(
  req: Request,
  maxBodyBytes: number,
): Promise<Record<string, unknown> | Response> {
  const headerLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(headerLength) && headerLength > maxBodyBytes) {
    return badRequest(`request too large: ${headerLength} > ${maxBodyBytes}`);
  }
  const text = await readCappedText(req, maxBodyBytes);
  if (text instanceof Response) return text;
  let payload: unknown;
  try {
    payload = text.length === 0 ? null : JSON.parse(text);
  } catch {
    return badRequest("invalid json");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return badRequest("expected a json object body");
  }
  return payload as Record<string, unknown>;
}

async function readCappedText(req: Request, max: number): Promise<string | Response> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return badRequest(`request too large: > ${max}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const concat = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    concat.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(concat);
}

export function parseOr400<TSchema extends v.GenericSchema>(
  schema: TSchema,
  payload: unknown,
): v.InferOutput<TSchema> | Response {
  const result = v.safeParse(schema, payload);
  if (result.success) return result.output;
  const issue = result.issues[0];
  const path = issue.path?.map((p) => String(p.key)).join(".") ?? "";
  return badRequest(path ? `${path}: ${issue.message}` : issue.message);
}

export async function readAndParseJson<TSchema extends v.GenericSchema>(
  req: Request,
  maxBodyBytes: number,
  schema: TSchema,
): Promise<v.InferOutput<TSchema> | Response> {
  const payload = await readJsonBody(req, maxBodyBytes);
  if (payload instanceof Response) return payload;
  return parseOr400(schema, payload);
}
