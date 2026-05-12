import * as v from "valibot";
import {
  authenticateBearer,
  jsonOk,
  notFound,
  parseOr400,
  readJsonBody,
  unauthorized,
} from "./middleware.ts";
import { getVersionCommentsPayload } from "../domain/version-comments.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_ID_LEN = 200;

const VersionCommentsBodySchema = v.object({
  versionId: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LEN)),
});

/**
 * POST /api/extension/version-comments — canonical comments + their
 * projection state onto a single version (SPEC §12 Phase 4, comment-
 * reconciliation slice). Body: `{ versionId }`. Returns one entry per
 * `comment_projection` row for this version, joined with the canonical
 * comment metadata + origin-version label so the side panel can render
 * "(from v1)" attribution and surface fuzzy / orphan rows for action.
 *
 * Owner-scoped: 404 when the version doesn't exist OR the caller isn't
 * the project owner — matching `version-diff`'s no-info-leak posture.
 */
export async function handleVersionCommentsPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const payload = await readJsonBody(req, MAX_BODY_BYTES);
  if (payload instanceof Response) return payload;
  const parsed = parseOr400(VersionCommentsBodySchema, payload);
  if (parsed instanceof Response) return parsed;

  const result = await getVersionCommentsPayload({
    versionId: parsed.versionId,
    userId: auth.userId,
  });
  if (!result) return notFound();
  return jsonOk(result);
}
