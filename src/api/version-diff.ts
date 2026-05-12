import * as v from "valibot";
import {
  authenticateBearer,
  badRequest,
  jsonOk,
  notFound,
  parseOr400,
  readJsonBody,
  unauthorized,
} from "./middleware.ts";
import { getVersionDiffPayload } from "../domain/version-diff.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_ID_LEN = 200;

const Id = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LEN));

const VersionDiffBodySchema = v.object({
  fromVersionId: Id,
  toVersionId: Id,
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

  const payload = await readJsonBody(req, MAX_BODY_BYTES);
  if (payload instanceof Response) return payload;
  const parsed = parseOr400(VersionDiffBodySchema, payload);
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
