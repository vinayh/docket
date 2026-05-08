export interface ServeOptions {
  port?: number;
  hostname?: string;
}

/**
 * Phase-2 HTTP API host. Currently exposes only `/healthz` so Fly's
 * health checks pass; routes (OAuth callback, Drive webhook, extension
 * ingest, Drive Picker) get layered on as they land.
 */
export function startServer(opts: ServeOptions = {}) {
  const envPort = Bun.env.PORT ? Number(Bun.env.PORT) : undefined;
  const port = opts.port ?? envPort ?? 8787;

  return Bun.serve({
    port,
    hostname: opts.hostname,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
    error(err) {
      console.error("server error:", err);
      return new Response("internal error", { status: 500 });
    },
  });
}
