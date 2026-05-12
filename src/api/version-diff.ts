import * as v from "valibot";
import {
  authenticateBearer,
  badRequest,
  IdSchema,
  jsonOk,
  notFound,
  readAndParseJson,
  unauthorized,
} from "./middleware.ts";
import { getVersionDiffPayload } from "../domain/version-diff.ts";

const MAX_BODY_BYTES = 4 * 1024;

const VersionDiffBodySchema = v.object({
  fromVersionId: IdSchema,
  toVersionId: IdSchema,
});

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

  const parsed = await readAndParseJson(req, MAX_BODY_BYTES, VersionDiffBodySchema);
  if (parsed instanceof Response) return parsed;
  if (parsed.fromVersionId === parsed.toVersionId) {
    return badRequest("fromVersionId and toVersionId must differ");
  }

  const result = await getVersionDiffPayload({
    fromVersionId: parsed.fromVersionId,
    toVersionId: parsed.toVersionId,
    userId: auth.userId,
  });
  if (!result) return notFound();
  return jsonOk(result);
}
