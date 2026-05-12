import * as v from "valibot";
import {
  authenticateBearer,
  jsonOk,
  notFound,
  parseOr400,
  readJsonBody,
  unauthorized,
} from "./middleware.ts";
import { getProjectDetail } from "../domain/project-detail.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_ID_LEN = 200;

const ProjectDetailBodySchema = v.object({
  projectId: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LEN)),
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

  const payload = await readJsonBody(req, MAX_BODY_BYTES);
  if (payload instanceof Response) return payload;
  const parsed = parseOr400(ProjectDetailBodySchema, payload);
  if (parsed instanceof Response) return parsed;

  const detail = await getProjectDetail({
    projectId: parsed.projectId,
    userId: auth.userId,
  });
  if (!detail) return notFound();
  return jsonOk(detail);
}
