import {
  authenticateBearer,
  jsonOk,
  unauthorized,
} from "./middleware.ts";
import { listProjectsOwnedBy } from "../domain/project.ts";

/**
 * POST /api/extension/projects — list projects owned by the caller. Used by
 * the side panel as a fallback picker when the active tab isn't a Docs URL.
 * No body — the bearer session identifies the user; returning a list scoped
 * to that user is the entire job.
 */
export async function handleProjectsListPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const projects = await listProjectsOwnedBy(auth.userId);
  return jsonOk({
    projects: projects.map((p) => ({
      id: p.id,
      parentDocId: p.parentDocId,
      createdAt: p.createdAt.getTime(),
    })),
  });
}
