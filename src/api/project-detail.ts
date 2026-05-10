import { authenticateBearer, badRequest, jsonOk, unauthorized } from "./middleware.ts";
import { getProjectDetail } from "../domain/project-detail.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_ID_LEN = 200;

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

  const projectId = await readProjectId(req);
  if (typeof projectId !== "string") return projectId;

  const detail = await getProjectDetail({ projectId, userId: auth.userId });
  if (!detail) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return jsonOk(detail);
}

async function readProjectId(req: Request): Promise<string | Response> {
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
    return badRequest("expected { projectId: string }");
  }
  const raw = (payload as { projectId?: unknown }).projectId;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ID_LEN) {
    return badRequest("expected { projectId: string }");
  }
  return raw;
}
