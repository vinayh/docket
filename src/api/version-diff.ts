import {
  authenticateBearer,
  badRequest,
  jsonOk,
  notFound,
  readJsonBody,
  readStringField,
  unauthorized,
} from "./middleware.ts";
import { getVersionDiffPayload } from "../domain/version-diff.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_ID_LEN = 200;

/**
 * POST /api/extension/version-diff — structured side-by-side diff payload
 * for two versions of the same project. Body:
 * `{ fromVersionId, toVersionId }`. Returns the summarized paragraphs for
 * both sides; the side-panel runs the actual diff render client-side
 * (SPEC §12 Phase 4 structured-diff bullet).
 *
 * Owner-scoped on both versions, and refuses cross-project diffs — both
 * conditions collapse to 404 so the caller can't probe for the existence
 * of versions they shouldn't see.
 */
export async function handleVersionDiffPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const ids = await readVersionIds(req);
  if (ids instanceof Response) return ids;

  const payload = await getVersionDiffPayload({
    fromVersionId: ids.fromVersionId,
    toVersionId: ids.toVersionId,
    userId: auth.userId,
  });
  if (!payload) return notFound();
  return jsonOk(payload);
}

interface VersionIds {
  fromVersionId: string;
  toVersionId: string;
}

async function readVersionIds(req: Request): Promise<VersionIds | Response> {
  const payload = await readJsonBody(req, MAX_BODY_BYTES);
  if (payload instanceof Response) return payload;
  const from = readStringField(payload, "fromVersionId", MAX_ID_LEN);
  if (from instanceof Response) return from;
  const to = readStringField(payload, "toVersionId", MAX_ID_LEN);
  if (to instanceof Response) return to;
  if (from === to) {
    return badRequest("fromVersionId and toVersionId must differ");
  }
  return { fromVersionId: from, toVersionId: to };
}
