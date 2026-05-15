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
 * Requests carrying an `Origin` that isn't on the allow-list are rejected
 * server-side with 403 — defense in depth, since browser-only enforcement
 * leaves bearer-holding curl free to exfiltrate. Requests with no `Origin`
 * header (curl, CI, cron) pass through; bearer-token confidentiality is
 * still the access boundary there.
 */
const ALLOWED_HEADERS = "authorization, content-type";
const EXPOSED_HEADERS = "x-margin-rate-limit-remaining";

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

/**
 * Returns a 403 Response when the request has an `Origin` header that
 * doesn't match the allow-list; otherwise null. Lets non-browser callers
 * (no `Origin`) through.
 */
export function disallowedOriginResponse(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (!origin || isAllowedOrigin(origin)) return null;
  const headers = new Headers({
    "content-type": "application/json",
    vary: "Origin",
  });
  applySecurityHeaders(headers);
  return new Response(
    JSON.stringify({ error: "origin_not_allowed" }),
    { status: 403, headers },
  );
}

export function preflight(req: Request): Response {
  const blocked = disallowedOriginResponse(req);
  if (blocked) return blocked;
  const headers = new Headers(corsHeaders(req));
  applySecurityHeaders(headers);
  return new Response(null, { status: 204, headers });
}

export function withCors(req: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
  applySecurityHeaders(headers);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Universal hardening headers applied to every response. HSTS is set with
 * `preload` so margin.pub stays eligible for the Chromium preload list
 * (https://hstspreload.org); flipping max-age down or dropping `preload`
 * later requires a manual de-list and a Chrome release cycle to take effect.
 * CSP is set only when the handler hasn't set one — the `/picker` page
 * needs gapi + GIS origins (see picker.ts) and provides its own.
 */
function applySecurityHeaders(headers: Headers): void {
  headers.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("cross-origin-opener-policy", "same-origin");
  if (!headers.has("content-security-policy")) {
    headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  }
}

/** Apply security headers to a response that doesn't go through CORS. */
export function withSecurity(res: Response): Response {
  const headers = new Headers(res.headers);
  applySecurityHeaders(headers);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
