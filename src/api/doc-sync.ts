import {
  authenticateBearer,
  internalError,
  jsonOk,
  unauthorized,
} from "./middleware.ts";
import { readDocId } from "./doc-state.ts";
import { getDocState } from "../domain/doc-state.ts";
import { ingestVersionComments } from "../domain/comments.ts";

/**
 * POST /api/extension/doc-sync — popup "Sync now" handler. Body: `{ docId }`.
 * Looks up the user's project for that doc, ingests comments for the relevant
 * version (the one tied to the open doc, or the latest active version when
 * the user is viewing the parent), then returns refreshed state.
 *
 * Returns 200 with `{ tracked: false }` when the doc isn't a known project —
 * the popup uses that to render the onboarding affordance instead of an
 * error. 500 only on infrastructure failures (Drive API down, credentials
 * missing); idempotent so the popup can retry safely.
 */
export async function handleDocSyncPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const docId = await readDocId(req);
  if (typeof docId !== "string") return docId;

  const before = await getDocState({ docId, userId: auth.userId });
  if (!before.tracked) return jsonOk(before);
  if (!before.version) {
    // Tracked but no version row yet — nothing to ingest. Surface as a
    // clean 200 with the unchanged state; popup will display "no versions
    // yet" on its own.
    return jsonOk(before);
  }

  try {
    await ingestVersionComments(before.version.id);
  } catch (err) {
    return internalError(err instanceof Error ? err.message : String(err));
  }

  // Re-fetch state after ingest so the popup can reflect updated counts and
  // lastSyncedAt without a second round-trip.
  const after = await getDocState({ docId, userId: auth.userId });
  return jsonOk(after);
}
