import * as v from "valibot";
import {
  authenticateBearer,
  jsonOk,
  notFound,
  parseOr400,
  readJsonBody,
  unauthorized,
} from "./middleware.ts";
import {
  ProjectSettingsPatchSchema,
  SettingsNotFoundError,
  loadProjectSettings,
  updateProjectSettings,
} from "../domain/settings.ts";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_ID_LEN = 200;

const SettingsBodySchema = v.object({
  projectId: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LEN)),
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

  const payload = await readJsonBody(req, MAX_BODY_BYTES);
  if (payload instanceof Response) return payload;

  const parsed = parseOr400(SettingsBodySchema, payload);
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
