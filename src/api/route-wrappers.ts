import { config } from "../config.ts";
import { preflight, withCors, withSecurity } from "./cors.ts";
import { authenticateBearer, internalError } from "./middleware.ts";
import { checkRateLimit, clientIp } from "./rate-limit.ts";

/**
 * Method-keyed handler tables used by `Bun.serve`'s `routes:` option. A bare
 * function would accept any verb; the keyed form lets Bun.serve return 405
 * on mismatch automatically.
 */
export type Handler = (req: Request) => Response | Promise<Response>;
export type MethodHandlers = Partial<Record<"GET" | "POST" | "OPTIONS", Handler>>;

/**
 * `rateLimitGate` falls back to `server.requestIP(req)` when proxy headers
 * aren't trusted, so it needs a handle on the running server. We accept that
 * via a setter rather than a closure because the wrappers are constructed
 * *before* `Bun.serve` returns (handler tables are an argument to it).
 */
interface ServerWithIP {
  requestIP(req: Request): { address: string } | null;
}
let serverRef: ServerWithIP | null = null;

export function setActiveServer(server: ServerWithIP | null): void {
  serverRef = server;
}

/**
 * Stamp HSTS + nosniff + frame-deny + default-deny CSP on the response of a
 * non-CORS route. CORS routes flow through `withCors`, which applies the
 * same headers; this helper covers `/healthz`, the magic-link review handler,
 * and the Drive webhook so every public response is hardened.
 */
export function secured(handler: Handler): Handler {
  return async (req) => withSecurity(await handler(req));
}

/**
 * Wrap a method-keyed route table with CORS handling, rate limiting, and a
 * uniform error response: every supplied handler's response gets
 * `Access-Control-Allow-*` headers stamped on, an `OPTIONS` preflight
 * handler is auto-injected, every authenticated route counts against a
 * per-user (or per-IP) fixed-window budget, and any thrown error becomes a
 * structured `internalError` JSON response with CORS headers preserved.
 * Routes registered with `corsRoute` therefore never need their own
 * catch-all try/catch; they catch only domain exceptions that demand a
 * non-500 mapping (e.g. `DuplicateProjectError` → 409).
 */
export function corsRoute(handlers: MethodHandlers): MethodHandlers {
  const out: MethodHandlers = { OPTIONS: preflight };
  for (const [method, handler] of Object.entries(handlers) as [
    keyof MethodHandlers,
    Handler,
  ][]) {
    out[method] = async (req: Request) => {
      let res: Response;
      let remaining: number | null = null;
      try {
        const gate = await rateLimitGate(req);
        if (gate.kind === "block") {
          res = gate.response;
        } else {
          remaining = gate.remaining;
          res = await handler(req);
        }
      } catch (err) {
        console.error(`[${method} ${new URL(req.url).pathname}] error:`, err);
        res = internalError();
      }
      if (remaining !== null && !res.headers.has("x-margin-rate-limit-remaining")) {
        res = new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: (() => {
            const h = new Headers(res.headers);
            h.set("x-margin-rate-limit-remaining", String(remaining));
            return h;
          })(),
        });
      }
      return withCors(req, res);
    };
  }
  return out;
}

type RateLimitGate =
  | { kind: "allow"; remaining: number }
  | { kind: "block"; response: Response };

/**
 * Pre-handler rate-limit check for `/api/extension/*` and
 * `/api/picker/register-doc`. Keys on the authenticated user id when
 * possible (so a stolen-token abuser burns *their own* budget, not their
 * victim's pool, and a NAT'd office shares per-user buckets), falling
 * back to client IP for unauthenticated requests. On exhaustion the
 * caller receives 429 + `Retry-After`; otherwise the handler runs and the
 * remaining slot count is surfaced via `x-margin-rate-limit-remaining`.
 *
 * Better Auth has its own rate limiter on `/api/auth/*` (defaults to 100
 * reqs / 10 s in production), so we don't need to wrap that route.
 */
async function rateLimitGate(req: Request): Promise<RateLimitGate> {
  // Skip the session lookup entirely for callers that didn't send a
  // credential — every unauthenticated request would otherwise trip Better
  // Auth's DB-backed `getSession` before reaching the bucket check, which
  // amplifies the DoS surface (the limiter is supposed to be cheap). When
  // Authorization is present but the session is invalid we still fall
  // through to IP-based bucketing, so attackers can't burst anonymously by
  // omitting the header.
  const hasBearer = req.headers.has("authorization");
  const session = hasBearer ? await authenticateBearer(req).catch(() => null) : null;
  const key = session
    ? `u:${session.userId}`
    : `ip:${clientIp(req, { server: serverRef ?? undefined, trustProxy: config.trustProxy })}`;
  const decision = checkRateLimit(key);
  if (!decision.allowed) {
    return {
      kind: "block",
      response: new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(decision.resetSeconds),
          "x-margin-rate-limit-remaining": "0",
        },
      }),
    };
  }
  return { kind: "allow", remaining: decision.remaining };
}
