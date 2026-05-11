import { authenticateBearer, badRequest, jsonOk, unauthorized } from "./middleware.ts";
import { getVersionCommentsPayload } from "../domain/version-comments.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_ID_LEN = 200;

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

  const versionId = await readVersionId(req);
  if (typeof versionId !== "string") return versionId;

  const payload = await getVersionCommentsPayload({
    versionId,
    userId: auth.userId,
  });
  if (!payload) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return jsonOk(payload);
}

async function readVersionId(req: Request): Promise<string | Response> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return badRequest(`request too large: ${contentLength} > ${MAX_BODY_BYTES}`);
  }
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return badRequest("invalid json");
  }
  if (!payload || typeof payload !== "object") {
    return badRequest("expected { versionId: string }");
  }
  const raw = (payload as { versionId?: unknown }).versionId;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ID_LEN) {
    return badRequest("expected { versionId: string }");
  }
  return raw;
}
