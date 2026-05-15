import { auth } from "../auth/server.ts";
import { config } from "../config.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import { nonce, renderPage } from "./render.ts";
import { PickerPage } from "./pages/PickerPage.tsx";
import { PickerErrorPage, type PickerErrorVariant } from "./pages/PickerErrorPage.tsx";

const STATIC_CSP =
  "default-src 'none'; style-src 'self'; font-src 'self'; frame-ancestors 'none'";

function renderError(variant: PickerErrorVariant, status: number, details?: string): Response {
  return renderPage(<PickerErrorPage variant={variant} details={details} />, {
    csp: STATIC_CSP,
    status,
  });
}

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
    return renderError("not-signed-in", 401);
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
    return renderError("not-configured", 500);
  }

  let accessToken: string;
  try {
    accessToken = await tokenProviderForUser(session.user.id).getAccessToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return renderError("token-error", 500, msg);
  }

  const n = nonce();
  return renderPage(
    <PickerPage apiKey={apiKey} projectNumber={projectNumber} accessToken={accessToken} nonce={n} />,
    {
      csp: [
        "default-src 'none'",
        `script-src 'nonce-${n}' https://apis.google.com`,
        "style-src 'self'",
        "font-src 'self'",
        "connect-src 'self' https://apis.google.com https://www.googleapis.com https://content.googleapis.com",
        "frame-src https://docs.google.com https://content.googleapis.com",
        "img-src 'self' data: https:",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  );
}
