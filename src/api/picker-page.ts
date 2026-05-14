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
 * Backend-hosted Drive Picker. The Picker's iframe parent can't be `chrome-extension://`
 * (OAuth client origins don't allow that scheme), so the page runs on the backend origin
 * instead, which is already in the OAuth allow-list. Inlines a fresh Drive access token
 * so the Picker skips GIS. On pick the page POSTs same-origin to /api/picker/register-doc.
 */
export async function handlePickerPage(req: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return htmlErrorResponse(renderNotSignedInHtml(), 401);
  }

  // clientId is required(); the other two degrade to null when unset.
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
        "font-src 'self'",
        "connect-src 'self' https://apis.google.com https://www.googleapis.com https://content.googleapis.com",
        "frame-src https://docs.google.com https://content.googleapis.com",
        "img-src 'self' data: https:",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  });
}
