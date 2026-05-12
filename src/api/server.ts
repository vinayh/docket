import {
  handleAuthExtLaunchTab,
  handleAuthExtSuccess,
  handleAuthRequest,
} from "./auth-handler.ts";
import { handleDocStatePost } from "./doc-state.ts";
import { handleDocSyncPost } from "./doc-sync.ts";
import { handleProjectDetailPost } from "./project-detail.ts";
import { handleVersionDiffPost } from "./version-diff.ts";
import { handleVersionCommentsPost } from "./version-comments.ts";
import { handleCommentActionPost } from "./comment-action.ts";
import { handleSettingsPost } from "./settings.ts";
import { handleReviewActionGet } from "./review-action.ts";
import { handlePickerPage } from "./picker-page.ts";
import { handleRegisterDocPost } from "./picker-register.ts";
import { handleDriveWebhook } from "./drive-webhook.ts";
import { preflight, withCors, withSecurity } from "./cors.ts";
import { authenticateBearer, internalError } from "./middleware.ts";
import { checkRateLimit, clientIp } from "./rate-limit.ts";
import { config } from "../config.ts";

// Bun.serve routes handlers receive only `(req)` — the Server is the return
// value of Bun.serve. We capture it here so rateLimitGate can fall back to
// `server.requestIP(req)` when proxy headers aren't trusted. Module-scope is
// fine because handlers never run before `startServer` returns.
interface ServerWithIP {
  requestIP(req: Request): { address: string } | null;
  stop(): Promise<void> | void;
  readonly port: number | undefined;
  readonly hostname: string | undefined;
}
let serverRef: ServerWithIP | null = null;

export interface ServeOptions {
  port?: number;
  hostname?: string;
}

type Handler = (req: Request) => Response | Promise<Response>;
type MethodHandlers = Partial<Record<"GET" | "POST" | "OPTIONS", Handler>>;

/**
 * Stamp HSTS + nosniff + frame-deny + default-deny CSP on the response of a
 * non-CORS route. CORS routes flow through `withCors`, which applies the
 * same headers; this helper covers `/healthz`, the magic-link review handler,
 * and the Drive webhook so every public response is hardened.
 */
