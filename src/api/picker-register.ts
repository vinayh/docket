import * as v from "valibot";
import {
  authenticateBearer,
  jsonOk,
  readAndParseJson,
  unauthorized,
} from "./middleware.ts";
import { createProject, DuplicateProjectError } from "../domain/project.ts";

const MAX_BODY_BYTES = 8 * 1024;
// `docUrlOrId` accepts a full Google Docs URL, which is longer than an opaque
// id — keep this limit local rather than borrowing `MAX_ID_LEN`.
const MAX_FIELD_LEN = 4 * 1024;

const RegisterBodySchema = v.object({
  docUrlOrId: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_FIELD_LEN)),
});

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
 *           when the caller already owns a project for this doc. Cross-owner
 *           collisions are intentionally not surfaced — uniqueness is scoped
 *           per-owner, mirroring `getDocState`'s tenant isolation.
 */
export async function handleRegisterDocPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const parsed = await readAndParseJson(req, MAX_BODY_BYTES, RegisterBodySchema);
  if (parsed instanceof Response) return parsed;

  // Catch only the domain exception that maps to a non-500 status. Other
  // errors (Drive 5xx, missing credentials, schema violations) propagate
  // to `corsRoute`'s wrapper, which renders them as a structured 500.
  try {
    const project = await createProject({
      ownerUserId: auth.userId,
      parentDocUrlOrId: parsed.docUrlOrId,
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
    throw err;
  }
}
