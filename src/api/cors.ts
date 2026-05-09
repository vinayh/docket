/**
 * CORS for the extension surface. Authentication is bearer-token-based, so
 * no cookies cross — we don't need credentialed CORS. But we *do* want to
 * narrow which origins the browser will allow to read responses, so a
 * stolen token can't be exfiltrated by a malicious page running in a
 * regular Docs tab. Allowed:
 *
 *   - `chrome-extension://<id>` — Chrome / Edge MV3 extension origin
 *   - `moz-extension://<uuid>`  — Firefox MV3 extension origin
 *   - `http://localhost[:<port>]` — local dev (options page test, curl, etc.)
 *
 * Anything else: we omit `Access-Control-Allow-Origin` entirely. The
 * browser will block the response per spec; servers that want to debug
 * arbitrary origins should hit the endpoint without a browser in the loop.
 */
const ALLOWED_HEADERS = "authorization, content-type";
const EXPOSED_HEADERS = "x-docket-rate-limit-remaining";

const ORIGIN_PATTERNS: readonly RegExp[] = [
  /^chrome-extension:\/\/[a-z]{32}$/,
  /^moz-extension:\/\/[0-9a-fA-F-]{36}$/,
  /^http:\/\/localhost(?::\d+)?$/,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/,
];

export function isAllowedOrigin(origin: string): boolean {
  return ORIGIN_PATTERNS.some((p) => p.test(origin));
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const base = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-expose-headers": EXPOSED_HEADERS,
    "access-control-max-age": "600",
    vary: "Origin",
  };
  if (!origin || !isAllowedOrigin(origin)) return base;
  return { ...base, "access-control-allow-origin": origin };
}

export function preflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function withCors(req: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
