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
import {
  ReviewRequestBadRequestError,
  ReviewRequestNotFoundError,
  createReviewRequest,
} from "../domain/review.ts";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_EMAILS = 32;
const MAX_EMAIL_LEN = 320;

const ReviewRequestBodySchema = v.object({
  versionId: IdSchema,
  assigneeEmails: v.pipe(
    v.array(v.pipe(v.string(), v.email(), v.maxLength(MAX_EMAIL_LEN))),
    v.minLength(1, "at least one assignee required"),
    v.maxLength(MAX_EMAILS),
  ),
  deadline: v.optional(v.union([v.null(), v.pipe(v.number(), v.integer())])),
});

/**
 * POST /api/extension/review/request — create a review request for a version
 * and mint magic-link tokens. Body:
 *   { versionId, assigneeEmails: string[], deadline?: number | null }
 *
 * Owner-scoped via `loadOwnedVersion`: 404 when the version doesn't exist or
 * the caller isn't the project owner.
 *
 * Email transport isn't wired in this phase — the response carries the issued
 * `/r/<token>` URLs so the side-panel POC can render them inline (and the
 * audit log records which tokens were minted). Phase 5 / 6 swap the inline
 * render for Slack + email transports.
 */
export async function handleReviewRequestPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const parsed = await readAndParseJson(
    req,
    MAX_BODY_BYTES,
    ReviewRequestBodySchema,
  );
  if (parsed instanceof Response) return parsed;

  try {
    const result = await createReviewRequest({
      versionId: parsed.versionId,
      ownerUserId: auth.userId,
      assigneeEmails: parsed.assigneeEmails,
      deadline: parsed.deadline ? new Date(parsed.deadline) : null,
    });
    return jsonOk(result);
  } catch (err) {
    if (err instanceof ReviewRequestNotFoundError) return notFound(err.message);
    if (err instanceof ReviewRequestBadRequestError) {
      return badRequest(err.message);
    }
    throw err;
  }
}
