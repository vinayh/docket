import {
  authenticateBearer,
  jsonOk,
  unauthorized,
} from "./middleware.ts";
import { listProjectsOwnedBy } from "../domain/project.ts";
import {
  countVersionsByProject,
  pickLastSyncedAtByProject,
} from "../domain/stats.ts";

/**
 * POST /api/extension/projects — list projects owned by the caller, with
 * roll-up stats (version count, last sync) so the Options page's
 * "Connected docs" list can render without per-project follow-up calls.
 * The side panel's project picker treats the stat fields as optional.
 */
export async function handleProjectsListPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const projects = await listProjectsOwnedBy(auth.userId);
  const projectIds = projects.map((p) => p.id);
  const [versionCounts, lastSynced] = await Promise.all([
    countVersionsByProject(projectIds),
    pickLastSyncedAtByProject(projectIds),
  ]);
  return jsonOk({
    projects: projects.map((p) => ({
      id: p.id,
      parentDocId: p.parentDocId,
      name: p.name,
      createdAt: p.createdAt.getTime(),
      versionCount: versionCounts.get(p.id) ?? 0,
      lastSyncedAt: lastSynced.get(p.id) ?? null,
    })),
  });
}
