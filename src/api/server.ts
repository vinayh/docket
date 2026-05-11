import { handleOauthCallback, handleOauthStart } from "./oauth.ts";
import { handleCapturesPost } from "./extension.ts";
import { handleDocStatePost } from "./doc-state.ts";
import { handleDocSyncPost } from "./doc-sync.ts";
import { handleProjectDetailPost } from "./project-detail.ts";
import { handleVersionDiffPost } from "./version-diff.ts";
import { handleVersionCommentsPost } from "./version-comments.ts";
import { handlePickerHost } from "./picker.ts";
import { handlePickerConfig } from "./picker-config.ts";
import { handleRegisterDocPost } from "./picker-register.ts";
import { handleDriveWebhook } from "./drive-webhook.ts";
import { preflight, withCors } from "./cors.ts";
import { internalError } from "./middleware.ts";

export interface ServeOptions {
  port?: number;
  hostname?: string;
}

type Handler = (req: Request) => Response | Promise<Response>;
type MethodHandlers = Partial<Record<"GET" | "POST" | "OPTIONS", Handler>>;

/**
 * Wrap a method-keyed route table with CORS handling and a uniform error
 * response: every supplied handler's response gets `Access-Control-Allow-*`
 * headers stamped on, an `OPTIONS` preflight handler is auto-injected, and
 * any thrown error becomes a structured `internalError` JSON response with
 * CORS headers preserved. Routes registered with `corsRoute` therefore
 * never need their own catch-all try/catch; they catch only domain
 * exceptions that demand a non-500 mapping (e.g. `DuplicateProjectError`
 * → 409).
 */
function corsRoute(handlers: MethodHandlers): MethodHandlers {
  const out: MethodHandlers = { OPTIONS: preflight };
  for (const [method, handler] of Object.entries(handlers) as [
    keyof MethodHandlers,
    Handler,
  ][]) {
    out[method] = async (req: Request) => {
      let res: Response;
      try {
        res = await handler(req);
      } catch (err) {
        console.error(`[${method} ${new URL(req.url).pathname}] error:`, err);
        res = internalError(err instanceof Error ? err.message : String(err));
      }
      return withCors(req, res);
    };
  }
  return out;
}

/**
 * Phase-2 HTTP API host. Public routes: `/healthz`, `/oauth/{start,callback}`,
 * `/picker`. Webhooks: `/webhooks/drive` (Drive push notifications).
 * Bearer-authenticated API surface: `/api/extension/captures`,
 * `/api/extension/doc-state`, `/api/extension/doc-sync`,
 * `/api/extension/project`, `/api/extension/version-diff`,
 * `/api/extension/version-comments`, `/api/picker/register-doc`. Method dispatch + 405-on-mismatch comes
 * from Bun.serve's `routes:` option; unknown paths fall through to
 * `fetch`'s 404.
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
      "/healthz": { GET: () => Response.json({ ok: true }) },
      "/oauth/start": { GET: handleOauthStart },
      "/oauth/callback": { GET: handleOauthCallback },
      "/picker": { GET: handlePickerHost },
      "/webhooks/drive": { POST: handleDriveWebhook },
      "/api/extension/captures": corsRoute({ POST: handleCapturesPost }),
      "/api/extension/doc-state": corsRoute({ POST: handleDocStatePost }),
      "/api/extension/doc-sync": corsRoute({ POST: handleDocSyncPost }),
      "/api/extension/project": corsRoute({ POST: handleProjectDetailPost }),
      "/api/extension/version-diff": corsRoute({ POST: handleVersionDiffPost }),
      "/api/extension/version-comments": corsRoute({ POST: handleVersionCommentsPost }),
      "/api/picker/config": corsRoute({ GET: handlePickerConfig }),
      "/api/picker/register-doc": corsRoute({ POST: handleRegisterDocPost }),
      // Google Search Console domain verification. Required before Drive
      // `files.watch` will accept this host as a webhook address (SPEC §9.3).
      // The token below is from the Search Console URL-prefix flow for
      // https://margin-server.fly.dev/. Safe to commit — it identifies the
      // verification claim, not a credential.
      "/google4c42fb2047912f0c.html": {
        GET: () =>
          new Response("google-site-verification: google4c42fb2047912f0c.html", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      },
    },
    fetch() {
      return new Response("not found", { status: 404 });
    },
    error(err) {
      console.error("server error:", err);
      return new Response("internal error", { status: 500 });
    },
  });

  const loops = opts.backgroundLoops === false ? null : startBackgroundLoops();

  return {
    port: server.port,
    hostname: server.hostname,
    async stop() {
      loops?.stop();
      await server.stop();
    },
  };
}

import { renewExpiringChannels, pollAllActiveVersions } from "../domain/watcher.ts";
import { config } from "../config.ts";

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
 */
function startBackgroundLoops(): BackgroundLoops {
  if (!config.publicBaseUrl) {
    console.log("background loops: MARGIN_PUBLIC_BASE_URL not set, skipping");
    return { stop() {} };
  }

  console.log(
    `background loops: renew every ${RENEW_INTERVAL_MS / 60000}m, poll every ${POLL_INTERVAL_MS / 60000}m`,
  );

  const renewTimer = setInterval(async () => {
    try {
      const r = await renewExpiringChannels();
      if (r.renewed > 0 || r.failed > 0) {
        console.log(`renew: renewed=${r.renewed} failed=${r.failed}`);
      }
    } catch (err) {
      console.error("renew loop error:", err);
    }
  }, RENEW_INTERVAL_MS);

  const pollTimer = setInterval(async () => {
    try {
      const outcomes = await pollAllActiveVersions();
      const ok = outcomes.filter((o) => !o.error).length;
      const errs = outcomes.length - ok;
      if (outcomes.length > 0) {
        console.log(`poll: versions=${outcomes.length} ok=${ok} errors=${errs}`);
      }
    } catch (err) {
      console.error("poll loop error:", err);
    }
  }, POLL_INTERVAL_MS);

  return {
    stop() {
      clearInterval(renewTimer);
      clearInterval(pollTimer);
    },
  };
}
