import {
  authenticateBearer,
  badRequest,
  jsonOk,
  notFound,
  readJsonBody,
  readStringField,
  unauthorized,
} from "./middleware.ts";
import {
  CommentActionBadRequestError,
  CommentActionNotFoundError,
  performCommentAction,
  type CommentActionKind,
} from "../domain/comment-action.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_ID_LEN = 200;

const VALID_ACTIONS: readonly CommentActionKind[] = [
  "accept_projection",
  "reanchor",
  "mark_resolved",
  "mark_wontfix",
  "reopen",
];

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

  const parsed = await readActionPayload(req);
  if (parsed instanceof Response) return parsed;

  try {
    const result = await performCommentAction({
      userId: auth.userId,
      canonicalCommentId: parsed.canonicalCommentId,
      action: parsed.action,
      targetVersionId: parsed.targetVersionId,
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

interface ActionPayload {
  canonicalCommentId: string;
  action: CommentActionKind;
  targetVersionId: string | null;
}

async function readActionPayload(req: Request): Promise<ActionPayload | Response> {
  const payload = await readJsonBody(req, MAX_BODY_BYTES);
  if (payload instanceof Response) return payload;

  const canonicalCommentId = readStringField(payload, "canonicalCommentId", MAX_ID_LEN);
  if (canonicalCommentId instanceof Response) return canonicalCommentId;

  const rawAction = payload.action;
  if (
    typeof rawAction !== "string" ||
    !(VALID_ACTIONS as readonly string[]).includes(rawAction)
  ) {
    return badRequest(
      `expected { action: ${VALID_ACTIONS.map((a) => `"${a}"`).join(" | ")} }`,
    );
  }
  const action = rawAction as CommentActionKind;

  let targetVersionId: string | null = null;
  const rawTarget = payload.targetVersionId;
  if (rawTarget !== undefined && rawTarget !== null) {
    const t = readStringField(payload, "targetVersionId", MAX_ID_LEN);
    if (t instanceof Response) return t;
    targetVersionId = t;
  }

  return { canonicalCommentId, action, targetVersionId };
}
