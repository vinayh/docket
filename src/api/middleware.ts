import * as v from "valibot";
import { auth } from "../auth/server.ts";

export interface AuthenticatedRequest {
  userId: string;
  sessionId: string;
}

/**
 * Upper bound for any opaque id we accept on the wire (project, version,
 * canonical-comment, etc.). 200 covers UUIDs, Google Doc ids, and slugs with
 * room to spare; anything longer is almost certainly hostile. Routes that
 * carry user-supplied URLs (e.g. `picker-register`'s `docUrlOrId`) override
 * locally.
 */
export const MAX_ID_LEN = 200;

/**
 * Shared schema for opaque ids on incoming JSON bodies. Pairs with
 * `MAX_ID_LEN` above.
 */
export const IdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LEN));

/**
 * Resolve the caller's user via Better Auth. Accepts either a session cookie
 * or `Authorization: Bearer <session_token>` (the bearer plugin converts the
 * header into the same session lookup). Returns null when no valid session
 * is present; routes decide whether to 401 or fall through.
 *
 * The pre-handler rate-limit gate and the handler itself both call this for
 * every authenticated route. We memoize on the `Request` object so the
 * second call reuses the first call's promise instead of running the DB
 * lookup twice per request.
 */
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
 * this with `parseOr400` + a valibot schema to validate individual fields.
 *
 * The check is enforced at the stream level — `Content-Length` is advisory
 * (chunked-encoded requests omit it; hostile clients can lie about it), so
 * we accumulate bytes off `req.body` and bail the moment the cap is
 * exceeded. A trusted `Content-Length` that's already too large gets
 * short-circuited without reading the body at all.
 */
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

/**
 * Run a Valibot schema against a parsed payload. Returns the schema's output
 * on success, or a 400 `Response` carrying the first issue. The 400 message
 * includes the dotted path (`patch.defaultReviewerEmails.0`) so the caller
 * gets enough to localize the problem without exposing internal details.
 */
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

/**
 * Read + size-check the request body, parse JSON, and validate against
 * `schema` in one call. Returns the parsed value or a 400 `Response`.
 * Callers use a single `if (x instanceof Response) return x` guard instead
 * of two.
 */
export async function readAndParseJson<TSchema extends v.GenericSchema>(
  req: Request,
  maxBodyBytes: number,
  schema: TSchema,
): Promise<v.InferOutput<TSchema> | Response> {
  const payload = await readJsonBody(req, maxBodyBytes);
  if (payload instanceof Response) return payload;
  return parseOr400(schema, payload);
}
