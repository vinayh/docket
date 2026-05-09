import { handleOauthCallback, handleOauthStart } from "./oauth.ts";
import { handleCapturesPost } from "./extension.ts";
import { handlePickerHost } from "./picker.ts";
import { handleDriveWebhook } from "./drive-webhook.ts";
import { preflight, withCors } from "./cors.ts";

export interface ServeOptions {
  port?: number;
  hostname?: string;
}

type Handler = (req: Request) => Response | Promise<Response>;
type MethodHandlers = Partial<Record<"GET" | "POST" | "OPTIONS", Handler>>;

/**
 * Wrap a method-keyed route table with CORS handling: every supplied
 * handler's response gets `Access-Control-Allow-*` headers stamped on, and
 * an `OPTIONS` preflight handler is auto-injected. Use for routes hit
 * cross-origin (the extension's service worker, the options page).
 */
function corsRoute(handlers: MethodHandlers): MethodHandlers {
  const out: MethodHandlers = { OPTIONS: preflight };
  for (const [method, handler] of Object.entries(handlers) as [
    keyof MethodHandlers,
    Handler,
  ][]) {
    out[method] = async (req: Request) => withCors(req, await handler(req));
  }
  return out;
}

/**
 * Phase-2 HTTP API host. Public routes: `/healthz`, `/oauth/{start,callback}`,
 * `/picker`. Webhooks: `/webhooks/drive` (Drive push notifications).
 * Bearer-authenticated API surface: `/api/extension/captures`. Method
 * dispatch + 405-on-mismatch comes from Bun.serve's `routes:` option;
 * unknown paths fall through to `fetch`'s 404.
 */
export function startServer(opts: ServeOptions = {}) {
  const envPort = Bun.env.PORT ? Number(Bun.env.PORT) : undefined;
  const port = opts.port ?? envPort ?? 8787;

  return Bun.serve({
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
    },
    fetch() {
      return new Response("not found", { status: 404 });
    },
    error(err) {
      console.error("server error:", err);
      return new Response("internal error", { status: 500 });
    },
  });
}