function secured(handler: Handler): Handler {
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
function corsRoute(handlers: MethodHandlers): MethodHandlers {
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

/**
 * Phase-2 HTTP API host. Public routes: `/healthz`, the magic-link review
 * handler `/r/<token>`, the backend-hosted Drive Picker page
 * `/api/picker/page` (cookie-authenticated), and Better Auth's catch-all
 * `/api/auth/**` (sign-in, social-provider callback, session lookup,
 * sign-out). Webhooks: `/webhooks/drive` (Drive push notifications).
 * Bearer-authenticated API surface:
 * `/api/extension/{doc-state,doc-sync,project,version-diff,
 * version-comments,comment-action,settings}`, `/api/picker/register-doc`.
 * Method dispatch + 405-on-mismatch comes from Bun.serve's `routes:` option;
 * unknown paths fall through to `fetch`'s 404.
 *
 * `backgroundLoops` (default true) controls the in-process renew + poll
 * timers (SPEC §9.3). Tests pass `false` to keep the server quiet; in
 * prod the loops gate themselves on `MARGIN_PUBLIC_BASE_URL` being set.
 */
export interface StartServerResult {
  port: number | undefined;
  hostname: string | undefined;
  stop(): Promise<void>;
}

export function startServer(opts: ServeOptions & { backgroundLoops?: boolean } = {}): StartServerResult {
  const envPort = Bun.env.PORT ? Number(Bun.env.PORT) : undefined;
  const port = opts.port ?? envPort ?? 8787;

  const server = Bun.serve({
    port,
    hostname: opts.hostname,
    routes: {
      // Bun.serve treats a bare-function route as accept-any-method, so we
      // wrap GET-only routes in the method-keyed form to get automatic 405
      // on the wrong verb.
      "/healthz": { GET: secured(() => Response.json({ ok: true })) },
      "/api/auth/ext/launch-tab": { GET: secured(handleAuthExtLaunchTab) },
      // `secured` wraps the response with default-deny CSP + frame-deny
      // *unless* the handler set its own — `handleAuthExtSuccess` returns
      // a CSP with a sha256 script hash, so the global default-src 'none'
      // doesn't clobber it.
      "/api/auth/ext/success": { GET: secured(handleAuthExtSuccess) },
      "/api/auth/*": {
        GET: secured(handleAuthRequest),
        POST: secured(handleAuthRequest),
      },
      "/webhooks/drive": { POST: secured(handleDriveWebhook) },
      "/api/extension/doc-state": corsRoute({ POST: handleDocStatePost }),
      "/api/extension/doc-sync": corsRoute({ POST: handleDocSyncPost }),
      "/api/extension/project": corsRoute({ POST: handleProjectDetailPost }),
      "/api/extension/version-diff": corsRoute({ POST: handleVersionDiffPost }),
      "/api/extension/version-comments": corsRoute({ POST: handleVersionCommentsPost }),
      "/api/extension/comment-action": corsRoute({ POST: handleCommentActionPost }),
      "/api/extension/settings": corsRoute({ POST: handleSettingsPost }),
      "/api/picker/page": { GET: secured(handlePickerPage) },
      "/api/picker/register-doc": corsRoute({ POST: handleRegisterDocPost }),
      "/r/:token": { GET: secured(handleReviewActionGet) },
    },
    fetch() {
      return new Response("not found", { status: 404 });
    },
    error(err) {
      console.error("server error:", err);
      return new Response("internal error", { status: 500 });
    },
  });

  serverRef = server;

  const loops = opts.backgroundLoops === false ? null : startBackgroundLoops();

  return {
    port: server.port,
    hostname: server.hostname,
    async stop() {
      loops?.stop();
      await server.stop();
      if (serverRef === server) serverRef = null;
    },
  };
}

import { renewExpiringChannels, pollAllActiveVersions } from "../domain/watcher.ts";

const RENEW_INTERVAL_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 60 * 1000;

interface BackgroundLoops {
  stop(): void;
}

/**
 * Start the in-process renew + polling loops. Both gate on
 * `MARGIN_PUBLIC_BASE_URL`: there's nothing to renew if no production
 * webhook address has been configured, and the polling fallback is just
 * paired infrastructure for the same setup.
 *
 * Loops use a self-rescheduling `setTimeout` chain (not `setInterval`), so a
 * slow run can't overlap with the next tick — the next timer is armed only
 * after the previous run finishes. This matters because `pollAllActiveVersions`
 * iterates every active version serially through Drive; a backlog plus
 * concurrent ingests would compound the upsert races the unique constraints
 * guard against.
 */
function startBackgroundLoops(): BackgroundLoops {
  if (!config.publicBaseUrl) {
    console.log("background loops: MARGIN_PUBLIC_BASE_URL not set, skipping");
    return { stop() {} };
  }

  console.log(
    `background loops: renew every ${RENEW_INTERVAL_MS / 60000}m, poll every ${POLL_INTERVAL_MS / 60000}m`,
  );

  let stopped = false;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRenew = (delay: number) => {
    if (stopped) return;
    renewTimer = setTimeout(async () => {
      try {
        const r = await renewExpiringChannels();
        if (r.renewed > 0 || r.failed > 0) {
          console.log(`renew: renewed=${r.renewed} failed=${r.failed}`);
        }
      } catch (err) {
        console.error("renew loop error:", err);
      } finally {
        scheduleRenew(RENEW_INTERVAL_MS);
      }
    }, delay);
  };

  const schedulePoll = (delay: number) => {
    if (stopped) return;
    pollTimer = setTimeout(async () => {
      try {
        const outcomes = await pollAllActiveVersions();
        const ok = outcomes.filter((o) => !o.error).length;
        const errs = outcomes.length - ok;
        if (outcomes.length > 0) {
          console.log(`poll: versions=${outcomes.length} ok=${ok} errors=${errs}`);
        }
        for (const o of outcomes) {
          if (o.error) console.error(`poll: version ${o.versionId} failed: ${o.error}`);
        }
      } catch (err) {
        console.error("poll loop error:", err);
      } finally {
        schedulePoll(POLL_INTERVAL_MS);
      }
    }, delay);
  };

  scheduleRenew(RENEW_INTERVAL_MS);
  schedulePoll(POLL_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      if (renewTimer) clearTimeout(renewTimer);
      if (pollTimer) clearTimeout(pollTimer);
    },
  };
}
