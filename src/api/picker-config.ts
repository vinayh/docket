import { config } from "../config.ts";
import { jsonOk } from "./middleware.ts";

/**
 * GET /api/picker/config — returns the Drive Picker runtime values the
 * extension's sandboxed picker iframe needs. These are not secrets: the
 * same values are inlined into the public `/picker` HTML page (which any
 * unauthenticated browser can fetch), so nothing is exposed here that
 * wasn't already client-visible. Public on purpose — the extension popup
 * needs to call this without a user gesture, and gating it would force a
 * round-trip through the SW solely to attach a bearer token.
 *
 * `null` values are returned when the operator hasn't configured the
 * Picker yet (missing GOOGLE_API_KEY / GOOGLE_PROJECT_NUMBER); the popup
 * surfaces a friendly "Picker not configured on this server" message.
 */
export function handlePickerConfig(_req: Request): Response {
  // `clientId` is `required()` and throws when GOOGLE_CLIENT_ID is unset.
  // Catch so the route degrades to a "not configured" payload instead of
  // 500-ing the whole popup load.
  let clientId: string | null = null;
  try {
    clientId = config.google.clientId;
  } catch {
    clientId = null;
  }
  return jsonOk({
    clientId,
    apiKey: config.google.apiKey,
    projectNumber: config.google.projectNumber,
  });
}
