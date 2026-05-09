import {
  authenticateBearer,
  badRequest,
  internalError,
  jsonOk,
  unauthorized,
} from "./middleware.ts";
import { createProject, DuplicateProjectError } from "../domain/project.ts";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_FIELD_LEN = 4 * 1024;

/**
 * POST /api/picker/register-doc — completes the Drive Picker entry flow
 * (SPEC §9.2). The picker page (or the extension) holds the user's API
 * token and the picked doc id; this endpoint resolves the token to a
 * user, calls `createProject`, and returns the new (or pre-existing)
 * project row.
 *
 * Request:  { docUrlOrId: string }
 * Success:  200 { projectId, parentDocId }
 * Conflict: 409 { error: "already_exists", projectId, parentDocId }
 *           when the doc is already registered (regardless of which user owns it)
 */
export async function handleRegisterDocPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

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
    return badRequest("expected { docUrlOrId: string }");
  }
  const raw = (payload as { docUrlOrId?: unknown }).docUrlOrId;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_FIELD_LEN) {
    return badRequest("expected { docUrlOrId: string }");
  }

  try {
    const project = await createProject({
      ownerUserId: auth.userId,
      parentDocUrlOrId: raw,
    });
    return jsonOk({
      projectId: project.id,
      parentDocId: project.parentDocId,
    });
  } catch (err) {
    if (err instanceof DuplicateProjectError) {
      return new Response(
        JSON.stringify({
          error: "already_exists",
          projectId: err.projectId,
          parentDocId: err.parentDocId,
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    return internalError(err instanceof Error ? err.message : String(err));
  }
}
