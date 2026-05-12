import * as v from "valibot";
import {
  authenticateBearer,
  IdSchema,
  jsonOk,
  notFound,
  readAndParseJson,
  unauthorized,
} from "./middleware.ts";
import {
  ProjectSettingsPatchSchema,
  SettingsNotFoundError,
  loadProjectSettings,
  updateProjectSettings,
} from "../domain/settings.ts";

const MAX_BODY_BYTES = 8 * 1024;

const SettingsBodySchema = v.object({
  projectId: IdSchema,
  patch: v.optional(ProjectSettingsPatchSchema),
});

/**
 * POST /api/extension/settings — project settings surface for the side
 * panel (SPEC §12 Phase 4: notification prefs, default reviewers, Slack
 * workspace linking).
 *
 * Body shape:
 *   { projectId }                 → return current settings
 *   { projectId, patch: {...} }   → merge-update + return the new state
 *
 * `patch` is a partial of `ProjectSettingsView`; omitted fields keep their
 * current value. Owner-scoped — 404 when the project is missing or not
 * owned by the caller (no info leak).
 */
export async function handleSettingsPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const parsed = await readAndParseJson(req, MAX_BODY_BYTES, SettingsBodySchema);
  if (parsed instanceof Response) return parsed;

  try {
    if (parsed.patch === undefined) {
      const settings = await loadProjectSettings({
        projectId: parsed.projectId,
        userId: auth.userId,
      });
      return jsonOk({ settings });
    }
    const settings = await updateProjectSettings({
      projectId: parsed.projectId,
      userId: auth.userId,
      patch: parsed.patch,
    });
    return jsonOk({ settings });
  } catch (err) {
    if (err instanceof SettingsNotFoundError) return notFound(err.message);
    throw err;
  }
}
