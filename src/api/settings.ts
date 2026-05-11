import {
  authenticateBearer,
  badRequest,
  jsonOk,
  notFound,
  readJsonBody,
  readStringField,
  unauthorized,
} from "./middleware.ts";
import {
  SettingsBadRequestError,
  SettingsNotFoundError,
  loadProjectSettings,
  updateProjectSettings,
  type ProjectSettingsView,
} from "../domain/settings.ts";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_ID_LEN = 200;

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

  const payload = await readJsonBody(req, MAX_BODY_BYTES);
  if (payload instanceof Response) return payload;

  const projectId = readStringField(payload, "projectId", MAX_ID_LEN);
  if (projectId instanceof Response) return projectId;

  const rawPatch = (payload as { patch?: unknown }).patch;

  try {
    if (rawPatch === undefined) {
      const settings = await loadProjectSettings({ projectId, userId: auth.userId });
      return jsonOk({ settings });
    }
    if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
      return badRequest("patch must be an object");
    }
    const settings = await updateProjectSettings({
      projectId,
      userId: auth.userId,
      patch: rawPatch as Partial<ProjectSettingsView>,
    });
    return jsonOk({ settings });
  } catch (err) {
    if (err instanceof SettingsNotFoundError) return notFound(err.message);
    if (err instanceof SettingsBadRequestError) return badRequest(err.message);
    throw err;
  }
}
