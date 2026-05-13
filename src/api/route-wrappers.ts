import { config } from "../config.ts";
import { preflight, withCors, withSecurity } from "./cors.ts";
import { authenticateBearer, internalError } from "./middleware.ts";
import { checkRateLimit, clientIp } from "./rate-limit.ts";

// Method-keyed shape lets Bun.serve auto-405 on verb mismatch.
export type Handler = (req: Request) => Response | Promise<Response>;
export type MethodHandlers = Partial<Record<"GET" | "POST" | "OPTIONS", Handler>>;

// Held via setter rather than a closure: wrappers are constructed before Bun.serve returns.
interface ServerWithIP {
  requestIP(req: Request): { address: string } | null;
}
let serverRef: ServerWithIP | null = null;

export function setActiveServer(server: ServerWithIP | null): void {
  serverRef = server;
}

// Applies the same hardening headers as withCors, for routes not on the CORS path.
export function secured(handler: Handler): Handler {
  return async (req) => withSecurity(await handler(req));
}

/**
 * Adds CORS, per-user/IP rate limiting, auto OPTIONS preflight, and a uniform
 * `internalError` fallback to a method-keyed handler table. Routes registered
 * here only need to catch domain exceptions that demand a non-500 mapping.
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

// Keys on authenticated user id when possible, IP otherwise.
// Better Auth handles its own /api/auth/* rate limit, so we don't wrap that route.
async function rateLimitGate(req: Request): Promise<RateLimitGate> {
  // Don't pay for a session lookup on uncredentialed requests — that would amplify the DoS
  // surface (the limiter is meant to be cheap).
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
