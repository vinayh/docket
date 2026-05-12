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
import {
  CommentActionBadRequestError,
  CommentActionNotFoundError,
  performCommentAction,
} from "../domain/comment-action.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_ID_LEN = 200;

const Id = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LEN));

const CommentActionBodySchema = v.object({
  canonicalCommentId: Id,
  action: v.picklist([
    "accept_projection",
    "reanchor",
    "mark_resolved",
    "mark_wontfix",
    "reopen",
  ]),
  targetVersionId: v.optional(v.nullable(Id)),
});

/**
 * POST /api/extension/comment-action — reconciliation actions on a single
 * canonical comment (SPEC §12 Phase 4). Body:
 *   { canonicalCommentId, action, targetVersionId? }
 *
 * `action` is one of `accept_projection`, `reanchor`, `mark_resolved`,
 * `mark_wontfix`, `reopen`. `targetVersionId` is required for the projection-
 * scoped actions (`accept_projection`, `reanchor`) and ignored for the
 * canonical-status actions.
 *
 * Owner-scoped: 404 when the comment is missing OR the caller isn't the
 * project owner — matches `version-comments`'s no-info-leak posture. Audit
 * log entries are written inside the domain layer.
 */
export async function handleCommentActionPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const payload = await readJsonBody(req, MAX_BODY_BYTES);
  if (payload instanceof Response) return payload;
  const parsed = parseOr400(CommentActionBodySchema, payload);
  if (parsed instanceof Response) return parsed;

  try {
    const result = await performCommentAction({
      userId: auth.userId,
      canonicalCommentId: parsed.canonicalCommentId,
      action: parsed.action,
      targetVersionId: parsed.targetVersionId ?? null,
    });
    return jsonOk(result);
  } catch (err) {
    if (err instanceof CommentActionNotFoundError) {
      return notFound(err.message);
    }
    if (err instanceof CommentActionBadRequestError) {
      return badRequest(err.message);
    }
    throw err;
  }
}
