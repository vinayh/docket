import { handleOauthCallback, handleOauthStart } from "./oauth.ts";

export interface ServeOptions {
  port?: number;
  hostname?: string;
}

/**
 * Phase-2 HTTP API host. Routes shipped: `/healthz`, `/oauth/start`,
 * `/oauth/callback`. Drive webhook, extension ingest, and the Drive
 * Picker host page get layered on as they land.
 */
export function startServer(opts: ServeOptions = {}) {
  const envPort = Bun.env.PORT ? Number(Bun.env.PORT) : undefined;
  const port = opts.port ?? envPort ?? 8787;

  return Bun.serve({
    port,
    hostname: opts.hostname,
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method;

      if (method === "GET" && url.pathname === "/healthz") {
        return Response.json({ ok: true });
      }
      if (method === "GET" && url.pathname === "/oauth/start") {
        return handleOauthStart(req);
      }
      if (method === "GET" && url.pathname === "/oauth/callback") {
        return handleOauthCallback(req);
      }
      return new Response("not found", { status: 404 });
    },
    error(err) {
      console.error("server error:", err);
      return new Response("internal error", { status: 500 });
    },
  });
}
