import * as v from "valibot";
import {
  authenticateBearer,
  IdSchema,
  jsonOk,
  notFound,
  readAndParseJson,
  unauthorized,
} from "./middleware.ts";
import { getProjectDetail } from "../domain/project-detail.ts";

const MAX_BODY_BYTES = 4 * 1024;

const ProjectDetailBodySchema = v.object({
  projectId: IdSchema,
});

/**
 * POST /api/extension/project — dashboard payload for one project.
 *
 * Body: `{ projectId }`. Returns the composed `ProjectDetail` view (project
 * header, versions with per-version comment count + last-synced, derivatives,
 * open review requests).
 *
 * Owner-scoped: returns 404 when the project doesn't exist OR the caller
 * isn't the owner — matching `doc-state`'s no-info-leak posture. The 404
 * answer is "from your perspective there is no such project," not "this
 * project exists but you can't see it."
 *
 * POST instead of GET to keep the route table consistent with the rest of
 * `/api/extension/*` (and to keep the project id out of URLs / proxy logs).
 */
export async function handleProjectDetailPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const parsed = await readAndParseJson(req, MAX_BODY_BYTES, ProjectDetailBodySchema);
  if (parsed instanceof Response) return parsed;

  const detail = await getProjectDetail({
    projectId: parsed.projectId,
    userId: auth.userId,
  });
  if (!detail) return notFound();
  return jsonOk(detail);
}
