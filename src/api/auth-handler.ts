import { auth } from "../auth/server.ts";
import { db } from "../db/client.ts";
import { session as sessionTable } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { badRequest } from "./middleware.ts";
import { config } from "../config.ts";
import { renderHashedScriptHtml, sha256Base64 } from "./html.ts";

/**
 * Catch-all for `/api/auth/**`. Better Auth's `auth.handler` reads the basePath
 * (`/api/auth`) off the request URL and dispatches to its internal route
 * registry — sign-in, social-provider callback, get-session, sign-out, etc.
 */
export function handleAuthRequest(req: Request): Response | Promise<Response> {
  return auth.handler(req);
}

/**
 * Extension ID query-param validator. The launch-tab / success bridge
 * round-trips `?ext=<chrome.runtime.id>` so the success page knows which
 * extension to `sendMessage` to. Chrome IDs are exactly 32 lowercase a-p
 * chars; Firefox IDs are UUIDs. Anything else: reject.
 */
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
 * Kicks off Google sign-in for the MV3 extension via a normal top-level
 * tab. `chrome.identity.launchWebAuthFlow` is unusable because Chrome 122+
 * stamps the extension's `chrome-extension://` origin onto the OAuth
 * request, which Google rejects on `Web application` clients. Calls Better
 * Auth's `signInSocial` to mint the Google authorization URL (+ PKCE/state
 * cookies), then 302s into Google. The inner `callbackURL` points at
 * `/api/auth/ext/success`, which renders the bridge page.
 *
 * `ext` is round-tripped through to `/success` so the bridge script knows
 * which extension to `sendMessage` to. The receiving SW only honors
 * messages whose `sender.origin` matches the stored backend, so even if a
 * caller forges a different ext id the token never lands.
 */
export async function handleAuthExtLaunchTab(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const ext = url.searchParams.get("ext");
  if (!ext || !isAllowedExtId(ext)) {
    return badRequest("missing or unrecognized ?ext extension id");
  }

  // Prefer the operator-configured public origin over `req.url`. The latter
  // is Host-header dependent — a misrouted proxy or an attacker forging Host
  // would steer `successURL` (and therefore the token-bearing bridge page)
  // to a hostname they control. Better Auth's `trustedOrigins` already
  // rejects mismatches, but this is the belt to that suspenders.
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
 * Bridge page rendered after Google → Better Auth's social callback →
 * session cookie. Reads the session, looks up the raw `session.token`,
 * and inlines it into an HTML page that hands the token to the extension.
 *
 * The inline script feature-detects `chrome.runtime.sendMessage` instead
 * of UA-sniffing for Firefox:
 *  - When `chrome.runtime.sendMessage` is a function on the page (the
 *    Chromium externally_connectable bridge), the script calls
 *    `chrome.runtime.sendMessage(extId, { kind: "auth/token", token })`
 *    and `window.close()`s on success.
 *  - Otherwise (Firefox today — no `externally_connectable.matches`
 *    support, see Bugzilla 1319168 — or a future Chromium revision that
 *    drops the API on regular pages) the script parks the token in
 *    `location.hash`. The SW's `tabs.onUpdated` listener picks it up,
 *    patches settings, and closes the bridge tab.
 *
 * Security:
 *  - The token is inlined into the page body, so the response is marked
 *    no-store / no-referrer / noindex.
 *  - The inline `<script>` is gated by a per-response SHA-256 CSP hash,
 *    not a blanket `'unsafe-inline'`.
 *  - The page declares `<base target="_self">` so even if a future
 *    handler injects a link, it can't open in the originating window.
 *  - `frame-ancestors 'none'` prevents framing.
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
        "frame-ancestors 'none'",
      ].join("; "),
    },
  });
}

function buildBridgeScript(extId: string, token: string): string {
  // JSON.stringify gives us a JS-safe string literal: it escapes quotes,
  // newlines, and the dangerous </script> separators. Both values come
  // from validated/database-trusted sources, but the encoder is the
  // defense-in-depth that keeps the inline script un-breakable.
  //
  // Two paths, picked by feature detection (not UA):
  //  1. `chrome.runtime.sendMessage` exists on the page — that's the
  //     externally_connectable bridge, available on Chromium because we
  //     declared `externally_connectable.matches: ["*://*/*"]` in the
  //     manifest. Send the token to the SW directly and close the tab on
  //     ack. Firefox doesn't expose chrome.runtime on regular pages
  //     (Bugzilla 1319168), so this branch is skipped there.
  //  2. Fall through to `location.hash = 'token=…'`. The SW's
  //     `tabs.onUpdated` listener observes the hash and patches settings.
  //     This is Firefox's path today; it would also be the path if a
  //     future Chromium revision dropped chrome.runtime exposure on web
  //     pages.
  //
  // The bridge intentionally falls back to the fragment if the
  // sendMessage callback never fires (extension uninstalled, SW asleep,
  // host permission missing) so the user isn't stranded with a token
  // the page can't deliver.
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
    // 1.5s gives a sleeping SW time to spin up; if no ack we still hand off via the fragment.
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

