import * as v from "valibot";
import {
  authenticateBearer,
  IdSchema,
  jsonOk,
  notFound,
  readAndParseJson,
  unauthorized,
} from "./middleware.ts";
import { deleteOwnedProject } from "../domain/project.ts";

const MAX_BODY_BYTES = 4 * 1024;

const ProjectDeleteBodySchema = v.object({
  projectId: IdSchema,
});

/**
 * POST /api/extension/project-delete — owner-scoped project removal. Body
 * `{ projectId }`. 200 on success with `{ deleted: true }`; 404 when nothing
 * matched (project missing OR caller isn't the owner — same posture as
 * `project-detail`'s read path).
 *
 * Drive itself isn't touched: this removes the local Margin record only,
 * leaving the user's Google Doc untouched. Reviewer share-grants Margin
 * issued via Drive remain; that's intentional for now, since rewinding them
 * needs a Drive permissions sweep that hasn't been built yet.
 */
export async function handleProjectDeletePost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const parsed = await readAndParseJson(req, MAX_BODY_BYTES, ProjectDeleteBodySchema);
  if (parsed instanceof Response) return parsed;

  const deleted = await deleteOwnedProject(parsed.projectId, auth.userId);
  if (!deleted) return notFound();
  return jsonOk({ deleted: true });
}
