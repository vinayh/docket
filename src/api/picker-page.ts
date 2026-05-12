import { auth } from "../auth/server.ts";
import { config } from "../config.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import { sha256Base64 } from "./html.ts";
import {
  buildPickerScript,
  htmlErrorResponse,
  renderNotConfiguredHtml,
  renderNotSignedInHtml,
  renderPickerHtml,
  renderTokenErrorHtml,
} from "./picker-page-html.ts";

/**
 * GET /api/picker/page
 *
 * Backend-hosted Drive Picker. The same Google `origin_mismatch` policy
 * that killed `chrome.identity.launchWebAuthFlow` (extension-origin sign-in,
 * see `handleAuthExtSuccess`) also rejects `docs.google.com/picker`'s
 * iframe parent when it's `chrome-extension://<id>/...` — the OAuth
 * client's authorized JavaScript origins can't include that scheme. The
 * fix is to host the Picker page on the backend's own origin (which is
 * already in the OAuth client allow-list because sign-in runs there too).
 *
 * Auth: Better Auth session cookie — the user reached this tab from the
 * extension popup *after* completing sign-in via `/api/auth/ext/launch-tab`,
 * so the cookie is on the same origin. No bearer here; the page is a
 * top-level navigation, not a CORS XHR.
 *
 * Inlined into the page body (all from trusted sources):
 *   - the Drive Picker dev-key + app-id (`/picker/config`'s payload —
 *     not secrets)
 *   - a freshly-minted Drive `access_token` via `tokenProviderForUser`,
 *     so the Picker skips GIS entirely (`accounts.google.com` chokes the
 *     same way it does on extension origins for the in-popup sandbox).
 *
 * On pick the page POSTs to `/api/picker/register-doc` (same-origin, so the
 * session cookie rides along) and shows a "tracked — close this tab"
 * message. Reopening the popup on the original Docs tab picks up the
 * tracked state via `doc/state`; no cross-surface message bus needed.
 *
 * CSP: hashed inline script + `https://apis.google.com` for the gapi
 * loader, `docs.google.com` / `content.googleapis.com` for the Picker
 * iframe, and `'self' https://*.googleapis.com` in `connect-src` for the
 * Picker's REST calls plus our register-doc POST.
 */
export async function handlePickerPage(req: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return htmlErrorResponse(renderNotSignedInHtml(), 401);
  }

  // `clientId` is the only `required()` getter; the other two are
  // `optional()` and degrade to null. Treat any missing as "not
  // configured" rather than 500-ing.
  let clientId: string | null = null;
  try {
    clientId = config.google.clientId;
  } catch {
    clientId = null;
  }
  const apiKey = config.google.apiKey;
  const projectNumber = config.google.projectNumber;
  if (!clientId || !apiKey || !projectNumber) {
    return htmlErrorResponse(renderNotConfiguredHtml(), 500);
  }

  let accessToken: string;
  try {
    accessToken = await tokenProviderForUser(session.user.id).getAccessToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return htmlErrorResponse(renderTokenErrorHtml(msg), 500);
  }

  const script = buildPickerScript({ apiKey, projectNumber, accessToken });
  const scriptHash = await sha256Base64(script);
  const html = renderPickerHtml(script);

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'sha256-${scriptHash}' https://apis.google.com`,
        "style-src 'unsafe-inline'",
        "connect-src 'self' https://apis.google.com https://www.googleapis.com https://content.googleapis.com",
        "frame-src https://docs.google.com https://content.googleapis.com",
        "img-src 'self' data: https:",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  });
}
