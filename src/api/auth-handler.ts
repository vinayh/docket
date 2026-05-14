import { auth } from "../auth/server.ts";
import { db } from "../db/client.ts";
import { session as sessionTable } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { badRequest } from "./middleware.ts";
import { config } from "../config.ts";
import { renderHashedScriptHtml, sha256Base64 } from "./html.ts";

export function handleAuthRequest(req: Request): Response | Promise<Response> {
  return auth.handler(req);
}

// Chrome IDs are 32 lowercase a-p chars; Firefox IDs are UUIDs. Reject anything else.
const EXT_ID_PATTERNS: readonly RegExp[] = [
  /^[a-p]{32}$/, // Chrome / Edge
  /^\{?[0-9a-fA-F-]{36}\}?$/, // Firefox (UUID, optional braces)
];

function isAllowedExtId(id: string): boolean {
  return EXT_ID_PATTERNS.some((p) => p.test(id));
}

/**
 * GET /api/auth/ext/launch-tab?ext=<chrome.runtime.id>
 *
 * Kicks off Google sign-in via a top-level tab. `chrome.identity.launchWebAuthFlow`
 * can't be used: Chrome 122+ stamps the `chrome-extension://` origin onto the OAuth
 * request and Google rejects it on Web-application clients. The `ext` param round-trips
 * to `/success` so the bridge knows which extension to message.
 */
export async function handleAuthExtLaunchTab(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const ext = url.searchParams.get("ext");
  if (!ext || !isAllowedExtId(ext)) {
    return badRequest("missing or unrecognized ?ext extension id");
  }

  // Use the configured public origin, not req.url — Host header is attacker-spoofable
  // and would let a forged Host steer the token-bearing bridge page elsewhere.
  const baseURL = new URL(config.publicBaseUrl ?? req.url);
  baseURL.search = "";
  baseURL.pathname = "/api/auth/ext/success";
  const successURL = `${baseURL.toString()}?ext=${encodeURIComponent(ext)}`;

  const res = await auth.api.signInSocial({
    body: {
      provider: "google",
      callbackURL: successURL,
      disableRedirect: true,
    },
    asResponse: true,
  });

  const body = (await res.json()) as { url?: string };
  if (!res.ok || !body.url) {
    return new Response("sign-in init failed", { status: 502 });
  }

  const redirect = new Response(null, {
    status: 302,
    headers: { location: body.url },
  });
  for (const [k, v] of res.headers.entries()) {
    if (k.toLowerCase() === "set-cookie") redirect.headers.append("set-cookie", v);
  }
  return redirect;
}

/**
 * GET /api/auth/ext/success?ext=<runtime.id>
 *
 * Renders the post-OAuth bridge page. Inlines the raw `session.token` into a script that
 * hands it to the extension. Two delivery paths, picked by feature detection (not UA):
 *  - Chromium: `chrome.runtime.sendMessage(extId, ...)` via the externally_connectable bridge.
 *  - Firefox / fallback: park the token in `location.hash` for the SW's tabs.onUpdated to pick up.
 *
 * Security posture: token-bearing response is `no-store`/noindex, the inline `<script>` is
 * gated by a per-response SHA-256 CSP hash (no `unsafe-inline`), `frame-ancestors 'none'`.
 */
export async function handleAuthExtSuccess(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const ext = url.searchParams.get("ext");
  if (!ext || !isAllowedExtId(ext)) {
    return badRequest("missing or unrecognized ?ext extension id");
  }

  const result = await auth.api.getSession({ headers: req.headers });
  if (!result) {
    return new Response("sign-in did not produce a session", { status: 401 });
  }

  const rows = await db
    .select({ token: sessionTable.token })
    .from(sessionTable)
    .where(eq(sessionTable.id, result.session.id))
    .limit(1);
  const token = rows[0]?.token;
  if (!token) {
    return new Response("session row missing", { status: 500 });
  }

  const script = buildBridgeScript(ext, token);
  const scriptHash = await sha256Base64(script);
  const html = renderHashedScriptHtml({
    title: "Margin — Signed in",
    bodyMarkup: `<h1>Margin</h1>\n<p id="status">Finishing sign-in…</p>`,
    inlineScript: script,
  });

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'sha256-${scriptHash}'`,
        "style-src 'unsafe-inline'",
        "font-src 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  });
}

function buildBridgeScript(extId: string, token: string): string {
  // JSON.stringify keeps the inline values un-escaping out of the <script> context.
  // Firefox doesn't expose chrome.runtime on regular pages (Bugzilla 1319168), so the
  // sendMessage branch only runs on Chromium; everything else falls back to location.hash.
  const extJson = JSON.stringify(extId);
  const tokenJson = JSON.stringify(token);
  return [
    "(function () {",
    `  var extId = ${extJson};`,
    `  var token = ${tokenJson};`,
    "  var statusEl = document.getElementById('status');",
    "  function setText(t) { if (statusEl) statusEl.textContent = t; }",
    "  function closeTab() { try { window.close(); } catch (_) {} }",
    "  var done = false;",
    "  function fallbackToFragment() {",
    "    if (done) return; done = true;",
    "    try { location.hash = 'token=' + encodeURIComponent(token); } catch (_) {}",
    "    setText('Signed in. You can close this tab.');",
    "  }",
    "  var hasSendMessage = (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function');",
    "  if (!hasSendMessage) { fallbackToFragment(); return; }",
    // 1.5s gives a sleeping SW time to wake; on timeout we fall through to the hash path.
    "  var timer = setTimeout(fallbackToFragment, 1500);",
    "  try {",
    "    chrome.runtime.sendMessage(extId, { kind: 'auth/token', token: token }, function (r) {",
    "      clearTimeout(timer);",
    "      if (done) return;",
    "      if (r && r.ok) { done = true; setText('Signed in. You can close this tab.'); setTimeout(closeTab, 400); }",
    "      else { fallbackToFragment(); }",
    "    });",
    "  } catch (_) { clearTimeout(timer); fallbackToFragment(); }",
    "})();",
  ].join("\n");
}

